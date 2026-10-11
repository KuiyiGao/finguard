import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, SERVER_ROOT } from "../config.ts";
import { loadPolicyFile } from "../policy/store.ts";
import { BM25Retriever, loadKnowledgeBaseSync } from "../rag/index.ts";
import { RuleScamShield } from "./scamshield.ts";

const policy = loadPolicyFile(loadConfig({}).policyFile);
const shield = new RuleScamShield({ policy: () => policy, retriever: new BM25Retriever(loadKnowledgeBaseSync(path.join(SERVER_ROOT, "kb"))) });

test("an investment pitch promising guaranteed daily returns is an investment scam with its own citation", async () => {
  const a = await shield.assessMessage("Our AI trading desk pays guaranteed 2% daily returns. Act within 24 hours: send USDT to the wallet below.", "m");
  assert.ok(a.risk === "high" || a.risk === "medium");
  assert.ok(a.redFlags.some((f) => f.signal === "guaranteed_returns"));
  assert.equal(a.typologies[0]?.name, "Investment scam");
  assert.equal(a.typologies[0]?.citation.docId, "kb:scams/investment-scam");
  assert.match(a.typologies[0]?.citation.url ?? "", /^https:\/\/consumer\.ftc\.gov\//);
});

test("a loan forgiveness text asking for an upfront fee is loan relief with its own citation", async () => {
  const a = await shield.assessMessage("You qualify to have your federal student loans forgiven. Pay the $499 processing fee today to enroll.", "m");
  assert.ok(a.risk === "high" || a.risk === "medium");
  assert.ok(a.redFlags.some((f) => f.signal === "upfront_fee"));
  assert.equal(a.typologies[0]?.name, "Loan relief with an upfront fee");
  assert.equal(a.typologies[0]?.citation.docId, "kb:scams/loan-relief");
  const fee = await shield.assessMessage("Debt relief offer: an upfront fee of $300 starts your program.", "m");
  assert.ok(fee.redFlags.some((f) => f.signal === "upfront_fee"));
});

test("rates, shop returns, no-fee promises and ordinary loan notices are not flagged", async () => {
  for (const text of [
    "Your Capital One CD earns a guaranteed rate of 4.25% APY.",
    "Free returns guaranteed for 30 days on every order.",
    "We never charge upfront fees for our services.",
    "You never have to pay a fee to receive your tax refund.",
    "Your auto loan payment of $465.78 is due Oct 15.",
    "Late notice: pay your Duke Energy bill by Friday to avoid a $5 fee.",
    "Get 3% Daily Cash back on every purchase with your card.",
  ]) {
    const a = await shield.assessMessage(text, "m");
    assert.equal(a.risk, "low", text);
    assert.deepEqual(a.redFlags.filter((f) => f.signal === "guaranteed_returns" || f.signal === "upfront_fee"), [], text);
  }
});

test("the new patterns are not named for unrelated scams", async () => {
  const crypto = await shield.assessMessage("They asked me to send bitcoin to a wallet address to fix my account now", "m");
  assert.ok(!crypto.typologies.some((t) => t.name === "Investment scam"));
  const loan = await shield.assessMessage("Your loan payment is late. Pay now by wire transfer to avoid collections.", "m");
  assert.ok(!loan.typologies.some((t) => t.name === "Loan relief with an upfront fee"));
});
