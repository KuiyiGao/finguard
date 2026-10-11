import type { ToolAdapter, ToolResult, ToolSpec } from "../types.ts";
import { companyByTicker, normalizeTicker, type Company } from "./companies.ts";
import { SAMPLE_LABEL, SEC_SAMPLES } from "./fixtures.ts";
import { PublicDataClient, ResearchError, type PublicDataOptions } from "./http.ts";

export { SAMPLE_LABEL } from "./fixtures.ts";

export const RESEARCH_HOSTS = {
  sec: ["data.sec.gov", "www.sec.gov"],
  treasury: ["api.fiscaldata.treasury.gov"],
  fdic: ["api.fdic.gov"],
  cfpb: ["www.consumerfinance.gov"],
} as const;

const ticker = { type: "string", description: "Stock ticker, e.g. AAPL" };

export const RESEARCH_TOOLS = {
  secFilings: {
    name: "research.sec_filings",
    description: "Recent SEC filings (10-K annual, 10-Q quarterly, 8-K current reports) for a public company, with the filing date and a link on sec.gov. Public data only.",
    inputSchema: { type: "object", properties: { ticker, limit: { type: "number", description: "1-20, default 8" } }, required: ["ticker"] },
    effect: "read",
    capability: "research.read",
  },
  secFacts: {
    name: "research.sec_facts",
    description: "Reported financials from SEC XBRL company facts: revenue and net income by fiscal year, total assets, liabilities and cash, each with its form, period end and filing link. Public data only.",
    inputSchema: { type: "object", properties: { ticker }, required: ["ticker"] },
    effect: "read",
    capability: "research.read",
  },
  treasuryRates: {
    name: "research.treasury_rates",
    description: "Latest monthly average interest rates on U.S. Treasury bills, notes and bonds (Treasury FiscalData), with the record date. Public data only.",
    inputSchema: { type: "object", properties: {} },
    effect: "read",
    capability: "research.read",
  },
  fdicBank: {
    name: "research.fdic_bank",
    description: "Look a bank up by name in the FDIC BankFind registry: matching institutions with certificate number, active status, city and state. Public data only.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Bank name, e.g. Capital One" } }, required: ["name"] },
    effect: "read",
    capability: "research.read",
  },
  cfpbComplaints: {
    name: "research.cfpb_complaints",
    description: "Consumer complaints about a company in the CFPB Consumer Complaint Database: the total and the most common issues, optionally for one product. Public data only.",
    inputSchema: {
      type: "object",
      properties: { company: { type: "string", description: "Company name, e.g. Capital One" }, product: { type: "string", description: "Optional CFPB product, e.g. Credit card" } },
      required: ["company"],
    },
    effect: "read",
    capability: "research.read",
  },
} satisfies Record<string, ToolSpec>;

export const RESEARCH_TOOL_NAMES: string[] = Object.values(RESEARCH_TOOLS).map((t) => t.name);

export interface ResearchOptions extends PublicDataOptions {
  secUserAgent?: string;
  bases?: Partial<Record<"sec" | "secWww" | "treasury" | "fdic" | "cfpb", string>>;
}

const DEFAULT_BASES = {
  sec: "https://data.sec.gov",
  secWww: "https://www.sec.gov",
  treasury: "https://api.fiscaldata.treasury.gov",
  fdic: "https://api.fdic.gov",
  cfpb: "https://www.consumerfinance.gov",
};

export interface Source {
  name: string;
  url: string;
  api?: string;
}

export function moneyText(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)} billion`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)} million`;
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const ok = (data: unknown): ToolResult => ({ ok: true, data, systemValues: [], texts: [] });
const fail = (error: string): ToolResult => ({ ok: false, data: null, systemValues: [], texts: [], error });

async function guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    return fail(err instanceof ResearchError ? err.message : `The research tool failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const asRecord = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const asArray = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

export function edgarBrowseUrl(cik: string, form = ""): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${encodeURIComponent(form)}&dateb=&owner=include&count=40`;
}

function filingIndexUrl(cik: string, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${accession}-index.htm`;
}

interface CompanyRef {
  ticker: string;
  cik: string;
  name: string;
}

class Sec {
  readonly client: PublicDataClient;
  constructor(private readonly o: ResearchOptions) {
    this.client = new PublicDataClient("SEC EDGAR", RESEARCH_HOSTS.sec, o);
  }

  get live(): boolean {
    return Boolean(this.o.secUserAgent?.trim());
  }

  private get headers(): Record<string, string> {
    return { "User-Agent": this.o.secUserAgent!.trim() };
  }

  private base(which: "sec" | "secWww"): string {
    return (this.o.bases?.[which] ?? DEFAULT_BASES[which]).replace(/\/+$/, "");
  }

  async company(raw: unknown): Promise<CompanyRef> {
    const t = normalizeTicker(raw);
    if (!t) throw new ResearchError(`"${String(raw ?? "").slice(0, 20)}" is not a stock ticker; use a symbol like AAPL.`);
    const known: Company | undefined = companyByTicker(t);
    if (known) return { ticker: known.ticker, cik: known.cik, name: known.name };
    if (!this.live) throw new ResearchError(`${t} is not in FinGuard's built-in list; other tickers need live SEC access (set SEC_USER_AGENT to a contact email).`);
    const { body } = await this.client.getJson(`${this.base("secWww")}/files/company_tickers.json`, this.headers);
    const row = Object.values(asRecord(body))
      .map(asRecord)
      .find((r) => normalizeTicker(r.ticker) === t);
    if (!row) throw new ResearchError(`SEC EDGAR has no company with ticker ${t}.`);
    return { ticker: t, cik: String(row.cik_str).padStart(10, "0"), name: String(row.title ?? t) };
  }

  async json(kind: "submissions" | "facts", c: CompanyRef): Promise<{ body: unknown; live: boolean; api?: string }> {
    if (this.live) {
      const api = kind === "submissions" ? `${this.base("sec")}/submissions/CIK${c.cik}.json` : `${this.base("sec")}/api/xbrl/companyfacts/CIK${c.cik}.json`;
      return { body: (await this.client.getJson(api, this.headers)).body, live: true, api };
    }
    const sample = SEC_SAMPLES[c.ticker];
    if (!sample)
      throw new ResearchError(`Live SEC data needs SEC_USER_AGENT (a contact email). Without it FinGuard has a cached sample only for ${Object.keys(SEC_SAMPLES).join(" and ")}.`);
    return { body: kind === "submissions" ? sample.submissions : sample.facts, live: false };
  }
}

const FORMS = new Set(["10-K", "10-Q", "8-K", "10-K/A", "10-Q/A", "8-K/A"]);
const FORM_NAMES: Record<string, string> = { "10-K": "annual report", "10-Q": "quarterly report", "8-K": "current report" };

function filingsTool(sec: Sec): ToolAdapter {
  return {
    spec: RESEARCH_TOOLS.secFilings,
    run: (args) =>
      guarded(async () => {
        const company = await sec.company(args.ticker);
        const limit = Math.min(20, Math.max(1, Math.floor(Number(args.limit ?? 8)) || 8));
        const { body, live, api } = await sec.json("submissions", company);
        const recent = asRecord(asRecord(asRecord(body).filings).recent);
        const forms = asArray(recent.form).map(String);
        const filings = forms
          .map((form, i) => {
            const accession = String(asArray(recent.accessionNumber)[i] ?? "");
            const doc = String(asArray(recent.primaryDocument)[i] ?? "");
            return {
              form,
              kind: FORM_NAMES[form.replace("/A", "")] ?? "filing",
              filed: String(asArray(recent.filingDate)[i] ?? ""),
              reportDate: String(asArray(recent.reportDate)[i] ?? "") || undefined,
              url: accession && doc ? `https://www.sec.gov/Archives/edgar/data/${Number(company.cik)}/${accession.replace(/-/g, "")}/${doc}` : edgarBrowseUrl(company.cik, form),
              status: live ? "live" : SAMPLE_LABEL,
            };
          })
          .filter((f) => FORMS.has(f.form) && /^\d{4}-\d{2}-\d{2}$/.test(f.filed))
          .slice(0, limit);
        const source: Source = { name: "SEC EDGAR company filings", url: edgarBrowseUrl(company.cik), ...(api ? { api } : {}) };
        return ok({ company, filings, live, status: live ? "live" : SAMPLE_LABEL, source });
      }),
  };
}

type MetricKey = "revenue" | "net_income" | "assets" | "liabilities" | "cash";
const METRICS: { key: MetricKey; label: string; kind: "duration" | "instant"; concepts: string[] }[] = [
  { key: "revenue", label: "Revenue", kind: "duration", concepts: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"] },
  { key: "net_income", label: "Net income", kind: "duration", concepts: ["NetIncomeLoss", "ProfitLoss"] },
  { key: "assets", label: "Total assets", kind: "instant", concepts: ["Assets"] },
  { key: "liabilities", label: "Total liabilities", kind: "instant", concepts: ["Liabilities"] },
  { key: "cash", label: "Cash and cash equivalents", kind: "instant", concepts: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "Cash"] },
];

export interface FactValue {
  period: string;
  start?: string;
  end: string;
  value: number;
  display: string;
  form: string;
  filed: string;
  url: string;
  status: string;
}

export interface FactSeries {
  key: MetricKey;
  label: string;
  concept: string;
  basis: "fiscal_year" | "period_end";
  values: FactValue[];
}

const DAY = 86_400_000;
const days = (start: string, end: string) => (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY;

function series(def: (typeof METRICS)[number], concept: string, facts: unknown[], cik: string, live: boolean): FactSeries {
  const rows = facts
    .map(asRecord)
    .filter((f) => FORMS.has(String(f.form)) && typeof f.val === "number" && /^\d{4}-\d{2}-\d{2}$/.test(String(f.end)))
    .filter((f) =>
      def.kind === "duration"
        ? String(f.form).startsWith("10-K") && typeof f.start === "string" && days(String(f.start), String(f.end)) >= 350 && days(String(f.start), String(f.end)) <= 380
        : f.start === undefined && (String(f.form).startsWith("10-K") || String(f.form).startsWith("10-Q")),
    );
  const byEnd = new Map<string, Record<string, unknown>>();
  for (const f of rows) {
    const prev = byEnd.get(String(f.end));
    if (!prev || String(f.filed) > String(prev.filed)) byEnd.set(String(f.end), f);
  }
  const values = [...byEnd.values()]
    .sort((a, b) => String(a.end).localeCompare(String(b.end)))
    .slice(-8)
    .map((f) => {
      const accession = typeof f.accn === "string" ? f.accn : "";
      const value = f.val as number;
      return {
        period: def.kind === "duration" ? `FY${String(f.end).slice(0, 4)}` : String(f.end),
        ...(typeof f.start === "string" ? { start: f.start } : {}),
        end: String(f.end),
        value,
        display: moneyText(value),
        form: String(f.form),
        filed: String(f.filed ?? ""),
        url: accession ? filingIndexUrl(cik, accession) : edgarBrowseUrl(cik, String(f.form).replace("/A", "")),
        status: live ? "live" : SAMPLE_LABEL,
      };
    });
  return { key: def.key, label: def.label, concept, basis: def.kind === "duration" ? "fiscal_year" : "period_end", values };
}

function factsTool(sec: Sec): ToolAdapter {
  return {
    spec: RESEARCH_TOOLS.secFacts,
    run: (args) =>
      guarded(async () => {
        const company = await sec.company(args.ticker);
        const { body, live, api } = await sec.json("facts", company);
        const gaap = asRecord(asRecord(asRecord(body).facts)["us-gaap"]);
        const metrics: FactSeries[] = [];
        for (const def of METRICS) {
          const candidates = def.concepts
            .map((concept) => series(def, concept, asArray(asRecord(asRecord(gaap[concept]).units).USD), company.cik, live))
            .filter((s) => s.values.length > 0)
            .sort((a, b) => (b.values.at(-1)!.end.localeCompare(a.values.at(-1)!.end)) || b.values.length - a.values.length);
          if (candidates[0]) metrics.push(candidates[0]);
        }
        if (metrics.length === 0) throw new ResearchError(`SEC EDGAR has no revenue, income or balance sheet facts for ${company.ticker} in USD.`);
        const source: Source = { name: "SEC EDGAR XBRL company facts", url: edgarBrowseUrl(company.cik, "10-K"), ...(api ? { api } : {}) };
        return ok({ company, metrics, live, status: live ? "live" : SAMPLE_LABEL, source });
      }),
  };
}

const TREASURY_PAGE = "https://fiscaldata.treasury.gov/datasets/average-interest-rates-treasury-securities/average-interest-rates-on-u-s-treasury-securities";

function treasuryTool(o: ResearchOptions): ToolAdapter {
  const client = new PublicDataClient("Treasury FiscalData", RESEARCH_HOSTS.treasury, o);
  return {
    spec: RESEARCH_TOOLS.treasuryRates,
    run: () =>
      guarded(async () => {
        const base = (o.bases?.treasury ?? DEFAULT_BASES.treasury).replace(/\/+$/, "");
        const api = `${base}/services/api/fiscal_service/v2/accounting/od/avg_interest_rates?sort=-record_date&page%5Bsize%5D=30&fields=record_date,security_type_desc,security_desc,avg_interest_rate_amt&filter=security_type_desc:eq:Marketable`;
        const { body } = await client.getJson(api);
        const rows = asArray(asRecord(body).data).map(asRecord);
        const recordDate = String(rows[0]?.record_date ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(recordDate)) throw new ResearchError("Treasury FiscalData returned no rates.");
        const rates = rows
          .filter((r) => r.record_date === recordDate && /^Treasury /.test(String(r.security_desc)))
          .map((r) => ({ security: String(r.security_desc), rate: Number(r.avg_interest_rate_amt) }))
          .filter((r) => Number.isFinite(r.rate))
          .map((r) => ({ ...r, display: `${r.rate.toFixed(3)}%` }));
        if (rates.length === 0) throw new ResearchError("Treasury FiscalData returned no rates for bills, notes or bonds.");
        const source: Source = { name: "U.S. Treasury FiscalData: Average Interest Rates on U.S. Treasury Securities", url: TREASURY_PAGE, api };
        return ok({
          recordDate,
          rates,
          live: true,
          status: "live",
          note: "Average interest rates the Treasury pays on its outstanding marketable debt, by security type, for the month. They are not today's market yields.",
          source,
        });
      }),
  };
}

const cleanName = (raw: unknown) =>
  String(raw ?? "")
    .replace(/[^A-Za-z0-9&.,' -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

function fdicTool(o: ResearchOptions): ToolAdapter {
  const client = new PublicDataClient("FDIC BankFind", RESEARCH_HOSTS.fdic, o);
  return {
    spec: RESEARCH_TOOLS.fdicBank,
    run: (args) =>
      guarded(async () => {
        const name = cleanName(args.name);
        if (name.length < 2) throw new ResearchError("Give a bank name of at least 2 letters.");
        const base = (o.bases?.fdic ?? DEFAULT_BASES.fdic).replace(/\/+$/, "");
        const api = `${base}/banks/institutions?search=${encodeURIComponent(`NAME:"${name.replace(/"/g, "")}"`)}&fields=NAME,CERT,ACTIVE,CITY,STALP,WEBADDR&limit=10`;
        const { body } = await client.getJson(api);
        const matches = asArray(asRecord(body).data)
          .map((row) => asRecord(asRecord(row).data))
          .filter((d) => d.NAME !== undefined)
          .map((d) => ({
            name: String(d.NAME),
            cert: Number(d.CERT),
            active: Number(d.ACTIVE) === 1,
            city: String(d.CITY ?? ""),
            state: String(d.STALP ?? ""),
            website: String(d.WEBADDR ?? "") || undefined,
            url: `https://banks.data.fdic.gov/bankfind-suite/bankfind/details/${Number(d.CERT)}`,
          }));
        const wanted = squash(name.replace(/\b(the|bank|n\.?a\.?|national association)\b/gi, " ")) || squash(name);
        const named = matches.filter((m) => squash(m.name).includes(wanted));
        const activeNamed = named.filter((m) => m.active);
        const total = Number(asRecord(asRecord(body).meta).total ?? matches.length);
        return ok({
          query: name,
          total: Number.isFinite(total) ? total : matches.length,
          matches,
          activeMatches: activeNamed.length,
          listed: activeNamed.length > 0,
          verdict: activeNamed.length > 0 ? "listed_active" : named.length > 0 ? "listed_inactive_only" : "not_found",
          live: true,
          status: "live",
          note: "FDIC BankFind lists FDIC-insured institutions. A bank that takes deposits in the U.S. is normally listed; a name match alone does not prove a message really came from that bank.",
          source: { name: "FDIC BankFind Suite", url: "https://banks.data.fdic.gov/bankfind-suite/bankfind", api } satisfies Source,
        });
      }),
  };
}

function cfpbTool(o: ResearchOptions): ToolAdapter {
  const client = new PublicDataClient("CFPB Consumer Complaint Database", RESEARCH_HOSTS.cfpb, o);
  return {
    spec: RESEARCH_TOOLS.cfpbComplaints,
    run: (args) =>
      guarded(async () => {
        const query = cleanName(args.company);
        if (query.length < 2) throw new ResearchError("Give a company name of at least 2 letters.");
        const product = typeof args.product === "string" && args.product.trim() ? args.product.trim().slice(0, 80) : undefined;
        const base = `${(o.bases?.cfpb ?? DEFAULT_BASES.cfpb).replace(/\/+$/, "")}/data-research/consumer-complaints/search/api/v1/`;
        const found = await client.getJson(`${base}?search_term=${encodeURIComponent(query)}&field=company&size=0`);
        const buckets = asArray(asRecord(asRecord(asRecord(asRecord(found.body).aggregations).company).company).buckets).map(asRecord);
        const company = buckets[0]?.key ? String(buckets[0].key) : null;
        const page = `https://www.consumerfinance.gov/data-research/consumer-complaints/search/?${company ? `company=${encodeURIComponent(company)}` : `searchText=${encodeURIComponent(query)}`}`;
        if (!company) {
          return ok({ query, company: null, total: 0, topIssues: [], topProducts: [], live: true, status: "live", source: { name: "CFPB Consumer Complaint Database", url: page } satisfies Source });
        }
        const api = `${base}?company=${encodeURIComponent(company)}&size=0${product ? `&product=${encodeURIComponent(product)}` : ""}`;
        const { body } = await client.getJson(api);
        const aggs = asRecord(asRecord(body).aggregations);
        const top = (name: string) =>
          asArray(asRecord(asRecord(aggs[name])[name]).buckets)
            .map(asRecord)
            .slice(0, 5)
            .map((b) => ({ name: String(b.key), count: Number(b.doc_count) }))
            .filter((b) => Number.isFinite(b.count));
        const total = Number(asRecord(asRecord(body).hits).total && asRecord(asRecord(asRecord(body).hits).total).value);
        return ok({
          query,
          company,
          ...(product ? { product } : {}),
          total: Number.isFinite(total) ? total : 0,
          topIssues: top("issue").map((b) => ({ issue: b.name, count: b.count })),
          topProducts: top("product").map((b) => ({ product: b.name, count: b.count })),
          lastUpdated: String(asRecord(asRecord(body)._meta).last_updated ?? "") || undefined,
          live: true,
          status: "live",
          note: "Complaints are submitted by consumers and not verified by the CFPB. Counts grow with a company's size, so they are not a rating.",
          source: { name: "CFPB Consumer Complaint Database", url: page, api } satisfies Source,
        });
      }),
  };
}

export function createResearchAdapters(o: ResearchOptions = {}): ToolAdapter[] {
  const sec = new Sec(o);
  return [filingsTool(sec), factsTool(sec), treasuryTool(o), fdicTool(o), cfpbTool(o)];
}
