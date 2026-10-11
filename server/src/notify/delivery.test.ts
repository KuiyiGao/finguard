import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovalRequest } from "../types.ts";
import {
  BoundApprovalChannel,
  type ApprovalDelivery,
  type ApprovalOutcome,
  type ApprovalReply,
  type ApprovalRoute,
  type ApprovalTransport,
} from "./approval-channel.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

class DeferredTransport implements ApprovalTransport {
  readonly delivery = deferred();
  readonly deliveries: ApprovalDelivery[] = [];
  readonly listeners = new Set<(reply: ApprovalReply) => void>();

  send(delivery: ApprovalDelivery): Promise<void> {
    this.deliveries.push(delivery);
    return this.delivery.promise;
  }

  async notify(_route: Readonly<ApprovalRoute>, _text: string): Promise<void> {}

  subscribe(listener: (reply: ApprovalReply) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(reply: ApprovalReply): void {
    for (const listener of this.listeners) listener(reply);
  }
}

const route: ApprovalRoute = {
  recipientId: "fictional:delivery-alex",
  conversationId: "fictional:delivery-conversation",
};

function request(id: string, changes: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id,
    callId: `call-${id}`,
    actionHash: "a".repeat(64),
    code: "4821",
    summary: "FICTIONAL DEMO: Review a proposed $84.20 bill payment.",
    channel: "imessage",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "pending",
    ...changes,
  };
}

function reply(requestId: string, changes: Partial<ApprovalReply> = {}): ApprovalReply {
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

function observe(promise: Promise<ApprovalOutcome>) {
  const outcomes: ApprovalOutcome[] = [];
  void promise.then((outcome) => { outcomes.push(outcome); });
  return outcomes;
}

test("a valid reply during send waits for successful delivery and preserves the action snapshot", async (t) => {
  const transport = new DeferredTransport();
  const channel = new BoundApprovalChannel({ route, transport });
  t.after(() => channel.close());
  const approval = request("delivery-early-yes");
  const original = { ...approval };
  const result = channel.ask(approval);
  const outcomes = observe(result);
  approval.id = "delivery-mutated-id";
  approval.code = "9999";
  approval.actionHash = "b".repeat(64);
  approval.summary = "Mutated summary";
  await nextTurn();

  assert.equal(transport.deliveries.length, 1);
  const delivery = transport.deliveries[0];
  assert.ok(delivery);
  assert.deepEqual(delivery.request, original);
  assert.ok(delivery.text.includes(original.summary));
  transport.emit(reply(original.id));
  await nextTurn();
  assert.deepEqual(outcomes, [], "no approval before delivery succeeds");

  transport.delivery.resolve();
  assert.equal(await result, "approved");
  await nextTurn();
  assert.deepEqual(outcomes, ["approved"]);
  assert.equal(transport.deliveries.length, 1, "early reply does not resend the summary");
});

test("a valid NO during send waits for successful delivery then denies", async (t) => {
  const transport = new DeferredTransport();
  const channel = new BoundApprovalChannel({ route, transport });
  t.after(() => channel.close());
  const result = channel.ask(request("delivery-early-no"));
  const outcomes = observe(result);
  await nextTurn();
  transport.emit(reply("delivery-early-no", { text: "NO" }));
  await nextTurn();
  assert.deepEqual(outcomes, []);

  transport.delivery.resolve();
  assert.equal(await result, "denied");
  assert.equal(transport.deliveries.length, 1);
});

test("wrong sender, conversation, request, and code cannot become buffered approvals", async (t) => {
  const transport = new DeferredTransport();
  const channel = new BoundApprovalChannel({ route, transport });
  t.after(() => channel.close());
  const result = channel.ask(request("delivery-routing"));
  const outcomes = observe(result);
  await nextTurn();
  for (const [index, changes] of [
    { senderId: "fictional:other-user" },
    { conversationId: "fictional:other-conversation" },
    { requestId: "delivery-other-request" },
    { text: "YES 9999" },
  ].entries()) {
    transport.emit(reply("delivery-routing", { id: `invalid-early-${index}`, ...changes }));
  }
  transport.delivery.resolve();
  await nextTurn();
  assert.deepEqual(outcomes, []);

  transport.emit(reply("delivery-routing", { id: "correct-after-send" }));
  assert.equal(await result, "approved");
});

test("delivery failure denies even when a correct YES arrived while sending", async (t) => {
  const transport = new DeferredTransport();
  const channel = new BoundApprovalChannel({ route, transport });
  t.after(() => channel.close());
  const result = channel.ask(request("delivery-failed"));
  const outcomes = observe(result);
  await nextTurn();
  transport.emit(reply("delivery-failed"));
  await nextTurn();
  assert.deepEqual(outcomes, []);

  transport.delivery.reject(new Error("Fictional delivery failure"));
  assert.equal(await result, "denied");
  await nextTurn();
  assert.deepEqual(outcomes, ["denied"]);
  assert.equal(transport.deliveries.length, 1);
});

test("a hung send expires despite a correct early reply and late success cannot approve", async (t) => {
  const transport = new DeferredTransport();
  const channel = new BoundApprovalChannel({ route, transport });
  t.after(() => channel.close());
  const result = channel.ask(request("delivery-hung", {
    expiresAt: new Date(Date.now() + 50).toISOString(),
  }));
  const outcomes = observe(result);
  await nextTurn();
  assert.equal(transport.deliveries.length, 1);
  transport.emit(reply("delivery-hung"));
  assert.equal(await result, "expired");

  transport.delivery.resolve();
  await nextTurn();
  transport.emit(reply("delivery-hung", { id: "late-after-expiry" }));
  await nextTurn();
  assert.deepEqual(outcomes, ["expired"]);
  assert.equal(transport.deliveries.length, 1);
});

test("close before the queued send starts denies without delivering a summary", async () => {
  const transport = new DeferredTransport();
  const channel = new BoundApprovalChannel({ route, transport });
  const result = channel.ask(request("delivery-close-queued"));
  channel.close();
  assert.equal(await result, "denied");
  await nextTurn();
  assert.equal(transport.deliveries.length, 0);
  assert.equal(transport.listeners.size, 0);
});

test("a reply before send starts is consumed and cannot be replayed after delivery", async (t) => {
  const transport = new DeferredTransport();
  const channel = new BoundApprovalChannel({ route, transport });
  t.after(() => channel.close());
  const result = channel.ask(request("delivery-premature"));
  const outcomes = observe(result);
  const premature = reply("delivery-premature", { id: "premature-provider-message" });
  transport.emit(premature);
  await nextTurn();
  transport.delivery.resolve();
  await nextTurn();
  transport.emit(premature);
  await nextTurn();
  assert.deepEqual(outcomes, []);

  transport.emit(reply("delivery-premature", { id: "fresh-after-delivery" }));
  assert.equal(await result, "approved");
  assert.equal(transport.deliveries.length, 1);
});

test("deadline reached before the queued send starts expires without delivering", async (t) => {
  const transport = new DeferredTransport();
  let clock = Date.now();
  const deadline = clock + 60_000;
  const channel = new BoundApprovalChannel({ route, transport, now: () => clock });
  t.after(() => channel.close());
  const result = channel.ask(request("delivery-expired-before-send", {
    expiresAt: new Date(deadline).toISOString(),
  }));

  clock = deadline;
  assert.equal(await result, "expired");
  await nextTurn();
  assert.equal(transport.deliveries.length, 0);
});

test("send rejection at the deadline expires even before the expiry timer runs", async (t) => {
  const transport = new DeferredTransport();
  let clock = Date.now();
  const deadline = clock + 60_000;
  const channel = new BoundApprovalChannel({ route, transport, now: () => clock });
  t.after(() => channel.close());
  const result = channel.ask(request("delivery-reject-at-deadline", {
    expiresAt: new Date(deadline).toISOString(),
  }));
  await nextTurn();
  assert.equal(transport.deliveries.length, 1);

  clock = deadline;
  transport.delivery.reject(new Error("Fictional rejection at expiry"));
  assert.equal(await result, "expired");
});

test("send success at the deadline expires without waiting for a reply or timer", async (t) => {
  const transport = new DeferredTransport();
  let clock = Date.now();
  const deadline = clock + 60_000;
  const channel = new BoundApprovalChannel({ route, transport, now: () => clock });
  t.after(() => channel.close());
  const result = channel.ask(request("delivery-success-at-deadline", {
    expiresAt: new Date(deadline).toISOString(),
  }));
  const outcomes = observe(result);
  await nextTurn();
  assert.equal(transport.deliveries.length, 1);

  clock = deadline;
  transport.delivery.resolve();
  assert.equal(await result, "expired");
  transport.emit(reply("delivery-success-at-deadline"));
  await nextTurn();
  assert.deepEqual(outcomes, ["expired"]);
  assert.equal(transport.deliveries.length, 1);
});

test("a resolved request ID cannot be reused for a different action", async (t) => {
  const transport = new DeferredTransport();
  const channel = new BoundApprovalChannel({ route, transport });
  t.after(() => channel.close());
  const result = channel.ask(request("delivery-used-request"));
  await nextTurn();
  transport.delivery.resolve();
  await nextTurn();
  transport.emit(reply("delivery-used-request"));
  assert.equal(await result, "approved");

  assert.equal(await channel.ask(request("delivery-used-request", {
    callId: "fictional:different-call",
    actionHash: "b".repeat(64),
  })), "denied");
  await nextTurn();
  assert.equal(transport.deliveries.length, 1, "reused request is never delivered again");
});
