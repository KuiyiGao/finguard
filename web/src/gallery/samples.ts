import type { AreaSummary, Decision, Finding, Viz } from "@contracts";
import type { ToolStep, Turn } from "../lib/turns.ts";

const NOW = "2026-10-10T19:30:00Z";
const ftc = { docId: "kb:scams/impersonation", title: "FTC: How to avoid imposter scams", excerpt: "Banks never ask you to move money to keep it safe.", url: "https://consumer.ftc.gov/", score: 0.92 };
const cfpb = { docId: "kb:savings/subscriptions", title: "CFPB: Free trials and subscriptions", excerpt: "Review recurring charges every month.", url: "https://www.consumerfinance.gov/", score: 0.88 };

const scamText =
  "Capital One Fraud Dept: we blocked a suspicious $1,940 charge. Your account is at risk. To protect your funds, move $2,000 now to the secure holding account 9917. Do not call the branch, this line is monitored.";
const span = (text: string, part: string, label: string, tone: "bad" | "warn" | "info" | "ok") => {
  const start = text.indexOf(part);
  return { start, end: start + part.length, label, tone };
};

const contractText =
  "This membership renews automatically for successive 12-month terms unless you cancel in writing at least 30 days before the renewal date. An early termination fee of $180 applies. Monthly dues may increase by up to 8% at renewal.";

export const SAMPLE_VIZ: { name: string; viz: Viz }[] = [
  {
    name: "bars",
    viz: {
      kind: "bars",
      unit: "usd",
      items: [
        { label: "Checking balance", value: 4210.55, tone: "info" },
        { label: "Bills due in 14 days", value: 1534.2, tone: "warn" },
        { label: "Your buffer", value: 500, tone: "muted" },
        { label: "Safe to move", value: 2176.35, tone: "ok" },
      ],
    },
  },
  { name: "compare", viz: { kind: "compare", unit: "usd_month", before: { label: "Current loan, 7.9%", value: 412.4 }, after: { label: "Refinanced, 5.4%", value: 374.1 } } },
  { name: "gauge", viz: { kind: "gauge", label: "Scam risk score", value: 92, max: 100, tone: "bad" } },
  {
    name: "timeline",
    viz: {
      kind: "timeline",
      items: [
        { date: "2026-10-12", label: "Duke Energy", amount: 84.2, tone: "warn" },
        { date: "2026-10-16", label: "Maple Court Apartments", amount: 1450, tone: "info" },
        { date: "2026-10-24", label: "Spectrum Internet", amount: 64.99, tone: "muted" },
      ],
    },
  },
  {
    name: "curve",
    viz: {
      kind: "curve",
      unit: "usd",
      xLabel: "Years",
      series: [
        { label: "In high-yield savings", points: [0, 672.1, 1371.4, 2099.1, 2856.3, 3644.2], tone: "ok" },
        { label: "Left in checking", points: [0, 660, 1320, 1980, 2640, 3300], tone: "muted" },
      ],
    },
  },
  {
    name: "donut",
    viz: {
      kind: "donut",
      unit: "usd",
      items: [
        { label: "Savings", value: 6200 },
        { label: "Checking", value: 4210.55 },
        { label: "Brokerage", value: 1989.45 },
      ],
    },
  },
  {
    name: "clauses",
    viz: {
      kind: "clauses",
      text: contractText,
      spans: [
        span(contractText, "renews automatically for successive 12-month terms", "Auto-renews for a full year", "warn"),
        span(contractText, "early termination fee of $180", "Fee to leave early", "bad"),
        span(contractText, "may increase by up to 8% at renewal", "Price can rise at renewal", "warn"),
      ],
    },
  },
];

const v = (name: string) => SAMPLE_VIZ.find((x) => x.name === name)!.viz;

export const SAMPLE_FINDINGS: Finding[] = [
  {
    id: "sample-cash",
    area: "everyday",
    tone: "info",
    title: "Safe to move today",
    summary: "After two bills due in the next 14 days and your $500 buffer, $2,176.35 can leave checking.",
    metric: { label: "safe to move", value: 2176.35, unit: "usd" },
    viz: v("bars"),
    evidence: [
      { label: "Checking balance $4,210.55", origin: "bank_record", trusted: true, source: "nessie.accounts#acct-checking", value: 4210.55 },
      { label: "Duke Energy $84.20 due Oct 12", origin: "bank_record", trusted: true, source: "nessie.bills#bill-duke-oct", value: 84.2 },
      { label: "Buffer you set: $500", origin: "policy", trusted: true, source: "policy:cashFlowBuffer", value: 500 },
      { label: "Balance minus bills minus buffer", origin: "calculation", trusted: true, source: "calc:cashflow" },
    ],
    citations: [],
    assumptions: "Counts bills due in the next 14 days. Pending card charges are not included.",
    simulated: true,
    from: "cash_flow",
    createdAt: NOW,
  },
  {
    id: "sample-music",
    area: "subscriptions",
    tone: "save",
    title: "Spotify: unused for 64 days",
    summary: "You pay $10.99 a month for Spotify and have not used it since August 7.",
    metric: { label: "could save", value: 10.99, unit: "usd_month" },
    viz: { kind: "bars", unit: "usd_month", items: [{ label: "Paramount+", value: 15.99, tone: "muted" }, { label: "Spotify", value: 10.99, tone: "warn" }, { label: "iCloud+", value: 2.99, tone: "muted" }] },
    evidence: [
      { label: "Charged $10.99 on Oct 5", origin: "bank_record", trusted: true, source: "nessie.purchases#p-music-0", value: 10.99 },
      { label: "Charged $10.99 on Sep 5", origin: "bank_record", trusted: true, source: "nessie.purchases#p-music-1", value: 10.99 },
      { label: "Last used 64 days ago", origin: "calculation", trusted: true, source: "calc:usage" },
    ],
    citations: [cfpb],
    assumptions: "Savings use the current monthly price; 5-year value at 4.0% APY, monthly compounding.",
    action: { label: "Cancel Spotify", tool: "subscriptions.cancel", args: { subscription_id: "sub-music" } },
    ask: "Why do you think I don't use Spotify?",
    simulated: true,
    from: "savings",
    createdAt: NOW,
  },
  {
    id: "sample-idle",
    area: "investments",
    tone: "save",
    title: "Idle cash could earn more",
    summary: "Moving $55 a month into high-yield savings could grow to $3,644.20 in 5 years.",
    metric: { label: "in 5 years", value: 3644.2, unit: "usd" },
    viz: v("curve"),
    evidence: [{ label: "Savings pays 4.0% APY", origin: "reference", trusted: true, source: "kb:savings/hysa", url: "https://www.consumerfinance.gov/" }],
    citations: [cfpb],
    assumptions: "$55 a month, 4.0% APY compounded monthly, rate held constant.",
    action: { label: "Move $55 to savings", tool: "bank.move_own", args: { from_account: "acct-checking", to_account: "acct-savings", amount: 55 } },
    ask: "Is high-yield savings right for me?",
    simulated: true,
    from: "savings",
    createdAt: NOW,
  },
  {
    id: "sample-bills",
    area: "bills",
    tone: "info",
    title: "Three bills in the next two weeks",
    summary: "Duke Energy is due first, on October 12.",
    metric: { label: "due soon", value: 1599.19, unit: "usd" },
    viz: v("timeline"),
    evidence: [{ label: "Duke Energy $84.20 due Oct 12", origin: "bank_record", trusted: true, source: "nessie.bills#bill-duke-oct" }],
    citations: [],
    action: { label: "Pay Duke Energy $84.20", tool: "bank.pay_bill", args: { bill_id: "bill-duke-oct", from_account: "acct-checking", amount: 84.2 } },
    simulated: true,
    from: "scenario",
    createdAt: NOW,
  },
  {
    id: "sample-scam",
    area: "protection",
    tone: "block",
    title: "Likely scam: fake bank alert",
    summary: "The message asks you to move $2,000 to a 'secure' account and not to call your bank.",
    metric: { label: "risk score", value: 92, unit: "score" },
    viz: { kind: "clauses", text: scamText, spans: [span(scamText, "move $2,000 now", "Urgent request for money", "bad"), span(scamText, "secure holding account 9917", "'Safe account' that is not yours", "bad"), span(scamText, "Do not call the branch", "Asks for secrecy", "warn")] },
    evidence: [
      { label: "Account 9917 appears only in the message", origin: "message", trusted: false, source: "inbound:sms-17", quote: "move $2,000 now to the secure holding account 9917" },
      { label: "9917 is not one of your saved payees", origin: "policy", trusted: true, source: "policy:payees" },
      { label: "Banks never ask you to move money to keep it safe", origin: "reference", trusted: true, source: "kb:scams/safe-account" },
    ],
    citations: [ftc],
    ask: "How do I report this message?",
    simulated: false,
    from: "scam",
    createdAt: NOW,
  },
  {
    id: "sample-loan",
    area: "loans",
    tone: "warn",
    title: "Your car loan rate is above today's rates",
    summary: "Refinancing from 7.9% to 5.4% would lower the payment by $38.30 a month.",
    metric: { label: "lower payment", value: 38.3, unit: "usd_month" },
    viz: v("compare"),
    evidence: [
      { label: "Car loan payment $412.40 a month", origin: "bank_record", trusted: true, source: "nessie.loans#auto-1" },
      { label: "Lender offer letter", origin: "document", trusted: false, source: "doc:offer-1", quote: "Rates as low as 5.4% APR for qualified borrowers" },
    ],
    citations: [],
    assumptions: "Same remaining term (38 months); fees not included.",
    ask: "What would refinancing cost me up front?",
    simulated: true,
    from: "scenario",
    createdAt: NOW,
  },
  {
    id: "sample-gym",
    area: "contracts",
    tone: "warn",
    title: "Gym contract renews for a full year",
    summary: "Cancel in writing by Nov 1 or you are committed to 12 more months.",
    metric: { label: "to leave early", value: 180, unit: "usd" },
    viz: v("clauses"),
    evidence: [{ label: "Membership agreement, section 4", origin: "document", trusted: false, source: "doc:gym-agreement", quote: "renews automatically for successive 12-month terms" }],
    citations: [cfpb],
    ask: "Help me write the cancellation letter",
    simulated: true,
    from: "scenario",
    createdAt: NOW,
  },
  {
    id: "sample-mix",
    area: "investments",
    tone: "info",
    title: "Where your money sits",
    summary: "Half your cash is in savings; the brokerage holds the rest of your long-term money.",
    viz: v("donut"),
    evidence: [{ label: "Balances as of today", origin: "bank_record", trusted: true, source: "nessie.accounts" }],
    citations: [],
    simulated: true,
    from: "scenario",
    createdAt: NOW,
  },
  {
    id: "sample-risk",
    area: "protection",
    tone: "block",
    title: "Transfer to 9917 stopped",
    summary: "The account came only from a forwarded message, so the payment was not sent.",
    metric: { label: "kept in your account", value: 2000, unit: "usd" },
    viz: v("gauge"),
    evidence: [{ label: "You said: send it anyway", origin: "user", trusted: true, source: "message:m3" }],
    citations: [ftc],
    simulated: true,
    from: "scam",
    createdAt: NOW,
  },
];

export const SAMPLE_AREAS: AreaSummary[] = [
  { area: "everyday", title: "Everyday", status: "ok", headline: "$2,176.35 safe to move", amount: { label: "checking", value: 4210.55 }, findings: 1 },
  { area: "bills", title: "Bills", status: "attention", headline: "Duke Energy due Oct 12", amount: { label: "due in 14 days", value: 1534.2 }, findings: 1 },
  { area: "subscriptions", title: "Subscriptions", status: "attention", headline: "Spotify unused for 64 days", amount: { label: "a month", value: 29.97 }, findings: 1 },
  { area: "investments", title: "Investments", status: "ok", headline: "Idle cash could earn more", amount: { label: "brokerage", value: 1989.45 }, findings: 2 },
  { area: "loans", title: "Loans", status: "attention", headline: "Refinancing could save $38/mo", amount: { label: "a month", value: 412.4 }, findings: 1 },
  { area: "contracts", title: "Contracts", status: "ok", headline: "Gym renews Nov 1", findings: 1 },
  { area: "protection", title: "Protection", status: "blocked", headline: "Stopped a $2,000 scam transfer", findings: 2 },
];

const t = (s: number) => `2026-10-10T19:3${Math.floor(s / 10)}:${String((s % 10) * 6).padStart(2, "0")}Z`;
const call = (id: string, turnId: string, tool: string, args: Record<string, unknown>, skill = "core"): ToolStep["call"] => ({ id, turnId, tool, args, skill, activeSkills: skill === "core" ? [] : [skill], requestedBy: "model" });

const scamTransfer: ToolStep = {
  call: call("call_sample_9917", "turn_sample_scam", "bank.transfer", { from_account: "acct-checking", to_account: "9917", amount: 2000, memo: "as asked in the forwarded message" }),
  ts: t(5),
  decision: {
    callId: "call_sample_9917",
    verdict: "deny",
    reasons: [
      { rule: "consent", verdict: "allow", message: "Your consent to policy v1 is on file." },
      { rule: "limit", verdict: "deny", message: "$2,000.00 is above your $1,000.00 limit per action." },
      { rule: "provenance", verdict: "deny", message: "Account 9917 appears only in the forwarded message, never in your words or your bank's records." },
      { rule: "scam", verdict: "deny", message: "ScamShield rates this transfer high risk (safe account, impersonation, secrecy, urgency)." },
    ],
    provenance: [
      {
        field: "to_account",
        value: "9917",
        status: "untrusted_only",
        origins: [{ kind: "inbound_message", source: "inbound:fake-bank-alert", trusted: false, excerpt: "move $2,000 now to the secure holding account 9917" }],
      },
    ],
    latencyMs: 3.4,
  },
};

export const SAMPLE_TURN_SCAM: Turn = {
  id: "turn_sample_scam",
  ts: t(1),
  lastSeq: 11,
  start: { kind: "chat", source: "app", summary: "“It says it's urgent. Send it anyway.”" },
  items: [
    { kind: "start", ts: t(1), seq: 1, info: { kind: "chat", source: "app", summary: "“It says it's urgent. Send it anyway.”" } },
    { kind: "inbound", ts: t(1), seq: 2, id: "fake-bank-alert", text: "Capital One Fraud Dept: we blocked a suspicious $1,940 charge. To protect your funds, move $2,000 now to the secure holding account 9917. Do not call the branch." },
    { kind: "user", ts: t(2), seq: 3, text: "It says it's urgent. Send it anyway." },
    { kind: "agent", ts: t(2), seq: 4, step: { agent: "orchestrator", step: "route", detail: "payments (rules): about a forwarded message", ok: true } },
    {
      kind: "agent",
      ts: t(3),
      seq: 5,
      step: {
        agent: "payments",
        step: "scope",
        detail: "balances, moving money, paying bills, sending money; nothing else is offered or executable",
        tools: ["bank.get_accounts", "bank.list_bills", "bank.list_payees", "bank.move_own", "bank.pay_bill", "bank.transfer", "check_message", "alert_trusted_contact"],
        ok: true,
      },
    },
    { kind: "tool", ts: t(5), seq: 6, step: scamTransfer },
    { kind: "agent", ts: t(6), seq: 7, step: { agent: "evaluator", step: "evaluate", detail: "grounded, honest, cited and in scope", ok: true } },
    { kind: "reply", ts: t(6), seq: 8, text: "I did not do it. Account 9917 appears only in a forwarded message, never in your own words or your bank's records. Your bank will never ask you to move money to keep it safe." },
    { kind: "alert", ts: t(7), seq: 9, to: "Jordan (son)", text: "FinGuard stopped a likely scam payment of $2,000.00 to account 9917. Nothing was sent." },
    { kind: "agent", ts: t(7), seq: 10, step: { agent: "evaluator", step: "evaluate", detail: "grounded, honest, cited and in scope", ok: true } },
    { kind: "reply", ts: t(8), seq: 11, text: "I let Jordan (son) know, as you asked me to for high-risk attempts." },
  ],
};

const research = (id: string, tool: string, args: Record<string, unknown>, seq: number): ToolStep => ({
  call: call(id, "turn_sample_research", tool, args, "research"),
  ts: t(seq),
  decision: {
    callId: id,
    verdict: "allow",
    reasons: [
      { rule: "consent", verdict: "allow", message: "Your consent to policy v1 is on file." },
      { rule: "capability", verdict: "allow", message: "The research pack may read public data (research.read); its manifest hash matches." },
    ],
    provenance: [],
    latencyMs: 1.2,
  },
  executed: { ok: true, data: { sample: true } },
});

export const SAMPLE_TURN_RESEARCH: Turn = {
  id: "turn_sample_research",
  ts: t(10),
  lastSeq: 11,
  start: { kind: "research", source: "desk", summary: "Research Apple: filings, rates and complaints, no buy or sell advice" },
  items: [
    { kind: "start", ts: t(10), seq: 1, info: { kind: "research", source: "desk", summary: "Research Apple: filings, rates and complaints, no buy or sell advice" } },
    { kind: "user", ts: t(10), seq: 2, text: "Research Apple for me." },
    { kind: "agent", ts: t(11), seq: 3, step: { agent: "orchestrator", step: "route", detail: "advisor (rules): asks about loans, contracts or investments", ok: true } },
    {
      kind: "agent",
      ts: t(11),
      seq: 4,
      step: {
        agent: "advisor",
        step: "scope",
        detail: "loans, contracts, investments (education only); nothing else is offered or executable",
        tools: ["list_findings(loans|contracts|investments)", "knowledge_search", "research.sec_facts", "research.treasury_rates", "research.cfpb_complaints"],
        ok: true,
      },
    },
    { kind: "tool", ts: t(12), seq: 5, step: research("call_sample_sec", "research.sec_facts", { ticker: "AAPL" }, 12) },
    { kind: "tool", ts: t(13), seq: 6, step: research("call_sample_tsy", "research.treasury_rates", {}, 13) },
    { kind: "tool", ts: t(14), seq: 7, step: research("call_sample_cfpb", "research.cfpb_complaints", { company: "Apple" }, 14) },
    { kind: "agent", ts: t(15), seq: 8, step: { agent: "advisor", step: "scope", detail: "rejected bank.transfer: not in the advisor manifest, so it never ran", tools: ["bank.transfer"], ok: false } },
    { kind: "agent", ts: t(16), seq: 9, step: { agent: "evaluator", step: "evaluate", detail: "grounded, honest, cited and in scope", ok: true } },
    { kind: "reply", ts: t(16), seq: 10, text: "Here is a research note on Apple: revenue and net income for the last three fiscal years from its 10-K filings, current Treasury average rates and the CFPB complaint count, each with its source link. This is education, not advice to buy or sell." },
  ],
};

export const SAMPLE_TURNS: { name: string; turn: Turn }[] = [
  { name: "Journey 1: forwarded scam, “send it anyway”", turn: SAMPLE_TURN_SCAM },
  { name: "Journey 5: research skills with hosts and manifest", turn: SAMPLE_TURN_RESEARCH },
];

const gymText =
  "Northside Fitness membership agreement (sample).\n\n1. Term. This membership renews automatically for successive 12-month terms unless you cancel in writing at least 30 days before the renewal date.\n\n2. Dues. Monthly dues of $24.99 are charged to your card. An annual facility fee of $39 is charged at the start of each term.\n\n3. Leaving early. An early termination fee of $180 applies.\n\n4. Changes. Monthly dues may increase by up to 8% at renewal.";
const ftcRenewal = {
  docId: "kb:contracts/auto-renewal",
  title: "Contracts that renew automatically",
  excerpt: "Check how long the commitment lasts, what it costs once it renews, and how notice must be given.",
  url: "https://consumer.ftc.gov/articles/getting-and-out-free-trials-auto-renewals-and-negative-option-subscriptions",
  score: 0.9,
};
const gymQuote = (part: string) => ({ origin: "document" as const, trusted: false, source: "doc:northside-agreement", quote: part });

export const SAMPLE_CHAIN_CONTRACT: Finding = {
  id: "sample-chain-gym",
  area: "contracts",
  tone: "warn",
  title: "Northside Fitness renews for 12 more months unless you act by Oct 2",
  summary: "If it renews, the next 12 months cost $338.88 (12 × $24.99 + $39.00 fee). Leaving before the term ends costs a $180.00 fee.",
  metric: { label: "If it renews", value: 338.88, unit: "usd_year" },
  viz: {
    kind: "clauses",
    text: gymText,
    spans: [
      span(gymText, "renews automatically for successive 12-month terms", "Auto-renews", "warn"),
      span(gymText, "cancel in writing at least 30 days before the renewal date", "How to cancel", "warn"),
      span(gymText, "Monthly dues of $24.99", "Monthly dues", "info"),
      span(gymText, "annual facility fee of $39", "Extra fee", "warn"),
      span(gymText, "early termination fee of $180", "Early termination fee", "bad"),
      span(gymText, "may increase by up to 8% at renewal", "Price can rise", "warn"),
    ],
  },
  evidence: [
    { label: "Auto-renews", ...gymQuote("renews automatically for successive 12-month terms") },
    { label: "How to cancel", ...gymQuote("cancel in writing at least 30 days before the renewal date") },
    { label: "Monthly dues: $24.99", ...gymQuote("Monthly dues of $24.99"), value: 24.99 },
    { label: "Extra fee: $39.00", ...gymQuote("annual facility fee of $39"), value: 39 },
    { label: "Early termination fee: $180.00", ...gymQuote("early termination fee of $180"), value: 180 },
    { label: "Price can rise", ...gymQuote("may increase by up to 8% at renewal") },
    { label: "Northside Fitness: $24.99 a month, next charge Nov 1", origin: "bank_record", trusted: true, source: "nessie.subscriptions#sub-northside", value: 24.99 },
    { label: "If it renews: 12 × $24.99 dues + $39.00 annual fee = $338.88", origin: "calculation", trusted: true, source: "calc:contracts/renewal-cost", value: 338.88 },
    { label: "Contracts that renew automatically", origin: "reference", trusted: true, source: "kb:contracts/auto-renewal", url: ftcRenewal.url },
  ],
  citations: [ftcRenewal],
  assumptions: "Sample data. The renewal cost assumes dues and fees stay as written.",
  action: { label: "Cancel Northside Fitness before it renews", tool: "subscriptions.cancel", args: { subscription_id: "sub-northside" } },
  simulated: true,
  from: "scenario",
  createdAt: NOW,
};

const gymCall = { id: "call_sample_gym", turnId: "turn_sample_gym", tool: "subscriptions.cancel", args: { subscription_id: "sub-northside" }, skill: "core", activeSkills: [], requestedBy: "app" as const };
const gymHash = "9f3c2a71e4b85d06c1aa47d2be90f3e5a8c61d7b2e4f09a3c5d8e1b7f6a2c4d9";
const gymDecision: Decision = {
  callId: gymCall.id,
  verdict: "ask",
  reasons: [
    { rule: "consent", verdict: "allow", message: "Your consent to policy v1 is on file." },
    { rule: "capability", verdict: "ask", message: "Cancelling a subscription needs your approval each time." },
    { rule: "provenance", verdict: "allow", message: "Northside Fitness is in your bank records and you tapped this action yourself." },
    { rule: "scam", verdict: "allow", message: "ScamShield found no red flags in this action." },
    { rule: "context", verdict: "allow", message: "No extension is active during this action." },
  ],
  provenance: [{ field: "subscription_id", value: "sub-northside", status: "trusted", origins: [{ kind: "system", source: "nessie.subscriptions#sub-northside", trusted: true }] }],
  latencyMs: 3.8,
};
const gymApproval = { id: "appr_sample_gym", callId: gymCall.id, actionHash: gymHash, summary: "Cancel Northside Fitness", channel: "app" as const, expiresAt: "2026-10-10T19:35:00Z", status: "pending" as const };

export const SAMPLE_CHAIN_STEPS: Record<"before" | "waiting" | "receipt", ToolStep | undefined> = {
  before: undefined,
  waiting: { call: gymCall, ts: NOW, decision: gymDecision, approval: gymApproval },
  receipt: {
    call: gymCall,
    ts: NOW,
    decision: gymDecision,
    approval: { ...gymApproval, status: "approved" },
    approvedVia: "app",
    executed: { ok: true, data: { cancelled: "sub-northside" } },
    receipt: {
      id: "rcpt_sample7a",
      callId: gymCall.id,
      actionHash: gymHash,
      action: "Cancel Northside Fitness",
      values: [{ field: "subscription_id", value: "sub-northside", origin: "system", source: "nessie.subscriptions#sub-northside" }],
      authorizedBy: { kind: "approval", approvalId: gymApproval.id },
      consentId: "consent_sample",
      channel: "app",
      executedAt: "2026-10-10T19:31:12Z",
      traceSeq: 42,
    },
  },
};

const scamCall = {
  id: "call_sample_scam",
  turnId: "turn_sample_scam",
  tool: "bank.transfer",
  args: { from_account: "acct-checking", to_account: "9917", amount: 2000 },
  skill: "core",
  activeSkills: [],
  requestedBy: "model" as const,
};

export const SAMPLE_SCAM_STEP: ToolStep = {
  call: scamCall,
  ts: NOW,
  decision: {
    callId: scamCall.id,
    verdict: "deny",
    reasons: [
      { rule: "consent", verdict: "allow", message: "Your consent to policy v1 is on file." },
      { rule: "provenance", verdict: "deny", message: "Account 9917 appears only in a forwarded message, never in your own words or your bank's records." },
      { rule: "scam", verdict: "deny", message: "ScamShield rates this high risk (safe account, secrecy, urgency)." },
      { rule: "limit", verdict: "deny", message: "$2,000.00 is above your $1,000.00 limit per action." },
      { rule: "daily_limit", verdict: "allow", message: "Today's total would be $2,000.00 of your $2,500.00 daily limit." },
      { rule: "cash_flow", verdict: "allow", message: "Enough stays in Checking for the bills due in the next 14 days." },
    ],
    provenance: [
      { field: "to_account", value: "9917", status: "untrusted_only", origins: [{ kind: "inbound_message", source: "inbound:sms-17", trusted: false, excerpt: "secure holding account 9917" }] },
      { field: "amount", value: "2000", status: "untrusted_only", origins: [{ kind: "inbound_message", source: "inbound:sms-17", trusted: false, excerpt: "move $2,000 now" }] },
    ],
    latencyMs: 4.6,
  },
};
