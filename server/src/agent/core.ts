import {
  annotateDocument,
  checkPayee,
  classifyDocument,
  DOCUMENT_KINDS,
  documentNoun,
  feePhrases,
  joinAnd,
  planMove,
  sampleFor,
  withMovePlan,
  withPayeeCheck,
  type Annotation,
  type Classification,
  type DocumentKind,
  type DocumentMark,
  type InvoiceReading,
  type MovePlan,
  type PayeeCheck,
} from "../documents/index.ts";
import { buildFindings, type FindingsInputs } from "../findings/index.ts";
import { replyCitations } from "../findings/normalize.ts";
import { actionHash } from "../policy/gate.ts";
import { runToolCall, type RunOutcome } from "../policy/run.ts";
import { monthlyPriceIn } from "../research/contracts.ts";
import { buildScenarios } from "../scenarios/index.ts";
import type { Clause } from "../scenarios/contracts.ts";
import type { Services } from "../services.ts";
import type { AgentRole, ApprovalRequest, CashFlow, Decision, Evidence, Finding, FindingsView, Nudge, SavingsReport, ScamAssessment, ToolAdapter, ToolCall, TurnKind } from "../types.ts";
import { accountNumbersIn, amountsIn, digits, formatUsd, newId, parseAmount, sha256 } from "../util.ts";
import { deterministicReply, emptyEvidence, evaluateReply, withoutCode, type TurnEvidence } from "./evaluator.ts";
import { explainOutcome } from "./explain.ts";
import { findNudges } from "./nudges.ts";
import { SPECIALISTS, type AgentStep, type SpecialistId } from "./supervisor.ts";

export type TurnSource = "app" | "imessage" | "desk" | "console" | "system";

export interface TurnStarted {
  kind: TurnKind;
  source: TurnSource;
  summary: string;
}

export function startTurn(s: Services, turnId: string, kind: TurnKind, source: TurnSource, summary: string): void {
  s.trace.append<TurnStarted>("turn_started", { kind, source, summary: summary.slice(0, 160) }, turnId);
}

const step = (s: Services, turnId: string, x: AgentStep) => s.trace.append("agent_step", x, turnId);

type Row = Record<string, unknown>;
const DAY = 86_400_000;

function readTool(name: string, description: string, capability: "bank.read" | "research.read", run: (args: Record<string, unknown>) => Promise<unknown>): ToolAdapter {
  return {
    spec: { name, description, inputSchema: { type: "object", properties: {} }, effect: "read", capability },
    run: async (args) => {
      try {
        return { ok: true, data: await run(args), systemValues: [], texts: [] };
      } catch (err) {
        return { ok: false, data: null, systemValues: [], texts: [], error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

async function rows(s: Services, tool: string): Promise<Row[]> {
  const result = await s.tools.get(tool)?.run({});
  if (!result?.ok) throw new Error(result?.error ?? `${tool} is not available.`);
  const list = Array.isArray(result.data) ? (result.data as Row[]) : [];
  s.gate.learnNames(
    list.flatMap((r) => {
      const key = (["payee", "name", "merchant", "nickname"] as const).find((k) => typeof r[k] === "string" && r[k]);
      return typeof r.id === "string" && key ? [{ source: `household#${r.id}.${key}`, value: String(r[key]) }] : [];
    }),
  );
  return list;
}

async function learnNamesFor(s: Services, args: Record<string, unknown>): Promise<void> {
  const lists = [
    ["bill_id", "bank.list_bills"],
    ["subscription_id", "subscriptions.list"],
  ] as const;
  await Promise.all(lists.filter(([field]) => typeof args[field] === "string" && !s.gate.knowsName(String(args[field]))).map(([, tool]) => rows(s, tool).catch(() => [])));
}

function gymOf(subs: Row[]) {
  const row = subs.find((x) => x.id === "sub-gym");
  return row && typeof row.price === "number" && typeof row.renews === "string" ? { id: "sub-gym", price: row.price, renews: row.renews, status: String(row.status ?? "active") } : undefined;
}

function recentMessages(s: Services) {
  const events = s.trace.list();
  const forwarded = events
    .filter((e) => e.type === "inbound_shared")
    .slice(-5)
    .map((e) => {
      const d = e.data as { inboundId?: string; text?: string };
      return { inboundId: d.inboundId ?? null, at: e.ts, excerpt: String(d.text ?? "").slice(0, 140) };
    });
  const checks = events
    .filter((e) => e.type === "scam_assessed")
    .slice(-5)
    .map((e) => {
      const a = e.data as ScamAssessment;
      return { subject: a.subject, risk: a.risk, score: a.score, signals: a.redFlags.map((f) => f.signal), at: e.ts };
    });
  return { forwarded, checks };
}

function protectionState(s: Services) {
  const since = Date.now() - DAY;
  const events = s.trace.list();
  const calls = new Map<string, ToolCall>();
  for (const e of events) if (e.type === "tool_proposed") calls.set((e.data as ToolCall).id, e.data as ToolCall);
  const blocked = events
    .filter((e) => e.type === "decision" && Date.parse(e.ts) >= since && (e.data as Decision).verdict === "deny")
    .map((e) => calls.get((e.data as Decision).callId))
    .filter((c): c is ToolCall => !!c && typeof c.args.amount === "number")
    .map((c) => ({ tool: c.tool, amount: Number(c.args.amount) }));
  const policy = s.policy.current();
  return { blocked, pendingApprovals: s.gate.pendingApprovals().length, paused: policy.paused, trustedContact: Boolean(policy.trustedContact) };
}

export function ensureCoreTools(s: Services): void {
  if (s.tools.get("household.accounts")) return;
  s.tools.register(
    readTool("household.subscriptions", "Subscriptions and trials with price, renewal date and last use (for the household review).", "bank.read", () => rows(s, "subscriptions.list")),
    readTool("household.savings_report", "The savings report: recommendations with amounts computed in code and their sources.", "bank.read", () => s.savings()),
    readTool("household.accounts", "Accounts with balances (for the household review).", "bank.read", () => rows(s, "bank.get_accounts")),
    readTool("household.bills", "Bills with payee, amount and due date (for the household review).", "bank.read", () => rows(s, "bank.list_bills")),
    readTool("household.cash_flow", "What is safe to move from checking after upcoming bills and the buffer.", "bank.read", async () => (await s.cashFlow(s.policy.current().ownAccounts[0] ?? "")) ?? null),
    readTool("household.messages", "Recent forwarded messages (excerpts) and their scam checks.", "bank.read", async () => recentMessages(s)),
    readTool("household.protection", "Money moves SkillGate denied in the last 24 hours, approvals waiting, pause and trusted contact.", "bank.read", async () => protectionState(s)),
    readTool("household.scenarios", "Loans, contracts and investments (simulated scenarios with public sources).", "bank.read", async () =>
      buildScenarios({ now: new Date(), retriever: s.rag, policy: () => s.policy.current(), gym: gymOf(await rows(s, "subscriptions.list").catch(() => [])) }),
    ),
    readTool("household.payees", "Saved payees with their accounts on file (to compare a document's payment details).", "bank.read", () => rows(s, "bank.list_payees")),
    readTool(
      "documents.annotate",
      "Read a document the customer shared (a contract, a bank statement or an invoice) and mark what matters: clauses; fee lines and the low balance; the payee, account, amount, due date and red-flag sentences. Every number is computed in code. Read-only.",
      "research.read",
      async (args) => {
        const text = String(args.text ?? "");
        const kind = DOCUMENT_KINDS.includes(args.kind as DocumentKind) ? (args.kind as DocumentKind) : classifyDocument(text).kind;
        return annotateDocument(text, kind, { retriever: s.rag });
      },
    ),
  );
}

function proposer(s: Services): ToolCall["requestedBy"] {
  return s.config.agentMode === "replay" ? "replay" : "model";
}

function dataOf<T>(o: RunOutcome | undefined): T | undefined {
  return o?.status === "executed" && o.result.ok ? (o.result.data as T) : undefined;
}

function evaluate(s: Services, turnId: string, draft: string, ev: TurnEvidence, kbIds: ReadonlySet<string>): string {
  const review = evaluateReply(draft, ev, kbIds);
  s.metrics?.inc(review.ok ? "agent.evaluator.pass" : "agent.evaluator.fail");
  step(s, turnId, {
    agent: "evaluator",
    step: "evaluate",
    detail: review.ok ? "grounded, honest, cited and in scope" : `${review.problems.length} problem(s) in the draft`,
    ok: review.ok,
    ...(review.ok ? {} : { problems: review.problems }),
  });
  if (review.ok) return draft;
  step(s, turnId, { agent: "evaluator", step: "repair", detail: "the draft failed review; answered from this turn's outcomes only", ok: true });
  return deterministicReply(ev);
}

function reply(s: Services, turnId: string, kind: TurnKind, text: string): void {
  s.trace.append("agent_reply", { ...replyData(s, text), kind }, turnId);
}

export function replyData(s: Services, text: string) {
  const citations = replyCitations(text).ids.flatMap((docId) => {
    const doc = s.sources?.get(docId);
    return doc ? [{ docId, title: doc.title, ...(doc.url ? { url: doc.url } : {}) }] : [];
  });
  return { text, agent: s.agent.name, ...(citations.length ? { citations } : {}) };
}

const kbOf = (findings: Finding[]) => new Set(findings.flatMap((f) => f.citations.map((c) => c.docId)));

export const REVIEW_SCOPE: Record<SpecialistId, { tools: string[]; covers: string }> = {
  savings: { tools: ["household.subscriptions", "household.savings_report"], covers: "subscriptions and the savings report" },
  guardian: { tools: ["household.messages", "household.protection"], covers: "recent forwarded messages and protection" },
  payments: { tools: ["household.accounts", "household.bills", "household.cash_flow"], covers: "balances, bills due and what is safe to move" },
  advisor: { tools: ["household.scenarios"], covers: "loans, contracts and investments (simulated scenarios)" },
};
const REVIEW_ORDER: SpecialistId[] = ["savings", "guardian", "payments", "advisor"];

export interface ReviewResult {
  turnId: string;
  reply: string;
  view: FindingsView & { turnId: string };
  nudges: Nudge[];
}

interface Latest {
  trace: Services["trace"];
  startSeq: number;
  endSeq: number;
  hour: string;
  result: ReviewResult;
}
const latest = new WeakMap<Services, Latest>();
const inflight = new WeakMap<Services, Promise<ReviewResult>>();

export async function runReviewTurn(s: Services, input: { reason: string; source?: TurnSource; nudge?: boolean }): Promise<ReviewResult> {
  ensureCoreTools(s);
  const turnId = newId("turn");
  const startSeq = s.trace.last()?.seq ?? 0;
  const trace = s.trace;
  startTurn(s, turnId, "review", input.source ?? "system", `Household review: ${input.reason}`);
  step(s, turnId, { agent: "orchestrator", step: "route", detail: `household review (${input.reason}): savings, guardian, payments, advisor in turn`, ok: true });

  const outcomes = new Map<string, RunOutcome>();
  for (const id of REVIEW_ORDER) {
    const scope = REVIEW_SCOPE[id];
    step(s, turnId, { agent: id, step: "scope", detail: `reviews ${scope.covers}; read-only, nothing else is offered or executable`, tools: scope.tools, ok: true });
    for (const tool of scope.tools) {
      const call: ToolCall = { id: newId("call"), turnId, tool, args: {}, skill: "core", activeSkills: [], requestedBy: proposer(s) };
      outcomes.set(tool, await runToolCall(call, s));
    }
  }

  const read = <T>(tool: string) => dataOf<T>(outcomes.get(tool));
  const inputs: FindingsInputs = {
    accounts: read<Row[]>("household.accounts") ?? [],
    bills: read<Row[]>("household.bills") ?? [],
    subs: read<Row[]>("household.subscriptions") ?? [],
    savings: read<SavingsReport>("household.savings_report") ?? null,
    flow: read<CashFlow | null>("household.cash_flow") ?? null,
    ...(read<FindingsInputs["scenarios"]>("household.scenarios") ? { scenarios: read<FindingsInputs["scenarios"]>("household.scenarios") } : {}),
  };
  const nudges = input.nudge ? await findNudges(s, { subs: inputs.subs, bills: inputs.bills, flow: inputs.flow ?? null }) : [];
  for (const n of nudges) s.trace.append("nudge_sent", n, turnId);
  const snapshot = s.trace.last()?.seq ?? 0;
  const view = await buildFindings(s, { turnId, inputs });

  const ev = emptyEvidence("household review", s.policy.current());
  for (const o of outcomes.values()) ev.outcomes.push(withoutCode(o));
  ev.records.push(view.findings, view.areas, nudges);
  const attention = view.areas.filter((a) => a.status !== "ok").map((a) => a.title.toLowerCase());
  const savings = inputs.savings && inputs.savings.totalMonthly > 0 ? ` Savings found: ${formatUsd(inputs.savings.totalMonthly)} a month.` : "";
  const draft =
    `FinGuard reviewed your money: ${view.findings.length} findings in ${view.areas.length} areas.` +
    (attention.length ? ` Needs a look: ${attention.join(", ")}.` : " Nothing needs your attention right now.") +
    savings +
    (input.nudge ? (nudges.length ? ` FinGuard noticed: ${nudges.map((n) => n.title).join("; ")}.` : " Nothing new to flag before it happens.") : "");
  const text = evaluate(s, turnId, draft, ev, kbOf(view.findings));
  reply(s, turnId, "review", text);

  const result: ReviewResult = { turnId, reply: text, view: { ...view, turnId }, nudges };
  const moved = s.trace.list(snapshot).some((e) => e.turnId !== turnId);
  if (s.trace === trace) latest.set(s, { trace, startSeq, endSeq: moved ? -1 : (s.trace.last()?.seq ?? 0), hour: new Date().toISOString().slice(0, 13), result });
  return result;
}

export function reviewNow(s: Services, input: { reason: string; source?: TurnSource }): Promise<ReviewResult> {
  const running = inflight.get(s);
  if (running) return running;
  const p = runReviewTurn(s, input).finally(() => {
    if (inflight.get(s) === p) inflight.delete(s);
  });
  inflight.set(s, p);
  return p;
}

const PANEL_EVENTS = new Set<string>(["receipt_issued", "inbound_shared", "scam_assessed", "policy_changed", "consent_recorded", "skill_installed", "skill_disabled"]);

export async function currentFindings(s: Services): Promise<FindingsView & { turnId: string }> {
  const last = latest.get(s);
  if (last && last.trace === s.trace && last.hour === new Date().toISOString().slice(0, 13)) {
    const head = s.trace.last()?.seq ?? 0;
    if (last.endSeq === head) return last.result.view;
    if (last.endSeq >= 0 && !s.trace.list(last.endSeq).some((e) => PANEL_EVENTS.has(e.type))) return last.result.view;
  }
  return (await reviewNow(s, { reason: last ? "new activity since the last review" : "the panel was opened" })).view;
}

export function latestReview(s: Services): ReviewResult | undefined {
  const last = latest.get(s);
  return last && last.trace === s.trace ? last.result : undefined;
}

export function startAgentCore(s: Services, o: { debounceMs?: number } = {}): () => void {
  const debounce = o.debounceMs ?? 2000;
  const fail = (err: unknown) => s.log(`review failed: ${err instanceof Error ? err.message : String(err)}`);
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe = () => {};
  const watch = () => {
    unsubscribe();
    unsubscribe = s.trace.subscribe((e) => {
      if (e.type !== "receipt_issued") return;
      const seq = e.seq;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const last = latest.get(s);
        if (last && last.trace === s.trace && last.startSeq >= seq) return;
        reviewNow(s, { reason: "a receipt was issued" }).catch(fail);
      }, debounce);
      timer.unref?.();
    });
  };
  const onReset = () => {
    watch();
    setTimeout(() => reviewNow(s, { reason: "the demo was reset" }).catch(fail), 50).unref?.();
  };
  s.events.on("reset", onReset);
  watch();
  reviewNow(s, { reason: "the server started" }).catch(fail);
  return () => {
    unsubscribe();
    clearTimeout(timer);
    s.events.off("reset", onReset);
  };
}

export function routeAction(tool: string): SpecialistId {
  if (tool.startsWith("subscriptions.")) return "savings";
  if (tool === "bank.move_own" || tool === "bank.pay_bill" || tool === "bank.transfer") return "payments";
  return "advisor"; // read-only: it holds no action tools, so its scope refuses the call
}

const ACTION_SCOPE: Record<SpecialistId, string[]> = {
  savings: SPECIALISTS.savings.manifest.tools.filter((t) => t.startsWith("subscriptions.")),
  payments: SPECIALISTS.payments.manifest.tools.filter((t) => t === "bank.move_own" || t === "bank.pay_bill" || t === "bank.transfer"),
  guardian: [],
  advisor: [],
};

export type ActionTurnResult =
  | { turnId: string; callId: string; agent: AgentRole; reply: string; outcome: RunOutcome }
  | { turnId: string; callId: string; agent: AgentRole; reply: string; refused: string };

export interface DocumentProposal {
  turnId: string;
  inboundId: string;
  text: string;
  what: string;
  fields: string[];
  hash: string;
  account?: string;
}

const proposals = new WeakMap<Services, DocumentProposal[]>();

function rememberProposal(s: Services, action: Pick<ToolCall, "tool" | "args">, p: Omit<DocumentProposal, "hash" | "account">): void {
  const hash = actionHash(action);
  const to = digits(action.args.to_account);
  const book = (proposals.get(s) ?? []).filter((x) => x.hash !== hash).slice(-19);
  book.push({ ...p, hash, ...(p.fields.includes("to_account") && to.length >= 4 ? { account: to } : {}) });
  proposals.set(s, book);
}

export function documentProposalFor(s: Services, call: Pick<ToolCall, "tool" | "args">): DocumentProposal | undefined {
  const book = proposals.get(s) ?? [];
  const hash = actionHash(call);
  const exact = book.findLast((p) => p.hash === hash);
  if (exact) return exact;
  const to = digits(call.args.to_account);
  const same = (a: string) => to.length >= 4 && (a === to || a.endsWith(to) || to.endsWith(a));
  const byAccount = book.findLast((p) => p.account !== undefined && same(p.account));
  return byAccount ? { ...byAccount, fields: ["to_account"] } : undefined;
}

function tapWords(s: Services, call: ToolCall, p: DocumentProposal): string {
  let words = s.gate.describe(call);
  for (const f of p.fields) {
    const raw = call.args[f];
    if (raw === undefined) continue;
    const shown = f === "amount" ? formatUsd(parseAmount(raw) ?? 0) : s.gate.label(String(raw));
    words = words.split(shown).join(f === "amount" ? `the amount written in the ${p.what}` : `the account written in the ${p.what}`);
  }
  const leaks = p.fields.some((f) => {
    const raw = call.args[f];
    if (raw === undefined) return false;
    if (f === "amount") {
      const n = parseAmount(raw);
      return n !== null && amountsIn(words).some((x) => Math.abs(x - n) < 0.005);
    }
    const d = digits(raw);
    return d.length >= 4 && accountNumbersIn(words).some((x) => x.endsWith(d.slice(-4)) || d.endsWith(x.slice(-4)));
  });
  return leaks ? `Tapped the action proposed from the shared ${p.what}; its values are the ${p.what}'s, not the customer's` : words;
}

export async function runActionTurn(
  s: Services,
  input: { tool: string; args: Record<string, unknown>; source?: TurnSource; turnId?: string },
  hooks: { onApprovalRequested?: (approval: ApprovalRequest) => void } = {},
): Promise<ActionTurnResult> {
  const turnId = input.turnId ?? newId("turn");
  const call: ToolCall = { id: newId("call"), turnId, tool: input.tool, args: input.args, skill: "core", activeSkills: [], requestedBy: "app" };
  await learnNamesFor(s, input.args);
  const described = s.gate.describe(call);
  startTurn(s, turnId, "action", input.source ?? "app", `Customer tapped: ${described}`);
  const proposal = documentProposalFor(s, call);
  if (proposal && !s.gate.contextTexts("inbound_message").includes(proposal.text)) s.gate.recordInbound(turnId, proposal.inboundId, proposal.text);
  if (proposal) s.gate.recordUserMessage(turnId, `tap:${call.id}`, tapWords(s, call, proposal));
  else s.gate.recordUserMessage(turnId, `tap:${call.id}`, described, Object.values(call.args).filter((v): v is string | number => typeof v === "string" || typeof v === "number"));

  const id = routeAction(input.tool);
  s.metrics?.inc(`agent.route.${id}`);
  step(s, turnId, { agent: "orchestrator", step: "route", detail: `${id} (by tool): ${input.tool}`, ok: true });
  const scope = ACTION_SCOPE[id];
  if (!scope.includes(input.tool)) {
    s.metrics?.inc("agent.scope.rejected");
    step(s, turnId, { agent: id, step: "scope", detail: `rejected ${input.tool}: not in the ${id} manifest, so it never ran`, tools: [input.tool], ok: false });
    const refused = `I cannot do that from the app: ${input.tool} is not an action FinGuard's specialists may take. Nothing was moved or changed.`;
    reply(s, turnId, "action", refused);
    return { turnId, callId: call.id, agent: id, reply: refused, refused: `${input.tool} is outside the ${id} specialist's scope, so it never reached SkillGate.` };
  }
  const fromDocument = proposal ? `; ${joinAnd(proposal.fields.map((f) => f.replace(/_/g, " ")))} came from the ${proposal.what}, not from the customer` : "";
  step(s, turnId, { agent: id, step: "scope", detail: `proposes ${input.tool} as tapped${fromDocument}; SkillGate decides`, tools: scope, ok: true });

  const outcome = await runToolCall(call, s, { onApprovalRequested: hooks.onApprovalRequested });
  const ev = emptyEvidence(described, s.policy.current());
  ev.outcomes.push(withoutCode(outcome));
  if (outcome.status === "executed" && outcome.receipt) ev.receipts.push(outcome.receipt);
  const draft = explainOutcome(outcome) ?? deterministicReply(ev);
  const text = evaluate(s, turnId, draft, ev, new Set());
  reply(s, turnId, "action", text);
  return { turnId, callId: call.id, agent: id, reply: text, outcome };
}

export interface DocumentTurnResult {
  turnId: string;
  reply: string;
  finding: Finding;
  kind: DocumentKind;
  marks: DocumentMark[];
  clauses: Clause[];
}

export const DOCUMENT_SCOPE: Record<DocumentKind, { agent: SpecialistId; tools: string[]; covers: string }> = {
  contract: { agent: "advisor", tools: ["documents.annotate", "household.subscriptions"], covers: "reads the document and the subscriptions on file; cannot move money" },
  statement: {
    agent: "payments",
    tools: ["documents.annotate", "household.accounts", "household.bills"],
    covers: "reads the statement, the balances and the bills on file; read-only here: a move it proposes runs only if the customer taps it, through SkillGate",
  },
  invoice: { agent: "guardian", tools: ["documents.annotate", "household.payees"], covers: "reads the invoice and the saved payees; cannot move money: paying it is a separate tap that SkillGate judges" },
};

const money = (n: number) => formatUsd(n);
const last4 = (account: string) => digits(account).slice(-4);

export async function runDocumentTurn(s: Services, input: { text: string; kind?: DocumentKind; source?: TurnSource; name?: string }): Promise<DocumentTurnResult> {
  ensureCoreTools(s);
  const turnId = newId("turn");
  const name = input.name?.trim().slice(0, 80);
  const kind = classifyDocument(input.text, input.kind);
  const scope = DOCUMENT_SCOPE[kind.kind];
  startTurn(s, turnId, "document", input.source ?? "desk", `Customer shared ${name ? `"${name}"` : "a document"} to review as ${documentNoun(kind.kind)} (${input.text.length} characters)`);
  const inboundId = kind.kind === "invoice" ? `invoice-${sha256(input.text).slice(0, 8)}` : undefined;
  if (inboundId) s.gate.recordInbound(turnId, inboundId, input.text);
  s.metrics?.inc(`agent.route.${scope.agent}`);
  step(s, turnId, { agent: "orchestrator", step: "route", detail: `${scope.agent} (by kind): ${kind.why} Read-only.`, ok: true });
  step(s, turnId, { agent: scope.agent, step: "scope", detail: scope.covers, tools: scope.tools, ok: true });

  const run = (tool: string, args: Record<string, unknown>) =>
    runToolCall({ id: newId("call"), turnId, tool, args, skill: "core", activeSkills: [], requestedBy: proposer(s) }, s);
  const annotated = await run("documents.annotate", { text: input.text, kind: kind.kind });
  const reads = new Map<string, RunOutcome>();
  for (const tool of scope.tools.slice(1)) reads.set(tool, await run(tool, {}));
  const ev = emptyEvidence(name ? `Review ${name}` : "Review this document", s.policy.current());
  ev.outcomes.push(withoutCode(annotated), ...[...reads.values()].map(withoutCode));

  const data = dataOf<Annotation>(annotated);
  if (!data) {
    const text = evaluate(s, turnId, explainOutcome(annotated) ?? "I could not read that document, so I stopped. Nothing was moved or changed.", ev, new Set());
    reply(s, turnId, "document", text);
    throw new Error(text);
  }
  const rowsOf = (tool: string) => dataOf<Row[]>(reads.get(tool)) ?? [];
  const base: Finding = { ...data.finding, turnId, agent: scope.agent };
  let chain: { finding: Finding; draft: string; household: boolean };
  if (kind.kind === "contract") chain = contractChain(base, data.clauses, rowsOf("household.subscriptions"), input.text);
  else if (kind.kind === "statement") {
    const plan = planMove({ accounts: rowsOf("household.accounts"), bills: rowsOf("household.bills"), policy: s.policy.current(), now: new Date() });
    chain = { finding: withMovePlan(base, plan), draft: statementReply(data, plan), household: !!plan };
  } else {
    const reading = data.invoice!;
    const check = checkPayee(reading, rowsOf("household.payees"), input.text);
    const scam = await s.scam.assessMessage(input.text, `inbound:${inboundId}`);
    s.trace.append("scam_assessed", scam, turnId);
    ev.records.push(scam);
    const finding = withPayeeCheck(base, reading, check, { fromAccount: s.policy.current().ownAccounts[0] ?? "acct-checking", scam, scamSource: `scam:${scam.id}` });
    if (finding.action && inboundId) rememberProposal(s, finding.action, { turnId, inboundId, text: input.text, what: "invoice", fields: ["to_account", "amount"] });
    chain = { finding, draft: invoiceReply(data, reading, check, scam), household: !!check.onFile };
  }
  const simulated = !!sampleFor(input.text) || (chain.household && s.config.nessieMode === "mock");
  const finding: Finding = { ...withKind(chain.finding, kind), simulated };
  ev.records.push(finding);
  const text = evaluate(s, turnId, chain.draft, ev, kbOf([finding]));
  reply(s, turnId, "document", text);
  return { turnId, reply: text, finding, kind: kind.kind, marks: data.marks, clauses: data.clauses };
}

function withKind(f: Finding, c: Classification): Finding {
  const line: Evidence = { label: c.why, origin: "calculation", trusted: true, source: "calc:documents/kind" };
  return { ...f, evidence: [...f.evidence.filter((e) => e.origin !== "reference"), line, ...f.evidence.filter((e) => e.origin === "reference")] };
}

function contractChain(base: Finding, clauses: Clause[], subs: Row[], text: string): { finding: Finding; draft: string; household: boolean } {
  let finding = base;
  const lower = text.toLowerCase();
  const sub = subs.find((x) => x.status === "active" && typeof x.merchant === "string" && x.merchant.length >= 3 && lower.includes(x.merchant.toLowerCase()));
  const renews = clauses.some((c) => c.label === "Auto-renews");
  const term = Number(text.match(/\b(\d{1,2})[- ]month\b/i)?.[1] ?? 0);
  const monthly = typeof sub?.price === "number" ? sub.price : monthlyPriceIn(text);
  const fee = clauses.find((c) => c.label === "Extra fee")?.amount ?? 0;
  let renewalCost: number | undefined;
  if (renews && term > 0 && monthly !== undefined) {
    const cost = Math.round((term * monthly + fee) * 100) / 100;
    renewalCost = cost;
    const calc: Evidence = {
      label: `If it renews: ${term} × ${money(monthly)}${fee ? ` + ${money(fee)} fee` : ""} = ${money(cost)}`,
      origin: "calculation",
      trusted: true,
      source: "calc:documents/renewal-cost",
      value: cost,
    };
    const record: Evidence[] = sub
      ? [{ label: `${String(sub.merchant)} subscription on file: ${money(Number(sub.price))} a month, renews ${String(sub.renews ?? "").slice(0, 10)}`, origin: "bank_record", trusted: true, source: `stub.subscriptions#${String(sub.id)}`, value: Number(sub.price) }]
      : [];
    finding = {
      ...finding,
      summary: `${finding.summary} If it renews, the next ${term} months cost ${money(cost)}.`,
      evidence: [...finding.evidence, ...record, calc],
    };
  }
  if (sub && renews)
    finding = { ...finding, action: { label: `Cancel ${String(sub.merchant)} before it renews`, tool: "subscriptions.cancel", args: { subscription_id: String(sub.id) } } };
  const draft =
    (clauses.length ? `I read the document and marked ${clauses.length} clause${clauses.length === 1 ? "" : "s"}: ${clauses.map((c) => c.label).join(", ")}.` : "I read the document and found no renewal, cancellation, fee, price-change or arbitration clause.") +
    (renewalCost !== undefined ? ` If it renews, the next ${term} months cost ${money(renewalCost)}.` : "") +
    (finding.action ? ` I can cancel ${String(sub!.merchant)} for you from the card; it runs only after you approve it with a code.` : "") +
    " Each highlight quotes your document. Not legal advice.";
  return { finding, draft, household: !!sub };
}

function statementReply(a: Annotation, plan: MovePlan | undefined): string {
  const r = a.statement!;
  const marked = [...feePhrases(r.fees), ...(r.low ? [r.low.overdrawn ? "the low balance before the account went negative" : "the lowest balance"] : [])];
  const parts = [a.marks.length ? `I read the statement and marked ${a.marks.length} passage${a.marks.length === 1 ? "" : "s"}: ${joinAnd(marked)}.` : "I read the statement and found no fee lines or balances to mark."];
  if (r.fees.length) parts.push(`Fees on this statement: ${money(r.feesTotal)}, which is ${money(r.feesPerYear)} a year at this rate.`);
  if (!plan) parts.push("I could not read the checking balance, so I propose no move.");
  else if (!plan.next || plan.need === undefined) parts.push(`No unpaid bill is on file for ${plan.checking.name.toLowerCase()}, so no move is needed now.`);
  else if (plan.move !== undefined)
    parts.push(
      `To keep your ${money(plan.buffer)} buffer when ${plan.next.payee} (${money(plan.next.amount)}) is due, I can move ${money(plan.move)} from ${plan.savings!.name.toLowerCase()} to ${plan.checking.name.toLowerCase()}. It runs only if you tap it, after SkillGate checks it.`,
    );
  else if (plan.need > 0) parts.push(`${plan.checking.name} is ${money(plan.need)} short of ${plan.next.payee} plus your buffer, and there is no savings account to move from.`);
  else parts.push(`${plan.checking.name} has ${money(plan.checking.balance)} today, enough for ${plan.next.payee} (${money(plan.next.amount)}) plus your ${money(plan.buffer)} buffer, so no move is needed now.`);
  parts.push("Each highlight quotes your statement.");
  return parts.join(" ");
}

function invoiceReply(a: Annotation, r: InvoiceReading, check: PayeeCheck, scam: ScamAssessment): string {
  const marked = [
    r.payee ? "the payee" : "",
    r.due ? "the due date" : "",
    r.amountDue ? "the amount due" : "",
    r.account ? "the account it asks you to pay" : "",
    r.redFlags.length ? `${r.redFlags.length} red-flag sentence${r.redFlags.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  const parts = [a.marks.length ? `I read the invoice and marked ${a.marks.length} passage${a.marks.length === 1 ? "" : "s"}: ${joinAnd(marked)}.` : "I read the invoice and found nothing to mark."];
  const amount = r.amountDue?.value ?? r.itemsTotal;
  if (r.account && check.onFile && check.differs)
    parts.push(`It asks you to pay ${amount !== undefined ? money(amount) : "it"} to an account ending ${last4(r.account.digits)}, but ${check.onFile.name}'s account on file ends in ${last4(check.onFile.account)}.`);
  else if (r.account && !check.onFile) parts.push(`It asks you to pay an account ending ${last4(r.account.digits)}, and nothing on file vouches for it.`);
  if (scam.risk !== "low") parts.push(`ScamShield rates it ${scam.risk} risk${scam.typologies[0] ? ` (${scam.typologies[0].name.toLowerCase()})` : ""}.`);
  if (r.account && (check.differs || !check.onFile))
    parts.push(`Do not pay the account in the invoice before you check it with ${check.onFile?.name ?? "the company"} on a number you already know. If you tap Pay as written, SkillGate checks it first.`);
  parts.push("Each highlight quotes your invoice.");
  return parts.join(" ");
}
