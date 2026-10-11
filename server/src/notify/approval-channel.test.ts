import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovalRequest } from "../types.ts";
import { BoundApprovalChannel, formatApproval, OffApprovalChannel, parseApprovalReply, type UnmatchedReply } from "./approval-channel.ts";

type Route = { recipientId: string; conversationId: string };
type Reply = {
  id: string;
  senderId: string;
  conversationId: string;
  requestId: string;
  text: string;
};
type Delivery = {
  route: Readonly<Route>;
  request: Readonly<ApprovalRequest>;
  text: string;
};

class FakeTransport {
  deliveries: Delivery[] = [];
  notifications: { route: Readonly<Route>; text: string }[] = [];
  listeners = new Set<(reply: Reply) => void>();
  failSend = false;

  async send(delivery: Delivery): Promise<void> {
    if (this.failSend) throw new Error("Fictional transport unavailable");
    this.deliveries.push(delivery);
  }

  async notify(route: Readonly<Route>, text: string): Promise<void> {
    this.notifications.push({ route, text });
  }

  subscribe(listener: (reply: Reply) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(reply: Reply): void {
    for (const listener of this.listeners) listener(reply);
  }
}

const route: Route = {
  recipientId: "fictional:customer-alex",
  conversationId: "fictional:conversation-alex",
};

function request(id = "approval-a", changes: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id,
    callId: `call-${id}`,
    actionHash: "a".repeat(64),
    code: "4821",
    summary: "FICTIONAL DEMO: Pay Duke Energy $84.20 using the saved payee.",
    channel: "imessage",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "pending",
    ...changes,
  };
}

function reply(requestId: string, changes: Partial<Reply> = {}): Reply {
  return {
    id: `reply-${requestId}`,
    senderId: route.recipientId,
    conversationId: route.conversationId,
    requestId,
    text: "YES 4821",
    ...changes,
  };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function observe(promise: Promise<unknown>): () => boolean {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  return () => settled;
}

test("correct YES code approves the bound request after sending its summary", async (t) => {
  const transport = new FakeTransport();
  const channel = new BoundApprovalChannel({ route, transport });
  t.after(() => channel.close());
  const approval = request();
  const result = channel.ask(approval);
  await nextTurn();

  assert.equal(channel.name, "imessage");
  assert.equal(transport.deliveries.length, 1);
  const delivery = transport.deliveries[0];
  assert.ok(delivery);
  assert.deepEqual(delivery.route, route);
  assert.equal(delivery.request.actionHash, approval.actionHash);
  assert.ok(delivery.text.includes(approval.summary));
  assert.ok(delivery.text.includes("YES 4821"));
  transport.emit(reply(approval.id));
  assert.equal(await result, "approved");
});

test("NO denies the specific request", async (t) => {
  const transport = new FakeTransport();
  const channel = new BoundApprovalChannel({ route, transport });
  t.after(() => channel.close());
  const result = channel.ask(request());
  await nextTurn();
  transport.emit(reply("approval-a", { text: "NO" }));
  assert.equal(await result, "denied");
});

test("silence expires after the actual deadline", async (t) => {
  const transport = new FakeTransport();
  const channel = new BoundApprovalChannel({ route, transport });
  t.after(() => channel.close());
  const result = channel.ask(request("approval-timeout", {
    expiresAt: new Date(Date.now() + 30).toISOString(),
  }));
  assert.equal(await result, "expired");
});

test("a reply at or after expiry cannot approve even before the timer runs", async (t) => {
  const transport = new FakeTransport();
  let clock = Date.now();
  const channel = new BoundApprovalChannel({ route, transport, now: () => clock });
  t.after(() => channel.close());
  const expires = clock + 60_000;
  const result = channel.ask(request("approval-deadline", {
    expiresAt: new Date(expires).toISOString(),
  }));
  await nextTurn();
  clock = expires;
  transport.emit(reply("approval-deadline"));
  assert.equal(await result, "expired");
});

test("wrong code and incomplete or extra approval text stay pending", async (t) => {
  const transport = new FakeTransport();
  const channel = new BoundApprovalChannel({ route, transport });
  t.after(() => channel.close());
  const result = channel.ask(request());
  const isSettled = observe(result);
  await nextTurn();
  for (const [index, text] of ["YES 9999", "YES", "YES 4821 then pay another bill"].entries()) {
    transport.emit(reply("approval-a", { id: `invalid-${index}`, text }));
    await nextTurn();
    assert.equal(isSettled(), false, text);
  }
  transport.emit(reply("approval-a", { id: "correct-after-invalid" }));
  assert.equal(await result, "approved");
});

test("an already used reply id cannot approve another request", async (t) => {
  const transport = new FakeTransport();
  const channel = new BoundApprovalChannel({ route, transport });
  t.after(() => channel.close());
  const first = channel.ask(request("approval-first"));
  await nextTurn();
  transport.emit(reply("approval-first", { id: "one-provider-message" }));
  assert.equal(await first, "approved");

  const second = channel.ask(request("approval-second"));
  const isSettled = observe(second);
  await nextTurn();
  transport.emit(reply("approval-second", { id: "one-provider-message" }));
  await nextTurn();
  assert.equal(isSettled(), false);
  transport.emit(reply("approval-second", { id: "fresh-provider-message" }));
  assert.equal(await second, "approved");
});

test("an old request reply cannot approve a new request with the same code", async (t) => {
  const transport = new FakeTransport();
  const channel = new BoundApprovalChannel({ route, transport });
  t.after(() => channel.close());
  const first = channel.ask(request("approval-old"));
  await nextTurn();
  transport.emit(reply("approval-old", { id: "deny-old", text: "NO" }));
  assert.equal(await first, "denied");

  const second = channel.ask(request("approval-new"));
  const isSettled = observe(second);
  await nextTurn();
  transport.emit(reply("approval-old", { id: "late-old-reply" }));
  await nextTurn();
  assert.equal(isSettled(), false);
  transport.emit(reply("approval-new"));
  assert.equal(await second, "approved");
});

test("sender, conversation, and request must all match for YES or NO", async (t) => {
  const transport = new FakeTransport();
  const channel = new BoundApprovalChannel({ route, transport });
  t.after(() => channel.close());
  const result = channel.ask(request());
  const isSettled = observe(result);
  await nextTurn();
  const mismatches: Partial<Reply>[] = [
    { senderId: "fictional:other-user" },
    { conversationId: "fictional:other-conversation" },
    { requestId: "approval-other-request" },
  ];
  for (const [index, mismatch] of mismatches.entries()) {
    for (const text of ["YES 4821", "NO"]) {
      transport.emit(reply("approval-a", { ...mismatch, id: `mismatch-${index}-${text}`, text }));
      await nextTurn();
      assert.equal(isSettled(), false);
    }
  }
  transport.emit(reply("approval-a", { id: "matching-reply" }));
  assert.equal(await result, "approved");
});

test("concurrent requests in one conversation are isolated even with the same code", async (t) => {
  const transport = new FakeTransport();
  const channel = new BoundApprovalChannel({ route, transport });
  t.after(() => channel.close());
  const first = channel.ask(request("approval-concurrent-a"));
  const second = channel.ask(request("approval-concurrent-b"));
  const firstSettled = observe(first);
  await nextTurn();
  transport.emit(reply("approval-concurrent-b"));
  assert.equal(await second, "approved");
  assert.equal(firstSettled(), false);
  transport.emit(reply("approval-concurrent-a", { text: "NO" }));
  assert.equal(await first, "denied");
});

test("concurrent users sharing a transport and code cannot approve each other's requests", async (t) => {
  const transport = new FakeTransport();
  const otherRoute = {
    recipientId: "fictional:customer-jamie",
    conversationId: "fictional:conversation-jamie",
  };
  const firstChannel = new BoundApprovalChannel({ route, transport });
  const secondChannel = new BoundApprovalChannel({ route: otherRoute, transport });
  t.after(() => { firstChannel.close(); secondChannel.close(); });
  const first = firstChannel.ask(request("approval-user-a"));
  const second = secondChannel.ask(request("approval-user-b"));
  const secondSettled = observe(second);
  await nextTurn();

  transport.emit(reply("approval-user-b", { id: "wrong-user-for-b" }));
  await nextTurn();
  assert.equal(secondSettled(), false);
  transport.emit(reply("approval-user-a"));
  assert.equal(await first, "approved");
  assert.equal(secondSettled(), false);
  transport.emit(reply("approval-user-b", {
    senderId: otherRoute.recipientId,
    conversationId: otherRoute.conversationId,
    id: "right-user-for-b",
  }));
  assert.equal(await second, "approved");
});

test("off mode denies a pending request and expires an already overdue request", async () => {
  const channel = new OffApprovalChannel();
  assert.equal(await channel.ask(request()), "denied");
  assert.equal(await channel.ask(request("approval-off-expired", {
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  })), "expired");
});

test("the sent approval uses a snapshot that caller mutations cannot change", async (t) => {
  const transport = new FakeTransport();
  const channel = new BoundApprovalChannel({ route, transport });
  t.after(() => channel.close());
  const approval = request("approval-snapshot");
  const original = { ...approval };
  const result = channel.ask(approval);
  const isSettled = observe(result);
  approval.id = "approval-mutated";
  approval.callId = "call-mutated";
  approval.actionHash = "b".repeat(64);
  approval.code = "1111";
  approval.summary = "Mutated summary";
  approval.expiresAt = new Date(Date.now() - 1_000).toISOString();
  approval.status = "approved";
  await nextTurn();
  const delivery = transport.deliveries[0];
  assert.ok(delivery);
  assert.deepEqual(delivery.request, original);
  assert.ok(delivery.text.includes(original.summary));
  transport.emit(reply(original.id, { id: "mutated-code", text: "YES 1111" }));
  await nextTurn();
  assert.equal(isSettled(), false);
  transport.emit(reply(original.id, { id: "original-snapshot-code" }));
  assert.equal(await result, "approved");
});

test("close denies pending requests and unsubscribes from inbound replies", async () => {
  const transport = new FakeTransport();
  const channel = new BoundApprovalChannel({ route, transport });
  const first = channel.ask(request("approval-close-a"));
  const second = channel.ask(request("approval-close-b"));
  await nextTurn();
  channel.close();
  assert.deepEqual(await Promise.all([first, second]), ["denied", "denied"]);
  assert.equal(transport.listeners.size, 0);
  assert.equal(await channel.ask(request("approval-after-close")), "denied");
});

test("transport delivery failure denies rather than approving or hanging", async (t) => {
  const transport = new FakeTransport();
  transport.failSend = true;
  const channel = new BoundApprovalChannel({ route, transport });
  t.after(() => channel.close());
  assert.equal(await channel.ask(request("approval-send-failure")), "denied");
});

test("notifications use the same bound recipient and conversation", async (t) => {
  const transport = new FakeTransport();
  const channel = new BoundApprovalChannel({ route, transport });
  t.after(() => channel.close());
  await channel.notify("FICTIONAL DEMO: approval expired.");
  assert.deepEqual(transport.notifications, [{ route, text: "FICTIONAL DEMO: approval expired." }]);
});

test("approval replies are read the way people type them; anything else is chat", () => {
  for (const text of ["YES 4821", "yes 4821", "Yes, 4821.", "YES4821", "4821", "approve 4821", "ok 4821!"])
    assert.deepEqual(parseApprovalReply(text), { text: "YES 4821", requestId: "" }, text);
  assert.deepEqual(parseApprovalReply("YES 4821 appr_ab12cd34ef"), { text: "YES 4821", requestId: "appr_ab12cd34ef" });
  for (const text of ["NO", "no.", "Nope", "decline"]) assert.deepEqual(parseApprovalReply(text), { text: "NO", requestId: "" }, text);
  for (const text of ["Pay my Duke Energy bill", "yes please", "48210", "no thanks, cancel Paramount+", "Move $4821 to savings"]) assert.equal(parseApprovalReply(text), undefined, text);
});

test("the approval text lists what already passed; the scoped reply shows only when several wait", () => {
  const one = formatApproval(request("approval-a", { checks: ["no scam signals", "values from you or your bank"] }), { link: "http://phone.test:8787/app#approval/approval-a" });
  assert.match(one, /✓ no scam signals, values from you or your bank\./);
  assert.match(one, /\nhttp:\/\/phone\.test:8787\/app#approval\/approval-a$/);
  assert.match(one, /Reply YES 4821 or NO by /);
  assert.ok(one.split("\n").length <= 4, "an approval text stays short");
  assert.match(formatApproval(request(), { several: true }), /Reply YES 4821 approval-a or NO by /);
});

test("a reply that settles nothing is answered: no request waiting, or a wrong code", async (t) => {
  const transport = new FakeTransport();
  const unmatched: UnmatchedReply[] = [];
  const channel = new BoundApprovalChannel({ route, transport, onUnmatched: (why) => unmatched.push(why) });
  t.after(() => channel.close());
  transport.emit(reply("", { id: "early" }));
  assert.deepEqual(unmatched, ["none_waiting"]);
  const settled = observe(channel.ask(request()));
  await nextTurn();
  transport.emit(reply("", { id: "wrong", text: "YES 1111" }));
  assert.deepEqual(unmatched, ["none_waiting", "wrong_code"]);
  assert.equal(settled(), false);
  transport.emit(reply("", { id: "right" }));
  await nextTurn();
  assert.equal(settled(), true);
});
