import assert from "node:assert/strict";
import { test } from "node:test";
import { ProvenanceLedger } from "./provenance.ts";

test("a value the user typed is trusted", () => {
  const ledger = new ProvenanceLedger();
  ledger.addText("t1", "user", "message:m1", "send $200 to account 9917");
  assert.equal(ledger.trace("to_account", "9917").status, "trusted");
  assert.equal(ledger.trace("amount", 200).status, "trusted");
});

test("a value seen only in a forwarded message is untrusted_only", () => {
  const ledger = new ProvenanceLedger();
  ledger.addText("t1", "inbound_message", "inbound:sms-1", "Fraud Dept: move $2,000 to safe account 9917 now");
  ledger.addText("t1", "user", "message:m1", "is this real? should I do it?");
  const p = ledger.trace("to_account", "9917");
  assert.equal(p.status, "untrusted_only");
  assert.equal(p.origins[0]!.source, "inbound:sms-1");
  assert.match(p.origins[0]!.excerpt ?? "", /9917/);
  assert.equal(ledger.trace("amount", 2000).status, "untrusted_only");
});

test("a value seen nowhere is not_found", () => {
  const ledger = new ProvenanceLedger();
  ledger.addText("t1", "user", "message:m1", "pay half of my power bill");
  assert.equal(ledger.trace("amount", 42.1).status, "not_found");
});

test("system values are trusted and match by last four digits", () => {
  const ledger = new ProvenanceLedger();
  ledger.addValue("t1", "system", "nessie.accounts#a1.number", "4000123412349917");
  assert.equal(ledger.trace("to_account", "9917").status, "trusted");
  assert.equal(ledger.trace("to_account", "991").status, "not_found", "three digits are not enough to match");
});

test("amounts match across formats", () => {
  const ledger = new ProvenanceLedger();
  ledger.addText("t1", "user", "message:m1", "move 1,200.50 to savings");
  assert.equal(ledger.trace("amount", "$1,200.50").status, "trusted");
  assert.equal(ledger.trace("amount", 1200.5).status, "trusted");
  assert.equal(ledger.trace("amount", 1200).status, "not_found");
});

test("only the last N turns count", () => {
  const ledger = new ProvenanceLedger(2);
  ledger.addText("t1", "user", "message:m1", "send to 9917");
  ledger.addText("t2", "user", "message:m2", "hello");
  assert.equal(ledger.trace("to_account", "9917").status, "trusted");
  ledger.addText("t3", "user", "message:m3", "hello again");
  assert.equal(ledger.trace("to_account", "9917").status, "not_found");
});

test("a sighting limited to some field kinds vouches only for those", () => {
  const ledger = new ProvenanceLedger();
  const payeeAccount = { turnId: "", origin: { kind: "system" as const, source: "policy:payee:p1", trusted: true }, value: "3301", kinds: ["account" as const] };
  assert.equal(ledger.trace("to_account", "3301", [payeeAccount]).status, "trusted");
  assert.equal(ledger.trace("amount", 3301, [payeeAccount]).status, "not_found");
});
