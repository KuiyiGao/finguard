import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.ts";
import { fixtureText } from "../demo/scenes.ts";
import { buildServices } from "../services.ts";
import { amountIn, requestIn } from "./rules.ts";
import { runTurn } from "./turn.ts";

test("amounts and requests are read from text", () => {
  assert.equal(amountIn("move $1,200.50 to savings"), 1200.5);
  assert.equal(amountIn("move 300 to savings"), 300);
  assert.equal(amountIn("send 40 dollars to Sam"), 40);
  assert.equal(amountIn("send it to 9917"), null);
  assert.deepEqual(requestIn("We blocked a $1,940 charge. Move $2,000 now to account 9917."), { amount: 2000, account: "9917" });
  assert.deepEqual(requestIn("Amount due: $142.60. Pay to account 4417 today."), { amount: 142.6, account: "4417" });
});

function setup() {
  const s = buildServices(loadConfig({ APPROVAL_TTL_SECONDS: "5" }), { persist: false });
  s.policy.recordConsent("app");
  return s;
}

test("paying the bill on file asks for approval, then pays after the code", async () => {
  const s = setup();
  const turn = runTurn(s, { text: "Pay my Duke Energy bill" }, { onApprovalRequested: (a) => void s.gate.answer(a.id, true, s.gate.approval(a.id)!.code) });
  const { replies } = await turn;
  assert.match(replies[0]!, /This needs your approval: Pay Duke Energy bill, \$84\.20, from Checking/);
  assert.match(replies[1]!, /^Done: Pay Duke Energy bill, \$84\.20/);
});

test("a forwarded invoice with a different account is blocked", async () => {
  const s = setup();
  const { replies } = await runTurn(s, { text: "Pay this invoice too", inbound: { id: "duke-invoice", text: fixtureText("duke-invoice") } });
  assert.ok(replies.some((r) => /^I did not do it\. ScamShield rates this high risk \(changed payment details/.test(r)), replies.join(" | "));
});

test("the agent asks how much when no amount is given", async () => {
  const s = setup();
  const { replies } = await runTurn(s, { text: "move some money to savings" });
  assert.deepEqual(replies, ["How much should I move to savings?"]);
});

test("pause from chat stops money movement", async () => {
  const s = setup();
  await runTurn(s, { text: "pause all payments" });
  assert.equal(s.policy.current().paused, true);
  const { replies } = await runTurn(s, { text: "move $20 to savings" });
  assert.match(replies[0]!, /Money movement is paused/);
});
