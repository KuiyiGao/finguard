import type { Metrics } from "../metrics.ts";
import type { DelegationPolicy, RagHit, RedFlag, Retriever, RiskLevel, ScamAssessment, ScamShield, ToolCall } from "../types.ts";
import { accountNumbersIn, amountsIn, digits, formatUsd, newId, parseAmount } from "../util.ts";
import { maxRisk, VIA_GEMINI, type Opinion, type SecondOpinion } from "./second-opinion.ts";
import { TYPOLOGIES } from "./typologies.ts";

type Signal = RedFlag["signal"];

const WEIGHT: Record<Signal, number> = {
  safe_account: 45,
  unusual_method: 40,
  payee_changed: 40,
  impersonation: 25,
  secrecy: 20,
  name_mismatch: 20,
  urgency: 15,
  inbound_request: 10,
  new_payee: 10,
  unusual_amount: 10,
  guaranteed_returns: 40,
  upfront_fee: 40,
};

const PATTERNS: [Signal, RegExp][] = [
  ["safe_account", /\b(safe|secure|protected|holding) account\b|\bprotect your (money|funds|savings)\b|\bmove (all )?(your )?(money|funds|savings)\b/i],
  ["impersonation", /\b(fraud (dept|department|team|alert)|security (team|department)|capital one|wells fargo|chase|bank of america|irs|social security|medicare|police|sheriff|officer|apple support|microsoft|amazon support|it'?s me|grandma|grandpa|your (manager|boss|supervisor|ceo))\b/i],
  ["urgency", /\b(now|immediately|urgent(ly)?|right away|asap|today|act fast|final (notice|warning)|within \d+ (minutes|hours)|before it'?s too late|suspended|locked)\b/i],
  ["secrecy", /\b(don'?t|do not) (tell|call|mention)|keep (this|it)(?: \w+)? (between us|secret|quiet|confidential)\b/i],
  ["unusual_method", /\b(gift ?cards?|itunes|google play|steam card|bitcoin|crypto(currency)?|btc|usdt|bitcoin atm|wire (transfer|it)|western union|moneygram)\b/i],
  ["payee_changed", /\b(new|updated|changed) (bank|account|payment|remittance) (details|information|info|number)\b|\b(bank|account|payment|banking) (details|information|info) (have|has) changed\b|\bremit (payment )?to\b|\bpay (to )?(our|the) new account\b/i],
  ["guaranteed_returns", /\bguarantee(?:d|s)?\s+(?:an?\s+)?(?:\d+(?:\.\d+)?\s?%\s+)?(?:daily\s+|weekly\s+|monthly\s+|high\s+|huge\s+|fixed\s+|big\s+)?(?:returns?|profits?|gains|payouts?|roi)\b|\b(?:risk[- ]free|no[- ]risk|zero[- ]risk)\s+(?:returns?|profits?|investments?|trading)\b|\b\d+(?:\.\d+)?\s?%\s+(?:daily|weekly|a day|per day|every day|a week|per week)\s+(?:returns?|profits?|gains|interest|roi)\b|\b(?:double|triple)\s+your\s+(?:money|investment|crypto|bitcoin)\b/i],
  ["upfront_fee", /(?<!\b(?:no|never|not|without|zero|don'?t|doesn'?t|won'?t)\b[^.!?\n]{0,25})\b(?:up[- ]?front|advance)[- ](?:fees?|payments?|charges?)\b|(?<!\b(?:no|never|not|without|don'?t|doesn'?t|won'?t)\b[^.!?\n]{0,25})\b(?:pay|send)\b[^\n?!]{0,40}?\bfees?\b[^\n?!]{0,60}?\b(?:forgiv\w*|relief|consolidat\w*|enroll\w*|qualify|approv\w*|releas\w*|unlock\w*|claim\w*|receiv\w*)/i],
];

const MONEY_REQUEST = /\b(send|transfer|move|pay|wire|deposit|buy)\b/i;

function flag(signal: Signal, evidence: string): RedFlag {
  return { signal, evidence, weight: WEIGHT[signal] };
}

function quote(text: string, re: RegExp): string {
  const m = text.match(re);
  if (!m || m.index === undefined) return "";
  const start = Math.max(0, m.index - 20);
  return (start > 0 ? "..." : "") + text.slice(start, m.index + m[0].length + 25).trim() + "...";
}

function riskOf(score: number): RiskLevel {
  return score >= 60 ? "high" : score >= 30 ? "medium" : "low";
}

function dedupe(flags: RedFlag[]): RedFlag[] {
  const best = new Map<Signal, RedFlag>();
  for (const f of flags) if (!best.has(f.signal)) best.set(f.signal, f);
  return [...best.values()];
}

export interface ScamShieldOptions {
  policy: () => DelegationPolicy;
  retriever?: Retriever;
  largeAmount?: number;
  secondOpinion?: SecondOpinion;
  metrics?: Metrics;
}

const RISK_FLOOR: Record<RiskLevel, number> = { low: 0, medium: 30, high: 60 };

export class RuleScamShield implements ScamShield {
  constructor(private readonly o: ScamShieldOptions) {}

  async assessMessage(text: string, ref: string): Promise<ScamAssessment> {
    const flags = this.messageFlags(text);
    const opinion = this.o.secondOpinion ? await this.o.secondOpinion.check(text) : undefined;
    if (!opinion) return this.assessment({ kind: "message", ref }, flags, text);
    return this.withOpinion({ kind: "message", ref }, flags, opinion, text);
  }

  private async withOpinion(subject: ScamAssessment["subject"], rules: RedFlag[], opinion: Opinion, text: string): Promise<ScamAssessment> {
    const ruled = new Set(rules.map((f) => f.signal));
    let extra = opinion.signals.filter((s) => !ruled.has(s.signal)).map((s) => flag(s.signal, `"${s.quote.length > 160 ? `${s.quote.slice(0, 157)}...` : s.quote}" ${VIA_GEMINI}`));
    if (!MONEY_REQUEST.test(text) && ![...rules, ...extra].some((f) => f.signal === "unusual_method")) extra = extra.filter((f) => f.signal !== "impersonation");
    const rulesRisk = riskOf(Math.min(100, dedupe(rules).reduce((sum, f) => sum + f.weight, 0)));
    const a = await this.assessment(subject, [...rules, ...extra], text);
    if (maxRisk(a.risk, opinion.risk) !== a.risk) {
      a.risk = opinion.risk;
      a.score = Math.max(a.score, RISK_FLOOR[a.risk]);
      a.advice.push(`A second opinion from Gemini rated this message ${a.risk} risk. Check it through a channel you already trust before sending money.`);
    }
    const m = this.o.metrics;
    m?.inc(a.risk === rulesRisk ? "scam.llm.agreed" : "scam.llm.raised");
    if (extra.length) m?.inc("scam.llm.signals.added", extra.length);
    return a;
  }

  async assessTransfer(call: ToolCall, context: { inbound: string[] }): Promise<ScamAssessment> {
    const policy = this.o.policy();
    const flags: RedFlag[] = [];
    const to = String(call.args.to_account ?? "");
    const amount = parseAmount(call.args.amount);
    const wanted = digits(to);
    const payee = policy.savedPayees.find((p) => p.id === to || (wanted.length >= 4 && digits(p.account) === wanted));

    const fromText: RedFlag[] = [];
    for (const text of context.inbound) {
      fromText.push(...this.messageFlags(text));
      const asked = (wanted.length >= 4 && accountNumbersIn(text).includes(wanted)) || (amount !== null && amountsIn(text).some((n) => Math.abs(n - amount) < 0.005));
      if (asked) flags.push(flag("inbound_request", `The forwarded message asks for this payment: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`));
      for (const known of policy.savedPayees) {
        if (text.toLowerCase().includes(known.name.toLowerCase()) && wanted.length >= 4 && digits(known.account) !== wanted)
          flags.push(flag("payee_changed", `The message names ${known.name}, whose account on file ends in ${digits(known.account).slice(-4)}, but asks to pay ${to}.`));
      }
    }
    if (call.tool === "bank.transfer" && !payee) flags.push(flag("new_payee", `${to} is not one of your saved payees.`));
    const name = typeof call.args.payee_name === "string" ? call.args.payee_name : "";
    if (payee && name && !payee.name.toLowerCase().includes(name.toLowerCase()))
      flags.push(flag("name_mismatch", `Account ${to} belongs to ${payee.name} on file, not "${name}".`));
    if (amount !== null && amount >= (this.o.largeAmount ?? 1000)) flags.push(flag("unusual_amount", `${formatUsd(amount)} is a large payment.`));
    return this.assessment({ kind: "transfer", ref: call.id }, [...flags, ...fromText], context.inbound.join("\n"));
  }

  private messageFlags(text: string): RedFlag[] {
    const flags = PATTERNS.filter(([, re]) => re.test(text)).map(([signal, re]) => flag(signal, quote(text, re)));
    if (!MONEY_REQUEST.test(text) && !flags.some((f) => f.signal === "unusual_method")) return flags.filter((f) => f.signal !== "impersonation");
    return flags;
  }

  private async assessment(subject: ScamAssessment["subject"], all: RedFlag[], text: string): Promise<ScamAssessment> {
    const redFlags = dedupe(all).sort((a, b) => b.weight - a.weight);
    const score = Math.min(100, redFlags.reduce((sum, f) => sum + f.weight, 0));
    const signals = new Set(redFlags.map((f) => f.signal));
    const matched = TYPOLOGIES.map((t) => ({ t, hits: t.signals.filter((s) => signals.has(s)).length }))
      .filter((m) => m.hits > 0 && m.t.cue.test(text) && (m.t.id !== "invoice-payee-swap" || signals.has("payee_changed")))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 2)
      .map((m) => m.t);
    const typologies = await Promise.all(matched.map(async (t) => ({ name: t.name, citation: await this.cite(t) })));
    const risk = riskOf(score);
    const advice = matched.flatMap((t) => t.advice).slice(0, 3);
    if (advice.length === 0 && risk !== "low") advice.push("Check the request through a channel you already trust before sending money.");
    return { id: newId("scam"), subject, risk, score, redFlags, typologies, advice };
  }

  private async cite(t: (typeof TYPOLOGIES)[number]): Promise<RagHit> {
    const hits = this.o.retriever ? await this.o.retriever.search(t.query, { collection: "scams", k: 10 }).catch(() => []) : [];
    const hit = hits.find((h) => h.docId === `kb:scams/${t.id}`);
    return hit ?? { docId: `builtin:scam/${t.id}`, title: t.name, excerpt: t.summary, score: 1 };
  }
}
