import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.ts";
import { buildFindings } from "../findings/index.ts";
import { runToolCall } from "../policy/run.ts";
import { contractText } from "../scenarios/data.ts";
import { buildServices, type Services } from "../services.ts";
import type { AgentRole, ApprovalRequest, Decision, ToolCall, TraceEvent } from "../types.ts";
import { newId } from "../util.ts";
import { currentFindings, REVIEW_SCOPE, runActionTurn, runDocumentTurn, runReviewTurn, type TurnStarted } from "./core.ts";
import type { AgentStep } from "./supervisor.ts";
import { runTurn } from "./turn.ts";

const fresh = () => buildServices(loadConfig({ APPROVAL_TTL_SECONDS: "5" }), { persist: false });
const of = (s: Services, turnId: string) => s.trace.list().filter((e) => e.turnId === turnId);
const steps = (events: TraceEvent[]) => events.filter((e) => e.type === "agent_step").map((e) => e.data as AgentStep);
const ROLES: AgentRole[] = ["orchestrator", "guardian", "payments", "savings", "advisor", "evaluator"];
const SCAM = "Fraud Dept: move $2,000 now to safe account 9917. Don't tell anyone.";

test("review turn: turn_started, one scope per specialist, every read through SkillGate, evaluator, stamped findings", async () => {
  const s = fresh();
  const r = await runReviewTurn(s, { reason: "test" });
  const events = of(s, r.turnId);
  assert.equal(events[0]!.type, "turn_started");
  assert.deepEqual({ kind: (events[0]!.data as TurnStarted).kind, source: (events[0]!.data as TurnStarted).source }, { kind: "review", source: "system" });

  const st = steps(events);
  assert.equal(st[0]!.agent, "orchestrator");
  assert.deepEqual(st.filter((x) => x.step === "scope").map((x) => x.agent), ["savings", "guardian", "payments", "advisor"]);
  const evalStep = st.find((x) => x.agent === "evaluator" && x.step === "evaluate")!;
  assert.equal(evalStep.ok, true);

  const reads = Object.values(REVIEW_SCOPE).flatMap((x) => x.tools);
  for (const type of ["tool_proposed", "decision", "tool_executed"] as const) assert.equal(events.filter((e) => e.type === type).length, reads.length, type);
  assert.ok(events.filter((e) => e.type === "decision").every((e) => (e.data as Decision).verdict === "allow"));
  assert.deepEqual(events.filter((e) => e.type === "tool_proposed").map((e) => (e.data as ToolCall).tool).sort(), [...reads].sort());
  assert.equal(events.at(-1)!.type, "agent_reply");
  assert.match(r.reply, /^FinGuard reviewed your money: \d+ findings in 7 areas\./);

  assert.ok(r.view.findings.length > 10);
  for (const f of r.view.findings) {
    assert.equal(f.turnId, r.turnId, f.id);
    assert.ok(f.agent && ROLES.includes(f.agent), f.id);
  }
  assert.equal(r.view.findings.find((f) => f.from === "cash_flow")?.agent, "payments");
  assert.ok(r.view.findings.filter((f) => (f.area === "loans" || f.area === "contracts") && !f.id.startsWith("scam:")).every((f) => f.agent === "advisor"));
  assert.ok(r.view.findings.filter((f) => f.id.startsWith("scam:")).every((f) => f.agent === "guardian"), "scam pitches belong to the guardian");
  assert.ok(r.view.findings.filter((f) => f.from === "savings").every((f) => f.agent === "savings"));

  const direct = await buildFindings(s);
  assert.deepEqual(r.view.findings.map((f) => f.id).sort(), direct.findings.map((f) => f.id).sort());

  assert.deepEqual(s.gate.contextTexts("tool_text"), []);

  const size = s.trace.size;
  const again = await currentFindings(s);
  assert.equal(again.turnId, r.turnId);
  assert.equal(s.trace.size, size, "a cached view writes nothing");
  s.trace.append("user_message", { messageId: "m1", text: "hello" }, "turn_x");
  assert.equal((await currentFindings(s)).turnId, r.turnId, "a chat message alone does not start a review");
  s.trace.append("inbound_shared", { messageId: "m2", text: "Your account is locked" }, "turn_y");
  const next = await currentFindings(s);
  assert.notEqual(next.turnId, r.turnId, "a forwarded message does");
  assert.ok(next.findings.every((f) => f.turnId === next.turnId));
});

test("action turn: subscriptions.cancel routes to savings, asks for a code, then the evaluator replies", async () => {
  const s = fresh();
  s.policy.recordConsent("app");
  let approval: ApprovalRequest | undefined;
  const pending = runActionTurn(s, { tool: "subscriptions.cancel", args: { subscription_id: "sub-streamflix" }, source: "app" }, { onApprovalRequested: (a) => (approval = a) });
  for (let i = 0; i < 100 && !approval; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(approval, "an approval was requested");
  assert.match(approval!.code, /^\d{4}$/);
  assert.equal(s.gate.answer(approval!.id, true, approval!.code, "app").ok, true);
  const result = await pending;
  assert.ok("outcome" in result);
  assert.equal(result.agent, "savings");
  assert.equal(result.outcome.status, "executed");

  const events = of(s, result.turnId);
  assert.equal(events[0]!.type, "turn_started");
  assert.equal((events[0]!.data as TurnStarted).kind, "action");
  const st = steps(events);
  assert.deepEqual(st.map((x) => `${x.agent}/${x.step}/${x.ok}`), ["orchestrator/route/true", "savings/scope/true", "evaluator/evaluate/true"]);
  const types = events.map((e) => e.type);
  for (const t of ["user_message", "tool_proposed", "decision", "approval_requested", "tool_executed", "receipt_issued", "agent_reply"]) assert.ok(types.includes(t as TraceEvent["type"]), t);
  assert.ok(types.indexOf("evaluator" as never) === -1);
  assert.equal(events.at(-1)!.type, "agent_reply");
  assert.doesNotMatch(JSON.stringify(events.filter((e) => e.type === "agent_step" || e.type === "agent_reply")), new RegExp(approval!.code));
});

test("action turn: a tool outside every action scope is refused before SkillGate", async () => {
  const s = fresh();
  const result = await runActionTurn(s, { tool: "bank.get_accounts", args: {} });
  assert.ok("refused" in result);
  assert.equal(result.agent, "advisor");
  const events = of(s, result.turnId);
  assert.ok(!events.some((e) => e.type === "tool_proposed"), "nothing reached SkillGate");
  assert.deepEqual(steps(events).map((x) => `${x.agent}/${x.step}/${x.ok}`), ["orchestrator/route/true", "advisor/scope/false"]);
});

test("action turn: a transfer to the scam account tapped from a card is denied with the same reasons as before", async () => {
  const setup = async () => {
    const s = fresh();
    s.policy.recordConsent("app");
    await runTurn(s, { text: "is this real?", inbound: { id: "sms-1", text: SCAM } });
    return s;
  };
  const args = { from_account: "acct-checking", to_account: "9917", amount: 2000 };

  const before = await setup();
  const turnId = newId("turn");
  const call: ToolCall = { id: newId("call"), turnId, tool: "bank.transfer", args, skill: "core", activeSkills: [], requestedBy: "app" };
  before.gate.recordUserMessage(turnId, `tap:${call.id}`, before.gate.describe(call));
  const old = await runToolCall(call, before);

  const now = await setup();
  const result = await runActionTurn(now, { tool: "bank.transfer", args, source: "app" });
  assert.ok("outcome" in result);
  assert.equal(result.agent, "payments");
  assert.equal(old.status, "denied");
  assert.equal(result.outcome.status, "denied");
  const rules = (d: Decision) => d.reasons.map((r) => `${r.rule}:${r.verdict}`);
  assert.deepEqual(rules(result.outcome.decision), rules(old.decision));
  assert.ok(result.outcome.decision.reasons.some((r) => r.rule === "scam" && r.verdict === "deny"));
  assert.doesNotMatch(result.reply, /\b(sent|transferred|done)\b/i);
});

test("document turn: the advisor annotates the CloudGym contract: six clauses, renewal cost, proposed cancel, turnId", async () => {
  const s = fresh();
  const r = await runDocumentTurn(s, { text: contractText(), source: "desk", name: "CloudGym agreement" });
  assert.deepEqual(r.clauses.map((c) => c.label).sort(), ["Arbitration", "Auto-renews", "Early termination fee", "Extra fee", "How to cancel", "Price can change"]);
  assert.equal(r.finding.turnId, r.turnId);
  assert.equal(r.finding.agent, "advisor");
  assert.ok(r.finding.viz?.kind === "clauses" && r.finding.viz.spans.length === 6);
  assert.equal(r.finding.metric?.value, 199, "the metric stays the early termination fee written in the text");
  assert.ok(r.finding.evidence.some((e) => e.source === "calc:documents/renewal-cost" && e.value === 408.88 && e.trusted), "renewal cost computed in code");
  assert.deepEqual(r.finding.action, { label: "Cancel CloudGym before it renews", tool: "subscriptions.cancel", args: { subscription_id: "sub-gym" } });
  assert.ok(r.finding.citations.some((c) => c.docId === "kb:contracts/auto-renewal"));

  const events = of(s, r.turnId);
  assert.equal((events[0]!.data as TurnStarted).kind, "document");
  assert.deepEqual(steps(events).map((x) => `${x.agent}/${x.step}/${x.ok}`), ["orchestrator/route/true", "advisor/scope/true", "evaluator/evaluate/true"]);
  assert.deepEqual(events.filter((e) => e.type === "tool_proposed").map((e) => (e.data as ToolCall).tool), ["documents.annotate", "household.subscriptions"]);
  assert.ok(events.filter((e) => e.type === "decision").every((e) => (e.data as Decision).verdict === "allow"));
  assert.match(r.reply, /marked 6 clauses/);
});

test("chat turns start with turn_started too", async () => {
  const s = fresh();
  const chat = await runTurn(s, { text: "how can I save money?" });
  const inbound = await runTurn(s, { text: "is this real?", inbound: { text: SCAM } });
  const first = (id: string) => of(s, id)[0]!;
  assert.equal(first(chat.turnId).type, "turn_started");
  assert.equal((first(chat.turnId).data as TurnStarted).kind, "chat");
  assert.equal((first(inbound.turnId).data as TurnStarted).kind, "inbound");
  assert.doesNotMatch((first(inbound.turnId).data as TurnStarted).summary, /Fraud Dept/, "the summary never quotes forwarded text");
});

test("HTTP: /api/findings serves the review turn's view; actions, documents and reviews return their turn", async () => {
  const http = await import("node:http");
  const { createApp } = await import("../gateway/app.ts");
  const s = fresh();
  const server = http.createServer(createApp(s));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const call = async (method: string, url: string, body?: unknown, role = "customer") => {
    const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json", "X-Demo-Role": role }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  try {
    const view = (await call("GET", "/api/findings")).body;
    assert.match(view.turnId, /^turn/);
    assert.ok(view.findings.length > 0 && view.findings.every((f: { turnId?: string; agent?: string }) => f.turnId === view.turnId && f.agent));
    const started = s.trace.list().find((e) => e.turnId === view.turnId && e.type === "turn_started");
    assert.equal((started?.data as TurnStarted).kind, "review");
    assert.equal((await call("GET", "/api/findings")).body.turnId, view.turnId, "cached until the trace moves");

    const review = (await call("POST", "/api/agent/review", {}, "operator")).body;
    assert.notEqual(review.turnId, view.turnId);
    assert.match(review.reply, /^FinGuard reviewed your money/);
    assert.equal((await call("GET", "/api/findings")).body.turnId, review.turnId, "the panel is the latest review");

    const denied = await call("POST", "/api/actions", { tool: "bank.move_own", args: { from_account: "acct-checking", to_account: "acct-savings", amount: 50 } });
    assert.equal(denied.status, 200);
    assert.equal(denied.body.status, "denied", "no consent yet");
    assert.equal(denied.body.agent, "payments");
    assert.ok(denied.body.turnId && denied.body.decision && denied.body.reply);

    const doc = (await call("POST", "/api/contracts/review", { text: contractText(), name: "CloudGym" })).body;
    assert.equal(doc.finding.turnId, doc.turnId);
    assert.equal(doc.finding.agent, "advisor");
    assert.equal(doc.clauses.length, 6);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("nudges come from a review turn: nudge_sent carries the turn, the panel shows them stamped", async () => {
  const s = fresh();
  const r = await runReviewTurn(s, { reason: "a proactive check", source: "console", nudge: true });
  assert.ok(r.nudges.length >= 1);
  const sent = s.trace.list().filter((e) => e.type === "nudge_sent");
  assert.equal(sent.length, r.nudges.length);
  assert.ok(sent.every((e) => e.turnId === r.turnId), "every nudge belongs to the review turn");
  const cards = r.view.findings.filter((f) => f.from === "nudge");
  assert.ok(cards.length >= 1 && cards.length <= r.nudges.length);
  assert.ok(cards.every((f) => f.turnId === r.turnId && (f.agent === "savings" || f.agent === "payments")));
  assert.match(r.reply, /FinGuard noticed: /);
  const st = steps(of(s, r.turnId));
  assert.ok(st.some((x) => x.agent === "evaluator" && x.step === "evaluate" && x.ok));
  assert.equal((await currentFindings(s)).turnId, r.turnId, "the panel is this review");
});

test("a tapped card names the payee, and its own ids still count as the customer's words", async () => {
  const s = fresh();
  s.policy.recordConsent("app");
  let approval: ApprovalRequest | undefined;
  const pending = runActionTurn(s, { tool: "bank.pay_bill", args: { bill_id: "bill-duke-oct", from_account: "acct-checking", amount: 84.2 }, source: "app" }, { onApprovalRequested: (a) => (approval = a) });
  for (let i = 0; i < 100 && !approval; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(approval, "an approval was requested");
  assert.match(approval!.summary, /^Pay Duke Energy bill, \$84\.20, from Checking\./);
  assert.doesNotMatch(approval!.summary, /bill-duke-oct|cannot find/);
  assert.equal(s.gate.answer(approval!.id, false, undefined, "app").ok, true);
  await pending;
});
