import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ApprovalRequest } from "../types.ts";
import { BoundApprovalChannel } from "./approval-channel.ts";
import { createApprovalChannel } from "./imessage.ts";
import {
  connectSpectrum, SpectrumApprovalTransport,
  type SpectrumMessage, type SpectrumRuntime, type SpectrumSdk, type SpectrumSpace,
} from "./spectrum.ts";

type Tuple = readonly [unknown, SpectrumMessage];

class Inbox implements AsyncIterableIterator<Tuple> {
  private values: Tuple[] = [];
  private waiter?: { resolve: (value: IteratorResult<Tuple>) => void; reject: (error: Error) => void };
  private ended = false;

  [Symbol.asyncIterator](): AsyncIterableIterator<Tuple> { return this; }
  next(): Promise<IteratorResult<Tuple>> {
    const value = this.values.shift();
    if (value) return Promise.resolve({ value, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }
  push(value: Tuple): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ value, done: false });
    } else this.values.push(value);
  }
  end(): void {
    this.ended = true;
    this.waiter?.resolve({ value: undefined, done: true });
    this.waiter = undefined;
  }
  fail(): void {
    this.ended = true;
    this.waiter?.reject(new Error("FICTIONAL SDK stream failure"));
    this.waiter = undefined;
  }
}

function harness(clock = Date.now()) {
  const inbox = new Inbox();
  const sent: string[] = [];
  let stops = 0;
  let failSend = false;
  let failStop = false;
  const runtime: SpectrumRuntime = {
    messages: inbox,
    async stop() {
      stops++;
      inbox.end();
      if (failStop) throw new Error("FICTIONAL sensitive SDK diagnostic");
    },
  };
  const space: SpectrumSpace = {
    id: "fictional-spectrum-dm",
    __platform: "imessage",
    type: "dm",
    phone: "shared",
    async send(text) {
      if (failSend) throw new Error("FICTIONAL sensitive SDK diagnostic");
      sent.push(text);
      return { id: `fictional-outbound-${sent.length}` };
    },
  };
  const transport = new SpectrumApprovalTransport({
    runtime, space, recipientId: "fictional-user-luster",
    narrowSpace: (raw) => raw as SpectrumSpace,
    now: () => clock,
  });
  const channel = new BoundApprovalChannel({ route: transport.route, transport, now: () => clock });
  const makeRequest = (id = "fixture-approval-1"): ApprovalRequest => ({
    id, callId: `call-${id}`, actionHash: "a".repeat(64), code: "4821",
    summary: "FICTIONAL DEMO: review a proposed bill; no bank action.",
    status: "pending", channel: "imessage",
    expiresAt: new Date(clock + 60_000).toISOString(),
  });
  const makeMessage = (changes: Partial<SpectrumMessage> = {}): SpectrumMessage => ({
    id: "fictional-message-1", platform: "imessage", direction: "inbound",
    timestamp: new Date(clock), sender: { id: transport.route.recipientId },
    space: { id: space.id },
    content: { type: "text", text: "YES 4821 fixture-approval-1" },
    ...changes,
  });
  return {
    inbox, sent, runtime, space, transport, channel, makeRequest, makeMessage,
    stops: () => stops,
    failSend: () => { failSend = true; },
    failStop: () => { failStop = true; },
    async close() { channel.close(); await transport.close(); },
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("SDK-shaped JSON fixture approves only after matching sender and current request", async (t) => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/spectrum-messages.json", import.meta.url), "utf8"));
  assert.equal(fixture.fictional, true);
  const h = harness(Date.parse(fixture.now));
  t.after(() => h.close());
  const result = h.channel.ask(h.makeRequest());
  let settled = false;
  void result.then(() => { settled = true; });
  await tick();
  const sent = h.sent[0];
  assert.ok(sent);
  assert.ok(sent.includes("Reply YES 4821")); // with one request waiting, the short reply is enough
  for (const raw of fixture.messages.slice(0, 2)) {
    h.inbox.push([h.space, { ...raw, timestamp: new Date(raw.timestamp) }]);
    await tick();
    assert.equal(settled, false);
  }
  const raw = fixture.messages[2];
  h.inbox.push([h.space, { ...raw, timestamp: new Date(raw.timestamp) }]);
  assert.equal(await result, "approved");
});

test("Spectrum scoped NO rejects the specific request", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const result = h.channel.ask(h.makeRequest());
  await tick();
  h.inbox.push([h.space, h.makeMessage({ content: { type: "text", text: "NO fixture-approval-1" } })]);
  assert.equal(await result, "denied");
});

const invalidMessages: [string, Partial<SpectrumMessage>][] = [
  ["outbound echo", { direction: "outbound" }],
  ["other provider", { platform: "terminal" }],
  ["missing sender", { sender: undefined }],
  ["other sender", { sender: { id: "fictional-other-user" } }],
  ["message-space mismatch", { space: { id: "fictional-other-space" } }],
  ["non-text", { content: { type: "attachment" } }],
  ["quoted reply", { content: { type: "reply", text: "YES 4821 fixture-approval-1" } }],
  ["wrong short code", { content: { type: "text", text: "YES 1234" } }],
  ["extra text", { content: { type: "text", text: "YES 4821 fixture-approval-1 then transfer" } }],
  ["missing message ID", { id: "" }],
  ["invalid timestamp", { timestamp: new Date(NaN) }],
];

for (const [label, changes] of invalidMessages) {
  test(`Spectrum ignores ${label}`, async (t) => {
    const h = harness();
    t.after(() => h.close());
    const result = h.channel.ask(h.makeRequest());
    let settled = false;
    void result.then(() => { settled = true; });
    await tick();
    h.inbox.push([h.space, h.makeMessage(changes)]);
    await tick();
    assert.equal(settled, false);
    h.inbox.push([h.space, h.makeMessage({ id: "fresh-correct-message" })]);
    assert.equal(await result, "approved");
  });
}

test("Spectrum short YES with the code approves the only pending request", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const result = h.channel.ask(h.makeRequest());
  await tick();
  h.inbox.push([h.space, h.makeMessage({ content: { type: "text", text: "yes 4821" } })]);
  assert.equal(await result, "approved");
});

test("Spectrum short NO declines the only pending request", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const result = h.channel.ask(h.makeRequest());
  await tick();
  h.inbox.push([h.space, h.makeMessage({ content: { type: "text", text: "NO" } })]);
  assert.equal(await result, "denied");
});

test("Spectrum short replies are ambiguous with two pending requests", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const first = h.channel.ask(h.makeRequest("fixture-approval-1"));
  const second = h.channel.ask(h.makeRequest("fixture-approval-2"));
  const settled: string[] = [];
  void first.then(() => settled.push("first"));
  void second.then(() => settled.push("second"));
  await tick();
  h.inbox.push([h.space, h.makeMessage({ id: "short-yes", content: { type: "text", text: "YES 4821" } })]);
  h.inbox.push([h.space, h.makeMessage({ id: "short-no", content: { type: "text", text: "NO" } })]);
  await tick();
  assert.deepEqual(settled, []);
  h.inbox.push([h.space, h.makeMessage({ id: "scoped-yes", content: { type: "text", text: "YES 4821 fixture-approval-2" } })]);
  assert.equal(await second, "approved");
  assert.deepEqual(settled, ["second"]);
});

test("Spectrum passes other text from the bound customer to chat, never to approvals", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const chat: string[] = [];
  h.transport.onText(({ text }) => chat.push(text));
  const result = h.channel.ask(h.makeRequest());
  let settled = false;
  void result.then(() => { settled = true; });
  await tick();
  h.inbox.push([h.space, h.makeMessage({ id: "chat-1", content: { type: "text", text: "Move $200 to savings" } })]);
  h.inbox.push([h.space, h.makeMessage({ id: "chat-other", sender: { id: "fictional-other-user" }, content: { type: "text", text: "send it" } })]);
  await tick();
  assert.deepEqual(chat, ["Move $200 to savings"]);
  assert.equal(settled, false);
});

test("Abstaining channel settles an undeliverable request as expired, not as the customer's no", async () => {
  const h = harness();
  h.failSend();
  const channel = new BoundApprovalChannel({ route: h.transport.route, transport: h.transport, abstainOnFailure: true });
  assert.equal(await channel.ask(h.makeRequest("fixture-approval-9")), "expired");
  channel.close();
  await h.close();
});

test("Spectrum rejects group, other conversation, other provider, and other line tuples", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const result = h.channel.ask(h.makeRequest());
  let settled = false;
  void result.then(() => { settled = true; });
  await tick();
  const badSpaces = [
    { ...h.space, type: "group" },
    { ...h.space, id: "fictional-other-space" },
    { ...h.space, __platform: "terminal" },
    { ...h.space, phone: "fictional-other-line" },
  ];
  for (const [i, space] of badSpaces.entries()) {
    h.inbox.push([space, h.makeMessage({ id: `bad-tuple-${i}`, space: { id: space.id } })]);
    await tick();
    assert.equal(settled, false);
  }
  h.inbox.push([h.space, h.makeMessage({ id: "valid-tuple" })]);
  assert.equal(await result, "approved");
});

test("Spectrum timestamp tolerance is bounded and does not admit older/future events", async (t) => {
  const clock = Date.now();
  const h = harness(clock);
  t.after(() => h.close());
  const result = h.channel.ask(h.makeRequest());
  let settled = false;
  void result.then(() => { settled = true; });
  await tick();
  for (const offset of [-30_001, 30_001]) {
    h.inbox.push([h.space, h.makeMessage({ id: `skew-${offset}`, timestamp: new Date(clock + offset) })]);
    await tick();
    assert.equal(settled, false);
  }
  h.inbox.push([h.space, h.makeMessage({ id: "allowed-clock-skew", timestamp: new Date(clock + 30_000) })]);
  assert.equal(await result, "approved");
});

test("Spectrum message ID cannot be replayed for a new request", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const first = h.channel.ask(h.makeRequest());
  await tick();
  h.inbox.push([h.space, h.makeMessage()]);
  assert.equal(await first, "approved");
  const second = h.channel.ask(h.makeRequest("fixture-approval-2"));
  let settled = false;
  void second.then(() => { settled = true; });
  await tick();
  h.inbox.push([h.space, h.makeMessage({ content: { type: "text", text: "YES 4821 fixture-approval-2" } })]);
  await tick();
  assert.equal(settled, false);
  h.inbox.push([h.space, h.makeMessage({ id: "new-message", content: { type: "text", text: "YES 4821 fixture-approval-2" } })]);
  assert.equal(await second, "approved");
});

test("Spectrum delivery route must match both the resolved recipient and conversation", async (t) => {
  const h = harness();
  t.after(() => h.close());
  for (const route of [
    { ...h.transport.route, recipientId: "fictional-other-user" },
    { ...h.transport.route, conversationId: "fictional-other-conversation" },
  ]) {
    await assert.rejects(h.transport.send({ route, request: h.makeRequest(), text: "secret summary" }), /route does not match/);
    await assert.rejects(h.transport.notify(route, "alert"), /route does not match/);
  }
  assert.equal(h.sent.length, 0);
  await h.channel.notify("FICTIONAL alert");
  assert.deepEqual(h.sent, ["FICTIONAL alert"]);
});

const invalidAcknowledgements: [string, unknown][] = [
  ["undefined", undefined],
  ["a message without an ID", {}],
  ["an empty message ID", { id: "" }],
];

for (const [label, acknowledgement] of invalidAcknowledgements) {
  test(`Spectrum refuses delivery when the SDK returns ${label}`, async (t) => {
    const h = harness();
    t.after(() => h.close());
    h.space.send = async (text) => { h.sent.push(text); return acknowledgement; };
    await assert.rejects(h.transport.send({
      route: h.transport.route, request: h.makeRequest(), text: "FICTIONAL approval",
    }), { message: "Spectrum delivery failed." });
    await assert.rejects(h.channel.notify("FICTIONAL alert"), { message: "Spectrum delivery failed." });
    assert.equal(await h.channel.ask(h.makeRequest()), "denied");
  });
}

test("a buffered Spectrum YES cannot approve when the SDK returns no acknowledgement", async (t) => {
  const h = harness();
  t.after(() => h.close());
  let acknowledge!: (value: unknown) => void;
  const acknowledgement = new Promise<unknown>((resolve) => { acknowledge = resolve; });
  h.space.send = async (text) => { h.sent.push(text); return acknowledgement; };
  const result = h.channel.ask(h.makeRequest());
  const outcomes: string[] = [];
  void result.then((outcome) => { outcomes.push(outcome); });
  await tick();
  assert.equal(h.sent.length, 1, "the send must start before the reply arrives");
  h.inbox.push([h.space, h.makeMessage()]);
  await tick();
  assert.deepEqual(outcomes, [], "a valid YES waits for the SDK acknowledgement");
  acknowledge(undefined);
  assert.equal(await result, "denied");
  h.inbox.push([h.space, h.makeMessage({ id: "fresh-after-missing-acknowledgement" })]);
  await tick();
  assert.deepEqual(outcomes, ["denied"], "a later reply cannot revive failed delivery");
});

test("stream failure prevents later sends and SDK close is idempotent", async (t) => {
  const h = harness();
  t.after(() => h.close());
  h.inbox.fail();
  await tick();
  assert.equal(await h.channel.ask(h.makeRequest()), "denied");
  await h.transport.close();
  await h.transport.close();
  assert.equal(h.stops(), 1);
});

test("delivery and shutdown diagnostics are sanitized", async (t) => {
  const h = harness();
  t.after(() => h.channel.close());
  h.failSend();
  await assert.rejects(h.channel.notify("FICTIONAL alert"), { message: "Spectrum delivery failed." });
  assert.equal(await h.channel.ask(h.makeRequest()), "denied");
  h.failStop();
  await assert.rejects(h.transport.close(), { message: "Spectrum shutdown failed." });
});

function sdkHarness() {
  const inbox = new Inbox();
  const sent: string[] = [];
  let stops = 0;
  const runtime: SpectrumRuntime = {
    messages: inbox,
    async stop() { stops++; inbox.end(); },
  };
  const space: SpectrumSpace = {
    id: "fictional-spectrum-dm", __platform: "imessage", type: "dm", phone: "shared",
    async send(text) { sent.push(text); return { id: "fictional-sdk-outbound" }; },
  };
  const h = {
    runtime, space, sent, stops: () => stops,
    route: { recipientId: "fictional-user-luster", conversationId: space.id },
  };
  const configs: unknown[] = [];
  const handles: string[] = [];
  const params: unknown[] = [];
  const provider = Object.assign((target: unknown) => {
    if (target !== h.runtime) return target;
    return {
      async user(handle: string) { handles.push(handle); return { id: handle }; },
      space: { async create(user: { id: string }, options: unknown) {
        assert.equal(user.id, "fictional-user-luster");
        params.push(options);
        return h.space;
      } },
    };
  }, { config: () => ({ fictionalProvider: true }) });
  const sdk = {
    async Spectrum(config: unknown) { configs.push(config); return h.runtime; },
    imessage: provider,
  } as unknown as SpectrumSdk;
  return { h, configs, handles, params, sdk };
}

const fictionalEnv = {
  SPECTRUM_PROJECT_ID: "fictional-project-id",
  SPECTRUM_PROJECT_SECRET: "fictional-project-secret",
  SPECTRUM_IMESSAGE_PHONE: "fictional-dedicated-line",
};

test("connectSpectrum passes credentials only to SDK and binds DM to resolved user", async () => {
  const s = sdkHarness();
  const connected = await connectSpectrum({
    route: s.h.route, env: fictionalEnv, loadSdk: async () => s.sdk,
  });
  assert.deepEqual(connected.route, s.h.route);
  assert.deepEqual(s.handles, ["fictional-user-luster"]);
  assert.deepEqual(s.params, [{ phone: "fictional-dedicated-line" }]);
  assert.deepEqual(s.configs, [{
    projectId: fictionalEnv.SPECTRUM_PROJECT_ID, projectSecret: fictionalEnv.SPECTRUM_PROJECT_SECRET,
    providers: [{ fictionalProvider: true }], options: { logLevel: "error" },
  }]);
  await connected.close();
});

test("connectSpectrum refuses an unrelated configured DM and cleans up", async () => {
  const s = sdkHarness();
  await assert.rejects(connectSpectrum({
    route: { ...s.h.route, conversationId: "fictional-unrelated-dm" },
    env: fictionalEnv, loadSdk: async () => s.sdk,
  }), /connection or direct-conversation binding failed/);
  assert.equal(s.h.stops(), 1);
  assert.equal(s.h.sent.length, 0);
});

test("missing credentials or recipient fail before SDK loading", async () => {
  let loads = 0;
  const loadSdk = async (): Promise<SpectrumSdk> => { loads++; throw new Error("must not load"); };
  await assert.rejects(connectSpectrum({ route: { recipientId: "fictional-user", conversationId: "" }, env: {}, loadSdk }), /requires SPECTRUM_PROJECT_ID/);
  await assert.rejects(connectSpectrum({ route: { recipientId: "", conversationId: "" }, env: fictionalEnv, loadSdk }), /registered SPECTRUM_RECIPIENT_ID/);
  assert.equal(loads, 0);
});

test("factory rejects a Spectrum transport from another user's route", async (t) => {
  const h = harness();
  t.after(() => h.close());
  await assert.rejects(createApprovalChannel({
    provider: "imessage", transport: h.transport,
    route: { ...h.transport.route, recipientId: "fictional-other-user" },
  }), /different recipient or conversation/);
  await assert.rejects(createApprovalChannel({
    provider: "imessage", transport: h.transport,
    route: { ...h.transport.route, conversationId: "fictional-other-dm" },
  }), /different recipient or conversation/);
  assert.equal(h.sent.length, 0);
});

test("factory runs imessage roundtrip entirely through an injected offline SDK stream", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const channel = await createApprovalChannel({ provider: "imessage", route: h.transport.route, transport: h.transport });
  t.after(() => channel.shutdown());
  const request = { ...h.makeRequest(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const result = channel.ask(request);
  await tick();
  h.inbox.push([h.space, h.makeMessage()]);
  assert.equal(await result, "approved");
  await channel.shutdown();
  assert.equal(h.stops(), 0, "caller retains ownership of the injected transport");
});
