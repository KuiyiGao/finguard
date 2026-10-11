
export type Capability =
  | "bank.read" // balances, bills, purchases, payees
  | "transfers.own" // between the user's own accounts
  | "bills.pay"
  | "transfers.external" // to someone else
  | "subscriptions.manage" // cancel a subscription or trial (no money moves, but it changes the account)
  | "research.read"; // public data for research: filings, rates, bank registry, complaint data (no account data)

export interface CapabilityGrant {
  capability: Capability;
  maxAmount?: number;
  approval: "never" | "always" | "over_limit"; // "never" = standing instruction (runs, receipt)
}

export interface DelegationPolicy {
  version: number;
  grants: CapabilityGrant[];
  ownAccounts: string[];
  savedPayees: { id: string; name: string; account: string; addedAt: string }[];
  newPayeeCoolingOffMinutes: number;
  dailyLimit: number;
  trustedContact?: { name: string; handle: string };
  cashFlowBuffer?: number;
  paused: boolean;
}

export interface ConsentRecord {
  id: string;
  policyVersion: number;
  policyHash: string;
  statement: string;
  acceptedAt: string;
  channel: "app" | "imessage";
}

export interface SkillManifest {
  name: string;
  description: string;
  publisher: string;
  capabilities: CapabilityGrant[];
}

export interface SkillRecord {
  manifest: SkillManifest;
  sha256: string;
  status: "pending_review" | "approved" | "disabled_hash_mismatch" | "removed";
  approvedAt?: string;
}

export type OriginKind =
  | "user" // the user's own words
  | "system" // structured fields from the bank: account ids, saved payees, bill ids and amounts
  | "tool_text" // free text inside tool results: memos, merchant descriptions, invoices
  | "inbound_message" // a message the user forwarded or shared ("is this real?")
  | "skill_text" // body of a third-party extension
  | "kb"; // knowledge-base passages (citations only; never a source of money values)

export interface Origin {
  kind: OriginKind;
  source: string;
  trusted: boolean;
  excerpt?: string;
}

export interface ToolResult {
  ok: boolean;
  data: unknown;
  systemValues: { source: string; value: string | number }[];
  texts: { source: string; text: string }[];
  error?: string;
}

export type Effect = "read" | "move_money" | "account_change";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: Effect;
  capability: Capability;
  moneyFields?: string[];
}

export interface ToolCall {
  id: string;
  turnId: string;
  tool: string;
  args: Record<string, unknown>;
  skill: string;
  activeSkills: string[];
  requestedBy: "model" | "replay" | "app";
}

export type RiskLevel = "low" | "medium" | "high";

export interface RedFlag {
  signal:
    | "inbound_request" // the request came from a message the user did not write
    | "new_payee"
    | "payee_changed" // differs from the payee's account on file
    | "urgency"
    | "secrecy"
    | "impersonation" // bank, government, police, family
    | "safe_account"
    | "unusual_method" // gift card, crypto, wire
    | "unusual_amount"
    | "name_mismatch"
    | "guaranteed_returns" // promises returns that are guaranteed, fixed or far above normal
    | "upfront_fee"; // a fee before a loan, debt relief or prize is delivered
  evidence: string;
  weight: number;
}

export interface ScamAssessment {
  id: string;
  subject: { kind: "message" | "transfer"; ref: string };
  risk: RiskLevel;
  score: number;
  redFlags: RedFlag[];
  typologies: { name: string; citation: RagHit }[];
  advice: string[];
}

export interface RagHit {
  docId: string;
  title: string;
  excerpt: string;
  url?: string;
  score: number;
}

export interface SavingsRecommendation {
  id: string;
  kind: "subscription" | "late_fee" | "fee" | "idle_cash" | "cheaper_plan";
  title: string;
  monthlySavings: number;
  annualSavings: number;
  fiveYearValue: number;
  assumptions: string;
  evidence: { label: string; source: string }[];
  citations: RagHit[];
  action?: { label: string; tool: string; args: Record<string, unknown> };
  simulated?: boolean;
}

export interface SavingsReport {
  generatedAt: string;
  recommendations: SavingsRecommendation[];
  totalMonthly: number;
  disclaimers: string[];
}

export interface Nudge {
  id: string;
  kind: "trial_ending" | "subscription_renewing" | "bill_due" | "safe_to_save" | "price_increase";
  title: string;
  body: string;
  evidence: { label: string; source: string }[];
  action?: { label: string; tool: string; args: Record<string, unknown> };
  createdAt: string;
}

export interface CashFlow {
  account: string;
  balance: number;
  upcoming: { label: string; amount: number; due: string; source: string }[];
  buffer: number;
  safeToMove: number;
  horizonDays: number;
}

export type Verdict = "allow" | "ask" | "deny";

export type RuleId =
  | "consent" // no consent for the current policy version
  | "paused"
  | "capability"
  | "limit"
  | "provenance" // a money value came only from untrusted text, or from nowhere
  | "scam" // ScamShield risk
  | "cooling_off"
  | "daily_limit"
  | "context" // a third-party extension is active during money movement
  | "hash" // extension changed since approval
  | "velocity"
  | "cash_flow" // would leave checking short of upcoming bills
  | "llm"; // second opinion escalated (it can never relax)

export interface Reason {
  rule: RuleId;
  verdict: Verdict;
  message: string;
}

export interface FieldProvenance {
  field: string;
  value: string;
  status: "trusted" | "untrusted_only" | "not_found";
  origins: Origin[];
}

export interface Decision {
  callId: string;
  verdict: Verdict;
  reasons: Reason[];
  provenance: FieldProvenance[];
  scam?: ScamAssessment;
  llm?: { verdict: Verdict; rationale: string; model: string };
  latencyMs: number;
}

export interface ApprovalRequest {
  id: string;
  callId: string;
  actionHash: string;
  code: string;
  summary: string;
  channel: "app" | "imessage";
  expiresAt: string;
  status: "pending" | "approved" | "denied" | "expired";
  checks?: string[];
}

export interface AuthorizationReceipt {
  id: string;
  callId: string;
  actionHash: string;
  action: string;
  values: { field: string; value: string; origin: OriginKind; source: string }[];
  authorizedBy: { kind: "approval"; approvalId: string } | { kind: "standing_instruction"; policyVersion: number };
  consentId: string;
  channel: "app" | "imessage" | "auto";
  executedAt: string;
  traceSeq: number;
}

export type TraceEventType =
  | "consent_recorded"
  | "policy_changed"
  | "user_message"
  | "inbound_shared"
  | "skill_loaded"
  | "skill_installed"
  | "skill_disabled"
  | "tool_proposed"
  | "scam_assessed"
  | "decision"
  | "approval_requested"
  | "approval_resolved"
  | "tool_executed"
  | "receipt_issued"
  | "savings_report"
  | "agent_reply"
  | "agent_step" // supervised agents: routing, a specialist's tool scope, the evaluator's verdict
  | "turn_started" // {kind: TurnKind, source, summary}: why this turn ran
  | "alert_sent"
  | "scenario_started"
  | "nudge_sent"
  | "approval_reuse_blocked"
  | "eval_result";

export interface TraceEvent<T = unknown> {
  seq: number;
  ts: string;
  turnId?: string;
  type: TraceEventType;
  data: T;
  prevHash: string;
  hash: string;
}

export interface SkillGate {
  recordUserMessage(turnId: string, messageId: string, text: string): void;
  recordInbound(turnId: string, inboundId: string, text: string): void;
  recordSkillLoaded(turnId: string, skill: string): void;
  recordToolResult(turnId: string, tool: string, result: ToolResult): void;
  check(call: ToolCall): Promise<Decision>;
  requestApproval(call: ToolCall, decision: Decision): Promise<ApprovalRequest>;
  issueReceipt(call: ToolCall, decision: Decision, approval?: ApprovalRequest): AuthorizationReceipt;
}

export interface ScamShield {
  assessMessage(text: string, ref: string): Promise<ScamAssessment>;
  assessTransfer(call: ToolCall, context: { inbound: string[] }): Promise<ScamAssessment>;
}

export interface Retriever {
  search(query: string, opts?: { collection?: "savings" | "plans" | "fees" | "scams"; k?: number }): Promise<RagHit[]>;
}

export interface SavingsEngine {
  report(): Promise<SavingsReport>;
}

export interface ToolAdapter {
  spec: ToolSpec;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ApprovalContext {
  turnId: string;
  tool: string;
}

export interface ApprovalChannel {
  name: "app" | "imessage";
  ask(request: ApprovalRequest, context?: ApprovalContext): Promise<"approved" | "denied" | "expired">;
  withdraw?(requestId: string): void;
  notify(text: string): Promise<void>;
}

export type Area = "everyday" | "bills" | "subscriptions" | "investments" | "loans" | "contracts" | "protection";

export type Tone = "ok" | "info" | "warn" | "bad" | "muted";

export type EvidenceOrigin = "bank_record" | "user" | "policy" | "calculation" | "reference" | "document" | "message";

export interface Evidence {
  label: string;
  origin: EvidenceOrigin;
  trusted: boolean;
  source: string;
  quote?: string;
  value?: number;
  url?: string;
}

export type Viz =
  | { kind: "bars"; unit: "usd" | "usd_month" | "number"; items: { label: string; value: number; tone?: Tone }[] } // number: counts (research: complaints)
  | { kind: "compare"; unit: "usd" | "usd_month" | "pct"; before: { label: string; value: number }; after: { label: string; value: number } }
  | { kind: "gauge"; label: string; value: number; max: number; tone?: Tone }
  | { kind: "timeline"; items: { date: string; label: string; amount?: number; tone?: Tone }[] }
  | { kind: "curve"; unit: "usd"; xLabel: string; series: { label: string; points: number[]; tone?: Tone }[] }
  | { kind: "donut"; unit: "usd" | "pct"; items: { label: string; value: number }[] }
  | { kind: "clauses"; text: string; spans: { start: number; end: number; label: string; tone: Tone }[] };

export type AgentRole = "orchestrator" | "guardian" | "payments" | "savings" | "advisor" | "evaluator";

export type TurnKind = "chat" | "review" | "action" | "document" | "research" | "inbound";

export interface Finding {
  id: string;
  area: Area;
  tone: "save" | "info" | "warn" | "block";
  title: string;
  summary: string;
  metric?: { label: string; value: number; unit: "usd" | "usd_month" | "usd_year" | "pct" | "days" | "score" };
  viz?: Viz;
  evidence: Evidence[];
  citations: RagHit[];
  assumptions?: string;
  action?: { label: string; tool: string; args: Record<string, unknown> };
  ask?: string;
  simulated: boolean;
  from: "savings" | "nudge" | "scam" | "cash_flow" | "scenario" | "research";
  turnId?: string;
  agent?: AgentRole;
  createdAt: string;
}

export interface AreaSummary {
  area: Area;
  title: string;
  status: "ok" | "attention" | "blocked";
  headline: string;
  amount?: { label: string; value: number };
  findings: number;
}

export interface FindingsView {
  generatedAt: string;
  areas: AreaSummary[];
  findings: Finding[];
  references: { id: string; title: string; url: string }[];
}
