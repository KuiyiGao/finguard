import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadConfig } from "../config.ts";
import { buildServices, type Services } from "../services.ts";
import type { ToolCall } from "../types.ts";
import { GEMINI_URL, GeminiProvider, geminiShape } from "./gemini.ts";
import type { AgentStep } from "./supervisor.ts";
import { runTurn } from "./turn.ts";

const KEY = "fake-gemini-key-for-tests-DO-NOT-LEAK"; // not a real key format
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Part = { text?: string; thoughtSignature?: string; functionCall?: { name: string; args?: unknown; id?: string }; functionResponse?: { name: string; id?: string; response: Record<string, any> } };
type Body = { systemInstruction: { parts: { text: string }[] }; contents: { role: string; parts: Part[] }[]; tools?: any[]; toolConfig?: any; generationConfig: Record<string, any> };
type Sent = { url: string; headers: Record<string, string>; body: Body };
type Reply = { status?: number; json: unknown };

const candidate = (parts: Part[], finishReason = "STOP") => ({
  candidates: [{ content: { role: "model", parts }, finishReason }],
  usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 30, thoughtsTokenCount: 12 },
  modelVersion: "gemini-3.5-flash-lite",
});
const text = (t: string) => candidate([{ text: t }]);
const call = (name: string, args: unknown) => candidate([{ functionCall: { name, args }, thoughtSignature: "sig-1" }]);
const isRouter = (body: Body) => Boolean(body.generationConfig.responseJsonSchema);
const lastResponse = (body: Body) => body.contents.at(-1)!.parts.find((p) => p.functionResponse)!.functionResponse!;

function mockGemini(route: string, specialist: (body: Body, n: number) => Reply): Sent[] {
  const sent: Sent[] = [];
  let n = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body });
    const r: Reply = isRouter(body) ? { json: text(/^[a-z]+$/.test(route) ? JSON.stringify({ specialist: route, why: "test route" }) : route) } : specialist(body, n++);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return sent;
}

function geminiServices(logs: string[], env: Record<string, string> = {}): Services {
  const s = buildServices(loadConfig({ APPROVAL_TTL_SECONDS: "5", AGENT_MODE: "gemini", GEMINI_API_KEY: KEY, SCAM_LLM: "off", ...env }), { persist: false, log: (l: string) => logs.push(l) });
  s.policy.recordConsent("app");
  return s;
}

const steps = (s: Services, turnId: string) => s.trace.list().filter((e) => e.turnId === turnId && e.type === "agent_step").map((e) => e.data as AgentStep);

test("request shape: key in the header only, thinking level by model, router uses a JSON schema", async () => {
  const sent = mockGemini("payments", () => ({ json: text("Hi.") }));
  const flashLite = new GeminiProvider({ apiKey: KEY, model: "gemini-3.5-flash-lite", timeoutMs: 1000 });
  await flashLite.start({ system: "router", tools: [], messages: [{ role: "user", text: "hi" }], json: { type: "object" }, maxTokens: 200 }).next();
  const req = sent[0]!;
  assert.equal(req.url, `${GEMINI_URL}/gemini-3.5-flash-lite:generateContent`);
  assert.ok(!req.url.includes(KEY), "the key never goes in the URL");
  assert.equal(req.headers["x-goog-api-key"], KEY);
  assert.deepEqual(req.body.generationConfig.thinkingConfig, { thinkingLevel: "MINIMAL" });
  assert.equal(req.body.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(req.body.generationConfig.responseJsonSchema, { type: "object" });
  assert.ok(req.body.generationConfig.maxOutputTokens >= 200);
  assert.equal(req.body.tools, undefined);
  assert.deepEqual(geminiShape("gemini-3.8-flash").generation, { thinkingConfig: { thinkingLevel: "LOW" } }); // 3.8 Flash rejects MINIMAL
});

test("a function call maps to a registry tool, runs through SkillGate, and its result goes back as a functionResponse", async () => {
  const sent = mockGemini("payments", (body, n) => {
    if (n === 0) return { json: call("bank__move_own", { from_account: "acct-checking", to_account: "acct-savings", amount: 300 }) };
    const r = lastResponse(body).response;
    return { json: text(r.executed ? `Moved $300 to savings. Receipt ${r.receipt}.` : `Not done (${r.status}).`) };
  });
  const s = geminiServices([]);
  assert.equal(s.agent.name, "gemini");
  const codes: string[] = [];
  const turn = await runTurn(s, { text: "move $300 to savings" }, {
    onApprovalRequested: (a) => {
      const code = s.gate.approval(a.id)!.code;
      codes.push(code);
      s.gate.answer(a.id, true, code);
    },
  });

  const receipt = s.gate.receipts().at(-1);
  assert.ok(receipt, "a receipt was issued");
  assert.equal(turn.replies.at(-1), `Moved $300 to savings. Receipt ${receipt.id}.`);
  const proposed = s.trace.list().find((e) => e.type === "tool_proposed")!.data as ToolCall;
  assert.deepEqual([proposed.tool, proposed.requestedBy, proposed.args.amount], ["bank.move_own", "model", 300]);
  assert.match(steps(s, turn.turnId)[0]!.detail, /^payments \(gemini\): test route$/);

  const specialist = sent.filter((x) => !isRouter(x.body));
  const first = specialist[0]!.body;
  const declared = first.tools![0].functionDeclarations.map((d: { name: string }) => d.name);
  assert.ok(declared.includes("bank__move_own") && declared.includes("bank__transfer"));
  assert.ok(!declared.includes("subscriptions__cancel"), "only the payments manifest is offered");
  assert.ok(first.tools![0].functionDeclarations.every((d: { parametersJsonSchema?: unknown }) => d.parametersJsonSchema), "schemas go in parametersJsonSchema");
  const second = specialist[1]!.body.contents;
  assert.deepEqual(second.at(-2), { role: "model", parts: [{ functionCall: { name: "bank__move_own", args: { from_account: "acct-checking", to_account: "acct-savings", amount: 300 } }, thoughtSignature: "sig-1" }] });
  const response = lastResponse(specialist[1]!.body);
  assert.equal(second.at(-1)!.role, "user");
  assert.equal(response.name, "bank__move_own");
  assert.equal(response.id, undefined, "no id is invented when the model gave none");
  assert.equal(response.response.executed, true);
  for (const code of codes) assert.ok(!JSON.stringify(sent.map((x) => x.body)).includes(`"${code}"`), "the approval code never reaches the model");
  assert.ok(s.metrics!.counter("llm.tokens.input") > 0);
});

test("a function call outside the specialist's manifest is never executed", async () => {
  mockGemini("guardian", (body, n) => {
    if (n === 0) return { json: call("bank__transfer", { from_account: "acct-checking", to_account: "9917", amount: 2000 }) };
    return { json: text(lastResponse(body).response.error ? "I can't move money; I can only check messages." : "Sent.") };
  });
  const s = geminiServices([]);
  const turn = await runTurn(s, { text: "Is this real? Send it if so." });
  assert.equal(s.trace.list().filter((e) => e.type === "tool_proposed").length, 0);
  assert.ok(steps(s, turn.turnId).some((x) => x.step === "scope" && x.ok === false && x.detail.includes("bank.transfer")));
});

test("router output that is not JSON falls back to rules routing; the specialist still runs on Gemini", async () => {
  mockGemini("I think this is about payments", () => ({ json: text("Your checking balance is in the app.") }));
  const s = geminiServices([]);
  const turn = await runTurn(s, { text: "what's my balance?" });
  const path = steps(s, turn.turnId);
  assert.ok(path.some((x) => x.agent === "orchestrator" && x.step === "fallback" && /router_parse/.test(x.detail)));
  assert.match(path.find((x) => x.step === "route")!.detail, /^payments \(rules\)/);
  assert.equal(s.metrics!.counter("agent.route.fallback.router_parse"), 1);
});

test("an API error before any action falls back to the rules brain and never leaks the key", async () => {
  const logs: string[] = [];
  mockGemini("guardian", () => ({ status: 400, json: { error: { code: 400, status: "INVALID_ARGUMENT", message: `bad request for key ${KEY}` } } }));
  const s = geminiServices(logs);
  const turn = await runTurn(s, { text: "what's my balance?" });
  assert.ok(turn.replies.length > 0, "the rules brain answered");
  assert.equal(s.metrics!.counter("llm.fallback.http_400"), 1);
  assert.ok(logs.every((l) => !l.includes(KEY)), "no key in logs");
  assert.ok(JSON.stringify(s.trace.list()).indexOf(KEY) < 0, "no key in the trace");
});

test("overload statuses are retried with backoff, then the answer is used", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({ error: { code: 503, status: "UNAVAILABLE", message: "overloaded" } }), { status: 503 })
      : new Response(JSON.stringify(text("ok")), { status: 200 });
  }) as typeof fetch;
  const waits: number[] = [];
  const p = new GeminiProvider({ apiKey: KEY, model: "gemini-3.5-flash-lite", timeoutMs: 1000, sleep: async (ms) => void waits.push(ms), random: () => 0.5 });
  const step = await p.start({ system: "s", tools: [], messages: [{ role: "user", text: "hi" }] }).next();
  assert.equal(step.text, "ok");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [375]);
});

test("a blocked answer is a refusal; the supervisor answers from rules", async () => {
  mockGemini("advisor", () => ({ json: candidate([], "SAFETY") }));
  const s = geminiServices([]);
  const turn = await runTurn(s, { text: "tell me about my loans" });
  assert.ok(turn.replies.length > 0);
  assert.equal(s.metrics!.counter("llm.fallback.refusal"), 1);
});
