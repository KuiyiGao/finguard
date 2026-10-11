import type { AgentContext } from "../agent/agent.ts";
import { explainOutcome } from "../agent/explain.ts";
import { bankNameIn, planResearch, runResearch, subjectOf } from "./brief.ts";
import { findCompany } from "./companies.ts";
import { RESEARCH_TOOLS, SAMPLE_LABEL, type FactSeries, type Source } from "./tools.ts";

export interface ResearchAsk {
  query: string;
  bank: boolean;
}

const HOW_DOING = /\bhow(?:'s|\s+is|\s+are|\s+has)\s+(?!my\b|our\b|your\b|the market\b|it\b|this\b|that\b|things\b|everything\b|i\b|we\b)(.{1,40}?)\s+(?:doing|performing|been doing)\b/i;
const RESEARCH_VERB = /^\s*(?:please\s+)?(?:research|look up|lookup|brief me on|give me a brief on)\s+\S/i;
const FILING_WORDS = /\b(10-k|10-q|8-k|sec filings?|filings|earnings|annual report|net income|revenue)\b/i;

export function researchAskIn(text: string): ResearchAsk | undefined {
  const t = text.trim();
  if (bankNameIn(t)) return { query: t, bank: true };
  if (RESEARCH_VERB.test(t) || HOW_DOING.test(t)) return { query: t, bank: false };
  if (FILING_WORDS.test(t) && findCompany(t)) return { query: t, bank: false };
  return undefined;
}

interface FdicData {
  query: string;
  matches: { name: string; cert: number; active: boolean; city: string; state: string; url: string }[];
  listed: boolean;
  source: Source;
}

function failure(outcome: Awaited<ReturnType<AgentContext["tool"]>>): string {
  if (outcome.status === "executed" && !outcome.result.ok) return `I could not get that public data: ${outcome.result.error ?? "the source did not answer"}`;
  return explainOutcome(outcome) ?? "I could not get that public data.";
}

async function bankCheck(query: string, ctx: AgentContext): Promise<void> {
  const name = bankNameIn(query) ?? subjectOf(query);
  const outcome = await ctx.tool(RESEARCH_TOOLS.fdicBank.name, { name });
  if (outcome.status !== "executed" || !outcome.result.ok) return ctx.say(failure(outcome));
  const d = outcome.result.data as FdicData;
  const top = d.matches.find((m) => m.active);
  if (d.listed && top)
    return ctx.say(
      `FDIC BankFind lists ${top.name} as an active institution (certificate ${top.cert}, ${top.city}, ${top.state}). ` +
        "A listed name alone does not prove a message came from that bank, so reach the bank through its official website or the number on your card. " +
        `Source: ${top.url}`,
    );
  ctx.say(
    `FDIC BankFind has no active bank named like "${d.query}". Do not move money or share personal details until you confirm the exact name on BankFind. Source: ${d.source.url}`,
  );
}

export async function answerResearch(ask: ResearchAsk, ctx: AgentContext): Promise<void> {
  if (ask.bank) return bankCheck(ask.query, ctx);
  const plan = planResearch(ask.query);
  const { ran } = await runResearch(plan, (tool, args) => ctx.tool(tool, args));
  const result = (tool: string) => {
    const o = ran.find((r) => r.tool === tool)?.outcome;
    return o?.status === "executed" && o.result.ok ? (o.result.data as Record<string, unknown>) : undefined;
  };
  const facts: string[] = [];
  let source: string | undefined;

  const factsData = result(RESEARCH_TOOLS.secFacts.name) as { company: { name: string; ticker: string }; metrics: FactSeries[]; live: boolean; source: Source } | undefined;
  if (factsData) {
    const revenue = factsData.metrics.find((m) => m.key === "revenue");
    const income = factsData.metrics.find((m) => m.key === "net_income");
    const first = revenue?.values[0];
    const last = revenue?.values.at(-1);
    const tag = factsData.live ? "" : ` (${SAMPLE_LABEL})`;
    if (revenue && first && last && first !== last)
      facts.push(`${factsData.company.name} (${factsData.company.ticker}) reported revenue of ${last.display} in ${last.period}, compared with ${first.display} in ${first.period}${tag}.`);
    else if (last) facts.push(`${factsData.company.name} (${factsData.company.ticker}) reported revenue of ${last.display} in ${last.period}${tag}.`);
    const ni = income?.values.at(-1);
    if (ni) facts.push(`Net income was ${ni.display} in ${ni.period}${tag}.`);
    source = last?.url ?? factsData.source.url;
  }
  const filings = result(RESEARCH_TOOLS.secFilings.name) as { filings: { form: string; filed: string; url: string }[]; live: boolean } | undefined;
  if (filings?.filings[0] && facts.length < 3) facts.push(`The latest SEC filing is a ${filings.filings[0].form} filed ${filings.filings[0].filed}${filings.live ? "" : ` (${SAMPLE_LABEL})`}.`);
  const complaints = result(RESEARCH_TOOLS.cfpbComplaints.name) as { company: string | null; total: number; source: Source } | undefined;
  if (complaints?.company && facts.length < 3) {
    facts.push(`The CFPB complaint database lists ${complaints.total.toLocaleString("en-US")} complaints about ${complaints.company}; complaints are unverified and grow with company size.`);
    source ??= complaints.source.url;
  }
  const treasury = result(RESEARCH_TOOLS.treasuryRates.name) as { recordDate: string; rates: { security: string; display: string }[]; source: Source } | undefined;
  if (treasury && facts.length < 3) {
    const bills = treasury.rates.find((r) => r.security === "Treasury Bills");
    if (bills) facts.push(`For context, Treasury bills averaged ${bills.display} in the ${treasury.recordDate} Treasury data.`);
    source ??= treasury.source.url;
  }

  if (facts.length === 0) {
    const first = ran.find((r) => r.outcome && !(r.outcome.status === "executed" && r.outcome.result.ok))?.outcome;
    return ctx.say(first ? failure(first) : `I found no public data for "${subjectOf(ask.query)}".`);
  }
  if (!factsData && plan.company === undefined)
    facts.unshift(`I could not match "${subjectOf(ask.query)}" to a listed company, so here is what public data shows.`);
  ctx.say(`${facts.slice(0, 3).join(" ")}${source ? ` Source: ${source}` : ""} These are facts from public filings and data, not advice.`);
}
