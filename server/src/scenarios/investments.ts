import { scamFinding } from "../findings/normalize.ts";
import type { Finding, Retriever, ScamShield } from "../types.ts";
import { cite, pct, references, round2, usd, usd0 } from "./common.ts";
import { FEE_DRAG, INDEX_FUND, INVESTMENT_ACCOUNTS, INVESTMENT_PITCH, SIMULATED_NOTE } from "./data.ts";

export function growthPath(balance: number, grossReturn: number, expenseRatio: number, years: number): number[] {
  if (!(balance >= 0) || !Number.isInteger(years) || years < 0 || years > 100) throw new Error("Invalid growth inputs");
  const out = [round2(balance)];
  let value = balance;
  for (let y = 1; y <= years; y++) {
    value *= 1 + grossReturn - expenseRatio;
    out.push(round2(value));
  }
  return out;
}

export interface FeeDrag {
  balance: number;
  years: number;
  grossReturn: number;
  heldRatio: number;
  indexRatio: number;
  heldPath: number[];
  indexPath: number[];
  heldFinal: number;
  indexFinal: number;
  drag: number;
  feesThisYearHeld: number;
  feesThisYearIndex: number;
}

export function feeDrag(): FeeDrag {
  const holding = INVESTMENT_ACCOUNTS.flatMap((a) => a.holdings).find((h) => h.id === FEE_DRAG.holdingId)!;
  const heldPath = growthPath(holding.value, FEE_DRAG.grossReturn, holding.expenseRatio, FEE_DRAG.years);
  const indexPath = growthPath(holding.value, FEE_DRAG.grossReturn, INDEX_FUND.expenseRatio, FEE_DRAG.years);
  const heldFinal = heldPath.at(-1)!;
  const indexFinal = indexPath.at(-1)!;
  return {
    balance: holding.value,
    years: FEE_DRAG.years,
    grossReturn: FEE_DRAG.grossReturn,
    heldRatio: holding.expenseRatio,
    indexRatio: INDEX_FUND.expenseRatio,
    heldPath,
    indexPath,
    heldFinal,
    indexFinal,
    drag: round2(indexFinal - heldFinal),
    feesThisYearHeld: round2(holding.value * holding.expenseRatio),
    feesThisYearIndex: round2(holding.value * INDEX_FUND.expenseRatio),
  };
}

export function investmentTotal(): number {
  return round2(INVESTMENT_ACCOUNTS.flatMap((a) => a.holdings).reduce((sum, h) => sum + h.value, 0));
}

const ILLUSTRATIVE = (d: FeeDrag) =>
  `${SIMULATED_NOTE} Illustrative only, not a forecast or investment advice: a constant ${pct(d.grossReturn)} yearly return before fees, compounded yearly, with the expense ratio taken out each year; no contributions, withdrawals, taxes, trading costs or other fees. Real returns vary and can be negative.`;

export async function investmentFindings(input: { now: Date; retriever: Retriever; shield: ScamShield }): Promise<Finding[]> {
  const createdAt = input.now.toISOString();
  const citations = await cite(input.retriever, "kb:investments/fees", "fund expense ratios cost over time");
  const holdings = INVESTMENT_ACCOUNTS.flatMap((a) => a.holdings.map((h) => ({ ...h, account: a })));
  const total = investmentTotal();
  const d = feeDrag();
  const held = holdings.find((h) => h.id === FEE_DRAG.holdingId)!;

  const allocation: Finding = {
    id: "scenario:investments/allocation",
    area: "investments",
    tone: "info",
    title: `${usd0(total)} invested across ${holdings.length} simulated funds`,
    summary: holdings.map((h) => `${h.name.replace(" (simulated)", "")} ${usd(h.value)} (${Math.round((h.value / total) * 100)}%, ${pct(h.expenseRatio)} a year in fees)`).join("; ") + ".",
    metric: { label: "Simulated total", value: total, unit: "usd" },
    viz: { kind: "donut", unit: "usd", items: holdings.map((h) => ({ label: h.name.replace(" (simulated)", ""), value: h.value })) },
    evidence: [
      ...holdings.map((h) => ({
        label: `${h.account.name}: ${h.name}, ${usd(h.value)}, expense ratio ${pct(h.expenseRatio)}`,
        origin: "bank_record" as const,
        trusted: true,
        source: `sim.investments#${h.account.id}.${h.id}`,
        value: h.value,
      })),
      ...references(citations),
    ],
    citations,
    assumptions: `${SIMULATED_NOTE} Balances are fixed demo values, not market prices. Education only, not investment advice.`,
    ask: "How is my simulated money split between funds, and what does each one cost a year?",
    simulated: true,
    from: "scenario",
    createdAt,
  };

  const compare: Finding = {
    id: "scenario:investments/fee-compare",
    area: "investments",
    tone: "info",
    title: `Fund fees: ${pct(d.heldRatio)} vs ${pct(d.indexRatio)} a year`,
    summary: `On the simulated ${usd(d.balance)} balance, a ${pct(d.heldRatio)} expense ratio costs about ${usd(d.feesThisYearHeld)} this year; at ${pct(d.indexRatio)} it would be about ${usd(d.feesThisYearIndex)}. Illustrative fee math, not a recommendation to buy or sell.`,
    metric: { label: "Fee gap this year", value: round2(d.feesThisYearHeld - d.feesThisYearIndex), unit: "usd_year" },
    viz: { kind: "compare", unit: "pct", before: { label: held.name, value: round2(d.heldRatio * 100) }, after: { label: INDEX_FUND.name, value: round2(d.indexRatio * 100) } },
    evidence: [
      { label: `${held.name}: ${usd(held.value)}, expense ratio ${pct(held.expenseRatio)}`, origin: "bank_record", trusted: true, source: `sim.investments#brokerage.${held.id}`, value: held.value },
      { label: `${INDEX_FUND.name}: expense ratio ${pct(INDEX_FUND.expenseRatio)}`, origin: "bank_record", trusted: true, source: `sim.funds#${INDEX_FUND.id}` },
      {
        label: `${usd(d.balance)} × ${pct(d.heldRatio)} = ${usd(d.feesThisYearHeld)}; ${usd(d.balance)} × ${pct(d.indexRatio)} = ${usd(d.feesThisYearIndex)}`,
        origin: "calculation",
        trusted: true,
        source: "calc:investments/fees-this-year",
        value: round2(d.feesThisYearHeld - d.feesThisYearIndex),
      },
      ...references(citations),
    ],
    citations,
    assumptions: `${SIMULATED_NOTE} Expense ratios only; loads, trading costs and taxes are left out. Education, not investment advice.`,
    ask: "What is an expense ratio, and what does mine cost each year?",
    simulated: true,
    from: "scenario",
    createdAt,
  };

  const drag: Finding = {
    id: "scenario:investments/fee-drag",
    area: "investments",
    tone: "info",
    title: `Over ${d.years} years, fees could cost about ${usd0(d.drag)} (illustrative)`,
    summary: `At an illustrative ${pct(d.grossReturn)} yearly return before fees, ${usd(d.balance)} grows to about ${usd(d.heldFinal)} at ${pct(d.heldRatio)} a year in fees, or ${usd(d.indexFinal)} at ${pct(d.indexRatio)}, after ${d.years} years.`,
    metric: { label: `Fee drag over ${d.years} years`, value: d.drag, unit: "usd" },
    viz: {
      kind: "curve",
      unit: "usd",
      xLabel: "Years from now",
      series: [
        { label: `${pct(d.heldRatio)} expense ratio`, points: d.heldPath, tone: "warn" },
        { label: `${pct(d.indexRatio)} expense ratio`, points: d.indexPath, tone: "ok" },
      ],
    },
    evidence: [
      { label: `${held.name}: ${usd(held.value)}`, origin: "bank_record", trusted: true, source: `sim.investments#brokerage.${held.id}`, value: held.value },
      {
        label: `${usd(d.balance)} × (1 + ${pct(d.grossReturn)} − ${pct(d.heldRatio)})^${d.years} = ${usd(d.heldFinal)}; × (1 + ${pct(d.grossReturn)} − ${pct(d.indexRatio)})^${d.years} = ${usd(d.indexFinal)}`,
        origin: "calculation",
        trusted: true,
        source: "calc:investments/fee-drag",
        value: d.drag,
      },
      ...references(citations),
    ],
    citations,
    assumptions: ILLUSTRATIVE(d),
    ask: `How do fund fees add up over ${d.years} years?`,
    simulated: true,
    from: "scenario",
    createdAt,
  };

  const text = INVESTMENT_PITCH.text;
  const assessed = await input.shield.assessMessage(text, `message:${INVESTMENT_PITCH.id}`);
  const scam = scamFinding({ ...assessed, id: "scenario-investment-pitch" }, { text, area: "investments", createdAt, simulated: true });
  const yearOfClaim = round2(1000 * Math.pow(1 + INVESTMENT_PITCH.claimedDailyReturn, 365));
  const pitch: Finding = {
    ...scam,
    summary: `A simulated message promises guaranteed returns of ${pct(INVESTMENT_PITCH.claimedDailyReturn)} a day. ${scam.summary}`,
    evidence: [
      ...scam.evidence,
      {
        label: `Reality check: ${pct(INVESTMENT_PITCH.claimedDailyReturn)} a day for a year would turn ${usd(1000)} into ${usd(yearOfClaim)}. No real investment can promise that.`,
        origin: "calculation",
        trusted: true,
        source: "calc:investments/claimed-return",
        value: yearOfClaim,
      },
    ],
    assumptions: `${SIMULATED_NOTE} ${scam.assumptions ?? ""}`.trim(),
    ask: "Why is a promise of guaranteed daily returns a warning sign?",
    from: "scenario",
  };
  return [pitch, drag, compare, allocation];
}
