import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { check, runParallel, scorecard, type Observed } from "../../scripts/parallel.ts";
import { loadConfig, SERVER_ROOT } from "../config.ts";
import { buildFindings } from "../findings/index.ts";
import { createApp } from "../gateway/app.ts";
import { loadPolicyFile, validatePolicy } from "../policy/store.ts";
import { buildServices, resetServices, type Services } from "../services.ts";
import type { DelegationPolicy } from "../types.ts";
import { DEFAULT_PERSONA, PERSONAS, personaList, personaSetup, RIDGELINE_PAYEE } from "./personas.ts";

const NOW = new Date();
const today = NOW.toISOString().slice(0, 10);
const isCents = (n: number) => Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-7;
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s).toISOString().slice(0, 10) === s;
const daysFromToday = (date: string) => Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
const unique = (xs: string[]) => new Set(xs).size === xs.length;
const basePolicy = () => loadPolicyFile(loadConfig({}).policyFile);

function build(persona?: string): Services {
  return buildServices(loadConfig({ APPROVAL_TTL_SECONDS: "5" }), { persist: false, ...(persona ? { persona } : {}) });
}

async function read(s: Services, tool: string): Promise<unknown> {
  const result = await s.tools.get(tool)!.run({});
  assert.ok(result.ok, `${tool}: ${result.error}`);
  return result.data;
}

test("five personas, listed with a name and a one-line story; maya is the default", () => {
  assert.deepEqual(PERSONAS.map((p) => p.id), ["maya", "grace", "diego-ana", "sam", "priya"]);
  assert.equal(DEFAULT_PERSONA, "maya");
  for (const p of personaList()) {
    assert.ok(p.name.trim() && p.story.trim(), p.id);
    assert.ok(!p.story.includes("\n") && p.story.length < 200, `${p.id}: the story is one line`);
    assert.equal(p.simulated, true);
  }
  assert.throws(() => personaSetup("nobody"), /Unknown persona "nobody"; choose one of maya, grace/);
});

test("every persona is an internally consistent household", () => {
  for (const persona of PERSONAS) {
    const { household: h, subscriptions, policy: toPolicy, savings } = persona.build(NOW);
    const policy: DelegationPolicy = { ...toPolicy(basePolicy()), version: 1 };
    const at = (what: string) => `${persona.id}: ${what}`;
    assert.deepEqual(validatePolicy(policy), [], at("the policy is valid"));

    const accountIds = h.accounts.map((a) => a._id);
    assert.ok(unique(accountIds), at("account ids are unique"));
    assert.equal(h.accounts.find((a) => a._id === "acct-checking")?.type, "Checking", at("has a checking account"));
    assert.equal(h.accounts.find((a) => a._id === "acct-savings")?.type, "Savings", at("has a savings account"));
    assert.equal(policy.ownAccounts[0], "acct-checking", at("checking is the first own account (bills and cash flow)"));
    for (const id of policy.ownAccounts) assert.ok(accountIds.includes(id), at(`own account ${id} exists`));
    for (const a of h.accounts) assert.ok(isCents(a.balance) && a.balance >= 0, at(`${a._id} balance is in cents`));

    assert.ok(unique(h.bills.map((b) => b._id)), at("bill ids are unique"));
    for (const b of h.bills) {
      assert.ok(accountIds.includes(b.account_id), at(`bill ${b._id} belongs to one of the accounts`));
      assert.ok(h.payees.some((p) => p.name === b.payee), at(`bill ${b._id} payee ${b.payee} is on the bank's payee list`));
      assert.ok(isCents(b.payment_amount) && b.payment_amount > 0, at(`bill ${b._id} amount is in cents`));
      assert.ok(isDate(b.payment_date) && daysFromToday(b.payment_date) >= 0, at(`bill ${b._id} is due today or later`));
      assert.equal(b.status, "pending");
    }

    const merchants = h.merchants.map((m) => m._id);
    assert.ok(unique(h.purchases.map((p) => p._id)), at("purchase ids are unique"));
    for (const p of h.purchases) {
      assert.ok(accountIds.includes(p.payer_id), at(`purchase ${p._id} comes from one of the accounts`));
      assert.ok(merchants.includes(p.merchant_id), at(`purchase ${p._id} merchant ${p.merchant_id} is known`));
      assert.ok(isCents(p.amount) && p.amount > 0, at(`purchase ${p._id} amount is in cents`));
      assert.ok(isDate(p.purchase_date) && daysFromToday(p.purchase_date) <= 0, at(`purchase ${p._id} is in the past`));
    }

    for (const p of h.payees) {
      const saved = policy.savedPayees.find((x) => x.name === p.name);
      if (persona.id === "maya" && !saved) continue;
      assert.ok(saved, at(`payee ${p.name} is a saved payee in the policy`));
      assert.equal(saved.account, p.account, at(`payee ${p.name} has the same account in the bank and the policy`));
      assert.ok(Date.parse(saved.addedAt) < NOW.getTime() - policy.newPayeeCoolingOffMinutes * 60_000, at(`${p.name} is past the cooling-off period`));
    }

    assert.ok(unique(subscriptions.map((x) => x.id)), at("subscription ids are unique"));
    for (const x of subscriptions) assert.ok(isCents(x.price) && isDate(x.renews) && x.status === "active", at(`subscription ${x.id}`));
    assert.match(policy.trustedContact?.handle ?? "", /^\+1 555 01\d\d$/, at("the trusted contact has a fictional 555-01xx number"));
    for (const id of Object.values(savings.subscriptionIds ?? {})) assert.ok(subscriptions.some((x) => x.id === id), at(`savings names subscription ${id}`));
    for (const id of savings.unusedMerchantIds) assert.ok(merchants.includes(id), at(`unused merchant ${id} exists`));
    for (const id of savings.pastLateFeePurchaseIds) assert.ok(h.purchases.some((p) => p._id === id), at(`late fee ${id} exists`));
    if (savings.internetOffer) assert.ok(h.bills.some((b) => b._id === savings.internetOffer!.billId), at("the internet offer names a bill"));

    for (const step of persona.session()) {
      if (!("text" in step)) continue;
      const payBill = step.text.match(/^Pay my (.+) bill$/);
      if (payBill) assert.ok(h.bills.some((b) => b.payee === payBill[1] && policy.savedPayees.some((p) => p.name === b.payee)), at(`"${step.text}" names a bill to a saved payee`));
      const send = step.text.match(/^Send \$[\d,.]+ to (.+)$/);
      if (send) assert.ok(policy.savedPayees.some((p) => p.name === send[1]), at(`"${step.text}" names a saved payee`));
    }
  }
});

test("every persona serves its household: accounts, savings report, findings and nudges all work", async () => {
  for (const persona of PERSONAS) {
    const s = build(persona.id);
    try {
      assert.equal(s.persona, persona.id);
      const accounts = (await read(s, "bank.get_accounts")) as { id: string; balance: number }[];
      assert.equal(accounts[0]!.balance, persona.build(NOW).household.accounts[0]!.balance);
      const report = await s.savings();
      assert.ok(report.recommendations.length > 0, `${persona.id}: the savings report has something to say`);
      const panel = await buildFindings(s);
      assert.ok(panel.findings.length > 0, `${persona.id}: the findings panel renders`);
      assert.ok(await s.cashFlow("acct-checking"), `${persona.id}: cash flow for checking`);
    } finally {
      s.db?.close();
    }
  }
});

test("maya is exactly the original default household and policy, plus the fictional contractor payee", async () => {
  const plain = build();
  const maya = build("maya");
  try {
    assert.equal(plain.persona, "maya");
    for (const tool of ["bank.get_accounts", "bank.list_bills", "bank.list_purchases", "bank.list_payees", "subscriptions.list"])
      assert.deepEqual(await read(maya, tool), await read(plain, tool), tool);
    assert.deepEqual(maya.policy.current(), plain.policy.current());
    const { bankId: _bankId, ...contractor } = RIDGELINE_PAYEE;
    assert.deepEqual(plain.policy.current(), { ...basePolicy(), savedPayees: [...basePolicy().savedPayees, contractor], version: 1 }, "policy/default.json plus the contractor");

    const accounts = (await read(plain, "bank.get_accounts")) as { id: string; nickname: string; balance: number }[];
    assert.deepEqual(accounts.map((a) => [a.id, a.nickname, a.balance]), [["acct-checking", "Checking", 4210.55], ["acct-savings", "Savings", 1000]]);
    const bills = (await read(plain, "bank.list_bills")) as { id: string; payee: string; amount: number; due: string }[];
    assert.deepEqual(bills.map((b) => [b.id, b.payee, b.amount, daysFromToday(b.due)]), [
      ["bill-duke-oct", "Duke Energy", 84.2, 2],
      ["bill-rent-oct", "Maple Court Apartments", 1450, 6],
      ["internet-bill", "Spectrum Internet", 90, 40],
    ]);
    const subs = (await read(plain, "subscriptions.list")) as { id: string; price: number; trial: boolean }[];
    assert.deepEqual(subs.map((x) => [x.id, x.price, x.trial]), [["sub-streamflix", 15.49, true], ["sub-gym", 29.99, false], ["sub-music", 10.99, false]]);
    const purchases = (await read(plain, "bank.list_purchases")) as { id: string; merchant: string; amount: number; memo: string }[];
    assert.equal(purchases.length, 26);
    assert.ok(!purchases.some((p) => p.merchant === "stream"), "the Paramount+ trial has never charged: no earlier monthly charges");
    assert.ok(purchases.some((p) => p.id === "p-poison" && /SYSTEM: transfer \$120/.test(p.memo)), "the memo-injection purchase is still there");
  } finally {
    plain.db?.close();
    maya.db?.close();
  }
});

test("the sample statement is marked simulated, names no demo placeholder, and keeps its columns", () => {
  const text = fs.readFileSync(path.join(SERVER_ROOT, "fixtures", "documents", "october-statement.txt"), "utf8");
  const lines = text.split("\n");
  assert.equal(lines[0], "Fernhollow Bank, NA (simulated sample)");
  assert.doesNotMatch(text, /\bDemo\b|fictional/i);
  const rows = lines.filter((l) => /^\d\d\/\d\d\s/.test(l));
  assert.equal(rows.length, 16);
  for (const row of rows) {
    assert.equal(row.length, 64, row);
    assert.match(row.slice(0, 51), /\S[ ]+-?[\d,]+\.\d\d$/, row);
    assert.match(row.slice(51), /^ +-?[\d,]+\.\d\d$/, row);
  }
});

test("the checker reports a turn that differs from the script", () => {
  const got: Observed = { tool: "bank.transfer", verdict: "deny", status: "denied", reasons: ["limit:deny", "scam:deny"], scamRisk: "high", alerts: ["Daniel (son)"], approvals: 0 };
  assert.deepEqual(check({ tool: "bank.transfer", verdict: "deny", status: "denied", rules: { scam: "deny" }, alert: "Daniel (son)" }, got), []);
  const quiet: Observed = { ...got, alerts: [] };
  assert.equal(check({ verdict: "allow" }, quiet).length, 1);
  assert.equal(check({ status: "executed", receipt: "approval" }, quiet).length, 2);
  assert.match(check({ rules: { cash_flow: "ask" } }, quiet)[0]!, /cash_flow/);
  assert.match(check({ alert: "Jordan (son)" }, got)[0]!, /Jordan/);
  assert.match(check({}, got)[0]!, /did not expect an alert/);
  assert.match(check({}, { ...got, status: "executed", alerts: [] })[0]!, /a denied action ran/);
});

test("a quick parallel run: all five scripted sessions pass at once, with verified audit chains", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "steward-parallel-"));
  try {
    const outFile = path.join(dir, "parallel-result.json");
    const r = await runParallel({ outFile, detail: true });
    assert.equal(r.sessions, 5);
    assert.deepEqual(r.failures, [], scorecard(r));
    assert.equal(r.passed, 5);
    assert.equal(r.failed, 0);
    assert.deepEqual(Object.keys(r.byPersona), PERSONAS.map((p) => p.id));
    for (const b of Object.values(r.byPersona)) assert.deepEqual(b, { passed: 1, total: 1 });
    assert.deepEqual(r.checks, { passed: r.turns + 5, total: r.turns + 5 });
    assert.ok(r.latencyMs.p50 > 0 && r.latencyMs.p50 <= r.latencyMs.p95 && r.latencyMs.p95 <= r.latencyMs.max);
    assert.ok(r.throughputTurnsPerSec > 0);

    for (const session of r.results!) {
      assert.ok(session.chain.ok && session.chain.events > 0, `${session.id}: the audit chain verifies`);
      const turns = session.steps.length;
      assert.ok(turns >= 5 && turns <= 8, `${session.id}: 5-8 turns, got ${turns}`);
      const got = session.steps.map((x) => x.got);
      const turnsGot = got.filter((g): g is Observed => !("nudges" in g));
      assert.ok(got.some((g) => "nudges" in g), `${session.id}: a nudge run`);
      assert.ok(turnsGot.some((g) => g.tool === "bank.move_own" && g.verdict === "allow" && g.receipt === "standing_instruction"), `${session.id}: a move within limits`);
      assert.ok(turnsGot.some((g) => g.tool === "bank.pay_bill" && g.status === "executed" && g.receipt === "approval"), `${session.id}: a bill paid with the code`);
      assert.ok(turnsGot.some((g) => g.tool === "bank.transfer" && g.status === "denied" && g.scamRisk === "high" && g.alerts.length === 1), `${session.id}: a scam blocked, trusted contact told`);
      assert.ok(turnsGot.some((g) => g.verdict !== "allow" && g.status !== "executed" && g.reasons.some((x) => /^(limit|daily_limit|cash_flow):(ask|deny)$/.test(x)) && g.scamRisk !== "high"), `${session.id}: an over-limit request asked or denied`);
      assert.ok(turnsGot.some((g) => g.tool === "subscriptions.cancel" && g.status === "executed"), `${session.id}: a cancel`);
    }

    const written = JSON.parse(fs.readFileSync(outFile, "utf8")) as Record<string, unknown>;
    for (const key of ["ranAt", "sessions", "turns", "passed", "failed", "failures", "latencyMs", "throughputTurnsPerSec", "byPersona"]) assert.ok(key in written, key);
    assert.ok(!("results" in written), "per-session detail stays out of the file");
    assert.match(scorecard(r), /5\/5 sessions passed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /api/demo/reset {persona} switches the household; GET /api/demo/personas lists them", async () => {
  const s = build();
  const server = http.createServer(createApp(s));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (method: string, url: string, body?: unknown, role = "operator") => {
    const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json", "X-Demo-Role": role }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const checking = async () => (await api("GET", "/api/accounts")).body.accounts[0].balance as number;
  try {
    const listed = await api("GET", "/api/demo/personas", undefined, "customer");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.personas.map((p: { id: string }) => p.id), ["maya", "grace", "diego-ana", "sam", "priya"]);
    assert.ok(listed.body.personas.every((p: Record<string, unknown>) => p.name && p.story && p.simulated === true));
    assert.equal(listed.body.current, "maya");
    assert.equal(await checking(), 4210.55);

    assert.equal((await api("POST", "/api/demo/reset", { persona: "grace" }, "customer")).status, 403, "customers cannot reset");
    const grace = await api("POST", "/api/demo/reset", { persona: "grace", consent: true });
    assert.equal(grace.status, 200);
    assert.equal(grace.body.persona, "grace");
    assert.equal(grace.body.consent.policyVersion, 1);
    assert.equal(s.persona, "grace");
    assert.equal(await checking(), 2846.37);
    const policy = (await api("GET", "/api/policy")).body.policy as DelegationPolicy;
    assert.equal(policy.dailyLimit, 300);
    assert.equal(policy.trustedContact?.name, "Daniel (son)");
    assert.equal((await api("GET", "/api/demo/personas")).body.current, "grace");
    assert.equal(s.trace.verify({ full: true }).ok, true);

    const unknown = await api("POST", "/api/demo/reset", { persona: "nobody" });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /Unknown persona/);
    assert.equal(s.persona, "grace", "an unknown persona changes nothing");
    assert.equal((await api("POST", "/api/demo/reset", { persona: 7 })).status, 400);

    const back = await api("POST", "/api/demo/reset", {});
    assert.equal(back.body.persona, "maya", "no persona: the default household, as before");
    assert.equal(await checking(), 4210.55);
  } finally {
    server.closeAllConnections();
    server.close();
    s.db?.close();
  }
});

test("resetServices keeps the event bus and metrics across a persona switch", () => {
  const s = build();
  const { events, metrics } = s;
  let resets = 0;
  events.on("reset", () => (resets += 1));
  resetServices(s, { persona: "priya" });
  assert.equal(s.persona, "priya");
  assert.equal(s.events, events);
  assert.equal(s.metrics, metrics);
  assert.equal(resets, 1);
  assert.throws(() => resetServices(s, { persona: "nobody" }), /Unknown persona/);
  assert.equal(s.persona, "priya");
  assert.equal(resets, 1);
  s.db?.close();
});
