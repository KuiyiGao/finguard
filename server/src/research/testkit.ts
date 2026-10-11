
export interface MockCall {
  url: string;
  headers: Record<string, string>;
}

type Reply = unknown | ((url: URL) => unknown);

export const MOCK = {
  facts: {
    cik: 320193,
    entityName: "Apple Inc.",
    facts: {
      "us-gaap": {
        Revenues: { label: "Revenues", units: { USD: [{ start: "2015-09-27", end: "2016-09-24", val: 215_639_000_000, fy: 2016, fp: "FY", form: "10-K", filed: "2016-10-26", accn: "0001628280-16-020309" }] } },
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          label: "Revenue",
          units: {
            USD: [
              ...Array.from({ length: 9 }, (_, i) => ({
                start: `${2016 + i}-10-01`,
                end: `${2017 + i}-09-30`,
                val: (200 + 10 * i) * 1_000_000_000,
                fy: 2017 + i,
                fp: "FY",
                form: "10-K",
                filed: `${2017 + i}-11-01`,
                accn: `0000320193-${String(17 + i).padStart(2, "0")}-000100`,
              })),
              { start: "2025-07-01", end: "2025-09-30", val: 99_000_000_000, fy: 2025, fp: "Q4", form: "10-Q", filed: "2025-11-01", accn: "0000320193-25-000200" },
            ],
          },
        },
        NetIncomeLoss: {
          label: "Net income",
          units: {
            USD: Array.from({ length: 9 }, (_, i) => ({
              start: `${2016 + i}-10-01`,
              end: `${2017 + i}-09-30`,
              val: (50 + i) * 1_000_000_000,
              fy: 2017 + i,
              fp: "FY",
              form: "10-K",
              filed: `${2017 + i}-11-01`,
              accn: `0000320193-${String(17 + i).padStart(2, "0")}-000100`,
            })),
          },
        },
        Assets: { label: "Assets", units: { USD: [{ end: "2025-09-30", val: 360_000_000_000, fy: 2025, fp: "FY", form: "10-K", filed: "2025-11-01", accn: "0000320193-25-000100" }] } },
      },
    },
  },
  submissions: {
    cik: "320193",
    name: "Apple Inc.",
    filings: {
      recent: {
        accessionNumber: ["0000320193-25-000100", "0000320193-25-000099", "0000320193-25-000098", "0000320193-25-000097"],
        filingDate: ["2025-11-01", "2025-10-30", "2025-10-15", "2025-08-01"],
        reportDate: ["2025-09-30", "2025-10-30", "", "2025-06-30"],
        form: ["10-K", "8-K", "4", "10-Q"],
        primaryDocument: ["aapl-20250930.htm", "aapl-8k.htm", "xslF345X05/form4.xml", "aapl-20250630.htm"],
      },
    },
  },
  treasury: {
    data: [
      { record_date: "2026-09-30", security_type_desc: "Marketable", security_desc: "Treasury Bills", avg_interest_rate_amt: "3.870" },
      { record_date: "2026-09-30", security_type_desc: "Marketable", security_desc: "Treasury Notes", avg_interest_rate_amt: "3.383" },
      { record_date: "2026-09-30", security_type_desc: "Marketable", security_desc: "Treasury Bonds", avg_interest_rate_amt: "3.466" },
      { record_date: "2026-09-30", security_type_desc: "Marketable", security_desc: "Total Marketable", avg_interest_rate_amt: "3.518" },
      { record_date: "2026-08-31", security_type_desc: "Marketable", security_desc: "Treasury Bills", avg_interest_rate_amt: "3.788" },
    ],
  },
  fdic: (url: URL) =>
    /First Example/i.test(url.searchParams.get("search") ?? "")
      ? { meta: { total: 0 }, data: [] }
      : {
          meta: { total: 2 },
          data: [
            { data: { NAME: "Capital One, National Association", CERT: 4297, ACTIVE: 1, CITY: "Mclean", STALP: "VA", WEBADDR: "www.capitalone.com" } },
            { data: { NAME: "Capital One Bank (USA), National Association", CERT: 33954, ACTIVE: 0, CITY: "Glen Allen", STALP: "VA", WEBADDR: "" } },
          ],
        },
  cfpb: (url: URL) =>
    url.searchParams.get("field") === "company"
      ? { hits: { total: { value: 1000 } }, aggregations: { company: { company: { buckets: [{ key: "CAPITAL ONE FINANCIAL CORPORATION", doc_count: 990 }, { key: "Lima One Capital, LLC", doc_count: 10 }] } } } }
      : {
          hits: { total: { value: url.searchParams.get("product") ? 400 : 990 } },
          aggregations: {
            issue: { issue: { buckets: [{ key: "Incorrect information on your report", doc_count: 300 }, { key: "Managing an account", doc_count: 200 }, { key: "Getting a credit card", doc_count: 100 }] } },
            product: { product: { buckets: [{ key: "Credit card", doc_count: 400 }] } },
          },
          _meta: { last_updated: "2026-10-10T12:00:00-05:00" },
        },
  tickers: { "0": { cik_str: 1318605, ticker: "TSLA", title: "Tesla, Inc." }, "1": { cik_str: 1999999, ticker: "ZZZZ", title: "Example Corp" } },
};

export function mockFetch(opts: { hang?: boolean; status?: number; replies?: Partial<Record<keyof typeof MOCK, Reply>> } = {}): typeof fetch & { calls: MockCall[] } {
  const calls: MockCall[] = [];
  const replies = { ...MOCK, ...opts.replies };
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url: url.href, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
    if (opts.hang)
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    if (opts.status) return new Response("{}", { status: opts.status });
    const pick = (key: keyof typeof MOCK) => {
      const r = replies[key];
      return typeof r === "function" ? (r as (u: URL) => unknown)(url) : r;
    };
    let body: unknown;
    if (url.hostname === "data.sec.gov" && url.pathname.startsWith("/api/xbrl/companyfacts/")) body = pick("facts");
    else if (url.hostname === "data.sec.gov" && url.pathname.startsWith("/submissions/")) body = pick("submissions");
    else if (url.hostname === "www.sec.gov" && url.pathname === "/files/company_tickers.json") body = pick("tickers");
    else if (url.hostname === "api.fiscaldata.treasury.gov") body = pick("treasury");
    else if (url.hostname === "api.fdic.gov") body = pick("fdic");
    else if (url.hostname === "www.consumerfinance.gov") body = pick("cfpb");
    else return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch & { calls: MockCall[] };
  fn.calls = calls;
  return fn;
}
