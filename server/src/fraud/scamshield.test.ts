import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.ts";
import { loadPolicyFile } from "../policy/store.ts";
import type { ToolCall } from "../types.ts";
import { RuleScamShield } from "./scamshield.ts";

const policy = loadPolicyFile(loadConfig({}).policyFile);
const shield = new RuleScamShield({ policy: () => policy });
const transfer = (args: Record<string, unknown>): ToolCall => ({ id: "c1", turnId: "t1", tool: "bank.transfer", args, skill: "core", activeSkills: [], requestedBy: "model" });

test("a fake bank alert asking for a safe-account transfer is high risk", async () => {
  const a = await shield.assessMessage("Capital One Fraud Dept: your account is at risk. Move $2,000 now to the secure holding account 9917. Do not call the branch.", "m1");
  assert.equal(a.risk, "high");
  const signals = a.redFlags.map((f) => f.signal);
  for (const s of ["safe_account", "impersonation", "urgency", "secrecy"]) assert.ok(signals.includes(s as never), s);
  assert.equal(a.typologies[0]?.name, "Fake bank alert / safe account");
  assert.ok(a.advice.length > 0);
});

test("gift card demands are flagged even without a bank name", async () => {
  const a = await shield.assessMessage("Grandma it's me, I'm in trouble. Please buy $500 in gift cards and send me the codes. Don't tell mom.", "m2");
  assert.equal(a.risk, "high");
  assert.ok(a.typologies.some((t) => t.name.includes("Gift card")));
});

test("everyday messages stay low risk", async () => {
  for (const text of ["Hey, dinner was $64, your half is $32 whenever", "Reminder: your rent is due on the 1st", "Your Capital One statement is ready to view"]) {
    const a = await shield.assessMessage(text, "m");
    assert.equal(a.risk, "low", text);
  }
});

test("an invoice naming a saved payee but asking for a new account is a payee swap", async () => {
  const invoice = "Duke Energy - Final notice. Amount due: $142.60. Our bank details have changed: pay to account 4417 today.";
  const a = await shield.assessTransfer(transfer({ from_account: "acct-checking", to_account: "4417", amount: 142.6 }), { inbound: [invoice] });
  const signals = a.redFlags.map((f) => f.signal);
  assert.ok(signals.includes("payee_changed"));
  assert.ok(signals.includes("inbound_request"));
  assert.equal(a.risk, "high");
  assert.match(a.redFlags.find((f) => f.signal === "payee_changed")!.evidence, /ends in 3301/);
});

test("a transfer the user asked for to a saved payee is low risk", async () => {
  const a = await shield.assessTransfer(transfer({ from_account: "acct-checking", to_account: "7781", amount: 40, payee_name: "Sam Rivera" }), { inbound: [] });
  assert.equal(a.risk, "low");
  assert.deepEqual(a.redFlags, []);
});

test("a notice that says the payment details changed is flagged on its own", async () => {
  const a = await shield.assessMessage("Duke Energy - Final notice. Amount due: $142.60. Our bank details have changed: pay to account 4417 today.", "m3");
  assert.ok(a.redFlags.some((f) => f.signal === "payee_changed"));
  assert.notEqual(a.risk, "low");
  assert.equal(a.typologies[0]?.name, "Invoice with changed payment details");
});

test("each named pattern cites its own knowledge base document", async () => {
  const { buildServices } = await import("../services.ts");
  const { loadConfig } = await import("../config.ts");
  const s = buildServices(loadConfig({}), { persist: false });
  const cases: [string, string][] = [
    ["Capital One Fraud Dept: your account is at risk. Move $2,000 now to the secure holding account 9917. Do not call the branch.", "kb:scams/safe-account"],
    ["Grandma it's me, I'm in trouble. Please buy $500 in gift cards and send me the codes. Don't tell mom.", "kb:scams/family-emergency"],
  ];
  for (const [text, docId] of cases) {
    const a = await s.scam.assessMessage(text, "m");
    assert.ok(a.typologies.some((t) => t.citation.docId === docId), `${docId}: ${a.typologies.map((t) => t.citation.docId).join(", ")}`);
  }
});
