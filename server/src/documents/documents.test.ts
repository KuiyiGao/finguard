import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { contractText } from "../scenarios/data.ts";
import type { DelegationPolicy } from "../types.ts";
import { annotateDocument, checkPayee, classifyDocument, documentSamples, planMove, readInvoice, readStatement, sampleFor, servedText, type DocumentKind } from "./index.ts";
import { SAMPLES_DIR } from "./samples.ts";

const sample = (kind: DocumentKind) => documentSamples().find((x) => x.kind === kind)!;
const NOW = new Date("2026-10-10T15:00:00Z");

test("samples: three fictional documents, one per kind, served from fixtures/documents with a README", () => {
  const samples = documentSamples();
  assert.deepEqual(samples.map((x) => [x.id, x.kind, x.fictional]), [
    ["cloudgym-contract", "contract", true],
    ["october-statement", "statement", true],
    ["ridgeline-invoice", "invoice", true],
  ]);
  for (const x of samples) assert.ok(x.name && x.text.length > 200 && !x.text.endsWith("\n") && !x.text.includes("\r"), x.id);
  assert.equal(sample("contract").text, contractText(), "the contract fixture is exactly the CloudGym scenario text");
  assert.match(fs.readFileSync(path.join(SAMPLES_DIR, "README.md"), "utf8"), /fictional/i);
  assert.equal(sampleFor(`${sample("invoice").text}\r\n`)?.id, "ridgeline-invoice", "a trailing newline or CRLF does not change which sample it is");
  assert.equal(sampleFor("Something else entirely"), undefined);
  assert.equal(servedText("a\r\nb\n\n"), "a\nb");
});

test("classification: keyword rules pick each sample's kind, say why, and fall back to the contract review", () => {
  for (const kind of ["contract", "statement", "invoice"] as const) {
    const c = classifyDocument(sample(kind).text);
    assert.equal(c.kind, kind);
    assert.equal(c.given, false);
    assert.ok(c.matched[kind].length >= 5, `${kind}: ${c.matched[kind].join(", ")}`);
    assert.match(c.why, /by keyword rules: "/);
  }
  assert.deepEqual(classifyDocument(sample("statement").text).matched.invoice, [], "no invoice words in the statement");
  const plain = classifyDocument("Hello, see you at the game on Saturday.");
  assert.equal(plain.kind, "contract");
  assert.match(plain.why, /no statement or invoice words/);
  assert.equal(classifyDocument("INVOICE. Amount due $40.00. Statement period noted.").kind, "invoice", "a tie goes to the invoice, the stricter review");
  const given = classifyDocument(sample("invoice").text, "statement");
  assert.deepEqual([given.kind, given.given], ["statement", true]);
});

test("statement: fee lines and the low balance are marked verbatim; fees and the year are computed in code", () => {
  const text = sample("statement").text;
  const r = readStatement(text);
  assert.deepEqual(r.period, { from: "2026-09-10", to: "2026-10-09" });
  assert.equal(r.lines.length, 16);
  assert.deepEqual(r.fees.map((f) => [f.kind, f.fee, f.date]), [
    ["overdraft", 20, "2026-09-16"],
    ["overdraft", 20, "2026-09-17"],
    ["maintenance", 12, "2026-10-09"],
  ]);
  assert.equal(r.feesTotal, 52);
  assert.equal(r.feesPerYear, 624);
  assert.equal(r.low?.line.balance, 23.17);
  assert.equal(r.low?.line.date, "2026-09-15");
  assert.equal(r.low?.next?.description, "Maple Court Apartments rent");
  assert.equal(r.low?.overdrawn, true);

  let balance = 348.7;
  for (const line of r.lines) {
    balance = Math.round((balance + line.amount) * 100) / 100;
    assert.equal(balance, line.balance, line.quote);
  }
  assert.equal(balance, 4210.55);
  assert.match(text, /Ending balance on Oct 9\s+\$4,210\.55/);
  assert.match(text, /^Fees\s+\$52\.00$/m, "the statement's own fee total matches the sum of its fee lines");

  assert.deepEqual(r.marks.map((m) => [m.label, m.value]), [
    ["Low balance before Maple Court Apartments rent: $23.17 on Sep 15", 23.17],
    ["Overdraft fee: $20.00", 20],
    ["Overdraft fee: $20.00", 20],
    ["Monthly maintenance fee: $12.00", 12],
  ]);
  for (const m of r.marks) assert.equal(text.slice(m.start, m.end), m.quote);
  assert.ok(r.marks.every((m, i) => i === 0 || r.marks[i - 1]!.end <= m.start), "in reading order, no overlaps");
});

test("statement move: sized from the bank's balance, the next bill and the policy buffer; none when checking covers it", () => {
  const policy = { ownAccounts: ["acct-checking", "acct-savings"], cashFlowBuffer: 500 } as DelegationPolicy;
  const accounts = (checking: number) => [
    { id: "acct-checking", nickname: "Checking", balance: checking },
    { id: "acct-savings", nickname: "Savings", balance: 1000 },
  ];
  const bills = [
    { id: "bill-rent", payee: "Maple Court Apartments", amount: 1450, due: "2026-10-16", status: "pending", account_id: "acct-checking" },
    { id: "bill-duke", payee: "Duke Energy", amount: 84.2, due: "2026-10-12", status: "pending", account_id: "acct-checking" },
    { id: "bill-old", payee: "Duke Energy", amount: 70, due: "2026-10-01", status: "pending", account_id: "acct-checking" },
    { id: "bill-paid", payee: "Spectrum Internet", amount: 90, due: "2026-10-11", status: "paid", account_id: "acct-checking" },
  ];
  const healthy = planMove({ accounts: accounts(4210.55), bills, policy, now: NOW })!;
  assert.equal(healthy.next?.id, "bill-duke", "the next unpaid bill from today");
  assert.equal(healthy.need, -3626.35);
  assert.equal(healthy.move, undefined);

  const short = planMove({ accounts: accounts(312.4), bills, policy, now: NOW })!;
  assert.equal(short.need, 271.8);
  assert.equal(short.move, 271.8);
  assert.equal(planMove({ accounts: accounts(312.4).slice(0, 1), bills, policy, now: NOW })?.move, undefined, "no savings account: nothing to move from");
  assert.equal(planMove({ accounts: accounts(312.4), bills: [], policy, now: NOW })?.need, undefined, "no bill on file: no move");
  assert.equal(planMove({ accounts: [], bills, policy, now: NOW }), undefined);
});

test("invoice: payee, account, amount due, due date and red-flag sentences marked verbatim; total and days in code", () => {
  const text = sample("invoice").text;
  const r = readInvoice(text, NOW);
  assert.equal(r.payee?.name, "Ridgeline Plumbing & Heating");
  assert.equal(r.number, "INV-2041");
  assert.equal(r.invoiceDate, "2026-10-08");
  assert.equal(r.due?.iso, "2026-10-15");
  assert.equal(r.amountDue?.value, 865);
  assert.equal(r.account?.digits, "731900418826");
  assert.deepEqual(r.items.map((i) => [i.label, i.amount, i.hours, i.rate]), [
    ["Labor, 4 hours at $160.00 per hour", 640, 4, 160],
    ["Parts", 225, undefined, undefined],
  ]);
  assert.equal(r.itemsTotal, 865, "labor $640.00 + parts $225.00, equal to the amount due");
  assert.equal(r.termsDays, 7);
  assert.equal(r.daysUntilDue, 5, "Oct 10 to Oct 15");
  assert.equal(readInvoice(text).daysUntilDue, undefined, "no clock, no days until due");
  assert.deepEqual(r.redFlags.map((m) => m.quote), [
    "Our bank details have changed.",
    "Please remit payment to our new account:",
    "Please pay today to avoid a $75.00 late fee.",
    "Do not call the office about this change; our phone line is being moved this week.",
  ]);
  assert.deepEqual(r.marks.map((m) => m.label), [
    "Payee named in the invoice: Ridgeline Plumbing & Heating",
    "Due date: Oct 15, 2026",
    "Amount due: $865.00",
    "Red flag: says the bank details changed",
    "Red flag: asks you to pay a new account",
    "Account to pay, written only in this invoice: ending 8826",
    "Red flag: pushes you to pay right away",
    "Red flag: tells you not to call and check",
  ]);
  for (const m of r.marks) assert.equal(text.slice(m.start, m.end), m.quote);
  assert.ok(r.marks.every((m, i) => i === 0 || r.marks[i - 1]!.end <= m.start), "in reading order, no overlaps");

  const onFile = [{ id: "ridgeline", name: "Ridgeline Plumbing & Heating", account: "6038", addedAt: "2025-11-03T15:00:00.000Z" }];
  assert.deepEqual(checkPayee(r, onFile, text), { onFile: { id: "ridgeline", name: "Ridgeline Plumbing & Heating", account: "6038", addedAt: "2025-11-03T15:00:00.000Z" }, differs: true });
  assert.equal(checkPayee(r, [{ ...onFile[0]!, account: "731900418826" }], text).differs, false, "the account on file is not a change");
  assert.deepEqual(checkPayee(r, [{ id: "duke", name: "Duke Energy", account: "3301" }], text), { differs: false }, "no saved payee named");
});

test("annotateDocument: one card per kind from the text alone; no action without the household's records", async () => {
  const docs = { search: async () => [] };
  for (const kind of ["contract", "statement", "invoice"] as const) {
    const a = await annotateDocument(sample(kind).text, kind, { retriever: docs, now: NOW });
    assert.equal(a.kind, kind);
    assert.equal(a.finding.viz?.kind, "clauses");
    assert.deepEqual(a.finding.viz?.kind === "clauses" ? a.finding.viz.spans : [], a.marks.map(({ start, end, label, tone }) => ({ start, end, label, tone })));
    assert.ok(a.finding.evidence.filter((e) => e.origin === "document").every((e) => !e.trusted));
    assert.equal(a.finding.action, undefined, "the document alone proposes nothing: actions need the household's records");
  }
  assert.equal((await annotateDocument(sample("contract").text, "contract")).clauses.length, 6);
  assert.deepEqual((await annotateDocument(sample("invoice").text, "invoice")).clauses, []);
});
