import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunOutcome } from "../policy/run.ts";
import type { AuthorizationReceipt } from "../types.ts";
import { accountNumbers, deterministicReply, dollarAmounts, emptyEvidence, evaluateReply, withoutCode, type TurnEvidence } from "./evaluator.ts";

const KB = new Set(["kb:scams/safe-account", "kb:savings/subscriptions"]);
const policy = { ownAccounts: ["acct-checking", "acct-savings"], savedPayees: [{ name: "Duke Energy", account: "3301" }], dailyLimit: 2500 };

function evidence(extra: Partial<TurnEvidence> = {}): TurnEvidence {
  return { ...emptyEvidence("move $300 to savings", policy), ...extra };
}

const receipt = { id: "rcpt_abc123", callId: "c1", action: "Move $300.00 from Checking ...1234 to Savings" } as unknown as AuthorizationReceipt;
const executed = { status: "executed", decision: { callId: "c1", verdict: "allow", reasons: [], provenance: [], latencyMs: 1 }, result: { ok: true, data: { balance: 3910.55 }, systemValues: [], texts: [] }, receipt } as unknown as RunOutcome;
const denied = {
  status: "denied",
  decision: {
    callId: "c2",
    verdict: "deny",
    reasons: [
      { rule: "scam", verdict: "deny", message: "ScamShield rates this high risk (safe account, inbound request)." },
      { rule: "provenance", verdict: "deny", message: "Account 9917 appears only in a forwarded message, never in your own words or your bank's records." },
      { rule: "limit", verdict: "ask", message: "$2,000.00 is over your $1,000.00 limit for sending money." },
    ],
    provenance: [],
    latencyMs: 1,
  },
} as unknown as RunOutcome;

test("amounts and account numbers are read from replies, not ids, dates or years", () => {
  assert.deepEqual(dollarAmounts("Moved $1,200.50 and 40 dollars, plus $ 7."), ["1,200.50", "40", "7"]);
  assert.deepEqual(accountNumbers("Sent to ...9917 on 2026-10-10 (receipt rcpt_1234567) in 2026, $3,301.00 kept."), ["9917"]);
});

test("grounded replies pass, including a correct SkillGate denial", () => {
  const ok = evaluateReply(`Done: Move $300.00 from Checking ...1234 to Savings. Receipt ${receipt.id}. Checking now has $3,910.55.`, evidence({ outcomes: [executed], receipts: [receipt] }), KB);
  assert.deepEqual(ok, { ok: true, problems: [] });
  const denial = deterministicReply(evidence({ outcomes: [denied] }));
  assert.match(denial, /^I did not do it\./);
  assert.deepEqual(evaluateReply(denial, evidence({ outcomes: [denied] }), KB), { ok: true, problems: [] });
  assert.ok(evaluateReply("You declined, so nothing was sent.", evidence(), KB).ok, "negated sentences make no claim");
  assert.ok(evaluateReply("See [kb:scams/safe-account]. Never share your code with anyone.", evidence(), KB).ok);
});

test("the evaluator catches an ungrounded amount, a false done, an unknown kb id and advice", () => {
  const ev = evidence();
  assert.deepEqual(evaluateReply("You could save $185.88 a year.", ev, KB).problems, ["The amount $185.88 does not appear in this turn's records or the customer's words."]);
  assert.deepEqual(evaluateReply("Sent it to account 4417.", ev, KB).problems, [
    "The number 4417 does not appear in this turn's records or the customer's words.",
    'It says "Sent" but no action was completed with a receipt in this turn.',
  ]);
  assert.deepEqual(evaluateReply("Done! Your $300 is in savings.", ev, KB).problems, ['It says "Done" but no action was completed with a receipt in this turn.']);
  assert.deepEqual(evaluateReply("This is a known pattern [kb:scams/made-up].", ev, KB).problems, ["It cites kb:scams/made-up, which is not in the knowledge base."]);
  assert.match(evaluateReply("You should buy index funds with the extra cash.", ev, KB).problems.join(" "), /investment advice/);
  assert.match(evaluateReply("I recommend you invest in bitcoin.", ev, KB).problems.join(" "), /investment advice/);
  assert.match(evaluateReply("Reply with your approval code to finish.", ev, KB).problems.join(" "), /asks the customer for a code/);
  assert.match(evaluateReply("I'm waiting for your approval code.", ev, KB).problems.join(" "), /approval is waiting/);
  assert.ok(evaluateReply("I can't tell you to invest in crypto; a licensed advisor can help.", ev, KB).ok, "negated advice is fine");
});

test("evidence never keeps an approval code; the floor reply is built from outcomes", () => {
  const notApproved = { status: "not_approved", decision: denied.decision, approval: { id: "appr_1", callId: "c2", code: "4821", status: "expired" } } as unknown as RunOutcome;
  assert.equal(JSON.stringify(withoutCode(notApproved)).includes("4821"), false);
  assert.equal(deterministicReply(evidence({ outcomes: [notApproved] })), "The approval request expired, so nothing was sent.");
  assert.match(deterministicReply(evidence()), /Nothing was moved or changed/);
});

test("after the receipt, a reply cannot say the payment still waits for approval", () => {
  const stale = evaluateReply(
    "SkillGate reviewed the $300 move and asked for your approval with a code. Once you approve it in your app, the payment will go through.",
    evidence({ outcomes: [executed], receipts: [receipt], pendingApprovals: 0 }),
    KB,
  );
  assert.equal(stale.ok, false);
  assert.ok(stale.problems.includes("It says an approval is waiting, but none is pending."));
  assert.equal(evaluateReply("Once you approve it in your app, the payment will go through.", evidence({ pendingApprovals: 1 }), KB).ok, true);
});
