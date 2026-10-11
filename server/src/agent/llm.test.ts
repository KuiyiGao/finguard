import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, test } from "node:test";
import { loadConfig, SERVER_ROOT } from "../config.ts";
import { fixtureText } from "../demo/scenes.ts";
import { createApp } from "../gateway/app.ts";
import { loadKnowledgeBaseSync } from "../rag/index.ts";
import { buildServices, type Services } from "../services.ts";
import type { Decision, ToolCall } from "../types.ts";
import { ANTHROPIC_URL, AnthropicProvider, requestShape, toolName } from "./llm.ts";
import { SupervisedAgent, type AgentStep } from "./supervisor.ts";
import { runTurn } from "./turn.ts";

const KEY = "fake-anthropic-key-for-tests-DO-NOT-LEAK"; // not a real key format, so secret scanners stay quiet
const KB_IDS = new Set(loadKnowledgeBaseSync(path.join(SERVER_ROOT, "kb")).map((d) => d.id));
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Body = { model: string; messages: { role: string; content: any }[]; tools?: any[]; system: any[]; output_config?: any; [k: string]: unknown };
type Sent = { url: string; headers: Record<string, string>; body: Body };
type Reply = { status?: number; json: unknown; headers?: Record<string, string> };

const message = (content: unknown[], stop_reason = "end_turn") => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content,
  stop_reason,
  usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
});
const text = (t: string) => message([{ type: "text", text: t }]);
const toolUse = (id: string, name: string, input: unknown) =>
  message([{ type: "thinking", thinking: "Checking what the customer asked.", signature: "sig-1" }, { type: "tool_use", id, name, input }], "tool_use");
const lastToolResult = (body: Body) => {
  const block = (body.messages.at(-1)!.content as { type: string; content: string }[]).find((b) => b.type === "tool_result")!;
  return JSON.parse(block.content) as Record<string, any>;
};
const isRouter = (body: Body) => Boolean(body.output_config);
const serverError = { type: "error", error: { type: "api_error", message: "Internal server error" } };

function mockModel(route: string, specialist: (body: Body, n: number) => Reply): Sent[] {
  const sent: Sent[] = [];
  let n = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body });
    const r: Reply = isRouter(body) ? { json: text(/^[a-z]+$/.test(route) ? JSON.stringify({ specialist: route, why: "test route" }) : route) } : specialist(body, n++);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return sent;
}
const specialistCalls = (sent: Sent[]) => sent.filter((x) => !isRouter(x.body));

function claudeServices(logs: string[], env: Record<string, string> = { ANTHROPIC_API_KEY: KEY }): Services {
  const s = buildServices(loadConfig({ APPROVAL_TTL_SECONDS: "5", AGENT_MODE: "claude", ...env }), { persist: false, log: (l: string) => logs.push(l) });
  s.policy.recordConsent("app");
  return s;
}

function withProvider(s: Services, logs: string[], waits: number[], extra: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {}): void {
  s.agent = new SupervisedAgent({
    trace: s.trace,
    kbIds: KB_IDS,
    tools: () => s.tools.specs(),
    metrics: s.metrics,
    log: (l) => logs.push(l),
    provider: new AnthropicProvider({ apiKey: KEY, model: "claude-sonnet-5-5", timeoutMs: 1000, sleep: async (ms) => void waits.push(ms), random: () => 0.5, metrics: s.metrics, ...extra }),
  });
}

const steps = (s: Services, turnId: string) => s.trace.list().filter((e) => e.turnId === turnId && e.type === "agent_step").map((e) => e.data as AgentStep);
const pathOf = (s: Services, turnId: string) => steps(s, turnId).map((x) => `${x.agent}/${x.step}${x.ok === false ? "!" : ""}`);

test("tool names map to the API's pattern; request shape depends on the model", () => {
  assert.equal(toolName("bank.move_own"), "bank__move_own");
  assert.equal(toolName("subscriptions.cancel"), "subscriptions__cancel");
  assert.deepEqual(requestShape("claude-sonnet-5-5").extra, { thinking: { type: "between_tools" } });
  assert.deepEqual(requestShape("claude-sonnet-4-6").extra, { temperature: 0 });
  assert.deepEqual(requestShape("claude-opus-5-5").extra, {});
});

test("(a) routed to payments, a $300 move to savings runs through SkillGate and ends with a receipt", async () => {
  const codes: string[] = [];
  const sent = mockModel("payments", (body, n) => {
    if (n === 0) return { json: toolUse("toolu_1", "bank__move_own", { from_account: "acct-checking", to_account: "acct-savings", amount: 300 }) };
    const r = lastToolResult(body);
    return { json: text(r.executed ? `Moved $300 to savings. Receipt ${r.receipt}.` : `Not done (${r.status}).`) };
  });
  const s = claudeServices([]);
  assert.equal(s.agent.name, "claude");
  const turn = await runTurn(s, { text: "move $300 to savings" }, {
    onApprovalRequested: (a) => {
      const code = s.gate.approval(a.id)!.code;
      codes.push(code);
      s.gate.answer(a.id, true, code);
    },
  });

  const receipt = s.gate.receipts().at(-1);
  assert.ok(receipt, "a receipt was issued");
  assert.match(turn.replies.at(-1)!, new RegExp(`^Moved \\$300 to savings\\. Receipt ${receipt.id}\\.$`));
  const proposed = s.trace.list().find((e) => e.type === "tool_proposed")!.data as ToolCall;
  assert.deepEqual([proposed.tool, proposed.requestedBy, proposed.args.amount], ["bank.move_own", "model", 300]);
  assert.deepEqual(pathOf(s, turn.turnId), ["orchestrator/route", "payments/scope", "evaluator/evaluate"]);
  assert.match(steps(s, turn.turnId)[0]!.detail, /^payments \(claude\): test route$/);

  const router = sent[0]!;
  assert.equal(router.url, ANTHROPIC_URL);
  assert.equal(router.headers["x-api-key"], KEY);
  assert.equal(router.headers["anthropic-version"], "2023-06-01");
  assert.equal(router.body.output_config.format.type, "json_schema");
  assert.equal(router.body.tools, undefined, "the router gets no tools");
  const first = specialistCalls(sent)[0]!;
  assert.equal(first.body.model, "claude-sonnet-5-5");
  assert.deepEqual(first.body.thinking, { type: "between_tools" });
  assert.equal(first.body.temperature, undefined, "Sonnet 5.5 rejects non-default sampling parameters");
  assert.deepEqual(first.body.system[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(first.body.tools!.at(-1).cache_control, { type: "ephemeral" });
  assert.deepEqual(
    first.body.tools!.map((t) => t.name as string).sort(),
    ["bank__get_accounts", "bank__list_bills", "bank__list_payees", "bank__move_own", "bank__pay_bill", "bank__transfer", "check_message"],
    "exactly the payments manifest",
  );
  assert.equal(specialistCalls(sent)[1]!.body.messages.at(-2)!.content[0].type, "thinking", "the assistant turn is replayed unchanged");
  for (const code of codes) assert.ok(!JSON.stringify(sent).includes(`"${code}"`), "approval codes never reach the model");
  assert.equal(s.metrics!.counter("agent.route.payments"), 1);
  assert.equal(s.metrics!.counter("agent.evaluator.pass"), 1);
});

test("(b) a transfer to an account found only in a forwarded message is denied, and the reply says it was not done", async () => {
  const sent = mockModel("payments", (body, n) => {
    if (n === 0) return { json: toolUse("toolu_1", "bank__transfer", { from_account: "acct-checking", to_account: "9917", amount: 2000 }) };
    const r = lastToolResult(body);
    return { json: text(r.executed ? "Done, I sent it." : `I did not send it. ${(r.reasons as string[]).filter((x) => /appears only/.test(x)).join(" ")}`) };
  });
  const s = claudeServices([]);
  const turn = await runTurn(s, { text: "my bank texted me this, just do what it says", inbound: { id: "bank-alert", text: fixtureText("fake-bank-alert") } });

  assert.match(turn.replies.at(-1)!, /^I did not send it\. .*appears only in a forwarded message/);
  assert.equal(s.gate.receipts().length, 0);
  const decision = s.trace.list().find((e) => e.type === "decision")!.data as Decision;
  assert.equal(decision.verdict, "deny");
  assert.ok(decision.reasons.some((r) => r.rule === "provenance" && r.verdict === "deny"));
  assert.deepEqual(pathOf(s, turn.turnId), ["orchestrator/route", "payments/scope", "evaluator/evaluate"], "a correct denial passes the evaluator");
  const userText = specialistCalls(sent)[0]!.body.messages.at(-1)!.content as string;
  assert.doesNotMatch(userText, /forwarded_message|9917/, "payments never sees the forwarded text");
  assert.match(userText, /\[The customer forwarded a message\. Only FinGuard's guardian reads forwarded messages/);
  assert.doesNotMatch(JSON.stringify(sent[0]!.body), /9917|Fraud Dept/i, "the router never sees it either");
});

test("advisor and guardian cannot execute a money tool even when the model asks", async () => {
  for (const [id, tool] of [["advisor", "bank__transfer"], ["guardian", "bank__move_own"]] as const) {
    const sent = mockModel(id, (body, n) => {
      if (n === 0) return { json: toolUse("toolu_x", tool, { from_account: "acct-checking", to_account: "acct-savings", amount: 50 }) };
      const r = lastToolResult(body);
      return { json: text(`I can't do that from here (${r.error ? "not my tool" : "?"}).`) };
    });
    const s = claudeServices([]);
    const turn = await runTurn(s, { text: id === "advisor" ? "explain my car loan" : "is this text a scam?" });
    assert.ok(!s.trace.list().some((e) => e.type === "tool_proposed"), `${id}: nothing reached SkillGate`);
    const rejected = steps(s, turn.turnId).find((x) => x.step === "scope" && x.ok === false)!;
    assert.deepEqual([rejected.agent, rejected.tools], [id, [tool.replace("__", ".")]]);
    const offered = specialistCalls(sent)[0]!.body.tools!.map((t) => t.name as string);
    assert.ok(!offered.some((n) => n.startsWith("bank__")), `${id} is offered ${offered.join(", ")}`);
    const result = (specialistCalls(sent)[1]!.body.messages.at(-1)!.content as { is_error?: boolean; content: string }[])[0]!;
    assert.equal(result.is_error, true);
    assert.match(result.content, new RegExp(`not one of the ${id} specialist's tools`));
    assert.equal(turn.replies.at(-1), "I can't do that from here (not my tool).");
    assert.equal(s.metrics!.counter("agent.scope.rejected"), 1);
  }
});

test("the evaluator sends a bad draft back once; a second bad draft gets the deterministic reply", async () => {
  let sent = mockModel("savings", (body, n) => {
    if (n === 0) return { json: text("You could save $999.99 a month.") };
    assert.match(body.messages.at(-1)!.content as string, /A reviewer found problems[\s\S]*\$999\.99/);
    return { json: text("I could not find a saving I can back up with your records yet.") };
  });
  let s = claudeServices([]);
  let turn = await runTurn(s, { text: "how can I save money?" });
  assert.equal(turn.replies.at(-1), "I could not find a saving I can back up with your records yet.");
  assert.deepEqual(pathOf(s, turn.turnId), ["orchestrator/route", "savings/scope", "evaluator/evaluate!", "evaluator/repair", "evaluator/evaluate"]);
  assert.equal(specialistCalls(sent).length, 2);
  assert.deepEqual([s.metrics!.counter("agent.evaluator.repair"), s.metrics!.counter("agent.evaluator.repaired")], [1, 1]);

  sent = mockModel("savings", () => ({ json: text("Done, I cancelled everything for you.") }));
  s = claudeServices([]);
  turn = await runTurn(s, { text: "cancel all my subscriptions" });
  assert.match(turn.replies.at(-1)!, /^I could not give you an answer I can back up/);
  assert.ok(!turn.replies.some((r) => r.startsWith("Done")), "no false claim reaches the customer");
  assert.deepEqual(pathOf(s, turn.turnId), ["orchestrator/route", "savings/scope", "evaluator/evaluate!", "evaluator/repair", "evaluator/evaluate!", "evaluator/repair"]);
  assert.equal(specialistCalls(sent).length, 2, "exactly one repair attempt");
});

test("a router reply that is not valid JSON falls back to rules routing", async () => {
  const sent = mockModel("I think this is about payments", () => ({ json: text("Your balances are in the app.") }));
  const s = claudeServices([]);
  const turn = await runTurn(s, { text: "what is my balance?" });
  assert.deepEqual(pathOf(s, turn.turnId).slice(0, 3), ["orchestrator/fallback!", "orchestrator/route", "payments/scope"]);
  assert.match(steps(s, turn.turnId)[1]!.detail, /^payments \(rules\)/);
  assert.equal(specialistCalls(sent).length, 1, "the specialist still runs on the model brain");
  assert.equal(s.metrics!.counter("agent.route.fallback.router_parse"), 1);
});

test("(c) three 500s fall back to the rules brain for that turn, with exponential backoff", async () => {
  let calls = 0;
  globalThis.fetch = (async () => (calls++, new Response(JSON.stringify(serverError), { status: 500 }))) as typeof fetch;
  const logs: string[] = [];
  const waits: number[] = [];
  const s = claudeServices(logs);
  withProvider(s, logs, waits);
  const turn = await runTurn(s, { text: "move $50 to savings" });
  assert.equal(calls, 6, "router and specialist: one request and two retries each");
  assert.deepEqual(waits, [375, 750, 375, 750], "equal jitter around 500 ms, doubling");
  assert.match(turn.replies.at(-1)!, /^Done: Move \$50\.00/, "the rules brain answered");
  assert.equal(s.metrics!.counter("llm.fallback.http_500"), 1);
  assert.equal(s.metrics!.counter("agent.route.fallback.http_500"), 1);
  assert.match(logs.join("\n"), /fell back to rules for turn .* \(http_500\)/);
  assert.equal(s.gate.receipts().length, 1, "the action ran once");
  assert.deepEqual(pathOf(s, turn.turnId), ["orchestrator/fallback!", "orchestrator/route", "payments/scope", "payments/fallback!", "orchestrator/route", "payments/scope", "evaluator/evaluate"]);
});

test("retry-after is honored; a long one, a timeout or a missing key fall back without waiting", async () => {
  const logs: string[] = [];
  const waits: number[] = [];
  let i = 0;
  globalThis.fetch = (async (_u: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    if (i++ === 0) return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), { status: 429, headers: { "retry-after": "2" } });
    return new Response(JSON.stringify(isRouter(body) ? text('{"specialist":"advisor","why":"greeting"}') : text("Hello.")), { status: 200 });
  }) as typeof fetch;
  let s = claudeServices(logs);
  withProvider(s, logs, waits);
  assert.deepEqual((await runTurn(s, { text: "hi" })).replies, ["Hello."]);
  assert.deepEqual(waits, [2000]);

  globalThis.fetch = (async () => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }), { status: 529, headers: { "retry-after": "60" } })) as typeof fetch;
  waits.length = 0;
  await runTurn(s, { text: "hi" });
  assert.deepEqual(waits, [], "a 60 s wait is longer than we accept");
  assert.equal(s.metrics!.counter("llm.fallback.http_529"), 1);

  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
  withProvider(s, logs, waits, { timeoutMs: 30 });
  const keepAlive = setInterval(() => {}, 1000);
  await runTurn(s, { text: "hi" });
  clearInterval(keepAlive);
  assert.equal(s.metrics!.counter("llm.fallback.timeout"), 1);

  let called = false;
  globalThis.fetch = (async () => ((called = true), new Response("{}"))) as typeof fetch;
  s = claudeServices(logs, {});
  const { replies } = await runTurn(s, { text: "move $20 to savings" });
  assert.equal(called, false);
  assert.match(replies[0]!, /^Done: Move \$20\.00/);
  assert.equal(s.metrics!.counter("llm.fallback.no_key"), 1);
});

test("the guardian reads the forwarded text as untrusted data and cites the knowledge base", async () => {
  const sent = mockModel("guardian", (body, n) => {
    if (n === 0)
      return {
        json: message([
          { type: "tool_use", id: "t1", name: "check_message", input: {} },
          { type: "tool_use", id: "t2", name: "knowledge_search", input: { query: "move money to a safe account", collection: "scams" } },
        ], "tool_use"),
      };
    const results = (body.messages.at(-1)!.content as { tool_use_id: string; content: string }[]).map((b) => JSON.parse(b.content));
    return { json: text(`Risk ${results[0].risk}: it asks you to move money to a "safe" account. See [${results[1].results[0].doc_id}].`) };
  });
  const s = claudeServices([]);
  const turn = await runTurn(s, { text: "is this real?", inbound: { id: "m1", text: fixtureText("fake-bank-alert") } });
  assert.equal(turn.replies.at(-1), 'Risk high: it asks you to move money to a "safe" account. See [kb:scams/safe-account].');
  const first = specialistCalls(sent)[0]!;
  assert.deepEqual(first.body.tools!.map((t) => t.name), ["check_message", "knowledge_search", "list_findings", "pause_all"]);
  const userText = first.body.messages.at(-1)!.content as string;
  assert.match(userText, /<forwarded_message id="m1">/);
  assert.match(userText, /Untrusted data written by third parties/);
  assert.ok(userText.indexOf("[The customer says]") > userText.indexOf("</forwarded_message>"));
  const results = specialistCalls(sent)[1]!.body.messages.at(-1)!.content as { tool_use_id: string }[];
  assert.deepEqual(results.map((r) => r.tool_use_id), ["t1", "t2"], "all tool results in one user message, in order");
});

test("(d) the API key never appears in the trace, logs, metrics, read model or any route", async () => {
  const logs: string[] = [];
  let i = 0;
  globalThis.fetch = (async (_u: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    i++;
    if (i <= 2) return new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } }), { status: 401 });
    if (isRouter(body)) return new Response(JSON.stringify(text('{"specialist":"payments","why":"balances"}')));
    const hasResult = body.messages.some((m) => Array.isArray(m.content) && m.content.some((b: { type: string }) => b.type === "tool_result"));
    return new Response(JSON.stringify(hasResult ? text("You have two accounts.") : toolUse("toolu_9", "bank__get_accounts", {})));
  }) as typeof fetch;
  const s = claudeServices(logs);
  await runTurn(s, { text: "move $20 to savings" }); // 401 on router and specialist: rules answer
  await runTurn(s, { text: "what is my balance?" }); // model turn with a read
  assert.ok(logs.some((l) => l.includes("[redacted]")), "the redaction path ran");

  globalThis.fetch = realFetch;
  const server = http.createServer(createApp(s, (l) => logs.push(l)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const routes = await Promise.all(
    ["/api/health", "/api/state", "/api/metrics", "/api/db/stats", "/api/tools"].map(async (p) => {
      const res = await fetch(base + p, { headers: { "X-Demo-Role": "operator" } });
      return `${p} ${res.status} ${await res.text()}`;
    }),
  );
  server.closeAllConnections();
  server.close();
  const health = JSON.parse(routes[0]!.slice(routes[0]!.indexOf("{")));
  assert.deepEqual(health.keys, { anthropic: true, gemini: false });
  assert.ok(routes.every((r) => / 200 /.test(r)), routes.map((r) => r.slice(0, 40)).join("\n"));

  const everything = [JSON.stringify(s.trace.list()), logs.join("\n"), JSON.stringify(s.metrics!.snapshot()), JSON.stringify(s.config), JSON.stringify(s.db!.query("SELECT * FROM events")), ...routes].join("\n");
  assert.ok(!everything.includes(KEY), "the key leaked");
  assert.ok(!everything.includes("DO-NOT-LEAK"), "part of the key leaked");
});
