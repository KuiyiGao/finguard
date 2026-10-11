import type { Evidence, Finding, Retriever, Tone } from "../types.ts";
import { addDays, cite, DAY, isoDate, references, round2, shortDate, usd } from "./common.ts";
import { CONTRACT, contractText, SIMULATED_NOTE } from "./data.ts";

export interface Clause {
  label: string;
  tone: Tone;
  start: number;
  end: number;
  quote: string;
  amount?: number;
}

export const CLAUSE_RULES: { label: string; tone: Tone; re: RegExp }[] = [
  { label: "Auto-renews", tone: "warn", re: /\b(?:renews?|will renew) automatically\b[^.\n]*|\bautomatic(?:ally)? renew(?:s|al|ed)?\b[^.\n]*/i },
  { label: "How to cancel", tone: "warn", re: /\b(?:send|mail|give|provide|deliver)\b[^.\n]{0,40}\bnotice\b[^.\n]*|\bcertified mail\b[^.\n]*/i },
  { label: "Early termination fee", tone: "bad", re: /\b(?:early termination|early cancellation|cancellation) fee\b(?: of)? \$\d[\d,]*(?:\.\d{2})?/i },
  { label: "Extra fee", tone: "warn", re: /\b(?:annual maintenance|maintenance|annual|enhancement|facility|processing|activation) fee\b(?: of)? \$\d[\d,]*(?:\.\d{2})?/i },
  { label: "Price can change", tone: "warn", re: /\bmay (?:change|increase|raise)\b[^.\n]*\b(?:dues|prices?|fees?|rates?)\b[^.\n]*/i },
  { label: "Arbitration", tone: "info", re: /\b(?:binding )?arbitration\b[^.\n]*/i },
];

export function extractClauses(text: string): Clause[] {
  const found: Clause[] = [];
  for (const rule of CLAUSE_RULES) {
    const m = rule.re.exec(text);
    if (!m) continue;
    const quote = m[0].trimEnd();
    const dollars = quote.match(/\$\s?(\d[\d,]*(?:\.\d+)?)/);
    found.push({ label: rule.label, tone: rule.tone, start: m.index, end: m.index + quote.length, quote, ...(dollars ? { amount: Number(dollars[1]!.replace(/,/g, "")) } : {}) });
  }
  found.sort((a, b) => a.start - b.start);
  return found.filter((c, i) => found.slice(0, i).every((p) => p.end <= c.start || c.end <= p.start));
}

const daysBetween = (fromIso: string, toIso: string) => Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY);

export interface ContractTerms {
  monthly: number;
  annualFee: number;
  earlyTerminationFee: number | null;
  noticeDays: number;
  renewalCost: number;
  nextCharge: string;
  renewal: string;
  deadline: string;
  daysToDeadline: number;
}

export function contractTerms(now: Date, clauses: Clause[], gym?: { price: number; renews: string }): ContractTerms {
  const monthly = gym?.price ?? CONTRACT.monthlyDues;
  const annualFee = clauses.find((c) => c.label === "Extra fee")?.amount ?? 0;
  const etf = clauses.find((c) => c.label === "Early termination fee")?.amount ?? null;
  const notice = clauses.find((c) => c.label === "How to cancel")?.quote.match(/(\d+)\s+days/);
  const noticeDays = notice ? Number(notice[1]) : CONTRACT.noticeDays;
  const nextCharge = gym?.renews?.slice(0, 10) || isoDate(addDays(now, CONTRACT.daysUntilNextCharge));
  const renewal = isoDate(addDays(new Date(`${nextCharge}T12:00:00Z`), noticeDays));
  const deadline = isoDate(addDays(new Date(`${renewal}T12:00:00Z`), -noticeDays));
  return {
    monthly,
    annualFee,
    earlyTerminationFee: etf,
    noticeDays,
    renewalCost: round2(CONTRACT.termMonths * monthly + annualFee),
    nextCharge,
    renewal,
    deadline,
    daysToDeadline: Math.max(0, daysBetween(isoDate(now), deadline)),
  };
}

export async function contractFindings(input: { now: Date; retriever: Retriever; gym?: { id: string; price: number; renews: string; status: string } }): Promise<{ findings: Finding[]; terms: ContractTerms; cancelled: boolean }> {
  const createdAt = input.now.toISOString();
  const text = contractText();
  const clauses = extractClauses(text);
  const terms = contractTerms(input.now, clauses, input.gym);
  const cancelled = input.gym?.status === "cancelled";
  const citations = await cite(input.retriever, "kb:contracts/auto-renewal", "gym contract renewed automatically cancellation deadline notice");
  const record: Evidence = {
    label: `${CONTRACT.merchant} subscription: ${usd(terms.monthly)} a month, next charge ${shortDate(terms.nextCharge)}${cancelled ? " (cancelled)" : ""}`,
    origin: "bank_record",
    trusted: true,
    source: input.gym ? `stub.subscriptions#${input.gym.id}` : `sim.subscriptions#${CONTRACT.subscriptionId}`,
    value: terms.monthly,
  };
  const clauseEvidence: Evidence[] = clauses.map((c) => ({
    label: c.amount !== undefined ? `${c.label}: ${usd(c.amount)}` : c.label,
    origin: "document",
    trusted: false,
    source: CONTRACT.id,
    quote: c.quote,
    ...(c.amount !== undefined ? { value: c.amount } : {}),
  }));
  const renewalCalc: Evidence = {
    label: `If it renews: ${CONTRACT.termMonths} × ${usd(terms.monthly)} dues + ${usd(terms.annualFee)} annual fee = ${usd(terms.renewalCost)}`,
    origin: "calculation",
    trusted: true,
    source: "calc:contracts/renewal-cost",
    value: terms.renewalCost,
  };
  const deadlineCalc: Evidence = {
    label: `Notice must arrive ${terms.noticeDays} days before the ${shortDate(terms.renewal)} renewal: by ${shortDate(terms.deadline)}`,
    origin: "calculation",
    trusted: true,
    source: "calc:contracts/notice-deadline",
  };
  const assumptions = `${SIMULATED_NOTE} Clauses are found by keyword rules, which can miss or mislabel terms; read the whole agreement. The renewal cost assumes dues and fees stay as written. The app's cancel action reaches the simulated merchant; a real contract may still require the notice method it names (here, certified mail). Not legal advice.`;
  const etfText = terms.earlyTerminationFee !== null ? ` Leaving before the term ends costs a ${usd(terms.earlyTerminationFee)} early termination fee.` : "";

  const review: Finding = {
    id: "scenario:contracts/cloudgym",
    area: "contracts",
    tone: cancelled ? "info" : "warn",
    title: cancelled ? `${CONTRACT.merchant} is cancelled` : `${CONTRACT.merchant} renews for ${CONTRACT.termMonths} more months unless you act by ${shortDate(terms.deadline)}`,
    summary: cancelled
      ? `You cancelled ${CONTRACT.merchant} in the app. The contract also asks for written notice by certified mail ${terms.noticeDays} days before renewal, so keep your confirmation.`
      : `If it renews, the next ${CONTRACT.termMonths} months cost ${usd(terms.renewalCost)} (${CONTRACT.termMonths} × ${usd(terms.monthly)} + ${usd(terms.annualFee)} fee); cancelling before ${shortDate(terms.deadline)} avoids that.${etfText}`,
    metric: { label: "If it renews", value: terms.renewalCost, unit: "usd_year" },
    viz: { kind: "clauses", text, spans: clauses.map(({ start, end, label, tone }) => ({ start, end, label, tone })) },
    evidence: [...clauseEvidence, record, renewalCalc, ...references(citations)],
    citations,
    assumptions,
    ...(cancelled ? {} : { action: { label: `Cancel ${CONTRACT.merchant} before it renews`, tool: "subscriptions.cancel", args: { subscription_id: CONTRACT.subscriptionId } } }),
    ask: `What does the ${CONTRACT.merchant} contract commit me to if I do nothing?`,
    simulated: true,
    from: "scenario",
    createdAt,
  };
  if (cancelled) return { findings: [review], terms, cancelled };

  const dates: Finding = {
    id: "scenario:contracts/cloudgym-dates",
    area: "contracts",
    tone: terms.daysToDeadline <= 14 ? "warn" : "info",
    title: `${terms.daysToDeadline} days left to give ${CONTRACT.merchant} notice`,
    summary: `The contract asks for notice by certified mail at least ${terms.noticeDays} days before the ${shortDate(terms.renewal)} renewal, so it must arrive by ${shortDate(terms.deadline)}. After that it renews for ${CONTRACT.termMonths} months (${usd(terms.renewalCost)}).${etfText}`,
    metric: { label: "Days to give notice", value: terms.daysToDeadline, unit: "days" },
    viz: {
      kind: "timeline",
      items: [
        { date: terms.deadline, label: "Last day for notice to arrive", tone: "warn" as const },
        { date: terms.nextCharge, label: "Next monthly charge", amount: terms.monthly, tone: "muted" as const },
        { date: terms.renewal, label: `Renews for ${CONTRACT.termMonths} months`, amount: terms.renewalCost, tone: "bad" as const },
      ].sort((a, b) => a.date.localeCompare(b.date)),
    },
    evidence: [...clauseEvidence.filter((e) => e.label === "How to cancel" || e.label === "Auto-renews"), record, deadlineCalc, renewalCalc, ...references(citations)],
    citations,
    assumptions,
    ask: `When is the last day to give ${CONTRACT.merchant} notice, and how does it have to be sent?`,
    simulated: true,
    from: "scenario",
    createdAt,
  };
  return { findings: [review, dates], terms, cancelled };
}
