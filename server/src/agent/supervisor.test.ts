import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.ts";
import { fixtureText } from "../demo/scenes.ts";
import { buildServices, type Services } from "../services.ts";
import type { AgentContext, TurnInput } from "./agent.ts";
import type { RuleIntent } from "./rules.ts";
import { parseRoute, SPECIALISTS, SupervisedAgent, type AgentStep } from "./supervisor.ts";
import { runTurn } from "./turn.ts";

function setup(): Services {
  const s = buildServices(loadConfig({ APPROVAL_TTL_SECONDS: "5" }), { persist: false });
  s.policy.recordConsent("app");
  return s;
}

const steps = (s: Services, turnId: string) => s.trace.list().filter((e) => e.turnId === turnId && e.type === "agent_step").map((e) => e.data as AgentStep);

test("rules brain: the orchestrator routes each request to one specialist", async () => {
  const s = setup();
  assert.equal(s.agent.name, "rules");
  const cases: [string, { text: string; inbound?: { id: string; text: string } }, string][] = [
    ["guardian", { text: "Is this real?", inbound: { id: "m1", text: fixtureText("fake-bank-alert") } }, "This looks like a scam"],
    ["payments", { text: "ok send it anyway" }, "I did not do it"],
    ["payments", { text: "move $20 to savings" }, "Done: Move $20.00"],
    ["payments", { text: "what is my balance?" }, "Checking"],
    ["savings", { text: "find ways to save" }, "a month you could save"],
    ["savings", { text: "cancel my subscriptions" }, "Which one?"],
    ["advisor", { text: "tell me about my car loan" }, "loan"],
    ["advisor", { text: "hello" }, "I can check a message"],
    ["guardian", { text: "pause all payments" }, "Paused."],
  ];
  for (const [specialist, request, reply] of cases) {
    const turn = await runTurn(s, request);
    const route = steps(s, turn.turnId).find((x) => x.step === "route")!;
    assert.match(route.detail, new RegExp(`^${specialist} \\(rules\\)`), `${request.text} -> ${route.detail}`);
    assert.ok(turn.replies.some((r) => r.includes(reply)), `${request.text}: ${turn.replies.join(" | ")}`);
    const path = steps(s, turn.turnId).map((x) => `${x.agent}/${x.step}`);
    assert.deepEqual(path.slice(0, 2), ["orchestrator/route", `${specialist}/scope`]);
    assert.ok(path.includes("evaluator/evaluate"), path.join(" "));
  }
  assert.equal(s.metrics!.counter("agent.route.payments"), 3);
  assert.equal(s.metrics!.counter("agent.evaluator.fail"), 0, "every rules reply is grounded");
  assert.ok(s.metrics!.summary("agent.stage.route") && s.metrics!.summary("agent.stage.evaluate"));
});

test("scope announcements list exactly the manifest; no specialist but payments holds a money tool", () => {
  const money = ["bank.move_own", "bank.pay_bill", "bank.transfer", "subscriptions.cancel"];
  for (const [id, sp] of Object.entries(SPECIALISTS)) {
    const held = sp.manifest.tools.filter((t) => money.includes(t));
    if (id === "payments") assert.deepEqual(held, ["bank.move_own", "bank.pay_bill", "bank.transfer"]);
    else if (id === "savings") assert.deepEqual(held, ["subscriptions.cancel"]);
    else assert.deepEqual(held, [], `${id} must not hold money tools`);
  }
  assert.equal(SPECIALISTS.guardian.manifest.seesForwarded, true);
  assert.ok(Object.values(SPECIALISTS).filter((x) => x.manifest.seesForwarded).length === 1, "only the guardian reads forwarded text");
});

test("a rules handler that reaches outside its scope is stopped in code", async () => {
  const s = setup();
  const agent = s.agent as SupervisedAgent;
  (agent as unknown as { rules: { run: (i: RuleIntent, t: TurnInput, c: AgentContext) => Promise<void> } }).rules.run = async (_i, _t, ctx) => {
    await ctx.tool("bank.transfer", { from_account: "acct-checking", to_account: "9917", amount: 50 });
  };
  const turn = await runTurn(s, { text: "tell me about my contracts" });
  assert.ok(!s.trace.list().some((e) => e.turnId === turn.turnId && e.type === "tool_proposed"), "SkillGate never even saw it");
  const rejected = steps(s, turn.turnId).find((x) => x.step === "scope" && x.ok === false)!;
  assert.deepEqual([rejected.agent, rejected.tools], ["advisor", ["bank.transfer"]]);
  assert.match(turn.replies.at(-1)!, /Nothing was moved or changed/);
  assert.equal(s.metrics!.counter("agent.scope.rejected"), 1);
});

test("a draft that fails review is replaced by a reply built from the turn's outcomes", async () => {
  const s = setup();
  const agent = s.agent as SupervisedAgent;
  (agent as unknown as { rules: { run: (i: RuleIntent, t: TurnInput, c: AgentContext) => Promise<void> } }).rules.run = async (_i, _t, ctx) => {
    const outcome = await ctx.tool("bank.move_own", { from_account: "acct-checking", to_account: "acct-savings", amount: 20 });
    assert.equal(outcome.status, "executed");
    ctx.say("Done, and I also paid your rent of $1,999.99. You should buy index funds with the rest.");
  };
  const turn = await runTurn(s, { text: "move $20 to savings" });
  const review = steps(s, turn.turnId).find((x) => x.agent === "evaluator" && x.step === "evaluate")!;
  assert.equal(review.ok, false);
  assert.match(review.problems!.join(" "), /\$1,999\.99/);
  assert.match(review.problems!.join(" "), /investment advice/);
  assert.match(turn.replies.at(-1)!, /^Done: Move \$20\.00 from Checking/);
  assert.ok(!turn.replies.some((r) => r.includes("1,999.99")));
  assert.ok(steps(s, turn.turnId).some((x) => x.agent === "evaluator" && x.step === "repair"));
});

test("agent_step events carry no approval codes", async () => {
  const s = setup();
  const codes: string[] = [];
  await runTurn(s, { text: "Pay my Duke Energy bill" }, {
    onApprovalRequested: (a) => {
      const code = s.gate.approval(a.id)!.code;
      codes.push(code);
      s.gate.answer(a.id, true, code);
    },
  });
  const all = JSON.stringify(s.trace.list().filter((e) => e.type === "agent_step"));
  assert.equal(codes.length, 1);
  assert.ok(!all.includes(`"${codes[0]}"`) && !all.includes(` ${codes[0]}`), all);
});

test("the router's JSON is validated", () => {
  assert.deepEqual(parseRoute('{"specialist":"savings","why":"cancel a trial"}'), { id: "savings", why: "cancel a trial" });
  assert.deepEqual(parseRoute('Sure: {"specialist": "guardian", "why": "forwarded text"}'), { id: "guardian", why: "forwarded text" });
  assert.throws(() => parseRoute("payments"), /valid specialist/);
  assert.throws(() => parseRoute('{"specialist":"admin","why":"x"}'), /valid specialist/);
});
