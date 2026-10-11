import assert from "node:assert/strict";
import { test } from "node:test";
import { createMockFetcher } from "../../mock-nessie/server.ts";
import { createBankAdapters } from "../bank/index.ts";
import { loadConfig } from "../config.ts";
import { personaSetup, RIDGELINE_PAYEE } from "../demo/personas.ts";
import { documentSamples, type DocumentKind, type DocumentMark } from "../documents/index.ts";
import { buildServices, type Services } from "../services.ts";
import type { ApprovalRequest, Decision, Finding, ScamAssessment, ToolCall, TraceEvent } from "../types.ts";
import { DOCUMENT_SCOPE, runActionTurn, runDocumentTurn, type ActionTurnResult, type TurnStarted } from "./core.ts";
import type { AgentStep } from "./supervisor.ts";
import { runTurn } from "./turn.ts";

const fresh = () => buildServices(loadConfig({ APPROVAL_TTL_SECONDS: "5" }), { persist: false });
const of = (s: Services, turnId: string) => s.trace.list().filter((e) => e.turnId === turnId);
const steps = (events: TraceEvent[]) => events.filter((e) => e.type === "agent_step").map((e) => e.data as AgentStep);
const sample = (kind: DocumentKind) => documentSamples().find((x) => x.kind === kind)!;
const KINDS: DocumentKind[] = ["contract", "statement", "invoice"];
const EXPECT: Record<DocumentKind, { agent: string; area: Finding["area"]; cite: string; marks: number }> = {
  contract: { agent: "advisor", area: "contracts", cite: "kb:contracts/auto-renewal", marks: 6 },
  statement: { agent: "payments", area: "everyday", cite: "kb:savings/overdraft", marks: 4 },
  invoice: { agent: "guardian", area: "protection", cite: "kb:scams/invoice-payee-swap", marks: 8 },
};

function withChecking(s: Services, balance: number): void {
  const { household } = personaSetup("maya", new Date());
  household.accounts[0]!.balance = balance;
  s.tools.register(...Object.values(createBankAdapters({ mode: "mock", baseUrl: "http://127.0.0.1:8788", fetcher: createMockFetcher(household), savedPayees: s.policy.current().savedPayees })));
}

async function tap(s: Services, action: NonNullable<Finding["action"]>, answer?: "approve" | "decline"): Promise<{ result: ActionTurnResult; approval?: ApprovalRequest }> {
  let approval: ApprovalRequest | undefined;
  const pending = runActionTurn(s, { tool: action.tool, args: action.args, source: "desk" }, {
    onApprovalRequested: (a) => {
      approval = a;
      if (answer) s.gate.answer(a.id, answer === "approve", a.code, "app");
    },
  });
  return { result: await pending, ...(approval ? { approval } : {}) };
}

const rulesOf = (d: Decision) => Object.fromEntries(d.reasons.filter((r) => r.rule !== "provenance").map((r) => [r.rule, r.verdict]));

test("document turns: every sample is one supervised turn, routed by kind to a read-only specialist", async () => {
  for (const kind of KINDS) {
    const s = fresh();
    const { text, name } = sample(kind);
    const r = await runDocumentTurn(s, { text, source: "desk", name }); // no kind: the keyword rules decide
    const want = EXPECT[kind];
    assert.equal(r.kind, kind);
    const events = of(s, r.turnId);
    const types = events.map((e) => e.type);
    assert.equal(types[0], "turn_started");
    assert.deepEqual({ kind: (events[0]!.data as TurnStarted).kind, source: (events[0]!.data as TurnStarted).source }, { kind: "document", source: "desk" });
    assert.equal(types.at(-1), "agent_reply");

    const st = steps(events);
    assert.deepEqual(st.map((x) => `${x.agent}/${x.step}/${x.ok}`), ["orchestrator/route/true", `${want.agent}/scope/true`, "evaluator/evaluate/true"], kind);
    assert.match(st[0]!.detail, new RegExp(`^${want.agent} \\(by kind\\): Read as .* by keyword rules`));
    assert.deepEqual(st[1]!.tools, DOCUMENT_SCOPE[kind].tools);

    const proposed = events.filter((e) => e.type === "tool_proposed").map((e) => e.data as ToolCall);
    assert.deepEqual(proposed.map((c) => c.tool), DOCUMENT_SCOPE[kind].tools);
    assert.ok(proposed.every((c) => s.tools.spec(c.tool)?.effect === "read"), "a document turn runs reads only");
    assert.ok(events.filter((e) => e.type === "decision").every((e) => (e.data as Decision).verdict === "allow"));
    assert.equal(events.filter((e) => e.type === "tool_executed" && (e.data as { ok: boolean }).ok).length, proposed.length);
    assert.ok(!types.includes("approval_requested") && !types.includes("receipt_issued"), "nothing is asked or executed in a document turn");
    const at = (t: TraceEvent["type"]) => types.indexOf(t);
    assert.ok(at("agent_step") < at("tool_proposed") && types.lastIndexOf("tool_executed") < types.lastIndexOf("agent_step"));

    assert.equal(types[1] === "inbound_shared", kind === "invoice", `${kind}: inbound_shared right after turn_started only for an invoice`);
    assert.equal(types.includes("scam_assessed"), kind === "invoice");

    const f = r.finding;
    assert.equal(f.turnId, r.turnId);
    assert.equal(f.agent, want.agent);
    assert.equal(f.area, want.area);
    assert.equal(f.simulated, true, "the samples are simulated");
    assert.equal(r.marks.length, want.marks, `${kind} marks`);
    assert.deepEqual(f.viz, { kind: "clauses", text, spans: r.marks.map(({ start, end, label, tone }) => ({ start, end, label, tone })) });
    assert.equal(f.citations[0]?.docId, want.cite);
    assert.match(f.citations[0]?.url ?? "", /^https:\/\/(www\.)?(consumer\.ftc\.gov|consumerfinance\.gov|fbi\.gov)\//);
    assert.ok(f.evidence.some((e) => e.source === "calc:documents/kind" && /by keyword rules/.test(e.label)), "the classification is in the evidence");
    for (const e of f.evidence) {
      if (e.origin === "document") assert.ok(!e.trusted && e.quote && text.includes(e.quote), `${kind}: document evidence is untrusted and quoted: ${e.label}`);
      if (e.origin === "bank_record" || e.origin === "policy") assert.ok(e.trusted, e.label);
      if (e.source.startsWith("calc:documents/") && e.source !== "calc:documents/kind" && e.source !== "calc:documents/payee-check") assert.ok(e.trusted && typeof e.value === "number", e.label);
    }
  }
});

test("contract chain: six clauses, the renewal cost in code, and the cancel asks for the customer's code", async () => {
  const s = fresh();
  s.policy.recordConsent("app");
  const doc = await runDocumentTurn(s, { text: sample("contract").text, kind: "contract" });
  assert.deepEqual(doc.clauses.map((c) => c.label), ["Auto-renews", "Extra fee", "Early termination fee", "How to cancel", "Price can change", "Arbitration"]);
  assert.ok(doc.finding.evidence.some((e) => e.source === "calc:documents/renewal-cost" && e.value === 408.88 && e.label === "If it renews: 12 × $29.99 + $49.00 fee = $408.88"));
  assert.deepEqual(doc.finding.action, { label: "Cancel CloudGym before it renews", tool: "subscriptions.cancel", args: { subscription_id: "sub-gym" } });

  const { result, approval } = await tap(s, doc.finding.action!, "approve");
  assert.ok("outcome" in result);
  assert.equal(result.agent, "savings");
  assert.equal(result.outcome.decision.verdict, "ask");
  assert.match(approval?.code ?? "", /^\d{4}$/, "a 4-digit code bound to this exact cancel");
  assert.equal(result.outcome.status, "executed");
  assert.equal(result.outcome.status === "executed" && result.outcome.receipt?.authorizedBy.kind, "approval");
});

test("statement chain: the move is sized from trusted records only; SkillGate allows it within limits, asks above them", async () => {
  const healthy = fresh();
  const calm = await runDocumentTurn(healthy, { text: sample("statement").text });
  assert.equal(calm.finding.action, undefined);
  assert.match(calm.finding.summary, /Today checking has \$4,210\.55, enough for Duke Energy \(\$84\.20, due \w{3} \d{1,2}\) plus your \$500\.00 buffer, so no move is needed now\./);
  assert.ok(calm.finding.evidence.some((e) => e.source === "calc:documents/statement-move" && e.value === 3626.35 && /balance \$4,210\.55 − bill \$84\.20 − buffer \$500\.00 = \$3,626\.35 to spare/.test(e.label)));
  assert.match(calm.reply, /no move is needed now/);

  const s = fresh();
  s.policy.recordConsent("app");
  withChecking(s, 312.4);
  const doc = await runDocumentTurn(s, { text: sample("statement").text, kind: "statement" });
  const move = doc.finding.evidence.find((e) => e.source === "calc:documents/statement-move")!;
  assert.equal(move.label, "Move before Duke Energy is due: bill $84.20 − balance $312.40 + buffer $500.00 = move $271.80");
  assert.equal(move.value, 271.8);
  assert.equal(doc.finding.evidence.findIndex((e) => e.origin === "calculation"), doc.finding.evidence.indexOf(move), "the move is the chain's calculation");
  for (const [source, value] of [["nessie.accounts#acct-checking", 312.4], ["nessie.bills#bill-duke-oct", 84.2], ["policy:cashFlowBuffer", 500]] as const)
    assert.ok(doc.finding.evidence.some((e) => e.source === source && e.value === value && e.trusted), source);
  assert.ok(!doc.finding.viz || doc.finding.viz.kind !== "clauses" || !doc.finding.viz.text.includes("271.80"), "the amount is not in the document");
  assert.deepEqual(doc.finding.action, { label: "Move $271.80 from savings before Duke Energy is due", tool: "bank.move_own", args: { from_account: "acct-savings", to_account: "acct-checking", amount: 271.8 } });

  const { result, approval } = await tap(s, doc.finding.action!);
  assert.ok("outcome" in result);
  assert.equal(result.agent, "payments");
  assert.equal(approval, undefined);
  assert.equal(result.outcome.decision.verdict, "allow");
  assert.deepEqual(rulesOf(result.outcome.decision), { consent: "allow", capability: "allow", limit: "allow", daily_limit: "allow", cash_flow: "allow" });
  assert.ok(result.outcome.decision.provenance.every((p) => p.status === "trusted"));
  assert.equal(result.outcome.status, "executed");
  assert.deepEqual(result.outcome.status === "executed" && result.outcome.receipt?.authorizedBy, { kind: "standing_instruction", policyVersion: 1 });

  const short = fresh();
  short.policy.recordConsent("app");
  withChecking(short, 40);
  const big = await runDocumentTurn(short, { text: sample("statement").text, kind: "statement" });
  assert.equal(big.finding.action?.args.amount, 544.2);
  const asked = await tap(short, big.finding.action!, "decline");
  assert.ok("outcome" in asked.result);
  assert.equal(asked.result.outcome.decision.verdict, "ask");
  assert.equal(rulesOf(asked.result.outcome.decision).limit, "ask");
  assert.match(asked.approval?.code ?? "", /^\d{4}$/);
  assert.equal(asked.result.outcome.status, "not_approved");
});

test("invoice chain: paying the account written in the invoice is denied on provenance and by ScamShield", async () => {
  const s = fresh();
  s.policy.recordConsent("app");
  const { text } = sample("invoice");
  const doc = await runDocumentTurn(s, { text });
  const payee = s.policy.current().savedPayees.find((p) => p.id === RIDGELINE_PAYEE.id);
  assert.equal(payee?.account, "6038", "the contractor is a saved payee with a different account");
  assert.equal(doc.finding.tone, "block");
  assert.ok(doc.finding.evidence.some((e) => e.source === "nessie.payees#ridgeline" && e.trusted && /account ending 6038/.test(e.label)));
  assert.ok(doc.finding.evidence.some((e) => e.source === "calc:documents/payee-check" && /ending 8826\) is not Ridgeline Plumbing & Heating's account on file \(ending 6038\)/.test(e.label)));
  assert.ok(doc.finding.evidence.some((e) => e.source === "calc:documents/invoice-total" && e.value === 865 && e.label === "Invoice total: labor $640.00 + parts $225.00 = $865.00"));
  const check = of(s, doc.turnId).find((e) => e.type === "scam_assessed")!.data as ScamAssessment;
  assert.equal(check.risk, "high");
  assert.deepEqual(check.typologies.map((t) => t.citation.docId), ["kb:scams/invoice-payee-swap"]);
  assert.deepEqual(doc.finding.action, {
    label: "Pay as the invoice asks: $865.00 to the account ending 8826",
    tool: "bank.transfer",
    args: { from_account: "acct-checking", to_account: "731900418826", amount: 865, payee_name: "Ridgeline Plumbing & Heating" },
  });
  assert.match(doc.reply, /ScamShield rates it high risk \(invoice with changed payment details\)/);

  const deniedTap = async (svc: Services) => {
    const { result, approval } = await tap(svc, doc.finding.action!, "approve");
    assert.ok("outcome" in result);
    assert.equal(result.agent, "payments");
    assert.equal(approval, undefined, "no code is ever asked for");
    assert.equal(result.outcome.status, "denied");
    const d = result.outcome.decision;
    assert.equal(d.verdict, "deny");
    const provenance = d.reasons.filter((r) => r.rule === "provenance");
    assert.ok(provenance.some((r) => r.verdict === "deny" && /^Account 731900418826 appears only in a forwarded message, never in your own words or your bank's records\.$/.test(r.message)), JSON.stringify(provenance));
    assert.ok(provenance.some((r) => r.verdict === "deny" && /^The amount \$865\.00 appears only in/.test(r.message)));
    assert.ok(d.provenance.some((p) => p.field === "to_account" && p.origins.some((o) => /^inbound:invoice-[0-9a-f]{8}$/.test(o.source))), "the invoice stays the recorded source");
    assert.deepEqual(d.provenance.filter((p) => p.field !== "from_account").map((p) => [p.field, p.status]), [["to_account", "untrusted_only"], ["amount", "untrusted_only"]]);
    assert.ok(d.reasons.some((r) => r.rule === "scam" && r.verdict === "deny" && /changed payment details/.test(r.message)));
    assert.deepEqual(d.scam?.typologies.map((t) => [t.name, t.citation.docId]), [["Invoice with changed payment details", "kb:scams/invoice-payee-swap"]]);
    assert.ok(d.scam?.redFlags.some((f) => f.signal === "payee_changed" && /Ridgeline Plumbing & Heating, whose account on file ends in 6038/.test(f.evidence)));
    const events = of(svc, result.turnId);
    assert.ok(!events.some((e) => e.type === "tool_executed" || e.type === "receipt_issued" || e.type === "approval_requested"), "the chain stops at Permission");
    const tapped = events.find((e) => e.type === "user_message")!.data as { messageId: string; text: string };
    assert.equal(tapped.text, "Send the amount written in the invoice from Checking to the account written in the invoice");
    assert.ok(steps(events).some((x) => x.agent === "payments" && x.step === "scope" && /to account and amount came from the invoice/.test(x.detail)));
    assert.ok(steps(events).some((x) => x.agent === "evaluator" && x.ok));
    assert.match(result.reply, /^I did not do it\. ScamShield rates this high risk/);
    assert.doesNotMatch(result.reply, /\b(sent|paid|done)\b/i);
    return events;
  };
  const first = await deniedTap(s);
  assert.ok(!first.some((e) => e.type === "inbound_shared"), "the invoice is still in SkillGate's context");

  const edited = await tap(s, { ...doc.finding.action!, args: { ...doc.finding.action!.args, amount: 800 } });
  assert.ok("outcome" in edited.result);
  assert.equal(edited.result.outcome.status, "denied");
  assert.deepEqual(edited.result.outcome.decision.provenance.map((p) => [p.field, p.status]), [["from_account", "trusted"], ["to_account", "untrusted_only"], ["amount", "trusted"]]);
  assert.ok(edited.result.outcome.decision.reasons.some((r) => r.rule === "scam" && r.verdict === "deny"));

  for (let i = 0; i < 6; i++) await runTurn(s, { text: "What can FinGuard do?" });
  assert.ok(!s.gate.contextTexts("inbound_message").includes(text));
  const later = await deniedTap(s);
  assert.ok(later.some((e) => e.type === "inbound_shared"));
});

function assertGrounded(f: Finding, marks: DocumentMark[], text: string): void {
  const nums = (t: string) => [...t.matchAll(/\$?\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,$/, ""));
  const cents = (n: number) => Math.round(n * 100);
  const values = new Set([...f.evidence.map((e) => e.value), f.metric?.value].filter((v): v is number => typeof v === "number").map(cents));
  const written = new Set(nums(f.evidence.map((e) => `${e.label} ${e.quote ?? ""}`).join(" | ")).map((n) => cents(Number(n.replace(/[$,]/g, "")))));
  const byKind = new Map<string, number>();
  for (const m of marks) byKind.set(m.label.split(":")[0]!, (byKind.get(m.label.split(":")[0]!) ?? 0) + 1);
  const counts = new Set([marks.length, ...byKind.values()].map(cents));
  for (const raw of nums(`${f.title} ${f.summary}`)) {
    const n = cents(Number(raw.replace(/[$,]/g, "")));
    if (raw.startsWith("$")) assert.ok(values.has(n), `${raw} must be an evidence value: ${f.summary}`);
    else assert.ok(written.has(n) || counts.has(n), `${raw} must appear in the evidence or count the marks: ${f.title} / ${f.summary}`);
  }
  for (const e of f.evidence) if (e.quote) assert.ok(text.includes(e.quote), `quote not verbatim: ${e.quote}`);
  for (const m of marks) assert.equal(text.slice(m.start, m.end), m.quote);
}

test("every number in each card comes from code and every quote is verbatim, for all three samples", async () => {
  for (const kind of KINDS) {
    const s = fresh();
    const { text } = sample(kind);
    const r = await runDocumentTurn(s, { text });
    assertGrounded(r.finding, r.marks, text);
  }
  const s = fresh();
  withChecking(s, 312.4);
  const r = await runDocumentTurn(s, { text: sample("statement").text });
  assert.ok(r.finding.action);
  assertGrounded(r.finding, r.marks, sample("statement").text);
});

test("HTTP: /api/documents/samples, /api/documents/review (with and without kind) and the /api/contracts/review alias", async () => {
  const http = await import("node:http");
  const { createApp } = await import("../gateway/app.ts");
  const s = fresh();
  const server = http.createServer(createApp(s));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const call = async (method: string, url: string, body?: unknown, role = "customer") => {
    const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json", "X-Demo-Role": role }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  try {
    const samples = await call("GET", "/api/documents/samples", undefined, "operator");
    assert.equal(samples.status, 200);
    assert.ok(Array.isArray(samples.body));
    assert.deepEqual(samples.body.map((x: { id: string; kind: string; fictional: boolean }) => [x.id, x.kind, x.fictional]), [
      ["cloudgym-contract", "contract", true],
      ["october-statement", "statement", true],
      ["ridgeline-invoice", "invoice", true],
    ]);
    assert.ok(samples.body.every((x: { name: string; text: string }) => x.name && x.text));

    for (const x of samples.body as { kind: DocumentKind; text: string; name: string }[]) {
      const res = await call("POST", "/api/documents/review", { text: x.text, name: x.name });
      assert.equal(res.status, 200, x.kind);
      assert.deepEqual(Object.keys(res.body).sort(), ["finding", "kind", "marks", "reply", "turnId"]);
      assert.equal(res.body.kind, x.kind, "classified by keyword rules");
      assert.equal(res.body.finding.turnId, res.body.turnId);
      assert.equal(res.body.marks.length, EXPECT[x.kind].marks);
      assert.equal(res.body.finding.agent, EXPECT[x.kind].agent);
    }
    const given = await call("POST", "/api/documents/review", { text: samples.body[2].text, kind: "invoice", source: "app" });
    assert.equal(given.body.kind, "invoice");
    const started = s.trace.list().find((e) => e.turnId === given.body.turnId && e.type === "turn_started")!.data as TurnStarted;
    assert.equal(started.source, "app");
    assert.equal((await call("POST", "/api/documents/review", { text: "hello", kind: "receipt" })).status, 400);
    assert.equal((await call("POST", "/api/documents/review", { text: "   " })).status, 400);
    assert.equal((await call("POST", "/api/documents/review", { text: "x".repeat(20_001) })).status, 400);

    const alias = await call("POST", "/api/contracts/review", { text: samples.body[0].text, name: "CloudGym" });
    assert.equal(alias.status, 200);
    assert.deepEqual(Object.keys(alias.body).sort(), ["clauses", "finding", "reply", "turnId"]);
    assert.equal(alias.body.clauses.length, 6);
    assert.equal(alias.body.finding.agent, "advisor");
    const forced = await call("POST", "/api/contracts/review", { text: samples.body[2].text });
    assert.equal(forced.body.finding.area, "contracts", "the alias always reads a contract");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
