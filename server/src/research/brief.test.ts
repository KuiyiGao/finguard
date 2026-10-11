import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { routeIntent } from "../agent/supervisor.ts";
import { classifyIntent } from "../agent/rules.ts";
import { runTurn } from "../agent/turn.ts";
import { loadConfig } from "../config.ts";
import { createApp } from "../gateway/app.ts";
import { runToolCall } from "../policy/run.ts";
import { contractText } from "../scenarios/data.ts";
import { buildServices, type Services } from "../services.ts";
import type { Decision, Finding, ToolCall, TraceEvent } from "../types.ts";
import { newId } from "../util.ts";
import { buildResearchBrief } from "./brief.ts";
import { createResearchAdapters, RESEARCH_TOOL_NAMES } from "./index.ts";
import { mockFetch } from "./testkit.ts";

function services(): Services {
  const s = buildServices(loadConfig({ APPROVAL_TTL_SECONDS: "5" }), { persist: false });
  s.tools.register(...createResearchAdapters({ fetch: mockFetch() }));
  return s;
}

function numbersIn(f: Finding): number[] {
  const out: number[] = [];
  if (f.metric) out.push(f.metric.value);
  const v = f.viz;
  if (v?.kind === "curve") out.push(...v.series.flatMap((x) => x.points));
  if (v?.kind === "bars") out.push(...v.items.map((x) => x.value));
  if (v?.kind === "compare") out.push(v.before.value, v.after.value);
  out.push(...f.evidence.flatMap((e) => (e.value === undefined ? [] : [e.value])));
  return out;
}

test("a brief runs each skill through SkillGate in one turn and returns evidence cards", async () => {
  const s = services();
  const brief = await buildResearchBrief(s, { query: "research Apple" });
  assert.equal(brief.company?.ticker, "AAPL");
  assert.deepEqual(
    brief.steps.map((x) => [x.skill, x.status]),
    [
      ["research.sec_facts", "cached_sample"],
      ["research.sec_filings", "cached_sample"],
      ["research.treasury_rates", "ok"],
      ["research.fdic_bank", "skipped"],
      ["research.cfpb_complaints", "skipped"],
    ],
  );
  const events = s.trace.list().filter((e) => e.turnId === brief.turnId);
  for (const type of ["tool_proposed", "decision", "tool_executed"] as const) assert.equal(events.filter((e) => e.type === type).length, 3, type);
  for (const e of events.filter((x) => x.type === "tool_proposed")) assert.equal((e.data as ToolCall).skill, "research");
  for (const e of events.filter((x) => x.type === "decision")) {
    const d = e.data as Decision;
    assert.equal(d.verdict, "allow");
    assert.match(d.reasons[0]!.message, /Extension research is approved to look up public data/);
  }

  const facts = brief.findings.find((f) => f.id === "research:AAPL/facts")!;
  assert.equal(facts.area, "investments");
  assert.equal(facts.from, "research");
  assert.equal(facts.simulated, true, "the SEC cached sample is not live");
  assert.match(facts.title, /cached sample, not live/);
  assert.equal(facts.viz?.kind, "curve");
  assert.ok(facts.evidence.every((e) => e.origin === "reference" && e.url?.startsWith("https://www.sec.gov/")));
  const treasury = brief.findings.find((f) => f.id.startsWith("research:treasury"))!;
  assert.equal(treasury.simulated, false);
  assert.deepEqual(treasury.viz, { kind: "compare", unit: "pct", before: { label: "Treasury bills", value: 3.87 }, after: { label: "Treasury notes", value: 3.383 } });
  assert.ok(brief.findings.some((f) => f.viz?.kind === "timeline"));

  const corpus = JSON.stringify(events.filter((e) => e.type === "tool_executed").map((e) => e.data));
  for (const f of brief.findings) for (const n of numbersIn(f)) assert.ok(corpus.includes(String(n)), `${f.id}: ${n} is not in the tool results`);
  assert.doesNotMatch(JSON.stringify(brief.findings), /\b(you should|we recommend|buy|sell)\b/i);
});

test("a bank brief adds the FDIC check and complaint bars", async () => {
  const s = services();
  const brief = await buildResearchBrief(s, { query: "Capital One" });
  const complaints = brief.findings.find((f) => f.id.startsWith("research:cfpb/"))!;
  assert.deepEqual(complaints.viz, {
    kind: "bars",
    unit: "number",
    items: [
      { label: "Incorrect information on your report", value: 300, tone: "warn" },
      { label: "Managing an account", value: 200, tone: "muted" },
      { label: "Getting a credit card", value: 100, tone: "muted" },
    ],
  });
  const fdic = brief.findings.find((f) => f.id.startsWith("research:fdic/"))!;
  assert.match(fdic.title, /Capital One, National Association is listed by the FDIC \(certificate 4297/);
  assert.equal(brief.steps.find((x) => x.skill === "research.sec_facts")!.status, "failed", "COF is not in the cached sample");
});

test("research results never vouch for a money field", async () => {
  const s = services();
  s.policy.recordConsent("app");
  const brief = await buildResearchBrief(s, { query: "Capital One" }); // returns cert 4297 and counts 300, 990
  const call: ToolCall = {
    id: newId("call"),
    turnId: brief.turnId,
    tool: "bank.transfer",
    args: { from_account: "acct-checking", to_account: "4297", amount: 300 },
    skill: "core",
    activeSkills: [],
    requestedBy: "model",
  };
  const decision = await s.gate.check(call);
  for (const field of ["to_account", "amount"]) assert.notEqual(decision.provenance.find((p) => p.field === field)?.status, "trusted", field);
  assert.notEqual(decision.verdict, "allow");
});

test("the pack's manifest narrows SkillGate: research cannot read bank data, and needs the user's grant", async () => {
  const s = services();
  const run = (tool: string, skill = "research") =>
    runToolCall({ id: newId("call"), turnId: newId("turn"), tool, args: {}, skill, activeSkills: [skill], requestedBy: "app" }, s);
  const bank = await run("bank.get_accounts");
  assert.equal(bank.status, "denied");
  assert.match(bank.decision.reasons[0]!.message, /Extension research never asked for permission to read your balances/);
  const unknown = await run("research.treasury_rates", "someone-else");
  assert.equal(unknown.status, "denied");

  s.policy.update({ grants: s.policy.current().grants.filter((g) => g.capability !== "research.read") });
  const brief = await buildResearchBrief(s, { query: "research Apple" });
  assert.ok(brief.steps.filter((x) => x.status !== "skipped").every((x) => x.status === "denied" && /policy does not let FinGuard look up public data/.test(x.detail ?? "")));
  assert.equal(brief.findings.length, 0);
});

test("advisor routing: research and bank questions go to the advisor with the research tools", () => {
  const route = (text: string, inbound?: { id: string; text: string }) => {
    const intent = classifyIntent({ turnId: "t", text, ...(inbound ? { inbound } : {}) }, []);
    return [intent.kind, routeIntent(intent)];
  };
  assert.deepEqual(route("research Apple"), ["research", "advisor"]);
  assert.deepEqual(route("how is MSFT doing"), ["research", "advisor"]);
  assert.deepEqual(route("is First Example Bank real?"), ["research", "advisor"]);
  assert.deepEqual(route("is this real?", { id: "in1", text: "Your bank account is locked" }), ["forwarded", "guardian"]);
  assert.deepEqual(route("how are my investments doing?")[0], "area");
  assert.deepEqual(classifyIntent({ turnId: "t", text: "is First Example Bank real?" }, ["an earlier forwarded text"]).kind, "research");
});

test("the advisor answers research questions with grounded facts and one source; the evaluator passes them", async () => {
  const s = services();
  const cases: [string, RegExp][] = [
    ["research Apple", /Apple Inc\. \(AAPL\) reported revenue of \$416\.16 billion in FY2025, compared with \$365\.82 billion in FY2021 \(cached sample, not live\)\..*Source: https:\/\/www\.sec\.gov\//],
    ["how is MSFT doing", /Microsoft Corp \(MSFT\) reported revenue of \$281\.72 billion in FY2025/],
    ["is First Example Bank real?", /FDIC BankFind has no active bank named like "First Example Bank"\..*Source: https:\/\/banks\.data\.fdic\.gov\//],
    ["is Capital One bank real?", /lists Capital One, National Association as an active institution \(certificate 4297, Mclean, VA\).*Source: https:\/\/banks\.data\.fdic\.gov\/bankfind-suite\/bankfind\/details\/4297/],
  ];
  for (const [text, expected] of cases) {
    const turn = await runTurn(s, { text });
    assert.equal(turn.replies.length, 1, text);
    assert.match(turn.replies[0]!, expected);
    const steps = s.trace.list().filter((e: TraceEvent) => e.turnId === turn.turnId && e.type === "agent_step").map((e) => e.data as { agent: string; step: string; ok?: boolean; detail: string });
    assert.match(steps.find((x) => x.step === "route")!.detail, /^advisor/);
    assert.equal(steps.find((x) => x.agent === "evaluator")?.ok, true, `${text}: ${JSON.stringify(steps)}`);
    assert.ok(s.trace.list().some((e) => e.turnId === turn.turnId && e.type === "tool_executed" && RESEARCH_TOOL_NAMES.includes((e.data as { tool: string }).tool)));
  }
});

let server: http.Server;
let base: string;
let shared: Services;

before(async () => {
  shared = services();
  server = http.createServer(createApp(shared));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

async function api(method: string, url: string, body?: unknown, role: "customer" | "operator" = "customer") {
  const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json", "X-Demo-Role": role }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

test("GET /api/research/skills shows the manifest: research.read only, its hosts and five read tools", async () => {
  const { status, body } = await api("GET", "/api/research/skills");
  assert.equal(status, 200);
  assert.equal(body.manifest.name, "research");
  assert.deepEqual(body.manifest.capabilities, [{ capability: "research.read", approval: "never" }]);
  assert.equal(body.summary, "This skill may only read public data.");
  assert.deepEqual(body.hosts, ["data.sec.gov", "www.sec.gov", "api.fiscaldata.treasury.gov", "api.fdic.gov", "www.consumerfinance.gov"]);
  assert.equal(body.tools.length, 5);
  assert.ok(body.tools.every((t: { effect: string }) => t.effect === "read"));
  assert.match(body.tools[0].mode, /cached sample/);
});

test("POST /api/research/brief works for customers and operators and validates the query", async () => {
  for (const role of ["customer", "operator"] as const) {
    const { status, body } = await api("POST", "/api/research/brief", { query: "how is MSFT doing" }, role);
    assert.equal(status, 200);
    assert.equal(body.company.ticker, "MSFT");
    assert.ok(body.findings.length >= 3);
    assert.ok(body.turnId.startsWith("turn"));
    assert.match(body.disclaimer, /does not recommend/);
  }
  assert.equal((await api("POST", "/api/research/brief", {})).status, 400);
  assert.equal((await api("POST", "/api/research/brief", { query: "x".repeat(201) })).status, 400);
});

test("POST /api/contracts/review returns one contracts card with the clauses highlighted", async () => {
  const text = contractText();
  const { status, body } = await api("POST", "/api/contracts/review", { text }, "operator");
  assert.equal(status, 200);
  const f = body.finding as Finding;
  assert.equal(f.area, "contracts");
  assert.equal(f.viz?.kind, "clauses");
  if (f.viz?.kind === "clauses") {
    assert.equal(f.viz.text, text);
    assert.ok(f.viz.spans.length >= 4);
    for (const span of f.viz.spans) assert.ok(span.end > span.start && span.end <= text.length);
  }
  assert.equal(f.metric?.value, 199, "early termination fee from the text");
  assert.ok(f.evidence.filter((e) => e.origin === "document").every((e) => e.trusted === false && (e.quote === undefined || text.includes(e.quote))));
  assert.match(f.summary, /renews automatically/);
  assert.equal((await api("POST", "/api/contracts/review", { text: "x".repeat(20_001) })).status, 400);
  assert.equal((await api("POST", "/api/contracts/review", {})).status, 400);
});
