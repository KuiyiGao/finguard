import { performance } from "node:perf_hooks";
import type { TraceLog } from "../audit/trace.ts";
import { BANK_TOOLS } from "../tools/specs.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type {
  ApprovalChannel,
  ApprovalRequest,
  AuthorizationReceipt,
  CapabilityGrant,
  Decision,
  DelegationPolicy,
  FieldProvenance,
  OriginKind,
  Reason,
  RuleId,
  ScamShield,
  SkillGate,
  SkillRecord,
  ToolCall,
  ToolResult,
  ToolSpec,
  Verdict,
} from "../types.ts";
import { RULE_ORDER, signalText } from "../findings/normalize.ts";
import { accountNumbersIn, amountsIn, approvalCode, canonicalJson, digits, formatUsd, newId, parseAmount, sha256 } from "../util.ts";
import { ApprovalBook, type AnswerResult } from "./approvals.ts";
import type { CashFlowSource } from "./cashflow.ts";
import { ProvenanceLedger, type Sighting } from "./provenance.ts";
import { CAPABILITY_PHRASE, type PolicyStore } from "./store.ts";

export interface ExtensionLookup {
  record(name: string): SkillRecord | undefined;
  currentHash(name: string): string | undefined;
}

export type SecondOpinion = (call: ToolCall, decision: Decision) => Promise<NonNullable<Decision["llm"]>>;

export interface GateOptions {
  policy: PolicyStore;
  trace: TraceLog;
  tools: ToolRegistry;
  approvalTtlSeconds: number;
  channels?: ApprovalChannel[];
  scam?: ScamShield;
  extensions?: ExtensionLookup;
  secondOpinion?: SecondOpinion;
  cashFlow?: CashFlowSource;
  contextTurns?: number;
  now?: () => Date;
}

export class GateError extends Error {}

const RANK: Record<Verdict, number> = { allow: 0, ask: 1, deny: 2 };
const APPROVAL_RANK: Record<CapabilityGrant["approval"], number> = { never: 0, over_limit: 1, always: 2 };

const UNTRUSTED_PLACE: Partial<Record<OriginKind, string>> = {
  inbound_message: "a forwarded message",
  tool_text: "free text from a bank record (a memo, description or invoice)",
  skill_text: "an extension's instructions",
  kb: "the knowledge base",
};

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

const CHECKED: Partial<Record<Reason["rule"], (r: Reason) => string>> = {
  scam: () => "no scam signals",
  provenance: () => "values from you or your bank",
  daily_limit: () => "within today's limit",
  limit: () => "within your limit",
  cash_flow: (r) => `${r.message.match(/^\$[\d,.]+/)?.[0] ?? "enough"} left after bills`,
};

export function passedChecks(reasons: Reason[]): string[] {
  return reasons
    .filter((r) => r.verdict === "allow" && CHECKED[r.rule])
    .sort((a, b) => RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule))
    .map((r) => CHECKED[r.rule]!(r));
}

export function strictest(verdicts: Verdict[]): Verdict {
  return verdicts.reduce<Verdict>((worst, v) => (RANK[v] > RANK[worst] ? v : worst), "allow");
}

export function actionHash(call: Pick<ToolCall, "tool" | "args">): string {
  return sha256(canonicalJson({ tool: call.tool, args: call.args }));
}

function tighter(a: CapabilityGrant, b: CapabilityGrant): CapabilityGrant {
  const limits = [a.maxAmount, b.maxAmount].filter((n): n is number => n !== undefined);
  return {
    capability: a.capability,
    maxAmount: limits.length ? Math.min(...limits) : undefined,
    approval: APPROVAL_RANK[a.approval] >= APPROVAL_RANK[b.approval] ? a.approval : b.approval,
  };
}

const reason = (rule: RuleId, verdict: Verdict, message: string): Reason => ({ rule, verdict, message });
const round2 = (n: number) => Math.round(n * 100) / 100;
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

interface Reviewed {
  actionHash: string;
  policyVersion: number;
  verdict: Verdict;
}

export class Gate implements SkillGate {
  private readonly ledger: ProvenanceLedger;
  private readonly approvals: ApprovalBook;
  private readonly reviewed = new Map<string, Reviewed>();
  private readonly approvalTurns = new Map<string, string>();
  private readonly issued: AuthorizationReceipt[] = [];
  private readonly now: () => Date;
  private readonly names = new Map<string, string>();

  constructor(private readonly o: GateOptions) {
    this.now = o.now ?? (() => new Date());
    this.ledger = new ProvenanceLedger(o.contextTurns ?? 5);
    this.approvals = new ApprovalBook((request, via) => {
      o.trace.append("approval_resolved", { approvalId: request.id, callId: request.callId, status: request.status, via }, this.approvalTurns.get(request.id));
      for (const channel of this.o.channels ?? []) channel.withdraw?.(request.id);
    });
    for (const e of o.trace.list()) if (e.type === "receipt_issued") this.issued.push(e.data as AuthorizationReceipt);
  }

  recordUserMessage(turnId: string, messageId: string, text: string, values: (string | number)[] = []): void {
    this.ledger.addText(turnId, "user", `message:${messageId}`, text);
    for (const v of values) this.ledger.addValue(turnId, "user", `message:${messageId}`, v);
    this.o.trace.append("user_message", { messageId, text }, turnId);
  }

  recordInbound(turnId: string, inboundId: string, text: string): void {
    this.ledger.addText(turnId, "inbound_message", `inbound:${inboundId}`, text);
    this.o.trace.append("inbound_shared", { inboundId, text }, turnId);
  }

  recordSkillLoaded(turnId: string, skill: string): void {
    this.ledger.addText(turnId, "skill_text", `skill:${skill}`, "");
    this.o.trace.append("skill_loaded", { skill }, turnId);
  }

  recordToolResult(turnId: string, _tool: string, result: ToolResult): void {
    for (const v of result.systemValues) {
      this.ledger.addValue(turnId, "system", v.source, v.value);
      const named = v.source.match(/#([^.#]+)\.(merchant|name|nickname|payee)$/);
      if (named) this.names.set(named[1]!, String(v.value));
    }
    for (const t of result.texts) this.ledger.addText(turnId, "tool_text", t.source, t.text);
    if (Array.isArray(result.data))
      for (const row of result.data as Record<string, unknown>[]) {
        const key = row && (["payee", "name", "merchant", "nickname"] as const).find((k) => typeof row[k] === "string" && row[k]);
        if (key && typeof row.id === "string" && !this.names.has(row.id)) this.names.set(row.id, String(row[key]));
      }
  }

  learnNames(values: ToolResult["systemValues"]): void {
    for (const v of values) {
      const named = v.source.match(/#([^.#]+)\.(merchant|name|nickname|payee)$/);
      if (named) this.names.set(named[1]!, String(v.value));
    }
  }

  knowsName(id: string): boolean {
    return this.names.has(id);
  }

  contextTexts(kind: OriginKind): string[] {
    return this.ledger.texts(kind);
  }

  resetContext(): void {
    this.ledger.reset();
  }

  async check(call: ToolCall): Promise<Decision> {
    const started = performance.now();
    this.o.trace.append("tool_proposed", call, call.turnId);
    const spec = this.o.tools.spec(call.tool);
    const policy = this.o.policy.current();
    let reasons: Reason[];
    let provenance: FieldProvenance[] = [];
    if (!spec) reasons = [reason("capability", "deny", `FinGuard has no tool named ${call.tool}.`)];
    else if (spec.effect === "read") reasons = this.grantFor(call, spec, policy).reasons;
    else ({ reasons, provenance } = this.moneyRules(call, spec, policy));

    const decision: Decision = { callId: call.id, verdict: strictest(reasons.map((r) => r.verdict)), reasons, provenance, latencyMs: 0 };

    if (spec?.effect === "move_money" && this.o.cashFlow) {
      const flow = await this.cashFlowRule(call, policy);
      if (flow) reasons.push(flow);
    }

    if (spec?.effect === "move_money" && spec.capability !== "transfers.own" && this.o.scam) {
      const inbound = this.ledger.recent().filter((s) => s.origin.kind === "inbound_message" && s.text && ((s.turnId === call.turnId && call.tool === "bank.transfer") || this.relatesTo(call, s.text)));
      const scam = await this.o.scam.assessTransfer(call, { inbound: [...new Set(inbound.map((s) => s.text!))] });
      this.o.trace.append("scam_assessed", scam, call.turnId);
      decision.scam = scam;
      const verdict: Verdict = scam.risk === "high" ? "deny" : scam.risk === "medium" ? "ask" : "allow";
      const flags = scam.redFlags.map((f) => lowerFirst(signalText(f.signal).label)).join(", ");
      reasons.push(reason("scam", verdict, verdict === "allow" ? "ScamShield found no strong scam signals." : `ScamShield rates this ${scam.risk} risk (${flags}).`));
    }

    const before = strictest(reasons.map((r) => r.verdict));
    if (spec?.effect === "move_money" && this.o.secondOpinion && before !== "deny") {
      try {
        decision.llm = await this.o.secondOpinion(call, { ...decision, verdict: before });
        if (RANK[decision.llm.verdict] > RANK[before]) reasons.push(reason("llm", decision.llm.verdict, `A second review asked for more caution: ${decision.llm.rationale}`));
      } catch {
      }
    }

    decision.verdict = strictest(reasons.map((r) => r.verdict));
    decision.latencyMs = Math.round((performance.now() - started) * 10) / 10;
    this.reviewed.set(call.id, { actionHash: actionHash(call), policyVersion: policy.version, verdict: decision.verdict });
    this.o.trace.append("decision", decision, call.turnId);
    return decision;
  }

  private grantFor(call: ToolCall, spec: ToolSpec, policy: DelegationPolicy): { grant?: CapabilityGrant; reasons: Reason[] } {
    const phrase = CAPABILITY_PHRASE[spec.capability];
    const userGrant = policy.grants.find((g) => g.capability === spec.capability);
    if (!userGrant) return { reasons: [reason("capability", "deny", `Your policy does not let FinGuard ${phrase}.`)] };
    if (call.skill !== "core") {
      const record = this.o.extensions?.record(call.skill);
      if (!record || record.status !== "approved")
        return { reasons: [reason("capability", "deny", `Extension ${call.skill} is not approved to act for you.`)] };
      if (this.o.extensions?.currentHash(call.skill) !== record.sha256)
        return { reasons: [reason("hash", "deny", `Extension ${call.skill} changed since you approved it, so it cannot act until you review it again.`)] };
      const manifestGrant = record.manifest.capabilities.find((g) => g.capability === spec.capability);
      if (!manifestGrant) return { reasons: [reason("capability", "deny", `Extension ${call.skill} never asked for permission to ${phrase}.`)] };
      return { grant: tighter(userGrant, manifestGrant), reasons: [reason("capability", "allow", `Extension ${call.skill} is approved to ${phrase}.`)] };
    }
    return spec.effect === "read" ? { grant: userGrant, reasons: [reason("capability", "allow", `Policy v${policy.version} lets FinGuard ${phrase}.`)] } : { grant: userGrant, reasons: [] };
  }

  private vouchesFor(call: ToolCall, field: string, s: Sighting): boolean {
    if (s.origin.kind !== "system" || !(field === "amount" || field.endsWith("_amount"))) return true;
    const bill = call.tool === "bank.pay_bill" ? String(call.args.bill_id ?? "") : "";
    return bill !== "" && s.origin.source.includes(`#${bill}.`);
  }

  private relatesTo(call: ToolCall, text: string): boolean {
    const to = digits(String(call.args.to_account ?? ""));
    if (to.length >= 4 && accountNumbersIn(text).some((n) => n.endsWith(to.slice(-4)) || to.endsWith(n.slice(-4)))) return true;
    const amount = parseAmount(call.args.amount);
    return call.tool !== "bank.pay_bill" && amount !== null && amountsIn(text).some((n) => Math.abs(n - amount) < 0.005);
  }

  private moneyRules(call: ToolCall, spec: ToolSpec, policy: DelegationPolicy): { reasons: Reason[]; provenance: FieldProvenance[] } {
    const reasons: Reason[] = [];
    const consent = this.o.policy.consent();
    reasons.push(
      consent
        ? reason("consent", "allow", `Your consent to policy v${policy.version} is on file (${consent.id}).`)
        : reason("consent", "deny", `You have not agreed to policy v${policy.version} yet, so FinGuard cannot move money.`),
    );
    if (policy.paused) reasons.push(reason("paused", "deny", "Money movement is paused; resume it in FinGuard's settings first."));

    const missing = ((spec.inputSchema.required as string[] | undefined) ?? []).filter((f) => call.args[f] === undefined || call.args[f] === "");
    if (missing.length) reasons.push(reason("capability", "deny", `The request is missing ${missing.join(", ")}.`));

    const amount = parseAmount(call.args.amount);
    const { grant, reasons: grantReasons } = this.grantFor(call, spec, policy);
    reasons.push(...grantReasons);
    if (grant) {
      reasons.push(this.approvalSetting(grant, policy));
      reasons.push(...this.accountRules(call, spec, policy));
      if (spec.effect === "move_money") reasons.push(this.limitRule(grant, amount));
    }

    const extra = this.policySightings(policy);
    const provenance = (spec.moneyFields ?? [])
      .filter((f) => call.args[f] !== undefined && call.args[f] !== "")
      .map((f) => this.ledger.trace(f, call.args[f], extra, (s) => this.vouchesFor(call, f, s)));
    reasons.push(...this.provenanceRules(provenance));

    if (spec.effect === "move_money" && amount !== null && amount > 0) reasons.push(this.dailyRule(amount, policy));
    if (spec.capability === "transfers.external") reasons.push(this.coolingOffRule(call, policy));

    const extensions = this.activeExtensions(call);
    if (extensions.length)
      reasons.push(reason("context", "ask", `Extension ${extensions.join(", ")} was active in this conversation, so moving money needs your approval.`));
    return { reasons, provenance };
  }

  private approvalSetting(grant: CapabilityGrant, policy: DelegationPolicy): Reason {
    const phrase = CAPABILITY_PHRASE[grant.capability];
    if (grant.approval === "never") return reason("capability", "allow", `Your settings let FinGuard ${phrase} without asking.`);
    if (grant.approval === "always") return reason("capability", "ask", `Your settings let FinGuard ${phrase} only with your approval each time.`);
    return reason("capability", "allow", `Your settings let FinGuard ${phrase} without asking up to ${formatUsd(grant.maxAmount ?? 0)}.`);
  }

  private accountRules(call: ToolCall, spec: ToolSpec, policy: DelegationPolicy): Reason[] {
    const out: Reason[] = [];
    const { from_account: from, to_account: to } = call.args;
    if (from !== undefined && !policy.ownAccounts.includes(String(from)))
      out.push(reason("capability", "deny", `FinGuard only moves money out of your own accounts, and ${this.label(String(from), policy)} is not one of them.`));
    if (spec.capability === "transfers.own" && to !== undefined && !policy.ownAccounts.includes(String(to)))
      out.push(reason("capability", "deny", sentence(`${this.label(String(to), policy)} is not one of your accounts; paying someone else is a transfer.`)));
    if (from !== undefined && from === to) out.push(reason("capability", "deny", "The source and destination are the same account."));
    return out;
  }

  private limitRule(grant: CapabilityGrant, amount: number | null): Reason {
    if (amount === null || amount <= 0) return reason("limit", "deny", "The amount must be a positive number of dollars.");
    if (grant.maxAmount === undefined) return reason("limit", "allow", `${formatUsd(amount)} has no per-action limit under your policy.`);
    const max = formatUsd(grant.maxAmount);
    if (amount <= grant.maxAmount) return reason("limit", "allow", `${formatUsd(amount)} is within your ${max} limit per action.`);
    if (grant.approval === "over_limit") return reason("limit", "ask", `${formatUsd(amount)} is above your ${max} no-ask limit, so it needs your approval.`);
    return reason("limit", "deny", `${formatUsd(amount)} is above your ${max} limit per action.`);
  }

  private provenanceRules(provenance: FieldProvenance[]): Reason[] {
    const out: Reason[] = [];
    for (const p of provenance) {
      const what = p.field === "amount" ? `The amount ${formatUsd(parseAmount(p.value) ?? 0)}` : p.field.includes("account") ? `Account ${p.value}` : `The ${p.field.replace(/_/g, " ")} ${p.value}`;
      if (p.status === "untrusted_only") {
        const places = [...new Set(p.origins.map((o) => UNTRUSTED_PLACE[o.kind] ?? o.kind))].join(" and "); // the source ids stay in decision.provenance
        out.push(reason("provenance", "deny", `${what} appears only in ${places}, never in your own words or your bank's records.`));
      } else if (p.status === "not_found") {
        out.push(reason("provenance", "ask", `FinGuard cannot find where ${what.charAt(0).toLowerCase() + what.slice(1)} came from, so you need to confirm it.`));
      }
    }
    if (out.length === 0 && provenance.length) out.push(reason("provenance", "allow", "Every account and amount came from you or your bank's records."));
    return out;
  }

  private dailyRule(amount: number, policy: DelegationPolicy): Reason {
    const total = round2(this.spentToday() + amount);
    const limit = formatUsd(policy.dailyLimit);
    return total > policy.dailyLimit
      ? reason("daily_limit", "deny", `This would bring today's total to ${formatUsd(total)}, above your ${limit} daily limit.`)
      : reason("daily_limit", "allow", `Today's total would be ${formatUsd(total)} of your ${limit} daily limit.`);
  }

  private coolingOffRule(call: ToolCall, policy: DelegationPolicy): Reason {
    const dest = String(call.args.to_account ?? "");
    const payee = this.findPayee(dest, policy);
    if (!payee) return reason("cooling_off", "ask", sentence(`${this.label(dest, policy)} is not one of your saved payees, so a first payment needs your approval.`));
    const minutes = (this.now().getTime() - Date.parse(payee.addedAt)) / 60000;
    if (minutes < policy.newPayeeCoolingOffMinutes) {
      const hours = Math.round(policy.newPayeeCoolingOffMinutes / 60);
      return reason("cooling_off", "ask", `${payee.name} was added ${Math.max(1, Math.round(minutes))} minutes ago; payments in the first ${hours} hours need your approval.`);
    }
    return reason("cooling_off", "allow", `${payee.name} has been a saved payee since ${payee.addedAt.slice(0, 10)}.`);
  }

  private async cashFlowRule(call: ToolCall, policy: DelegationPolicy): Promise<Reason | null> {
    const from = String(call.args.from_account ?? "");
    const amount = parseAmount(call.args.amount);
    if (!from || amount === null || amount <= 0 || !policy.ownAccounts.includes(from)) return null;
    const flow = await this.o.cashFlow!(from).catch(() => null);
    if (!flow) return null;
    const upcoming = flow.upcoming.filter((b) => b.source !== call.args.bill_id);
    const owed = round2(upcoming.reduce((sum, b) => sum + b.amount, 0));
    const left = round2(flow.balance - amount);
    const name = this.label(from, policy);
    if (left < 0) return reason("cash_flow", "deny", `${name} has ${formatUsd(flow.balance)}, less than ${formatUsd(amount)}.`);
    const needed = round2(owed + flow.buffer);
    const bills = upcoming.length ? ` (${upcoming.map((b) => `${b.label} ${formatUsd(b.amount)}`).join(", ")})` : "";
    if (left < needed)
      return reason("cash_flow", "ask", `This would leave ${formatUsd(left)} in ${name}, short of the ${formatUsd(owed)} due in the next ${flow.horizonDays} days${bills} plus your ${formatUsd(flow.buffer)} buffer.`);
    return reason("cash_flow", "allow", `${formatUsd(left)} stays in ${name}, enough for ${formatUsd(owed)} of bills due in the next ${flow.horizonDays} days plus your ${formatUsd(flow.buffer)} buffer.`);
  }

  private activeExtensions(call: ToolCall): string[] {
    const fromLedger = this.ledger
      .recent()
      .filter((s) => s.origin.kind === "skill_text")
      .map((s) => s.origin.source.replace(/^skill:/, ""));
    return [...new Set([...call.activeSkills, ...fromLedger, call.skill])].filter((s) => s && s !== "core");
  }

  private policySightings(policy: DelegationPolicy): Sighting[] {
    const seen = (source: string, value: string, kinds: Sighting["kinds"]): Sighting => ({ turnId: "", origin: { kind: "system", source, trusted: true }, value, kinds });
    return [
      ...policy.ownAccounts.map((id) => seen("policy:own-accounts", id, ["account"])),
      ...policy.savedPayees.flatMap((p) => [
        seen(`policy:payee:${p.id}`, p.id, ["account", "id"]),
        seen(`policy:payee:${p.id}`, p.account, ["account"]),
        seen(`policy:payee:${p.id}`, p.name, ["text"]),
      ]),
    ];
  }

  private findPayee(value: string, policy: DelegationPolicy) {
    const want = digits(value);
    return policy.savedPayees.find((p) => p.id === value || (want.length >= 4 && (digits(p.account) === want || (digits(p.account).length >= 4 && want.endsWith(digits(p.account))))));
  }

  label(value: string, policy = this.o.policy.current()): string {
    if (policy.ownAccounts.includes(value)) {
      const name = value.replace(/^acct-/, "").replace(/[-_]/g, " ");
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
    const payee = this.findPayee(value, policy);
    if (payee) return `${payee.name} (...${digits(payee.account).slice(-4)})`;
    const named = this.names.get(value);
    if (named) return /^bill-|-bill$/.test(value) ? `${named} bill` : named;
    if (value.startsWith("bill-")) return `bill ${value}`;
    if (/^sub-[a-z]/.test(value)) return value.replace(/^sub-/, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return digits(value).length >= 4 ? `account ${value}` : value;
  }

  describe(call: Pick<ToolCall, "tool" | "args">, provenance: FieldProvenance[] = [], quote = false): string {
    const show = (field: string) => {
      const raw = call.args[field];
      const text = field === "amount" ? formatUsd(parseAmount(raw) ?? 0) : this.label(String(raw ?? ""));
      const p = provenance.find((f) => f.field === field);
      return quote && p && p.status !== "trusted" ? `"${text}"` : text;
    };
    switch (call.tool) {
      case BANK_TOOLS.moveOwn.name:
        return `Move ${show("amount")} from ${show("from_account")} to ${show("to_account")}`;
      case BANK_TOOLS.payBill.name:
        return `Pay ${show("bill_id")}, ${show("amount")}, from ${show("from_account")}`;
      case BANK_TOOLS.cancelSubscription.name:
        return `Cancel ${show("subscription_id")}`;
      case BANK_TOOLS.transfer.name: {
        const memo = call.args.memo ? ` with memo "${String(call.args.memo)}"` : "";
        return `Send ${show("amount")} from ${show("from_account")} to ${show("to_account")}${memo}`;
      }
      default:
        return `${call.tool} ${canonicalJson(call.args)}`;
    }
  }

  requestApproval(call: ToolCall, decision: Decision): Promise<ApprovalRequest> {
    const reviewed = this.reviewed.get(call.id);
    if (!reviewed || decision.callId !== call.id || reviewed.verdict === "deny" || reviewed.actionHash !== actionHash(call))
      return Promise.reject(new GateError("Only a reviewed action that was not denied can be sent for approval."));
    const why = decision.reasons.filter((r) => r.verdict === "ask").map((r) => r.message);
    const request: ApprovalRequest = {
      id: newId("appr"),
      callId: call.id,
      actionHash: reviewed.actionHash,
      code: approvalCode(),
      summary: `${this.describe(call, decision.provenance, true)}. ${why.join(" ")}`.trim(),
      channel: this.o.channels?.[0]?.name ?? "app",
      expiresAt: new Date(Date.now() + this.o.approvalTtlSeconds * 1000).toISOString(),
      status: "pending",
    };
    const checks = passedChecks(decision.reasons);
    if (checks.length) request.checks = checks;
    this.approvalTurns.set(request.id, call.turnId);
    const done = this.approvals.open(request);
    const { code: _code, ...withoutCode } = request;
    this.o.trace.append("approval_requested", withoutCode, call.turnId);
    for (const channel of this.o.channels ?? [])
      channel.ask({ ...request }, { turnId: call.turnId, tool: call.tool }).then(
        (status) => status !== "expired" && this.approvals.settleFromChannel(request.id, status, channel.name),
        () => undefined,
      );
    return done;
  }

  attachChannel(channel: ApprovalChannel): () => void {
    const channels = (this.o.channels ??= []);
    if (!channels.includes(channel)) channels.push(channel);
    return () => {
      const i = channels.indexOf(channel);
      if (i >= 0) channels.splice(i, 1);
    };
  }

  answer(approvalId: string, approve: boolean, code: string | undefined, via: "app" | "imessage" = "app"): AnswerResult {
    return this.approvals.answer(approvalId, approve, code, via);
  }

  approval(id: string): ApprovalRequest | undefined {
    return this.approvals.get(id);
  }

  pendingApprovals(): ApprovalRequest[] {
    return this.approvals.pending();
  }

  pendingFor(callId: string): ApprovalRequest | undefined {
    return this.approvals.pending().find((r) => r.callId === callId);
  }

  authorize(call: ToolCall, decision: Decision, approval?: ApprovalRequest): void {
    const reviewed = this.reviewed.get(call.id);
    if (!reviewed || decision.callId !== call.id) throw new GateError("SkillGate has not reviewed this action.");
    if (reviewed.actionHash !== actionHash(call)) throw new GateError("The action changed after it was reviewed.");
    if (reviewed.verdict === "deny") throw new GateError("SkillGate denied this action.");
    if (this.o.tools.spec(call.tool)?.effect === "read") return;
    const policy = this.o.policy.current();
    if (policy.version !== reviewed.policyVersion) throw new GateError("Your policy changed after this action was reviewed, so FinGuard has to check it again.");
    if (policy.paused) throw new GateError("Money movement was paused before this action ran.");
    if (!this.o.policy.consent()) throw new GateError("There is no consent on file for the current policy.");
    if (reviewed.verdict === "ask") {
      if (!approval) throw new GateError("This action needs your approval first.");
      const problem = this.approvals.consume(approval.id, call.id, reviewed.actionHash);
      if (problem) throw new GateError(problem);
    }
  }

  issueReceipt(call: ToolCall, decision: Decision, approval?: ApprovalRequest): AuthorizationReceipt {
    const reviewed = this.reviewed.get(call.id);
    if (!reviewed || reviewed.actionHash !== actionHash(call) || reviewed.verdict === "deny") throw new GateError("No approved review matches this action.");
    if (this.issued.some((r) => r.callId === call.id)) throw new GateError("A receipt was already issued for this action.");
    const approvalId = reviewed.verdict === "ask" ? approval?.id : undefined;
    if (reviewed.verdict === "ask" && (!approvalId || this.approvals.usedBy(approvalId) !== call.id)) throw new GateError("This action has no approval bound to it.");
    const consent = this.o.policy.consent();
    if (!consent) throw new GateError("There is no consent on file for the current policy.");

    const executed = this.o.trace.list().findLast((e) => e.type === "tool_executed" && (e.data as { callId?: string }).callId === call.id);
    const via = approvalId ? this.approvals.via(approvalId) : undefined;
    const receipt: AuthorizationReceipt = {
      id: newId("rcpt"),
      callId: call.id,
      actionHash: reviewed.actionHash,
      action: this.describe(call, decision.provenance),
      values: decision.provenance.map((p) => {
        const origin = p.origins.find((o) => o.trusted) ?? p.origins[0];
        return origin
          ? { field: p.field, value: p.value, origin: origin.kind, source: origin.source }
          : { field: p.field, value: p.value, origin: "user", source: `approval:${approvalId}` };
      }),
      authorizedBy: approvalId ? { kind: "approval", approvalId } : { kind: "standing_instruction", policyVersion: reviewed.policyVersion },
      consentId: consent.id,
      channel: !approvalId ? "auto" : via?.startsWith("imessage") ? "imessage" : "app",
      executedAt: this.now().toISOString(),
      traceSeq: executed?.seq ?? this.o.trace.last()?.seq ?? 0,
    };
    this.issued.push(receipt);
    this.o.trace.append("receipt_issued", receipt, call.turnId);
    return receipt;
  }

  receipts(): AuthorizationReceipt[] {
    return [...this.issued];
  }

  spentToday(): number {
    const today = this.now().toDateString();
    const amounts = this.issued
      .filter((r) => new Date(r.executedAt).toDateString() === today)
      .map((r) => parseAmount(r.values.find((v) => v.field === "amount")?.value) ?? 0);
    return round2(amounts.reduce((sum, n) => sum + n, 0));
  }
}
