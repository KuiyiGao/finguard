import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ApprovalRequest } from "../types.ts";
import {
  BoundApprovalChannel, OffApprovalChannel,
  type ApprovalTransport,
} from "./approval-channel.ts";
import { createApprovalChannel, type SpectrumProvider } from "./imessage.ts";
import { TerminalApprovalTransport } from "./terminal.ts";

const route = {
  recipientId: "fictional:terminal-alex",
  conversationId: "fictional:terminal-session",
};

function request(id = "terminal-a", changes: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id,
    callId: `call-${id}`,
    actionHash: "a".repeat(64),
    code: "4821",
    summary: "FICTIONAL DEMO: Review a $24 dinner split.",
    channel: "imessage",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "pending",
    ...changes,
  };
}

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => { written += chunk.toString(); });
  const transport = new TerminalApprovalTransport({ input, output });
  return {
    input,
    transport,
    written: () => written,
    close: () => { transport.close(); input.destroy(); output.destroy(); },
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

test("terminal streams display the summary and accept scoped YES with its code", async (t) => {
  const terminal = streams();
  const channel = new BoundApprovalChannel({ route, transport: terminal.transport });
  t.after(() => { channel.close(); terminal.close(); });
  const approval = request();
  const result = channel.ask(approval);
  await nextTurn();
  assert.ok(terminal.written().includes(approval.summary));
  assert.ok(terminal.written().includes(route.recipientId));
  assert.ok(terminal.written().includes(route.conversationId));
  assert.ok(terminal.written().includes("Reply YES 4821") && terminal.written().includes("terminal-a"));
  terminal.input.write("YES 4821 terminal-a\n");
  assert.equal(await result, "approved");
});

test("terminal wrong, unscoped, unknown, and malformed commands cannot approve", async (t) => {
  const terminal = streams();
  const channel = new BoundApprovalChannel({ route, transport: terminal.transport });
  t.after(() => { channel.close(); terminal.close(); });
  const result = channel.ask(request());
  const isSettled = observe(result);
  await nextTurn();
  for (const command of [
    "YES 9999 terminal-a",
    "YES 4821",
    "YES 4821 unknown-request",
    "YES 4821 terminal-a unexpected",
    "NO",
    "YES 4821 terminal:a",
  ]) {
    terminal.input.write(`${command}\n`);
    await nextTurn();
    assert.equal(isSettled(), false, command);
  }
  assert.ok(terminal.written().includes("Use YES <4-digit-code> <request-id> or NO <request-id>."));
  terminal.input.write("YES 4821 terminal-a\n");
  assert.equal(await result, "approved");
});

test("terminal matching NO denies the request", async (t) => {
  const terminal = streams();
  const channel = new BoundApprovalChannel({ route, transport: terminal.transport });
  t.after(() => { channel.close(); terminal.close(); });
  const result = channel.ask(request());
  await nextTurn();
  terminal.input.write("NO terminal-a\n");
  assert.equal(await result, "denied");
});

test("terminal request ids keep simultaneous requests and their codes separate", async (t) => {
  const terminal = streams();
  const channel = new BoundApprovalChannel({ route, transport: terminal.transport });
  t.after(() => { channel.close(); terminal.close(); });
  const first = channel.ask(request("terminal-first"));
  const second = channel.ask(request("terminal-second", { code: "6723" }));
  const firstSettled = observe(first);
  const secondSettled = observe(second);
  await nextTurn();
  terminal.input.write("YES 4821 terminal-second\n");
  await nextTurn();
  assert.equal(firstSettled(), false);
  assert.equal(secondSettled(), false);
  terminal.input.write("YES 4821 terminal-first\n");
  assert.equal(await first, "approved");
  assert.equal(secondSettled(), false);
  terminal.input.write("NO terminal-second\n");
  assert.equal(await second, "denied");
});

test("terminal notify writes its bound route and alert text", async (t) => {
  const terminal = streams();
  const channel = new BoundApprovalChannel({ route, transport: terminal.transport });
  t.after(() => { channel.close(); terminal.close(); });
  await channel.notify("FICTIONAL DEMO: request expired.");
  assert.ok(terminal.written().includes(route.recipientId));
  assert.ok(terminal.written().includes(route.conversationId));
  assert.ok(terminal.written().includes("FICTIONAL DEMO: request expired."));
});

test("terminal EOF leaves an outstanding request fail closed until expiry", async (t) => {
  const terminal = streams();
  const channel = new BoundApprovalChannel({ route, transport: terminal.transport });
  t.after(() => { channel.close(); terminal.close(); });
  const result = channel.ask(request("terminal-eof", {
    expiresAt: new Date(Date.now() + 40).toISOString(),
  }));
  await nextTurn();
  terminal.input.end();
  assert.equal(await result, "expired");
});

test("terminal provider factory uses an injected stream transport", async (t) => {
  const terminal = streams();
  const channel = await createApprovalChannel({
    route,
    provider: "terminal",
    transport: terminal.transport,
  });
  t.after(() => { channel.close(); terminal.close(); });
  const result = channel.ask(request("terminal-factory"));
  await nextTurn();
  terminal.input.write("YES 4821 terminal-factory\n");
  assert.equal(await result, "approved");
});

function forbiddenTransport(): { transport: ApprovalTransport; touched: () => number } {
  let calls = 0;
  const forbidden = () => { calls += 1; throw new Error("Disabled provider used transport"); };
  return {
    transport: { send: forbidden, notify: forbidden, subscribe: forbidden },
    touched: () => calls,
  };
}

test("explicit off mode ignores transport and never approves", async (t) => {
  const forbidden = forbiddenTransport();
  const channel = await createApprovalChannel({ route, provider: "off", transport: forbidden.transport });
  t.after(() => channel.close());
  assert.ok(channel instanceof OffApprovalChannel);
  assert.equal(await channel.ask(request("terminal-off")), "denied");
  await channel.notify("FICTIONAL DEMO: disabled.");
  assert.equal(forbidden.touched(), 0);
});

test("missing provider defaults to off without creating or using a transport", async (t) => {
  const previous = process.env.SPECTRUM_PROVIDER;
  delete process.env.SPECTRUM_PROVIDER;
  t.after(() => {
    if (previous === undefined) delete process.env.SPECTRUM_PROVIDER;
    else process.env.SPECTRUM_PROVIDER = previous;
  });
  const forbidden = forbiddenTransport();
  const channel = await createApprovalChannel({ route, transport: forbidden.transport });
  const noTransportChannel = await createApprovalChannel({ route });
  t.after(() => { channel.close(); noTransportChannel.close(); });
  assert.ok(channel instanceof OffApprovalChannel);
  assert.ok(noTransportChannel instanceof OffApprovalChannel);
  assert.equal(await channel.ask(request("terminal-default")), "denied");
  assert.equal(await noTransportChannel.ask(request("terminal-default-no-transport")), "denied");
  assert.equal(forbidden.touched(), 0);
});

test("unknown provider is rejected before a transport is used", async () => {
  const forbidden = forbiddenTransport();
  await assert.rejects(createApprovalChannel({
    route,
    provider: "sms" as SpectrumProvider,
    transport: forbidden.transport,
  }), /SPECTRUM_PROVIDER must be terminal, off, or imessage/);
  assert.equal(forbidden.touched(), 0);
});
