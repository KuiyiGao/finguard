import type {
  Area,
  CashFlow,
  Evidence,
  EvidenceOrigin,
  Finding,
  Nudge,
  RedFlag,
  RuleId,
  SavingsRecommendation,
  SavingsReport,
  ScamAssessment,
  Tone,
  Viz,
} from "../types.ts";

export const AREA_TITLES: Record<Area, string> = {
  everyday: "Everyday",
  bills: "Bills",
  subscriptions: "Subscriptions",
  investments: "Investments",
  loans: "Loans",
  contracts: "Contracts",
  protection: "Protection",
};

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd = (n: number) => USD.format(n);
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const nowIso = () => new Date().toISOString();

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const RULE_ORDER: RuleId[] = ["scam", "provenance", "paused", "consent", "hash", "capability", "context", "cooling_off", "daily_limit", "limit", "cash_flow", "velocity", "llm"];

const CITATION_TAG = /\s*\[(kb:[\w./-]+)\]/g;

export function replyCitations(text: string): { text: string; ids: string[] } {
  const ids = [...new Set([...text.matchAll(CITATION_TAG)].map((m) => m[1]!))];
  return { text: text.replace(CITATION_TAG, "").replace(/\s+([.,;:!?])/g, "$1").trim(), ids };
}

export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${month} ${Number(m[3])}` : iso;
}

function prettyDates(text: string): string {
  return text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => shortDate(d));
}

export function originOf(source: string): { origin: EvidenceOrigin; trusted: boolean } {
  const s = source.trim().toLowerCase();
  if (/^(nessie|stub|sim)\./.test(s) || s.startsWith("bank:")) return { origin: "bank_record", trusted: true };
  if (s.startsWith("kb:") || s.startsWith("builtin:")) return { origin: "reference", trusted: true };
  if (s.startsWith("policy")) return { origin: "policy", trusted: true };
  if (s.startsWith("calc:")) return { origin: "calculation", trusted: true };
  if (s.startsWith("message:") || s.startsWith("inbound")) return { origin: "message", trusted: false };
  if (s.startsWith("doc:")) return { origin: "document", trusted: false };
  if (s.startsWith("user:")) return { origin: "user", trusted: true };
  return { origin: "calculation", trusted: true };
}

function dollarsIn(label: string): number[] {
  return [...label.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)].map((m) => Number(m[1]!.replace(/,/g, ""))).filter(Number.isFinite);
}

function withoutDollars(label: string): string {
  return label.replace(/\$\s?\d[\d,]*(?:\.\d+)?(\/month|\/mo)?/g, "").replace(/[\s:;,-]+$/, "").replace(/\s{2,}/g, " ").trim();
}

function evidenceFrom(items: { label: string; source: string }[]): Evidence[] {
  return items.map((e) => {
    const amounts = dollarsIn(e.label);
    return { label: prettyDates(e.label), ...originOf(e.source), source: e.source, ...(amounts.length === 1 ? { value: amounts[0]! } : {}) };
  });
}

const SAVINGS_AREA: Record<SavingsRecommendation["kind"], Area> = {
  subscription: "subscriptions",
  late_fee: "bills",
  fee: "bills",
  idle_cash: "everyday",
  cheaper_plan: "bills",
};

const SAVINGS_ASK: Record<SavingsRecommendation["kind"], string> = {
  subscription: "What would I save by dropping this subscription, and when would the saving start?",
  late_fee: "When is this bill due, and what could a late payment cost me?",
  fee: "Where does this fee come from, and how could I avoid it?",
  idle_cash: "How much cash could I set aside after my upcoming bills?",
  cheaper_plan: "What is worth comparing before switching to the cheaper plan?",
};

function barTone(label: string): Tone | undefined {
  if (/fee/i.test(label)) return "bad";
  if (/bill/i.test(label)) return "warn";
  if (/balance/i.test(label)) return "info";
  return undefined;
}

function savingsViz(r: SavingsRecommendation, evidence: Evidence[]): Viz | undefined {
  if (r.kind === "cheaper_plan") {
    const [current, offer] = dollarsIn(r.evidence[0]?.label ?? "");
    if (current !== undefined && offer !== undefined) return { kind: "compare", unit: "usd_month", before: { label: "Current plan", value: current }, after: { label: "Cheaper plan", value: offer } };
    return undefined;
  }
  const items = evidence
    .filter((e) => e.value !== undefined)
    .map((e) => {
      const tone = barTone(e.label);
      return { label: prettyDates(withoutDollars(e.label)) || e.source, value: e.value!, ...(tone ? { tone } : {}) };
    });
  return items.length ? { kind: "bars", unit: "usd", items } : undefined;
}

function savingsSummary(r: SavingsRecommendation, oneTime: number): string {
  const saving = r.monthlySavings > 0 ? `Acting on it could save ${usd(r.monthlySavings)} a month, ${usd(r.annualSavings)} a year.` : "";
  switch (r.kind) {
    case "subscription":
      return `Charged ${usd(r.monthlySavings)} every month on your bank record. ${saving}`.trim();
    case "late_fee":
      return oneTime > 0
        ? `A bill is due soon. A past late fee of ${usd(oneTime)} shows what paying late has cost before; it is not counted as monthly savings.`
        : "A bill is due soon. Paying on time avoids a late fee.";
    case "idle_cash":
      return `Money in checking above your reserve and the bills due soon. ${saving} Moving it still needs your approval.`.replace(/\s+/g, " ").trim();
    case "cheaper_plan":
      return `A cheaper plan is available for the same bill. ${saving}`.trim();
    default:
      return saving || r.title;
  }
}

function savingsFinding(r: SavingsRecommendation, createdAt: string, simulated: boolean): Finding {
  const evidence = evidenceFrom(r.evidence);
  const oneTime = r.monthlySavings > 0 ? 0 : round2(evidence.filter((e) => /fee/i.test(e.label)).reduce((sum, e) => sum + (e.value ?? 0), 0));
  const metric: Finding["metric"] =
    r.monthlySavings > 0 ? { label: "Per month", value: r.monthlySavings, unit: "usd_month" } : oneTime > 0 ? { label: "One-time", value: oneTime, unit: "usd" } : undefined;
  const viz = savingsViz(r, evidence);
  return {
    id: `savings:${r.id}`,
    area: SAVINGS_AREA[r.kind] ?? "everyday",
    tone: "save",
    title: prettyDates(r.title),
    summary: savingsSummary(r, oneTime),
    ...(metric ? { metric } : {}),
    ...(viz ? { viz } : {}),
    evidence,
    citations: r.citations,
    assumptions: r.assumptions,
    ...(r.action ? { action: r.action } : {}),
    ask: SAVINGS_ASK[r.kind] ?? "Why is this a saving?",
    simulated: simulated || r.simulated === true,
    from: "savings",
    createdAt,
  };
}

export function savingsFindings(report: SavingsReport, opts: { simulated?: boolean } = {}): Finding[] {
  return report.recommendations.map((r) => savingsFinding(r, report.generatedAt, opts.simulated ?? false));
}

const NUDGE_AREA: Record<Nudge["kind"], Area> = {
  trial_ending: "subscriptions",
  subscription_renewing: "subscriptions",
  price_increase: "subscriptions",
  bill_due: "bills",
  safe_to_save: "everyday",
};

const NUDGE_ASK: Record<Nudge["kind"], string> = {
  trial_ending: "When does this trial turn into a paid plan, and what will it cost?",
  subscription_renewing: "How much does this subscription cost me in a year?",
  price_increase: "How much more will this cost me in a year?",
  bill_due: "When is this bill due, and is there enough in checking for it?",
  safe_to_save: "How did you work out what is safe to set aside?",
};

export function nudgeFinding(n: Nudge, opts: { simulated?: boolean } = {}): Finding {
  const amount = n.action?.args.amount;
  return {
    id: `nudge:${n.id}`,
    area: NUDGE_AREA[n.kind] ?? "everyday",
    tone: "info",
    title: prettyDates(n.title),
    summary: prettyDates(n.body),
    ...(typeof amount === "number" ? { metric: { label: n.kind === "bill_due" ? "Amount due" : "Suggested amount", value: amount, unit: "usd" as const } } : {}),
    evidence: evidenceFrom(n.evidence),
    citations: [],
    ...(n.action ? { action: n.action } : {}),
    ask: NUDGE_ASK[n.kind] ?? "Why are you suggesting this?",
    simulated: opts.simulated ?? false,
    from: "nudge",
    createdAt: n.createdAt,
  };
}

type Signal = RedFlag["signal"];

const SIGNALS: Partial<Record<Signal, { label: string; phrase: string }>> = {
  inbound_request: { label: "Request from a message", phrase: "the payment request came from a message you did not write" },
  new_payee: { label: "New payee", phrase: "the account is not one of your saved payees" },
  payee_changed: { label: "Changed payment details", phrase: "the payment details differ from the ones on file" },
  urgency: { label: "Pressure to act fast", phrase: "it pushes you to act fast" },
  secrecy: { label: "Secrecy", phrase: "it asks you to keep it quiet" },
  impersonation: { label: "Claims to be someone you trust", phrase: "it claims to be someone you trust" },
  safe_account: { label: "\"Safe account\"", phrase: "it asks you to move money to a \"safe\" account" },
  unusual_method: { label: "Gift card, crypto or wire", phrase: "it asks for gift cards, crypto or a wire" },
  unusual_amount: { label: "Large amount", phrase: "the amount is unusually large" },
  name_mismatch: { label: "Name does not match", phrase: "the name does not match the account on file" },
  guaranteed_returns: { label: "Guaranteed returns", phrase: "it promises guaranteed or unusually high returns" },
  upfront_fee: { label: "Upfront fee", phrase: "it asks for a fee before anything is delivered" },
};

export function signalText(signal: Signal): { label: string; phrase: string } {
  const words = String(signal).replace(/_/g, " ");
  return SIGNALS[signal] ?? { label: words.charAt(0).toUpperCase() + words.slice(1), phrase: words };
}

function joinPlain(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function quoteCandidates(evidence: string): string[] {
  const strip = (s: string) => s.replace(/^\s*(\.\.\.|…)\s*/, "").replace(/\s*(\.\.\.|…)\s*$/, "").trim();
  const out = [strip(evidence)];
  const inner = evidence.match(/"([^"]{3,})"/);
  if (inner) out.push(strip(inner[1]!));
  return out.filter((q) => q.length >= 3);
}

const TONE_RANK: Record<Tone, number> = { muted: 0, ok: 1, info: 2, warn: 3, bad: 4 };

const TRIGGER: Partial<Record<Signal, RegExp>> = {
  safe_account: /\b(safe|secure|protected|holding) account\b|\bprotect your (money|funds|savings)\b|\bmove (all )?(your )?(money|funds|savings)\b/i,
  impersonation: /\b(fraud (dept|department|team|alert)|security (team|department)|capital one|wells fargo|chase|bank of america|irs|social security|medicare|police|sheriff|officer|apple support|microsoft|amazon support|it'?s me|grandma|grandpa)\b/i,
  urgency: /\b(now|immediately|urgent(ly)?|right away|asap|today|act fast|final (notice|warning)|within \d+ (minutes|hours)|before it'?s too late|suspended|locked)\b/i,
  secrecy: /\b(don'?t|do not) (tell|call|mention)|keep (this|it) (between us|secret|quiet)\b/i,
  unusual_method: /\b(gift ?cards?|itunes|google play|steam card|bitcoin|crypto(currency)?|btc|usdt|bitcoin atm|wire (transfer|it)|western union|moneygram)\b/i,
  payee_changed: /\b(new|updated|changed) (bank|account|payment|remittance) (details|information|info|number)\b|\b(bank|account|payment|banking) (details|information|info) (have|has) changed\b|\bremit (payment )?to\b|\bpay (to )?(our|the) new account\b/i,
  guaranteed_returns: /\bguarantee(?:d|s)?\s+(?:an?\s+)?(?:\d+(?:\.\d+)?\s?%\s+)?(?:daily\s+|weekly\s+|monthly\s+|high\s+|huge\s+|fixed\s+|big\s+)?(?:returns?|profits?|gains|payouts?|roi)\b|\b(?:risk[- ]free|no[- ]risk|zero[- ]risk)\s+(?:returns?|profits?|investments?|trading)\b|\b\d+(?:\.\d+)?\s?%\s+(?:daily|weekly|a day|per day|every day|a week|per week)\s+(?:returns?|profits?|gains|interest|roi)\b|\b(?:double|triple)\s+your\s+(?:money|investment|crypto|bitcoin)\b/i,
  upfront_fee: /\b(?:up[- ]?front|advance)[- ](?:fees?|payments?|charges?)\b|\b(?:pay|send)\b[^\n?!]{0,40}?\bfees?\b[^\n?!]{0,60}?\b(?:forgiv\w*|relief|consolidat\w*|enroll\w*|qualify|approv\w*|releas\w*|unlock\w*|claim\w*|receiv\w*)/i,
};

function narrow(text: string, start: number, end: number, signal: Signal): [number, number] {
  const window = text.slice(start, end);
  const m = TRIGGER[signal]?.exec(window);
  if (m && m[0].trim()) return [start + m.index, start + m.index + m[0].length];
  let a = start;
  let b = end;
  if (a > 0 && /\w/.test(text[a - 1]!) && /\w/.test(text[a]!)) while (a < b && /\w/.test(text[a]!)) a++; // drop a cut-off first word
  if (b < text.length && /\w/.test(text[b]!) && /\w/.test(text[b - 1]!)) while (b > a && /\w/.test(text[b - 1]!)) b--; // and a cut-off last word
  while (a < b && /\s/.test(text[a]!)) a++;
  while (b > a && /\s/.test(text[b - 1]!)) b--;
  return a < b ? [a, b] : [start, end];
}

function quoteSpans(text: string, flags: RedFlag[]): { start: number; end: number; label: string; tone: Tone }[] {
  const lower = text.toLowerCase();
  const raw: { start: number; end: number; label: string; tone: Tone }[] = [];
  for (const f of flags) {
    for (const q of quoteCandidates(f.evidence)) {
      const at = lower.indexOf(q.toLowerCase());
      if (at < 0) continue;
      const [start, end] = narrow(text, at, at + q.length, f.signal);
      raw.push({ start, end, label: signalText(f.signal).label, tone: f.weight >= 40 ? "bad" : "warn" });
      break;
    }
  }
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: typeof raw = [];
  for (const s of raw) {
    const prev = merged.at(-1);
    if (prev && s.start < prev.end) {
      prev.end = Math.max(prev.end, s.end);
      if (!prev.label.split("; ").includes(s.label)) prev.label = `${prev.label}; ${s.label}`;
      if (TONE_RANK[s.tone] > TONE_RANK[prev.tone]) prev.tone = s.tone;
    } else merged.push({ ...s });
  }
  return merged;
}

const isWord = (c: string | undefined) => c !== undefined && /\w/.test(c);

function wholeWords(evidence: string, text?: string): string {
  const lead = /^\s*(\.\.\.|…)/.test(evidence);
  const tail = /(\.\.\.|…)\s*$/.test(evidence);
  if (text) {
    const lower = text.toLowerCase();
    for (const q of quoteCandidates(evidence)) {
      const at = lower.indexOf(q.toLowerCase());
      if (at < 0) continue;
      let a = at;
      let b = at + q.length;
      if (isWord(text[a - 1]) && isWord(text[a])) while (isWord(text[a - 1])) a--;
      if (isWord(text[b]) && isWord(text[b - 1])) while (isWord(text[b])) b++;
      return `${a > 0 ? "…" : ""}${text.slice(a, b).trim()}${b < text.length ? "…" : ""}`;
    }
    return evidence;
  }
  if (!lead && !tail) return evidence;
  let core = evidence.replace(/^\s*(\.\.\.|…)\s*/, "").replace(/\s*(\.\.\.|…)\s*$/, "");
  if (lead) core = core.replace(/^\S*\s+/, "");
  if (tail) core = core.replace(/\s+\S*$/, "");
  return core.trim() ? `${lead ? "…" : ""}${core.trim()}${tail ? "…" : ""}` : evidence;
}

const RISK_TONE: Record<ScamAssessment["risk"], Finding["tone"]> = { high: "block", medium: "warn", low: "info" };
const RISK_GAUGE: Record<ScamAssessment["risk"], Tone> = { high: "bad", medium: "warn", low: "ok" };
export const RISK_WORDS: Record<ScamAssessment["risk"], string> = { high: "High risk", medium: "Medium risk", low: "Low risk" };

export function scamFinding(a: ScamAssessment, opts: { text?: string; area?: Area; createdAt?: string; simulated?: boolean } = {}): Finding {
  const name = a.typologies[0]?.name;
  const title = a.risk === "high" ? `Likely scam${name ? `: ${name}` : ""}` : a.risk === "medium" ? `Possible scam${name ? `: ${name}` : ""}` : "No strong scam signals";
  const phrases = a.redFlags.map((f) => signalText(f.signal).phrase);
  const summary = phrases.length
    ? `${RISK_WORDS[a.risk]}, ${a.score}/100: ${joinPlain(phrases)}.`
    : `${RISK_WORDS[a.risk]}, ${a.score}/100: no common scam signals found. Still check anything unexpected through a channel you already trust.`;
  const source = a.subject.kind === "message" ? a.subject.ref : `transfer:${a.subject.ref}`;
  const spans = opts.text ? quoteSpans(opts.text, a.redFlags) : [];
  const viz: Viz = opts.text && spans.length ? { kind: "clauses", text: opts.text, spans } : { kind: "gauge", label: "Risk score", value: a.score, max: 100, tone: RISK_GAUGE[a.risk] };
  return {
    id: `scam:${a.id}`,
    area: opts.area ?? "protection",
    tone: RISK_TONE[a.risk] ?? "warn",
    title,
    summary,
    metric: { label: "Risk score", value: a.score, unit: "score" },
    viz,
    evidence: a.redFlags.map((f) => {
      const { phrase } = signalText(f.signal);
      return { label: phrase.charAt(0).toUpperCase() + phrase.slice(1), origin: "message" as const, trusted: false, source, quote: wholeWords(f.evidence, opts.text) };
    }),
    citations: a.typologies.map((t) => t.citation),
    assumptions: "ScamShield flags common scam patterns in the words and the payment details. It cannot prove that a message is a scam, or that it is safe.",
    ask: a.risk === "low" ? "What should I look out for in messages like this?" : "What should I do about this message?",
    simulated: opts.simulated ?? false,
    from: "scam",
    createdAt: opts.createdAt ?? nowIso(),
  };
}

export function cashFlowFinding(c: CashFlow, opts: { createdAt?: string; simulated?: boolean } = {}): Finding {
  const owed = round2(c.upcoming.reduce((sum, b) => sum + b.amount, 0));
  const billSource = (s: string) => (/[.:#]/.test(s) ? s : `nessie.bills#${s}`);
  return {
    id: `cashflow:${c.account}`,
    area: "everyday",
    tone: "info",
    title: c.safeToMove > 0 ? `${usd(c.safeToMove)} is safe to move` : "Nothing is safe to move right now",
    summary: `Checking has ${usd(c.balance)}. After ${usd(owed)} of bills due in the next ${c.horizonDays} days and your ${usd(c.buffer)} buffer, ${usd(c.safeToMove)} could leave without straining them.`,
    metric: { label: "Safe to move", value: c.safeToMove, unit: "usd" },
    viz: {
      kind: "bars",
      unit: "usd",
      items: [
        { label: "Balance", value: c.balance, tone: "info" },
        ...c.upcoming.map((b) => ({ label: `${b.label} (due ${shortDate(b.due)})`, value: b.amount, tone: "warn" as const })),
        { label: "Buffer", value: c.buffer, tone: "muted" },
        { label: "Safe to move", value: c.safeToMove, tone: "ok" },
      ],
    },
    evidence: [
      { label: `Balance ${usd(c.balance)}`, origin: "bank_record", trusted: true, source: `nessie.accounts#${c.account}`, value: c.balance },
      ...c.upcoming.map((b): Evidence => ({ label: `${b.label} ${usd(b.amount)} due ${shortDate(b.due)}`, origin: "bank_record", trusted: true, source: billSource(b.source), value: b.amount })),
      { label: `Your buffer ${usd(c.buffer)}`, origin: "policy", trusted: true, source: "policy:cashFlowBuffer", value: c.buffer },
      { label: `Safe to move = balance - bills due - buffer = ${usd(c.safeToMove)}`, origin: "calculation", trusted: true, source: "calc:cash-flow", value: c.safeToMove },
    ],
    citations: [],
    assumptions: `Counts bills due in the next ${c.horizonDays} days. Spending that is not a bill yet is not included, so keep your own margin.`,
    ask: "How did you work out what is safe to set aside?",
    simulated: opts.simulated ?? false,
    from: "cash_flow",
    createdAt: opts.createdAt ?? nowIso(),
  };
}
