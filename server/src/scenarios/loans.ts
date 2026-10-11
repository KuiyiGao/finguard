import { scamFinding } from "../findings/normalize.ts";
import type { Evidence, Finding, Retriever, ScamShield } from "../types.ts";
import { cite, pct, references, round2, usd, usd0 } from "./common.ts";
import { LOAN_RELIEF_MESSAGE, LOANS, REFINANCE_OFFER, SIMULATED_NOTE } from "./data.ts";

export function monthlyPayment(principal: number, apr: number, months: number): number {
  if (!(principal > 0) || !Number.isInteger(months) || months < 1 || !(apr >= 0) || apr > 1) throw new Error("Invalid loan terms");
  const r = apr / 12;
  return r === 0 ? principal / months : (principal * r) / (1 - Math.pow(1 + r, -months));
}

export function balanceSchedule(principal: number, apr: number, months: number): number[] {
  const r = apr / 12;
  const payment = monthlyPayment(principal, apr, months);
  const out = [round2(principal)];
  let balance = principal;
  for (let m = 1; m <= months; m++) {
    balance = balance * (1 + r) - payment;
    out.push(round2(Math.max(0, balance)));
  }
  return out;
}

export interface RefinanceComparison {
  currentPayment: number;
  newPayment: number;
  monthlySaving: number;
  currentInterest: number;
  newInterest: number;
  fee: number;
  currentTotal: number;
  newTotal: number;
  netSaving: number;
  breakEvenMonth: number | null;
}

export function compareRefinance(loan: { balance: number; apr: number; monthsLeft: number }, offer: { apr: number; months: number; fee: number }): RefinanceComparison {
  const currentPayment = round2(monthlyPayment(loan.balance, loan.apr, loan.monthsLeft));
  const newPayment = round2(monthlyPayment(loan.balance, offer.apr, offer.months));
  const monthlySaving = round2(currentPayment - newPayment);
  const currentTotal = round2(currentPayment * loan.monthsLeft);
  const newPayments = round2(newPayment * offer.months);
  const newTotal = round2(newPayments + offer.fee);
  let breakEvenMonth: number | null = null;
  if (offer.fee <= 0) breakEvenMonth = 0;
  else if (monthlySaving > 0) {
    const month = Math.ceil(offer.fee / monthlySaving - 1e-9);
    breakEvenMonth = month <= Math.min(loan.monthsLeft, offer.months) ? month : null;
  }
  return {
    currentPayment,
    newPayment,
    monthlySaving,
    currentInterest: round2(currentTotal - loan.balance),
    newInterest: round2(newPayments - loan.balance),
    fee: offer.fee,
    currentTotal,
    newTotal,
    netSaving: round2(currentTotal - newTotal),
    breakEvenMonth,
  };
}

export function sample(points: number[], max = 49): number[] {
  if (points.length <= max) return points;
  return Array.from({ length: max }, (_, i) => points[Math.round((i * (points.length - 1)) / (max - 1))]!);
}

const pad = (points: number[], length: number) => [...points, ...Array<number>(Math.max(0, length - points.length)).fill(0)];

export interface LoanTotals {
  balance: number;
  monthlyPayments: number;
  refinanceMonthlySaving: number;
}

export function loanTotals(): LoanTotals {
  const loan = LOANS.find((l) => l.id === REFINANCE_OFFER.loanId)!;
  return {
    balance: round2(LOANS.reduce((sum, l) => sum + l.balance, 0)),
    monthlyPayments: round2(LOANS.reduce((sum, l) => sum + round2(monthlyPayment(l.balance, l.apr, l.monthsLeft)), 0)),
    refinanceMonthlySaving: compareRefinance(loan, REFINANCE_OFFER).monthlySaving,
  };
}

const loanRecord = (l: (typeof LOANS)[number]): Evidence => ({
  label: `${l.name}: ${usd(l.balance)} owed at ${pct(l.apr)} APR, ${l.monthsLeft} months left`,
  origin: "bank_record",
  trusted: true,
  source: `sim.loans#${l.id}`,
  value: l.balance,
});

export async function loanFindings(input: { now: Date; retriever: Retriever; shield: ScamShield }): Promise<Finding[]> {
  const createdAt = input.now.toISOString();
  const loan = LOANS.find((l) => l.id === REFINANCE_OFFER.loanId)!;
  const offer = REFINANCE_OFFER;
  const cmp = compareRefinance(loan, offer);
  const citations = await cite(input.retriever, "kb:loans/auto-refinance", "refinancing a car loan lower rate prepayment penalty fee payment");
  const totals = loanTotals();
  const length = Math.max(loan.monthsLeft, offer.months) + 1;

  const overview: Finding = {
    id: "scenario:loans/overview",
    area: "loans",
    tone: "info",
    title: `${usd0(totals.balance)} owed across ${LOANS.length} simulated loans`,
    summary: LOANS.map((l) => `${l.name.replace(" (simulated)", "")}: ${usd(l.balance)} at ${pct(l.apr)}, ${usd(round2(monthlyPayment(l.balance, l.apr, l.monthsLeft)))} a month for ${l.monthsLeft} more months`).join(". ") + ".",
    metric: { label: "Monthly payments", value: totals.monthlyPayments, unit: "usd_month" },
    viz: { kind: "bars", unit: "usd", items: LOANS.map((l) => ({ label: l.name.replace(" (simulated)", ""), value: l.balance, tone: l.apr >= 0.08 ? ("warn" as const) : ("info" as const) })) },
    evidence: [
      ...LOANS.map(loanRecord),
      {
        label: `Payments: ${LOANS.map((l) => usd(round2(monthlyPayment(l.balance, l.apr, l.monthsLeft)))).join(" + ")} = ${usd(totals.monthlyPayments)} a month (P×r ÷ (1 − (1+r)^−n))`,
        origin: "calculation",
        trusted: true,
        source: "calc:loans/payments",
        value: totals.monthlyPayments,
      },
      ...references(citations),
    ],
    citations,
    assumptions: `${SIMULATED_NOTE} Fixed rates and level monthly payments, rounded to the cent.`,
    ask: "What are my simulated loans costing me each month, and how much of it is interest?",
    simulated: true,
    from: "scenario",
    createdAt,
  };

  const refinance: Finding = {
    id: "scenario:loans/auto-refinance",
    area: "loans",
    tone: cmp.netSaving > 0 ? "save" : "info",
    title: cmp.monthlySaving > 0 ? `Refinancing the auto loan could save ${usd(cmp.monthlySaving)} a month` : "Refinancing the auto loan would not lower the payment",
    summary:
      `At ${pct(loan.apr)} APR the auto loan costs ${usd(cmp.currentPayment)} a month; the simulated ${pct(offer.apr)} offer costs ${usd(cmp.newPayment)}. ` +
      `After the ${usd(offer.fee)} fee you would pay ${usd(cmp.netSaving)} less over ${offer.months} months` +
      (cmp.breakEvenMonth !== null ? `, breaking even in month ${cmp.breakEvenMonth}.` : "; the fee is never paid back."),
    metric: { label: "Monthly saving", value: cmp.monthlySaving, unit: "usd_month" },
    viz: {
      kind: "curve",
      unit: "usd",
      xLabel: "Months from now",
      series: [
        { label: `Current loan, ${pct(loan.apr)} APR`, points: sample(pad(balanceSchedule(loan.balance, loan.apr, loan.monthsLeft), length)), tone: "bad" },
        { label: `Refinanced, ${pct(offer.apr)} APR (simulated offer)`, points: sample(pad(balanceSchedule(loan.balance, offer.apr, offer.months), length)), tone: "ok" },
      ],
    },
    evidence: [
      loanRecord(loan),
      {
        label: `${offer.lender} offer: ${pct(offer.apr)} APR for ${offer.months} months, ${usd(offer.fee)} fee`,
        origin: "bank_record",
        trusted: true,
        source: `sim.offers#${offer.id}`,
        value: offer.fee,
      },
      {
        label: `Payment ${usd(cmp.currentPayment)} now vs ${usd(cmp.newPayment)} refinanced, from P×r ÷ (1 − (1+r)^−n)`,
        origin: "calculation",
        trusted: true,
        source: "calc:loans/payment",
        value: cmp.monthlySaving,
      },
      {
        label: `Interest still to pay: ${usd(cmp.currentInterest)} now vs ${usd(cmp.newInterest)} refinanced, plus the ${usd(offer.fee)} fee; ${usd(cmp.netSaving)} less in total`,
        origin: "calculation",
        trusted: true,
        source: "calc:loans/total-cost",
        value: cmp.netSaving,
      },
      ...(cmp.breakEvenMonth !== null
        ? [{ label: `Break-even in month ${cmp.breakEvenMonth}: ${usd(offer.fee)} fee ÷ ${usd(cmp.monthlySaving)} saved a month`, origin: "calculation" as const, trusted: true, source: "calc:loans/break-even" }]
        : []),
      ...references(citations),
    ],
    citations,
    assumptions: `${SIMULATED_NOTE} Fixed rates; payments rounded to the cent; the ${usd(offer.fee)} fee is paid at signing, not added to the loan; no prepayment penalty on the current loan; same ${offer.months}-month term. Illustrative math, not a recommendation: check the lender's written terms.`,
    ask: "How does the refinance offer compare with my auto loan once the fee is counted?",
    simulated: true,
    from: "scenario",
    createdAt,
  };

  const text = LOAN_RELIEF_MESSAGE.text;
  const assessed = await input.shield.assessMessage(text, `message:${LOAN_RELIEF_MESSAGE.id}`);
  const scam = scamFinding({ ...assessed, id: "scenario-loan-relief" }, { text, area: "loans", createdAt, simulated: true });
  const relief: Finding = {
    ...scam,
    summary: `A simulated text asks for a ${usd(LOAN_RELIEF_MESSAGE.fee)} fee up front for student loan forgiveness. ${scam.summary}`,
    assumptions: `${SIMULATED_NOTE} ${scam.assumptions ?? ""}`.trim(),
    ask: "What are the warning signs in this loan forgiveness message?",
    from: "scenario",
  };
  return [refinance, relief, overview];
}
