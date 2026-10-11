import { performance } from "node:perf_hooks";
import { runToolCall, type RunOutcome } from "../policy/run.ts";
import type { Services } from "../services.ts";
import type { Evidence, Finding, ToolCall } from "../types.ts";
import { newId } from "../util.ts";
import { findCompany, type Company } from "./companies.ts";
import { RESEARCH_MANIFEST, RESEARCH_SKILL } from "./index.ts";
import { moneyText, RESEARCH_TOOL_NAMES, RESEARCH_TOOLS, SAMPLE_LABEL, type FactSeries, type FactValue, type Source } from "./tools.ts";

export type ResearchRunner = (tool: string, args: Record<string, unknown>) => Promise<RunOutcome>;

export interface ResearchPlan {
  query: string;
  company?: Company;
  complaintsName?: string;
  bankName?: string;
}

export interface BriefStep {
  skill: string;
  status: "ok" | "cached_sample" | "failed" | "denied" | "skipped";
  ms: number;
  source?: string;
  detail?: string;
}

export interface ResearchBrief {
  turnId: string;
  query: string;
  company: { ticker: string; name: string; cik: string } | null;
  findings: Finding[];
  steps: BriefStep[];
  disclaimer: string;
}

export const DISCLAIMER =
  "Facts from official public sources, with links. FinGuard does not recommend buying, selling or holding any security; for personal advice talk to a licensed professional.";

const BANK_WORDS = /\b(bank|banc|bancorp|credit union|savings|trust company|federal savings|national association|n\.a\.)\b/i;

export function bankNameIn(text: string): string | undefined {
  const m = text.match(/\b(?:is|are)\s+(?!this\b|that\b|it\b|my\b)(.{2,60}?)\s+(?:a\s+)?(?:real|legit(?:imate)?|insured|fdic[- ]insured|fdic[- ]listed|a real bank|safe)\b/i);
  const name = m?.[1]?.replace(/^(the|a)\s+/i, "").trim();
  return name && BANK_WORDS.test(name) ? name : undefined;
}

export function subjectOf(query: string): string {
  return query
    .replace(/[?!]+$/g, "")
    .replace(/^\s*(please\s+)?(research|look up|lookup|check|brief me on|give me a brief on|tell me how|how is|how's|how are|is|are)\s+/i, "")
    .replace(/\s+(doing|performing|real|legit(imate)?|insured|fdic[- ]insured|a real bank)\s*$/i, "")
    .trim()
    .slice(0, 80);
}

export function planResearch(query: string): ResearchPlan {
  const company = findCompany(query);
  const subject = subjectOf(query);
  const bank = bankNameIn(query) ?? (BANK_WORDS.test(subject) ? subject : undefined);
  return {
    query,
    ...(company ? { company } : {}),
    ...(company?.cfpb ? { complaintsName: company.cfpb } : !company && subject.length >= 2 ? { complaintsName: subject } : {}),
    ...(company?.fdic ? { bankName: company.fdic } : bank ? { bankName: bank } : {}),
  };
}

interface Ran {
  tool: string;
  outcome?: RunOutcome;
  ms: number;
}

function data<T>(r: Ran | undefined): T | undefined {
  return r?.outcome?.status === "executed" && r.outcome.result.ok ? (r.outcome.result.data as T) : undefined;
}

function stepOf(r: Ran): BriefStep {
  const o = r.outcome;
  const base = { skill: r.tool, ms: Math.round(r.ms) };
  if (!o) return { ...base, status: "skipped" };
  if (o.status === "denied") return { ...base, status: "denied", detail: o.decision.reasons.filter((x) => x.verdict === "deny").map((x) => x.message).join(" ") };
  if (o.status !== "executed") return { ...base, status: "failed", detail: "error" in o ? o.error : o.status };
  if (!o.result.ok) return { ...base, status: "failed", detail: o.result.error ?? "The tool failed." };
  const d = o.result.data as { live?: boolean; source?: Source };
  return { ...base, status: d.live === false ? "cached_sample" : "ok", ...(d.source ? { source: d.source.url } : {}) };
}

export async function runResearch(plan: ResearchPlan, run: ResearchRunner, now = new Date()): Promise<{ findings: Finding[]; steps: BriefStep[]; ran: Ran[] }> {
  const calls: [string, Record<string, unknown>][] = [];
  if (plan.company) calls.push([RESEARCH_TOOLS.secFacts.name, { ticker: plan.company.ticker }], [RESEARCH_TOOLS.secFilings.name, { ticker: plan.company.ticker, limit: 6 }]);
  calls.push([RESEARCH_TOOLS.treasuryRates.name, {}]);
  if (plan.complaintsName) calls.push([RESEARCH_TOOLS.cfpbComplaints.name, { company: plan.complaintsName }]);
  if (plan.bankName) calls.push([RESEARCH_TOOLS.fdicBank.name, { name: plan.bankName }]);

  const ran = await Promise.all(
    calls.map(async ([tool, args]): Promise<Ran> => {
      const started = performance.now();
      const outcome = await run(tool, args);
      return { tool, outcome, ms: performance.now() - started };
    }),
  );
  const byTool = (name: string) => ran.find((r) => r.tool === name);
  const createdAt = now.toISOString();
  const findings = [
    factsFinding(data<FactsData>(byTool(RESEARCH_TOOLS.secFacts.name)), createdAt),
    filingsFinding(data<FilingsData>(byTool(RESEARCH_TOOLS.secFilings.name)), createdAt),
    fdicFinding(data<FdicData>(byTool(RESEARCH_TOOLS.fdicBank.name)), createdAt),
    complaintsFinding(data<CfpbData>(byTool(RESEARCH_TOOLS.cfpbComplaints.name)), createdAt),
    treasuryFinding(data<TreasuryData>(byTool(RESEARCH_TOOLS.treasuryRates.name)), createdAt),
  ].filter((f): f is Finding => !!f);
  const skipped = RESEARCH_TOOL_NAMES.filter((t) => !calls.some(([name]) => name === t)).map((t): Ran => ({ tool: t, ms: 0 }));
  return { findings, steps: [...ran, ...skipped].map(stepOf), ran };
}

export async function buildResearchBrief(s: Services, input: { query: string }): Promise<ResearchBrief> {
  const query = input.query.trim().slice(0, 200);
  const turnId = newId("turn");
  const plan = planResearch(query);
  s.trace.append("turn_started", { kind: "research", source: "desk", summary: `Research brief: "${(subjectOf(query) || query).slice(0, 120)}"` }, turnId);
  s.trace.append(
    "agent_step",
    {
      agent: "advisor",
      step: "scope",
      detail: `research brief for "${subjectOf(query) || query}": skill pack ${RESEARCH_MANIFEST.name} (${RESEARCH_MANIFEST.capabilities.map((c) => c.capability).join(", ")}), public data only`,
      tools: RESEARCH_TOOL_NAMES,
      ok: true,
    },
    turnId,
  );
  const run: ResearchRunner = (tool, args) => {
    const call: ToolCall = { id: newId("call"), turnId, tool, args, skill: RESEARCH_SKILL, activeSkills: [RESEARCH_SKILL], requestedBy: "app" };
    return runToolCall(call, s);
  };
  const { findings, steps } = await runResearch(plan, run);
  return {
    turnId,
    query,
    company: plan.company ? { ticker: plan.company.ticker, name: plan.company.name, cik: plan.company.cik } : null,
    findings,
    steps,
    disclaimer: DISCLAIMER,
  };
}

interface CompanyRef {
  ticker: string;
  cik: string;
  name: string;
}
interface FactsData {
  company: CompanyRef;
  metrics: FactSeries[];
  live: boolean;
  source: Source;
}
interface FilingsData {
  company: CompanyRef;
  filings: { form: string; kind: string; filed: string; reportDate?: string; url: string; status: string }[];
  live: boolean;
  source: Source;
}
interface TreasuryData {
  recordDate: string;
  rates: { security: string; rate: number; display: string }[];
  note: string;
  source: Source;
}
interface FdicData {
  query: string;
  matches: { name: string; cert: number; active: boolean; city: string; state: string; url: string }[];
  activeMatches: number;
  listed: boolean;
  verdict: string;
  note: string;
  source: Source;
}
interface CfpbData {
  query: string;
  company: string | null;
  total: number;
  topIssues: { issue: string; count: number }[];
  lastUpdated?: string;
  note?: string;
  source: Source;
}

const sampleTag = (live: boolean) => (live ? "" : ` (${SAMPLE_LABEL})`);
const count = (n: number) => n.toLocaleString("en-US");

function factsFinding(d: FactsData | undefined, createdAt: string): Finding | undefined {
  if (!d) return undefined;
  const metric = (key: string) => d.metrics.find((m) => m.key === key);
  const revenue = metric("revenue");
  const income = metric("net_income");
  const lead = revenue ?? income ?? d.metrics[0]!;
  const last = lead.values.at(-1)!;
  const first = lead.values[0]!;
  const latestOf = (m: FactSeries | undefined) => m?.values.at(-1);
  const incomeLast = latestOf(income);

  const ends = (revenue?.values ?? []).map((v) => v.end).filter((end) => !income || income.values.some((v) => v.end === end));
  const pick = (m: FactSeries, end: string) => m.values.find((v) => v.end === end)!.value;
  const series =
    revenue && ends.length >= 2
      ? [
          { label: "Revenue", points: ends.map((e) => pick(revenue, e)), tone: "info" as const },
          ...(income ? [{ label: "Net income", points: ends.map((e) => pick(income, e)), tone: "ok" as const }] : []),
        ]
      : [{ label: lead.label, points: lead.values.map((v) => v.value), tone: "info" as const }];
  const periods = revenue && ends.length >= 2 ? ends.map((e) => `FY${e.slice(0, 4)}`) : lead.values.map((v) => v.period);

  const line = (m: FactSeries, v: FactValue): Evidence => ({
    label: `${m.label}, ${v.period}: ${v.display} (${v.form} filed ${v.filed})${sampleTag(d.live)}`,
    origin: "reference",
    trusted: true,
    source: `sec:CIK${d.company.cik}#${m.concept}@${v.end}`,
    value: v.value,
    url: v.url,
  });
  const evidence = d.metrics.flatMap((m) => (m.values.length ? [line(m, m.values.at(-1)!)] : []));
  const trend = lead.values.length >= 2 ? `${lead.label} went from ${first.display} in ${first.period} to ${last.display} in ${last.period}` : `${lead.label} was ${last.display} in ${last.period}`;
  const incomeText = incomeLast && lead !== income ? `; net income was ${incomeLast.display} in ${incomeLast.period}` : "";
  return {
    id: `research:${d.company.ticker}/facts`,
    area: "investments",
    tone: "info",
    title: `${d.company.name} (${d.company.ticker}): ${lead.label.toLowerCase()} ${last.display} in ${last.period}${sampleTag(d.live)}`,
    summary: `${trend}${incomeText}, as reported in 10-K filings on SEC EDGAR.${d.live ? "" : " Cached sample, not live."}`,
    metric: { label: `${lead.label}, ${last.period}`, value: last.value, unit: "usd" },
    viz: { kind: "curve", unit: "usd", xLabel: `${periods[0]} to ${periods.at(-1)}, fiscal years (10-K)`, series },
    evidence: [...evidence, { label: d.source.name, origin: "reference", trusted: true, source: `sec:CIK${d.company.cik}`, url: d.source.url }],
    citations: [],
    assumptions: `Values as reported in XBRL company facts; fiscal years end on ${d.company.name}'s own date and are labeled by the year they end. Past results do not predict future results. ${DISCLAIMER}${d.live ? "" : ` ${SAMPLE_LABEL[0]!.toUpperCase()}${SAMPLE_LABEL.slice(1)}: hand-built from filed 10-K reports and possibly out of date; set SEC_USER_AGENT for live SEC data.`}`,
    ask: `What do ${d.company.name}'s filings say about revenue and net income?`,
    simulated: !d.live,
    from: "research",
    createdAt,
  };
}

function filingsFinding(d: FilingsData | undefined, createdAt: string): Finding | undefined {
  if (!d || d.filings.length === 0) return undefined;
  const latest = d.filings[0]!;
  const annual = d.filings.find((f) => f.form.startsWith("10-K"));
  return {
    id: `research:${d.company.ticker}/filings`,
    area: "investments",
    tone: "info",
    title: `${d.company.name}: latest SEC filing is a ${latest.form} filed ${latest.filed}${sampleTag(d.live)}`,
    summary: `${d.filings.length} recent filings on SEC EDGAR${annual ? `; the latest annual report (10-K) was filed ${annual.filed}` : ""}. Each links to the filing on sec.gov.${d.live ? "" : " Cached sample, not live."}`,
    viz: { kind: "timeline", items: [...d.filings].reverse().map((f) => ({ date: f.filed, label: `${f.form} ${f.kind}`, tone: f.form.startsWith("10-K") ? ("info" as const) : ("muted" as const) })) },
    evidence: d.filings.map((f) => ({
      label: `${f.form} (${f.kind}) filed ${f.filed}${f.reportDate ? `, period ${f.reportDate}` : ""}${sampleTag(d.live)}`,
      origin: "reference" as const,
      trusted: true,
      source: `sec:CIK${d.company.cik}#${f.form}@${f.filed}`,
      url: f.url,
    })),
    citations: [],
    assumptions: DISCLAIMER,
    ask: `What did ${d.company.name} report in its latest ${latest.form}?`,
    simulated: !d.live,
    from: "research",
    createdAt,
  };
}

function treasuryFinding(d: TreasuryData | undefined, createdAt: string): Finding | undefined {
  if (!d) return undefined;
  const rate = (name: string) => d.rates.find((r) => r.security === name);
  const bills = rate("Treasury Bills");
  const notes = rate("Treasury Notes");
  const bonds = rate("Treasury Bonds");
  const parts = [bills && `bills ${bills.display}`, notes && `notes ${notes.display}`, bonds && `bonds ${bonds.display}`].filter(Boolean).join(", ");
  return {
    id: `research:treasury/${d.recordDate}`,
    area: "investments",
    tone: "info",
    title: `Treasury average rates for ${d.recordDate}: ${parts}`,
    summary: `Average interest rates on outstanding marketable U.S. Treasury debt for the month ending ${d.recordDate}: ${parts}. These are averages on debt already issued, not today's market yields.`,
    ...(bills ? { metric: { label: "Treasury bills, average rate", value: bills.rate, unit: "pct" as const } } : {}),
    ...(bills && notes ? { viz: { kind: "compare" as const, unit: "pct" as const, before: { label: "Treasury bills", value: bills.rate }, after: { label: "Treasury notes", value: notes.rate } } } : {}),
    evidence: d.rates.map((r) => ({
      label: `${r.security}: ${r.display} average, ${d.recordDate}`,
      origin: "reference" as const,
      trusted: true,
      source: `treasury:avg_interest_rates#${r.security}@${d.recordDate}`,
      url: d.source.url,
    })),
    citations: [],
    assumptions: `${d.note} ${DISCLAIMER}`,
    ask: "What do the Treasury's average interest rates measure?",
    simulated: false,
    from: "research",
    createdAt,
  };
}

function fdicFinding(d: FdicData | undefined, createdAt: string): Finding | undefined {
  if (!d) return undefined;
  const active = d.matches.filter((m) => m.active);
  const top = active[0] ?? d.matches[0];
  const listed = d.listed && top;
  return {
    id: `research:fdic/${d.query.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    area: "investments",
    tone: listed ? "info" : "warn",
    title: listed ? `${top.name} is listed by the FDIC (certificate ${top.cert}, ${top.city}, ${top.state})` : `No active FDIC-listed bank matches "${d.query}"`,
    summary: listed
      ? `FDIC BankFind lists ${d.activeMatches} active institution(s) matching "${d.query}". ${d.note}`
      : `FDIC BankFind has no active institution named like "${d.query}"${d.matches.length ? ` (${d.matches.length} other or inactive result(s))` : ""}. Check the exact name on BankFind before sending money or personal details.`,
    evidence: [
      ...d.matches.slice(0, 5).map((m) => ({
        label: `${m.name}: certificate ${m.cert}, ${m.active ? "active" : "inactive"}, ${m.city}, ${m.state}`,
        origin: "reference" as const,
        trusted: true,
        source: `fdic:cert#${m.cert}`,
        url: m.url,
      })),
      { label: d.source.name, origin: "reference" as const, trusted: true, source: "fdic:bankfind", url: d.source.url },
    ],
    citations: [],
    assumptions: d.note,
    ask: `Is ${d.query} an FDIC-insured bank?`,
    simulated: false,
    from: "research",
    createdAt,
  };
}

function complaintsFinding(d: CfpbData | undefined, createdAt: string): Finding | undefined {
  if (!d) return undefined;
  if (!d.company)
    return {
      id: `research:cfpb/${d.query.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      area: "investments",
      tone: "info",
      title: `No CFPB complaints found for "${d.query}"`,
      summary: `The CFPB Consumer Complaint Database has no company named like "${d.query}".`,
      evidence: [{ label: d.source.name, origin: "reference", trusted: true, source: "cfpb:complaints", url: d.source.url }],
      citations: [],
      simulated: false,
      from: "research",
      createdAt,
    };
  const issues = d.topIssues.slice(0, 5);
  const top = issues[0];
  return {
    id: `research:cfpb/${d.company.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    area: "investments",
    tone: "info",
    title: `${count(d.total)} CFPB complaints name ${d.company}`,
    summary: `The CFPB Consumer Complaint Database lists ${count(d.total)} complaints about ${d.company}${top ? `; the most common issue is "${top.issue}" (${count(top.count)})` : ""}. Complaints are not verified and grow with a company's size, so this is not a rating.`,
    ...(issues.length ? { viz: { kind: "bars" as const, unit: "number" as const, items: issues.map((i, n) => ({ label: i.issue, value: i.count, tone: n === 0 ? ("warn" as const) : ("muted" as const) })) } } : {}),
    evidence: [
      { label: `${count(d.total)} complaints about ${d.company}${d.lastUpdated ? ` (data updated ${d.lastUpdated.slice(0, 10)})` : ""}`, origin: "reference", trusted: true, source: "cfpb:complaints", url: d.source.url },
      ...issues.map((i) => ({ label: `${i.issue}: ${count(i.count)} complaints`, origin: "reference" as const, trusted: true, source: `cfpb:issue#${i.issue}`, url: d.source.url })),
    ],
    citations: [],
    assumptions: d.note ?? "",
    ask: `What do people complain about most with ${d.company}?`,
    simulated: false,
    from: "research",
    createdAt,
  };
}
