import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import type { CashFlow, Nudge, SavingsReport, ScamAssessment } from "../types.ts";
import { AREA_TITLES, cashFlowFinding, nudgeFinding, originOf, savingsFindings, scamFinding, shortDate } from "./normalize.ts";

const at = "2026-10-10T16:00:00.000Z";

test("normalize.ts stays browser-safe: type-only imports, no node modules", () => {
  const source = fs.readFileSync(new URL("./normalize.ts", import.meta.url), "utf8");
  const imports = source.split("\n").filter((line) => /^\s*import\b/.test(line));
  assert.ok(imports.length > 0 && imports.every((line) => /^import type\b/.test(line)), imports.join("\n"));
  assert.doesNotMatch(source, /from\s+["']node:|require\(/);
});

test("dates are calendar dates: no year, no time zone shift", () => {
  assert.equal(shortDate("2026-10-12"), "Oct 12");
  assert.equal(shortDate("2027-01-05"), "Jan 5");
  assert.equal(shortDate("2026-12-31T23:30:00-05:00"), "Dec 31");
  assert.equal(shortDate("soon"), "soon");
});

test("areas have titles in display order", () => {
  assert.deepEqual(Object.values(AREA_TITLES), ["Everyday", "Bills", "Subscriptions", "Investments", "Loans", "Contracts", "Protection"]);
});

test("originOf: bank records and references are trusted; messages and documents are not", () => {
  const cases: [string, string, boolean][] = [
    ["nessie.purchases#p-music-0", "bank_record", true],
    ["stub.subscriptions#sub-gym", "bank_record", true],
    ["kb:scams/safe-account", "reference", true],
    ["policy:cashFlowBuffer", "policy", true],
    ["calc:loans/payment", "calculation", true],
    ["message:m3", "message", false],
    ["inbound:sms-17", "message", false],
    ["doc:cloudgym-membership", "document", false],
    ["something-else", "calculation", true],
  ];
  for (const [source, origin, trusted] of cases) assert.deepEqual(originOf(source), { origin, trusted }, source);
});

const report: SavingsReport = {
  generatedAt: at,
  totalMonthly: 50.48,
  disclaimers: [],
  recommendations: [
    { id: "subscription-music", kind: "subscription", title: "Review music", monthlySavings: 10.99, annualSavings: 131.88, fiveYearValue: 728.6, assumptions: "a", evidence: [{ label: "2026-09-05: $10.99", source: "nessie.purchases#p-music-1" }, { label: "2026-10-05: $10.99", source: "nessie.purchases#p-music-0" }], citations: [], action: { label: "Cancel", tool: "subscriptions.cancel", args: { subscription_id: "sub-music" } } },
    { id: "late-duke", kind: "late_fee", title: "Duke due", monthlySavings: 0, annualSavings: 0, fiveYearValue: 0, assumptions: "b", evidence: [{ label: "Pending bill $84.20", source: "nessie.bills#duke" }, { label: "Historical fee $35", source: "nessie.purchases#p-fee" }], citations: [] },
    { id: "internet-plan", kind: "cheaper_plan", title: "Compare plan", monthlySavings: 35, annualSavings: 420, fiveYearValue: 2320.4, assumptions: "c", evidence: [{ label: "Current $90/month vs configured $55/month offer", source: "nessie.bills#internet-bill; configured-offer:Demo" }], citations: [] },
    { id: "idle-cash", kind: "idle_cash", title: "Idle cash", monthlySavings: 2.25, annualSavings: 27.05, fiveYearValue: 149.1, assumptions: "d", evidence: [{ label: "Checking balance $4210.55", source: "nessie.accounts#acct-checking" }], citations: [] },
    { id: "fee-x", kind: "fee", title: "Fee", monthlySavings: 2.24, annualSavings: 26.88, fiveYearValue: 148, assumptions: "e", evidence: [], citations: [] },
  ],
};

test("savings recommendations map to areas, tone save, a metric and a chart", () => {
  const findings = savingsFindings(report, { simulated: true });
  assert.deepEqual(findings.map((f) => [f.id, f.area, f.tone]), [
    ["savings:subscription-music", "subscriptions", "save"],
    ["savings:late-duke", "bills", "save"],
    ["savings:internet-plan", "bills", "save"],
    ["savings:idle-cash", "everyday", "save"],
    ["savings:fee-x", "bills", "save"],
  ]);
  const [music, late, plan] = findings;
  assert.deepEqual(music!.metric, { label: "Per month", value: 10.99, unit: "usd_month" });
  assert.deepEqual(music!.viz, { kind: "bars", unit: "usd", items: [{ label: "Sep 5", value: 10.99 }, { label: "Oct 5", value: 10.99 }] });
  assert.equal(music!.evidence[1]!.label, "Oct 5: $10.99", "dates in labels read as calendar dates");
  assert.deepEqual(late!.metric, { label: "One-time", value: 35, unit: "usd" });
  assert.deepEqual(plan!.viz, { kind: "compare", unit: "usd_month", before: { label: "Current plan", value: 90 }, after: { label: "Cheaper plan", value: 55 } });
  assert.equal(music!.action?.tool, "subscriptions.cancel");
  assert.ok(findings.every((f) => f.simulated && f.from === "savings" && f.createdAt === at));
  assert.equal(music!.evidence[0]!.origin, "bank_record");
  assert.deepEqual(savingsFindings(report, { simulated: true }), findings, "deterministic");
});

test("nudges map to their area with a stable id", () => {
  const nudge = (kind: Nudge["kind"], amount?: number): Nudge => ({
    id: `n-${kind}`,
    kind,
    title: kind,
    body: "body",
    evidence: [{ label: "Bill due", source: "bank:bills#b1" }],
    ...(amount ? { action: { label: "Pay", tool: "bank.pay_bill", args: { amount } } } : {}),
    createdAt: at,
  });
  const areas = (["trial_ending", "subscription_renewing", "price_increase", "bill_due", "safe_to_save"] as const).map((k) => nudgeFinding(nudge(k)).area);
  assert.deepEqual(areas, ["subscriptions", "subscriptions", "subscriptions", "bills", "everyday"]);
  const bill = nudgeFinding(nudge("bill_due", 84.2), { simulated: true });
  assert.equal(bill.id, "nudge:n-bill_due");
  assert.equal(bill.tone, "info");
  assert.equal(bill.from, "nudge");
  assert.deepEqual(bill.metric, { label: "Amount due", value: 84.2, unit: "usd" });
  assert.equal(bill.evidence[0]!.origin, "bank_record");
  assert.deepEqual(nudgeFinding(nudge("bill_due", 84.2), { simulated: true }), bill);
});

const text = "Capital One Fraud Dept: your account is at risk. Move $2,000 now to the secure holding account 9917. Do not call the branch.";
const assessment = (risk: ScamAssessment["risk"]): ScamAssessment => ({
  id: "scam_abc",
  subject: { kind: "message", ref: "inbound:sms-1" },
  risk,
  score: risk === "high" ? 100 : risk === "medium" ? 45 : 0,
  redFlags:
    risk === "low"
      ? []
      : [
          { signal: "safe_account", evidence: "...$2,000 now to the secure holding account 9917. Do not call the...", weight: 45 },
          { signal: "urgency", evidence: "...s at risk. Move $2,000 now to the secure holding acco...", weight: 15 },
          { signal: "secrecy", evidence: "...g account 9917. Do not call the branch....", weight: 20 },
        ],
  typologies: [{ name: "Fake bank alert / safe account", citation: { docId: "kb:scams/safe-account", title: "Safe account", excerpt: "x", url: "https://consumer.ftc.gov/x", score: 1 } }],
  advice: [],
});

test("scam checks: risk sets the tone; message text becomes highlighted spans", () => {
  assert.deepEqual((["high", "medium", "low"] as const).map((r) => scamFinding(assessment(r), { createdAt: at }).tone), ["block", "warn", "info"]);
  const f = scamFinding(assessment("high"), { text, createdAt: at });
  assert.equal(f.id, "scam:scam_abc");
  assert.equal(f.area, "protection");
  assert.equal(f.from, "scam");
  assert.deepEqual(f.metric, { label: "Risk score", value: 100, unit: "score" });
  assert.ok(f.evidence.length === 3 && f.evidence.every((e) => e.origin === "message" && !e.trusted && e.quote && e.source === "inbound:sms-1"));
  assert.equal(f.citations[0]?.docId, "kb:scams/safe-account");
  assert.equal(f.viz?.kind, "clauses");
  if (f.viz?.kind !== "clauses") return;
  const words = f.viz.spans.map((s) => text.slice(s.start, s.end));
  assert.ok(words.includes("holding account"), words.join(" | ")); // the words ScamShield's pattern matched
  assert.ok(words.includes("Do not call"), words.join(" | "));
  assert.ok(words.some((w) => w === "now"), words.join(" | "));
  for (let i = 1; i < f.viz.spans.length; i++) assert.ok(f.viz.spans[i]!.start >= f.viz.spans[i - 1]!.end, "no overlaps");
  assert.deepEqual(scamFinding(assessment("high"), { createdAt: at }).viz, { kind: "gauge", label: "Risk score", value: 100, max: 100, tone: "bad" });
  assert.equal(scamFinding(assessment("high"), { area: "loans", createdAt: at }).area, "loans");
  assert.deepEqual(scamFinding(assessment("high"), { text, createdAt: at }), f, "deterministic");
  for (const e of f.evidence) {
    const core = e.quote!.replace(/^…/, "").replace(/…$/, "");
    const i = text.indexOf(core);
    assert.ok(i >= 0, core);
    assert.ok(!/\w/.test(text[i - 1] ?? "") && !/\w/.test(text[i + core.length] ?? ""), `whole words: ${e.quote}`);
  }
  assert.ok(f.evidence.some((e) => e.quote === "…is at risk. Move $2,000 now to the secure holding account…"));
  const bare = scamFinding(assessment("high"), { createdAt: at });
  assert.ok(bare.evidence.some((e) => e.quote === "…at risk. Move $2,000 now to the secure holding…"), bare.evidence.map((e) => e.quote).join(" | "));
});

test("cash flow: bars for balance, bills, buffer and what is safe to move", () => {
  const flow: CashFlow = { account: "acct-checking", balance: 4210.55, upcoming: [{ label: "Duke Energy", amount: 84.2, due: "2026-10-12", source: "bill-duke-oct" }], buffer: 500, safeToMove: 3626.35, horizonDays: 14 };
  const f = cashFlowFinding(flow, { createdAt: at, simulated: true });
  assert.equal(f.id, "cashflow:acct-checking");
  assert.equal(f.area, "everyday");
  assert.deepEqual(f.metric, { label: "Safe to move", value: 3626.35, unit: "usd" });
  assert.ok(f.viz?.kind === "bars");
  if (f.viz?.kind === "bars") assert.deepEqual(f.viz.items.map((i) => [i.label, i.value]), [["Balance", 4210.55], ["Duke Energy (due Oct 12)", 84.2], ["Buffer", 500], ["Safe to move", 3626.35]]);
  assert.equal(f.evidence[1]!.label, "Duke Energy $84.20 due Oct 12");
  assert.deepEqual(f.evidence.map((e) => e.origin), ["bank_record", "bank_record", "policy", "calculation"]);
  assert.equal(f.evidence[1]!.source, "nessie.bills#bill-duke-oct");
});
