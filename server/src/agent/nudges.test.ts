import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.ts";
import { replayApproval } from "../demo/scenes.ts";
import { buildServices } from "../services.ts";
import { findNudges, sendNudges } from "./nudges.ts";
import { runTurn } from "./turn.ts";

function setup() {
  const s = buildServices(loadConfig({ APPROVAL_TTL_SECONDS: "5" }), { persist: false });
  s.policy.recordConsent("app");
  return s;
}

const approveWithCode = (s: ReturnType<typeof setup>) => ({ onApprovalRequested: (a: { id: string }) => void s.gate.answer(a.id, true, s.gate.approval(a.id)!.code) });

test("FinGuard finds what to act on before the user asks", async () => {
  const s = setup();
  const nudges = await findNudges(s);
  const kinds = nudges.map((n) => n.kind);
  assert.deepEqual(kinds.sort(), ["bill_due", "safe_to_save", "subscription_renewing", "trial_ending"].sort());
  const save = nudges.find((n) => n.kind === "safe_to_save")!;
  assert.match(save.title, /\$2,176\.35 is safe to save/);
  assert.deepEqual(save.action?.args, { from_account: "acct-checking", to_account: "acct-savings", amount: 500 });
  await sendNudges(s);
  assert.equal(s.trace.list().filter((e) => e.type === "nudge_sent").length, 4);
});

test("cancelling a subscription needs a code and leaves a receipt", async () => {
  const s = setup();
  const { replies } = await runTurn(s, { text: "Cancel the Paramount+ trial" }, approveWithCode(s));
  assert.match(replies[0]!, /This needs your approval: Cancel Paramount\+/);
  assert.match(replies.at(-1)!, /^Cancelled Paramount\+\. You will not be charged \$15\.49 again\. Receipt rcpt_/);
  const receipt = s.gate.receipts().at(-1)!;
  assert.equal(receipt.authorizedBy.kind, "approval");
  assert.equal(receipt.values[0]?.origin, "system", "the subscription id came from the bank record");
});

test("a move that would leave checking short of upcoming bills asks first", async () => {
  const s = setup();
  s.policy.update({ dailyLimit: 10000, grants: s.policy.current().grants.map((g) => (g.capability === "transfers.own" ? { ...g, maxAmount: 5000 } : g)) });
  s.policy.recordConsent("app");
  const fine = await runTurn(s, { text: "Move $1,000 to savings" });
  assert.match(fine.replies[0]!, /^Done: Move \$1,000\.00/);
  let reason = "";
  await runTurn(s, { text: "Move $2,500 to savings" }, {
    onApprovalRequested: (a) => {
      reason = a.summary;
      s.gate.answer(a.id, false, undefined);
    },
  });
  assert.match(reason, /would leave \$710\.55 in Checking, short of the \$1,534\.20 due in the next 14 days \(Duke Energy \$84\.20, Maple Court Apartments \$1,450\.00\) plus your \$500\.00 buffer/);
});

test("an approved code cannot be reused for a different payment", async () => {
  const s = setup();
  let approvalId = "";
  await runTurn(s, { text: "Pay my Duke Energy bill" }, {
    onApprovalRequested: (a) => {
      approvalId = a.id;
      s.gate.answer(a.id, true, s.gate.approval(a.id)!.code);
    },
  });
  const result = await replayApproval(s, approvalId);
  assert.ok(!("error" in result));
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "That approval was given for a different action.");
  assert.notEqual(result.originalHash, result.forgedHash);
  assert.ok(s.trace.list().some((e) => e.type === "approval_reuse_blocked"));
  assert.ok(s.trace.verify().ok);
});
