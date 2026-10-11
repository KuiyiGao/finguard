import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TraceLog } from "../audit/trace.ts";
import { loadConfig } from "../config.ts";
import { consentStatement, loadPolicyFile, PolicyError, PolicyStore, validatePolicy } from "./store.ts";

const defaults = loadPolicyFile(loadConfig({}).policyFile);

test("the default policy file is valid and has the agreed limits", () => {
  assert.deepEqual(validatePolicy(defaults), []);
  const own = defaults.grants.find((g) => g.capability === "transfers.own");
  assert.deepEqual(own, { capability: "transfers.own", maxAmount: 500, approval: "over_limit" });
  assert.equal(defaults.grants.find((g) => g.capability === "bills.pay")?.approval, "always");
  assert.equal(defaults.grants.find((g) => g.capability === "transfers.external")?.approval, "always");
  assert.equal(defaults.paused, false);
  assert.ok(defaults.newPayeeCoolingOffMinutes > 0 && defaults.dailyLimit > 0);
});

test("starts at version 1 with no consent, recorded in the trace", () => {
  const trace = new TraceLog();
  const store = new PolicyStore(trace, defaults);
  assert.equal(store.current().version, 1);
  assert.equal(store.consent(), undefined);
  assert.equal(trace.list()[0]!.type, "policy_changed");
});

test("consent covers one version; a change needs new consent", () => {
  const trace = new TraceLog();
  const store = new PolicyStore(trace, defaults);
  const first = store.recordConsent("app");
  assert.equal(first.policyVersion, 1);
  assert.equal(first.policyHash, store.hash());
  assert.equal(store.recordConsent("app").id, first.id, "consenting twice to the same version is idempotent");

  const v2 = store.update({ dailyLimit: 1000 }, "lower the daily limit");
  assert.equal(v2.version, 2);
  assert.equal(store.consent(), undefined, "v2 has no consent yet");
  const second = store.recordConsent("imessage");
  assert.equal(second.policyVersion, 2);
  assert.match(second.statement, /\$1,000\.00 in a day/);
  assert.deepEqual(
    trace.list().map((e) => e.type),
    ["policy_changed", "consent_recorded", "policy_changed", "consent_recorded"],
  );
});

test("an update that changes nothing does not create a version", () => {
  const store = new PolicyStore(new TraceLog(), defaults);
  assert.equal(store.update({ dailyLimit: defaults.dailyLimit }).version, 1);
});

test("invalid changes are refused with every problem listed", () => {
  const store = new PolicyStore(new TraceLog(), defaults);
  assert.throws(
    () => store.update({ dailyLimit: -5, grants: [{ capability: "bills.pay", approval: "over_limit" }] }),
    (err: unknown) => err instanceof PolicyError && err.problems.length === 2,
  );
  assert.equal(store.current().version, 1);
});

test("a new saved payee gets an id and an addedAt time", () => {
  const store = new PolicyStore(new TraceLog(), defaults);
  const payees = [...store.current().savedPayees, { name: "Lee Plumbing", account: "6612" }];
  const added = store.update({ savedPayees: payees }).savedPayees.at(-1)!;
  assert.match(added.id, /^payee_/);
  assert.ok(Date.now() - Date.parse(added.addedAt) < 5000);
  assert.equal(store.current().savedPayees[0]!.addedAt, defaults.savedPayees[0]!.addedAt, "existing payees keep their date");
});

test("policy and consent are rebuilt from the persisted trace", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "steward-policy-")), "trace.jsonl");
  const store = new PolicyStore(new TraceLog(file), defaults);
  store.update({ paused: true });
  store.recordConsent("app");
  const reloaded = new PolicyStore(new TraceLog(file), defaults);
  assert.equal(reloaded.current().version, 2);
  assert.equal(reloaded.current().paused, true);
  assert.equal(reloaded.consent()?.policyVersion, 2);
});

test("the consent statement spells out limits and liability", () => {
  const text = consentStatement(defaults);
  assert.match(text, /move money between my own accounts without asking me up to \$500\.00 each/);
  assert.match(text, /pay my bills up to \$1,000\.00 each, only after I approve each one/);
  assert.match(text, /count as authorized by me/);
});
