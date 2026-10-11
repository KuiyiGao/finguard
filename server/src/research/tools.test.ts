import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolAdapter, ToolResult } from "../types.ts";
import { mockFetch } from "./testkit.ts";
import { createResearchAdapters, moneyText, RESEARCH_TOOLS, SAMPLE_LABEL, type FactSeries, type ResearchOptions } from "./tools.ts";

const UA = "FinGuard test research@example.com";

function tools(o: ResearchOptions): Record<string, ToolAdapter> {
  return Object.fromEntries(createResearchAdapters(o).map((a) => [a.spec.name, a]));
}

function assertPublicOnly(r: ToolResult) {
  assert.deepEqual(r.systemValues, [], "public data never vouches for a money field");
  assert.deepEqual(r.texts, [], "nothing untrusted goes into texts");
}

test("every research tool is read-only research.read with no money fields", () => {
  const all = createResearchAdapters();
  assert.equal(all.length, 5);
  for (const a of all) {
    assert.equal(a.spec.effect, "read");
    assert.equal(a.spec.capability, "research.read");
    assert.equal(a.spec.moneyFields, undefined);
  }
});

test("sec_facts (live): last 8 fiscal years with form, period end and filing link; User-Agent sent", async () => {
  const fetch = mockFetch();
  const r = await tools({ fetch, secUserAgent: UA })[RESEARCH_TOOLS.secFacts.name]!.run({ ticker: "aapl" });
  assert.equal(r.ok, true, r.error);
  assertPublicOnly(r);
  const d = r.data as { live: boolean; metrics: FactSeries[]; company: { cik: string } };
  assert.equal(d.live, true);
  assert.equal(d.company.cik, "0000320193");
  const revenue = d.metrics.find((m) => m.key === "revenue")!;
  assert.equal(revenue.concept, "RevenueFromContractWithCustomerExcludingAssessedTax", "the concept with the latest period wins over the old Revenues tag");
  assert.equal(revenue.values.length, 8);
  assert.deepEqual(revenue.values.map((v) => v.period), ["FY2018", "FY2019", "FY2020", "FY2021", "FY2022", "FY2023", "FY2024", "FY2025"]);
  const last = revenue.values.at(-1)!;
  assert.equal(last.value, 280_000_000_000);
  assert.equal(last.display, "$280.00 billion");
  assert.equal(last.form, "10-K");
  assert.equal(last.end, "2025-09-30");
  assert.equal(last.url, "https://www.sec.gov/Archives/edgar/data/320193/000032019325000100/0000320193-25-000100-index.htm");
  assert.equal(last.status, "live");
  assert.ok(d.metrics.some((m) => m.key === "assets" && m.values[0]!.value === 360_000_000_000));
  assert.equal(fetch.calls[0]!.url, "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json");
  assert.equal(fetch.calls[0]!.headers["User-Agent"], UA);
});

test("sec_filings (live): 10-K, 10-Q and 8-K only, linked to the document on sec.gov", async () => {
  const r = await tools({ fetch: mockFetch(), secUserAgent: UA })[RESEARCH_TOOLS.secFilings.name]!.run({ ticker: "AAPL", limit: 5 });
  assert.equal(r.ok, true, r.error);
  assertPublicOnly(r);
  const d = r.data as { filings: { form: string; filed: string; url: string }[] };
  assert.deepEqual(d.filings.map((f) => f.form), ["10-K", "8-K", "10-Q"], "form 4 is left out");
  assert.equal(d.filings[0]!.url, "https://www.sec.gov/Archives/edgar/data/320193/000032019325000100/aapl-20250930.htm");
});

test("sec tools resolve other tickers through SEC's ticker file when live", async () => {
  const fetch = mockFetch();
  const r = await tools({ fetch, secUserAgent: UA })[RESEARCH_TOOLS.secFilings.name]!.run({ ticker: "ZZZZ" });
  assert.equal(r.ok, true, r.error);
  assert.equal((r.data as { company: { cik: string } }).company.cik, "0001999999");
  assert.equal(fetch.calls[0]!.url, "https://www.sec.gov/files/company_tickers.json");
});

test("without SEC_USER_AGENT the SEC tools answer from the cached sample, every value labeled, no request made", async () => {
  const fetch = mockFetch();
  const t = tools({ fetch });
  const facts = await t[RESEARCH_TOOLS.secFacts.name]!.run({ ticker: "MSFT" });
  assert.equal(facts.ok, true, facts.error);
  assertPublicOnly(facts);
  const d = facts.data as { live: boolean; status: string; metrics: FactSeries[] };
  assert.equal(d.live, false);
  assert.equal(d.status, SAMPLE_LABEL);
  assert.ok(d.metrics.length >= 4);
  assert.ok(d.metrics.every((m) => m.values.every((v) => v.status === "cached sample, not live")));
  const filings = await t[RESEARCH_TOOLS.secFilings.name]!.run({ ticker: "AAPL" });
  assert.ok((filings.data as { filings: { status: string; url: string }[] }).filings.every((f) => f.status === SAMPLE_LABEL && f.url.startsWith("https://www.sec.gov/")));
  assert.equal(fetch.calls.length, 0);

  const other = await t[RESEARCH_TOOLS.secFacts.name]!.run({ ticker: "TSLA" });
  assert.equal(other.ok, false);
  assert.match(other.error!, /SEC_USER_AGENT/);
});

test("SEC answering 403 says to set SEC_USER_AGENT", async () => {
  const r = await tools({ fetch: mockFetch({ status: 403 }), secUserAgent: "x" })[RESEARCH_TOOLS.secFacts.name]!.run({ ticker: "AAPL" });
  assert.equal(r.ok, false);
  assert.match(r.error!, /HTTP 403.*SEC_USER_AGENT/);
});

test("a source that does not answer times out with a clear message", async () => {
  const started = Date.now();
  const r = await tools({ fetch: mockFetch({ hang: true }), timeoutMs: 40 })[RESEARCH_TOOLS.treasuryRates.name]!.run({});
  assert.equal(r.ok, false);
  assert.match(r.error!, /Treasury FiscalData did not answer within 0 s|Treasury FiscalData did not answer within/);
  assert.ok(Date.now() - started < 2000);
});

test("a host outside the tool's allowlist is refused before any request", async () => {
  const fetch = mockFetch();
  const t = tools({ fetch, secUserAgent: UA, bases: { fdic: "https://evil.example.com", treasury: "http://api.fiscaldata.treasury.gov", sec: "https://api.fdic.gov" } });
  const fdic = await t[RESEARCH_TOOLS.fdicBank.name]!.run({ name: "Capital One" });
  assert.equal(fdic.ok, false);
  assert.match(fdic.error!, /evil\.example\.com is not on this tool's allowlist \(api\.fdic\.gov\)/);
  const plain = await t[RESEARCH_TOOLS.treasuryRates.name]!.run({});
  assert.match(plain.error!, /allowlist/, "http is refused too");
  const crossed = await t[RESEARCH_TOOLS.secFacts.name]!.run({ ticker: "AAPL" });
  assert.match(crossed.error!, /api\.fdic\.gov is not on this tool's allowlist \(data\.sec\.gov, www\.sec\.gov\)/, "one tool cannot borrow another's host");
  assert.equal(fetch.calls.length, 0);
});

test("treasury_rates: latest month's bills, notes and bonds", async () => {
  const r = await tools({ fetch: mockFetch() })[RESEARCH_TOOLS.treasuryRates.name]!.run({});
  assert.equal(r.ok, true, r.error);
  assertPublicOnly(r);
  const d = r.data as { recordDate: string; rates: { security: string; rate: number; display: string }[] };
  assert.equal(d.recordDate, "2026-09-30");
  assert.deepEqual(d.rates.map((x) => [x.security, x.rate, x.display]), [
    ["Treasury Bills", 3.87, "3.870%"],
    ["Treasury Notes", 3.383, "3.383%"],
    ["Treasury Bonds", 3.466, "3.466%"],
  ]);
});

test("fdic_bank: listed, and not found", async () => {
  const fetch = mockFetch();
  const t = tools({ fetch });
  const r = await t[RESEARCH_TOOLS.fdicBank.name]!.run({ name: "Capital One" });
  assert.equal(r.ok, true, r.error);
  assertPublicOnly(r);
  const d = r.data as { listed: boolean; verdict: string; matches: { cert: number; active: boolean; url: string }[] };
  assert.equal(d.listed, true);
  assert.equal(d.verdict, "listed_active");
  assert.equal(d.matches[0]!.cert, 4297);
  assert.equal(d.matches[0]!.url, "https://banks.data.fdic.gov/bankfind-suite/bankfind/details/4297");
  await t[RESEARCH_TOOLS.fdicBank.name]!.run({ name: 'Capital One"; DROP' });
  assert.equal(new URL(fetch.calls.at(-1)!.url).searchParams.get("search"), 'NAME:"Capital One DROP"', "quotes and symbols are stripped from the search");
  const missing = await t[RESEARCH_TOOLS.fdicBank.name]!.run({ name: "First Example Bank" });
  assert.equal((missing.data as { verdict: string }).verdict, "not_found");
});

test("cfpb_complaints: resolves the company, then its total and top issues (optionally one product)", async () => {
  const fetch = mockFetch();
  const r = await tools({ fetch })[RESEARCH_TOOLS.cfpbComplaints.name]!.run({ company: "Capital One", product: "Credit card" });
  assert.equal(r.ok, true, r.error);
  assertPublicOnly(r);
  const d = r.data as { company: string; total: number; product: string; topIssues: { issue: string; count: number }[] };
  assert.equal(d.company, "CAPITAL ONE FINANCIAL CORPORATION");
  assert.equal(d.total, 400);
  assert.equal(d.product, "Credit card");
  assert.deepEqual(d.topIssues[0], { issue: "Incorrect information on your report", count: 300 });
  assert.equal(new URL(fetch.calls[1]!.url).searchParams.get("company"), "CAPITAL ONE FINANCIAL CORPORATION");
});

test("results are cached for 10 minutes", async () => {
  let now = 0;
  const fetch = mockFetch();
  const t = tools({ fetch, now: () => now });
  await t[RESEARCH_TOOLS.treasuryRates.name]!.run({});
  await t[RESEARCH_TOOLS.treasuryRates.name]!.run({});
  assert.equal(fetch.calls.length, 1);
  now = 10 * 60_000 + 1;
  await t[RESEARCH_TOOLS.treasuryRates.name]!.run({});
  assert.equal(fetch.calls.length, 2);
});

test("money text matches what replies quote", () => {
  assert.equal(moneyText(416_161_000_000), "$416.16 billion");
  assert.equal(moneyText(35_934_000), "$35.93 million");
  assert.equal(moneyText(-1_200), "-$1,200.00");
});
