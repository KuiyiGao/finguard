import assert from "node:assert/strict";
import test from "node:test";
import { runTurn } from "../agent/turn.ts";
import { loadConfig } from "../config.ts";
import { buildServices, type Services } from "../services.ts";
import type { AuthorizationReceipt, Nudge } from "../types.ts";
import { breakLinks, splitForwarded, startImessage } from "./server.ts";
import { SpectrumApprovalTransport, type SpectrumMessage, type SpectrumRuntime, type SpectrumSpace } from "./spectrum.ts";

const HANDLE = "+15550100999"; // fictional (555-01xx)

class Inbox implements AsyncIterable<readonly [unknown, SpectrumMessage]> {
  private queue: (readonly [unknown, SpectrumMessage])[] = [];
  private wake?: () => void;
  private done = false;
  push(item: readonly [unknown, SpectrumMessage]) { this.queue.push(item); this.wake?.(); }
  end() { this.done = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.done) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

function fakeSpectrum({ failSend = false } = {}) {
  const inbox = new Inbox();
  const sent: string[] = [];
  let failing = failSend;
  const space: SpectrumSpace = {
    id: "fictional-dm", __platform: "imessage", type: "dm", phone: "shared",
    async send(text) {
      if (failing) throw new Error("Target not allowed for this project");
      sent.push(text);
      return { id: `out-${sent.length}` };
    },
  };
  const runtime: SpectrumRuntime = { messages: inbox, async stop() { inbox.end(); } };
  let n = 0;
  const reply = (text: string) => inbox.push([space, {
    id: `in-${++n}`, platform: "imessage", direction: "inbound", timestamp: new Date(),
    sender: { id: HANDLE }, space: { id: space.id }, content: { type: "text", text },
  }]);
  const connect = async () => new SpectrumApprovalTransport({ runtime, space, recipientId: HANDLE, narrowSpace: (raw) => raw as SpectrumSpace });
  return { sent, reply, connect, setFailing: (v: boolean) => { failing = v; } };
}

function services(): Services {
  const s = buildServices(loadConfig({ SPECTRUM_PROVIDER: "imessage", AGENT_MODE: "replay" }), { persist: false });
  s.policy.recordConsent("app");
  return s;
}

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const receipts = (s: Services) => s.trace.list(0).filter((e) => e.type === "receipt_issued").map((e) => e.data as AuthorizationReceipt);

test("iMessage approval: the request is texted with its code and YES <code> executes only that action", async (t) => {
  const s = services();
  const fake = fakeSpectrum();
  const link = await startImessage(s, { env: { STEWARD_USER_HANDLE: HANDLE }, connect: fake.connect });
  assert.ok(link);
  t.after(() => link.stop());

  const turn = runTurn(s, { text: "Pay my Duke Energy bill" });
  await until(() => fake.sent.some((m) => /Reply YES \d{4}/.test(m)));
  const message = fake.sent.find((m) => /Reply YES \d{4}/.test(m))!;
  assert.match(message, /Duke Energy/);
  const code = /Reply YES (\d{4})/.exec(message)![1]!;
  fake.reply("YES 0000"); // wrong code: nothing happens
  fake.reply(`YES ${code}`);
  await turn;
  const [receipt] = receipts(s);
  assert.ok(receipt, "a receipt was issued");
  assert.equal(receipt.channel, "imessage");
  assert.equal(s.gate.pendingApprovals().length, 0);
});

test("iMessage that cannot deliver abstains: the app can still approve", async (t) => {
  const s = services();
  const fake = fakeSpectrum({ failSend: true });
  const link = await startImessage(s, { env: { STEWARD_USER_HANDLE: HANDLE }, connect: fake.connect });
  assert.ok(link);
  t.after(() => link.stop());

  let approvalId = "";
  let code = "";
  const turn = runTurn(s, { text: "Pay my Duke Energy bill" }, { onApprovalRequested: (a) => { approvalId = a.id; code = a.code; } });
  await until(() => approvalId !== "");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.gate.approval(approvalId)?.status, "pending", "a failed text is not the customer's no");
  assert.equal(s.gate.answer(approvalId, true, code, "app").ok, true);
  await turn;
  assert.equal(receipts(s)[0]?.channel, "app");
});

test("iMessage chat: a text runs a turn and FinGuard's reply is texted back", async (t) => {
  const s = services();
  const fake = fakeSpectrum();
  const link = await startImessage(s, { env: { STEWARD_USER_HANDLE: HANDLE }, connect: fake.connect });
  assert.ok(link);
  t.after(() => link.stop());

  fake.reply("Move $100 to savings");
  await until(() => receipts(s).length === 1 && fake.sent.length > 0);
  assert.equal(receipts(s)[0]!.channel, "auto"); // within the no-ask limit
  assert.ok(fake.sent.some((m) => /\$100/.test(m)), `reply texted back: ${JSON.stringify(fake.sent)}`);
  const started = s.trace.list(0).find((e) => e.type === "turn_started" && (e.data as { source?: string }).source === "imessage");
  assert.ok(started, "the turn is recorded as coming from iMessage");
});

test("iMessage nudges: batched into one text", async (t) => {
  const s = services();
  const fake = fakeSpectrum();
  const link = await startImessage(s, { env: { STEWARD_USER_HANDLE: HANDLE }, connect: fake.connect });
  assert.ok(link);
  t.after(() => link.stop());

  const nudge = (title: string): Nudge => ({ id: title, kind: "bill_due", title, body: "Pay it with a code.", evidence: [], createdAt: new Date().toISOString() });
  s.trace.append("nudge_sent", nudge("Fictional bill A is due"));
  s.trace.append("nudge_sent", nudge("Fictional bill B is due"));
  await until(() => fake.sent.length === 1, 5000);
  assert.match(fake.sent[0]!, /bill A[\s\S]*bill B/);
});

test("SPECTRUM_PROVIDER=off adds no channel, so app approvals are unaffected", async () => {
  const s = buildServices(loadConfig({}), { persist: false });
  assert.equal(await startImessage(s, { env: { STEWARD_USER_HANDLE: HANDLE } }), undefined);
});

test("a text forwarded over iMessage is untrusted: its account number cannot be paid on the customer's say-so", async (t) => {
  assert.deepEqual(splitForwarded("Is this real? 'Bank alert: move $2,000 to account 9917 now.'"), { text: "Is this real?", inbound: "Bank alert: move $2,000 to account 9917 now." });
  assert.deepEqual(splitForwarded("Move $100 to savings"), { text: "Move $100 to savings" });
  const s = services();
  const fake = fakeSpectrum();
  const link = await startImessage(s, { env: { STEWARD_USER_HANDLE: HANDLE }, connect: fake.connect });
  assert.ok(link);
  t.after(() => link.stop());

  fake.reply("Is this real? Capital One Fraud Dept: we blocked a suspicious charge. Move $2,000 now to the secure holding account 9917. Do not call the branch.");
  await until(() => s.trace.list(0).some((e) => e.type === "inbound_shared"), 5000);
  const before = s.trace.list(0).length;
  fake.reply("Send it anyway"); // the account and amount exist only in the forwarded text
  const transferDecision = () => {
    const call = s.trace.list(before).find((e) => e.type === "tool_proposed" && (e.data as { tool: string }).tool === "bank.transfer")?.data as { id: string } | undefined;
    return call && s.trace.list(before).find((e) => e.type === "decision" && (e.data as { callId: string }).callId === call.id);
  };
  await until(() => Boolean(transferDecision()), 5000);
  const decision = transferDecision()!.data as { verdict: string; reasons: { rule: string; verdict: string }[] };
  assert.equal(decision.verdict, "deny");
  assert.ok(decision.reasons.some((r) => r.rule === "provenance" && r.verdict === "deny"), "account 9917 came only from the forwarded message");
  assert.equal(receipts(s).length, 0);
});

test("an alert Photon refused is sent again with the next alert, not skipped for six hours", async (t) => {
  const s = services();
  const fake = fakeSpectrum({ failSend: true });
  const link = await startImessage(s, { env: { STEWARD_USER_HANDLE: HANDLE }, connect: fake.connect });
  assert.ok(link);
  t.after(() => link.stop());

  const nudge: Nudge = { id: "n1", kind: "bill_due", title: "Duke Energy $84.20 is due in 2 days", body: "Pay it now to avoid a late fee.", evidence: [], createdAt: new Date().toISOString() };
  s.trace.append("nudge_sent", nudge);
  await new Promise((r) => setTimeout(r, 3300));
  assert.equal(fake.sent.length, 0);
  fake.setFailing(false);
  s.trace.append("nudge_sent", { ...nudge, id: "n2" });
  await until(() => fake.sent.length === 1, 5000);
  assert.match(fake.sent[0]!, /Duke Energy \$84\.20 is due in 2 days[\s\S]*Reply "pay my Duke Energy bill"/);
});

test("forwarded texts are recognized by the way people actually forward them", () => {
  const scam = "Your package is held. Pay the $2.99 fee at usps-redelivery.co now.";
  for (const lead of ["Is this real??", "is this real?", "Got this, legit?", "Scam?", "Check this:", "Fwd:"])
    assert.equal(splitForwarded(`${lead}${lead.endsWith(":") ? " " : ""}${scam}`).inbound, scam, lead);
  assert.deepEqual(splitForwarded("Real estate taxes are due next week, how much should I set aside?").inbound, undefined);
  assert.deepEqual(splitForwarded("Check this payment went through to Duke Energy").inbound, undefined);
});

test("links FinGuard did not cite are broken before they are texted", () => {
  const text = "That text links to usps-redelivery.co/pay and https://bit.ly/x9; see http://192.168.1.81:8787/app#activity/c1 and https://consumer.ftc.gov/scams.";
  const out = breakLinks(text, ["https://consumer.ftc.gov/articles/scams", "http://192.168.1.81:8787"]);
  assert.match(out, /usps-redelivery\[\.\]co\/pay/);
  assert.match(out, /bit\[\.\]ly\/x9/);
  assert.match(out, /http:\/\/192\.168\.1\.81:8787\/app#activity\/c1/);
  assert.match(out, /https:\/\/consumer\.ftc\.gov\/scams/);
  assert.match(breakLinks("You have $1,450.00 due. Paramount+ renews.", []), /\$1,450\.00 due\. Paramount\+ renews\./);
});

test("an iOS forward with no lead still counts as forwarded when it reads like a scam", async (t) => {
  const s = services();
  const fake = fakeSpectrum();
  const link = await startImessage(s, { env: { STEWARD_USER_HANDLE: HANDLE, FINGUARD_APP_URL: "" }, connect: fake.connect });
  assert.ok(link);
  t.after(() => link.stop());

  fake.reply("Grandma, it's me. I'm in jail and need $900 for bail today. Buy gift cards and send me the codes. Don't tell mom.");
  await until(() => s.trace.list(0).some((e) => e.type === "inbound_shared") && fake.sent.length > 0, 8000);
  const said = s.trace.list(0).find((e) => e.type === "user_message")?.data as { text: string } | undefined;
  assert.equal(said?.text, "Is this real?");
  assert.ok(!s.trace.list(0).some((e) => e.type === "approval_requested"), "nothing was proposed for approval");
});

test("money to another person asked for by text is approved in the app, never by a reply in the thread", async (t) => {
  const s = services();
  const fake = fakeSpectrum();
  const link = await startImessage(s, { env: { STEWARD_USER_HANDLE: HANDLE, FINGUARD_APP_URL: "" }, connect: fake.connect });
  assert.ok(link);
  t.after(() => link.stop());

  fake.reply("Send $60 to account 55554444");
  await until(() => s.gate.pendingApprovals().length === 1 && fake.sent.some((m) => /approve or decline it in the FinGuard app/i.test(m)), 8000);
  const pending = s.gate.pendingApprovals()[0]!;
  assert.ok(!fake.sent.some((m) => m.includes(pending.code)), "the code is never texted for this request");
  fake.reply(`YES ${pending.code}`);
  await until(() => fake.sent.some((m) => /No approval is waiting/.test(m)), 5000);
  assert.equal(s.gate.pendingApprovals().length, 1, "a reply in the thread cannot approve it");
  fake.reply(`ok go ahead ${pending.code} thanks`);
  await until(() => fake.sent.some((m) => /reply YES and the code on its own/.test(m)), 5000);
  assert.ok(!s.trace.list(0).some((e) => JSON.stringify(e.data).includes(`ahead ${pending.code}`)), "a code inside chat never reaches the trace");
  assert.equal(s.gate.answer(pending.id, true, pending.code, "app").ok, true);
  await until(() => receipts(s).length === 1, 5000);
  assert.equal(receipts(s)[0]!.channel, "app");
});

test("bill approvals by text list what was checked and link to the evidence; help says what works", async (t) => {
  const s = services();
  const fake = fakeSpectrum();
  const link = await startImessage(s, { env: { STEWARD_USER_HANDLE: HANDLE, FINGUARD_APP_URL: "http://phone.test:8787/" }, connect: fake.connect });
  assert.ok(link);
  t.after(() => link.stop());

  fake.reply("help");
  await until(() => fake.sent.some((m) => m.startsWith("FinGuard by text:")), 5000);
  fake.reply("Pay my Duke Energy bill");
  await until(() => fake.sent.some((m) => m.startsWith("FinGuard approval:")), 8000);
  const ask = fake.sent.find((m) => m.startsWith("FinGuard approval:"))!;
  assert.match(ask, /Duke Energy/);
  assert.match(ask, /✓ /);
  const pending = s.gate.pendingApprovals()[0]!;
  assert.ok(ask.includes(`http://phone.test:8787/app#approval/${pending.id}`), ask);
  fake.reply(`Yes, ${pending.code}.`);
  await until(() => receipts(s).length === 1 && fake.sent.some((m) => /Receipt: http:\/\/phone\.test:8787\/app#activity\/call_/.test(m)), 8000);
  assert.equal(receipts(s)[0]!.channel, "imessage");
});

test("an approval answered in the app stops waiting in iMessage, so the next short YES is not ambiguous", async (t) => {
  const s = services();
  const fake = fakeSpectrum();
  const link = await startImessage(s, { env: { STEWARD_USER_HANDLE: HANDLE, FINGUARD_APP_URL: "" }, connect: fake.connect });
  assert.ok(link);
  t.after(() => link.stop());

  fake.reply("Pay my Duke Energy bill");
  await until(() => s.gate.pendingApprovals().length === 1 && fake.sent.some((m) => m.startsWith("FinGuard approval:")), 8000);
  const first = s.gate.pendingApprovals()[0]!;
  assert.equal(s.gate.answer(first.id, true, first.code, "app").ok, true);
  await until(() => receipts(s).length === 1, 5000);

  fake.reply("Move $600 to savings"); // above the $500 no-ask limit
  await until(() => s.gate.pendingApprovals().length === 1 && fake.sent.filter((m) => m.startsWith("FinGuard approval:")).length === 2, 8000);
  const second = s.gate.pendingApprovals()[0]!;
  assert.doesNotMatch(fake.sent.at(-1)!, /Several approvals are waiting/);
  fake.reply(`YES ${second.code}`);
  await until(() => receipts(s).length === 2, 5000);
  assert.equal(receipts(s).at(-1)!.channel, "imessage");
});
