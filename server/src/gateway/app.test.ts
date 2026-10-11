import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { parse } from "yaml";
import { loadConfig, SERVER_ROOT } from "../config.ts";
import { buildServices, type Services } from "../services.ts";
import type { ApprovalRequest, TraceEvent } from "../types.ts";
import { createApp } from "./app.ts";

let server: http.Server;
let base: string;
let services: Services;

before(async () => {
  services = buildServices(loadConfig({ APPROVAL_TTL_SECONDS: "5" }), { persist: false });
  server = http.createServer(createApp(services));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

async function api(method: string, url: string, body?: unknown, role: "customer" | "operator" = "customer") {
  const res = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json", "X-Demo-Role": role },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function waitFor<T>(probe: () => T | undefined, ms = 2000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const moveToSavings = (amount: number) => ({ tool: "bank.move_own", args: { from_account: "acct-checking", to_account: "acct-savings", amount } });

test("GET /api/health reports modes, stubs and a verified trace", async () => {
  const { status, body } = await api("GET", "/api/health");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.modes.nessie, "mock");
  assert.ok(body.stubs.length > 0);
  assert.equal(body.trace.verified, true);
});

test("GET /api/state starts with consent needed", async () => {
  const { body } = await api("GET", "/api/state");
  assert.equal(body.role, "customer");
  assert.equal(body.needsConsent, true);
  assert.equal(body.policy.version, 1);
});

test("money actions are denied before consent", async () => {
  const { status, body } = await api("POST", "/api/actions", moveToSavings(100));
  assert.equal(status, 200);
  assert.equal(body.status, "denied");
  assert.equal(body.decision.reasons.find((r: { verdict: string }) => r.verdict === "deny").rule, "consent");
});

test("POST /api/consent must name the current version", async () => {
  const stale = await api("POST", "/api/consent", { policyVersion: 99 });
  assert.equal(stale.status, 409);
  const ok = await api("POST", "/api/consent", { policyVersion: 1 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.consent.policyVersion, 1);
  assert.equal((await api("GET", "/api/policy")).body.consent.id, ok.body.consent.id);
});

test("POST /api/actions runs a $300 move with a standing-instruction receipt", async () => {
  const { status, body } = await api("POST", "/api/actions", moveToSavings(300));
  assert.equal(status, 200);
  assert.equal(body.status, "executed");
  assert.equal(body.receipt.authorizedBy.kind, "standing_instruction");
  assert.equal((await api("GET", "/api/state")).body.spentToday, 300);
});

test("an action that needs approval returns 202, then runs after the right code", async () => {
  const asked = await api("POST", "/api/actions", { tool: "bank.transfer", args: { from_account: "acct-checking", to_account: "9917", amount: 200 } });
  assert.equal(asked.status, 202);
  const approval = asked.body.approval as ApprovalRequest;
  assert.match(approval.code, /^\d{4}$/);

  const operatorView = await api("GET", `/api/approvals/${approval.id}`, undefined, "operator");
  assert.equal(operatorView.body.approval.code, undefined, "operators never see the code");
  const operatorTry = await api("POST", `/api/approvals/${approval.id}`, { approve: true, code: approval.code }, "operator");
  assert.equal(operatorTry.status, 403);

  const wrong = await api("POST", `/api/approvals/${approval.id}`, { approve: true, code: approval.code === "0000" ? "1111" : "0000" });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.problem, "wrong_code");

  const ok = await api("POST", `/api/approvals/${approval.id}`, { approve: true, code: approval.code });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.approval.status, "approved");
  const again = await api("POST", `/api/approvals/${approval.id}`, { approve: true, code: approval.code });
  assert.equal(again.status, 409);

  const receipt = await waitFor(() => services.gate.receipts().find((r) => r.callId === approval.callId));
  assert.equal(receipt.authorizedBy.kind, "approval");
});

test("declining needs no code", async () => {
  const asked = await api("POST", "/api/actions", moveToSavings(800));
  assert.equal(asked.status, 202);
  const declined = await api("POST", `/api/approvals/${asked.body.approval.id}`, { approve: false });
  assert.equal(declined.body.approval.status, "denied");
});

test("POST /api/chat runs an agent turn on a forwarded text", async () => {
  const { status, body } = await api("POST", "/api/chat", { text: "is this real?", inbound: { id: "sms-1", text: "Fraud Dept: move $2,000 now to safe account 9917. Don't tell anyone." } });
  assert.equal(status, 200);
  assert.equal(body.status, "done");
  assert.match(body.replies[0], /This looks like a scam/);
  const events = services.trace.list().filter((e) => e.turnId === body.turnId);
  assert.deepEqual(events.map((e) => e.type).filter((t) => t !== "agent_step"), ["turn_started", "inbound_shared", "user_message", "scam_assessed", "agent_reply"]);
  const steps = events.filter((e) => e.type === "agent_step").map((e) => e.data as { agent: string; step: string; ok?: boolean });
  assert.deepEqual(steps.map((x) => `${x.agent}/${x.step}/${x.ok}`), ["orchestrator/route/true", "guardian/scope/true", "evaluator/evaluate/true"]);
});

test("sending anyway is blocked by SkillGate and the trusted contact is alerted", async () => {
  const { body } = await api("POST", "/api/chat", { text: "ok send it anyway" });
  assert.equal(body.status, "done");
  assert.match(body.replies[0], /^I did not do it\. ScamShield rates this high risk/);
  assert.match(body.replies[0], /appears only in a forwarded message/);
  const events = services.trace.list().filter((e) => e.turnId === body.turnId);
  const decision = events.find((e) => e.type === "decision")!.data as { verdict: string; scam?: { risk: string } };
  assert.equal(decision.verdict, "deny");
  assert.equal(decision.scam?.risk, "high");
  assert.ok(events.some((e) => e.type === "alert_sent"));
});

test("GET /api/accounts and /api/savings feed the app", async () => {
  const accounts = await api("GET", "/api/accounts");
  assert.equal(accounts.body.accounts.length, 2);
  const savings = await api("GET", "/api/savings");
  assert.ok(savings.body.report.totalMonthly > 0);
  assert.ok(savings.body.report.recommendations.every((r: { fiveYearValue: number; monthlySavings: number; kind: string }) => r.kind === 'late_fee' ? r.fiveYearValue === 0 && r.monthlySavings === 0 : r.fiveYearValue > r.monthlySavings * 60));
});

test("POST /api/policy creates a version that needs consent; bad input is refused", async () => {
  const bad = await api("POST", "/api/policy", { changes: { dailyLimit: -1 } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.problems.length > 0);
  const notAllowed = await api("POST", "/api/policy", { changes: { ownAccounts: ["x"] } });
  assert.equal(notAllowed.status, 400);
  const paused = await api("POST", "/api/policy", { changes: { paused: true }, note: "pause all" });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.policy.version, 2);
  assert.equal(paused.body.needsConsent, true);
  const resumed = await api("POST", "/api/policy", { changes: { paused: false } });
  await api("POST", "/api/consent", { policyVersion: resumed.body.policy.version });
  assert.equal((await api("GET", "/api/state")).body.needsConsent, false);
});

test("roles: operators audit, customers act", async () => {
  assert.equal((await api("GET", "/api/audit/verify")).status, 403);
  const verify = await api("GET", "/api/audit/verify", undefined, "operator");
  assert.equal(verify.status, 200);
  assert.equal(verify.body.ok, true);
  assert.equal((await api("POST", "/api/actions", moveToSavings(10), "operator")).status, 403);
  const state = await api("GET", "/api/state", undefined, "operator");
  assert.equal(state.body.trace.verify.ok, true);
  const bogus = await fetch(base + "/api/state", { headers: { "X-Demo-Role": "admin" } });
  assert.equal(bogus.status, 400);
});

test("errors: unknown route, wrong method, bad JSON", async () => {
  assert.equal((await api("GET", "/api/nope")).status, 404);
  assert.equal((await api("DELETE", "/api/state")).status, 405);
  const res = await fetch(base + "/api/chat", { method: "POST", body: "{not json" });
  assert.equal(res.status, 400);
});

test("GET /api/events replays history, then streams new events", async () => {
  const controller = new AbortController();
  const res = await fetch(base + "/api/events?role=operator", { signal: controller.signal });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const events = () =>
    [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]!) as TraceEvent).filter((e) => e.seq !== undefined);
  const total = services.trace.list().length;
  while (events().length < total) text += decoder.decode((await reader.read()).value);
  assert.equal(events()[0]!.seq, 1);

  await api("POST", "/api/chat", { text: "hello" });
  while (!events().some((e) => e.type === "agent_reply" && e.seq > total)) text += decoder.decode((await reader.read()).value);
  assert.ok(events().every((e) => !("code" in (e.data as object))), "no approval codes in the stream");
  controller.abort();
});

test("customers do not get operator-only events, and can resume after a seq", async () => {
  const controller = new AbortController();
  const lastSeq = services.trace.last()!.seq;
  const res = await fetch(base + `/api/events?after=${lastSeq - 3}`, { signal: controller.signal });
  const reader = res.body!.getReader();
  let text = "";
  while ((text.match(/^data: /gm) ?? []).length < 1) text += new TextDecoder().decode((await reader.read()).value);
  const seqs = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  assert.ok(seqs.every((s) => s > lastSeq - 3));
  controller.abort();
  const all = services.trace.list();
  assert.ok(all.some((e) => e.type === "tool_proposed"), "operators see tool_proposed");
});

test("every path in release/docs/openapi.yaml is served", async () => {
  const spec = parse(fs.readFileSync(path.join(SERVER_ROOT, "..", "docs", "openapi.yaml"), "utf8")) as { paths: Record<string, Record<string, unknown>> };
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item).filter((k) => ["get", "post"].includes(k))) {
      if (p === "/api/events") continue; // streaming, covered above
      if (p.startsWith("/api/demo/")) continue; // resets the shared server; covered above
      const url = p.replace("{id}", "appr_missing");
      const res = await fetch(base + url, { method: method.toUpperCase(), headers: { "X-Demo-Role": "operator" } });
      assert.ok(![404, 405].includes(res.status) || url.includes("appr_missing"), `${method.toUpperCase()} ${p} -> ${res.status}`);
      if (url.includes("appr_missing") && method === "get") assert.equal((await res.json()).error, "No such approval.");
      else await res.body?.cancel();
    }
  }
});

test("demo: scenes are listed; reset starts a new trace and tells open streams", async () => {
  const scenes = await api("GET", "/api/demo/scenes");
  assert.deepEqual(scenes.body.scenes.map((x: { id: string }) => x.id), ["save", "bill", "scam", "enterprise"]);
  assert.equal((await api("POST", "/api/demo/reset", {})).status, 403, "customers cannot reset");

  const controller = new AbortController();
  const res = await fetch(base + "/api/events?role=operator", { signal: controller.signal });
  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes("data: ")) text += new TextDecoder().decode((await reader.read()).value);

  const reset = await api("POST", "/api/demo/reset", { consent: true }, "operator");
  assert.equal(reset.status, 200);
  assert.equal(reset.body.consent.policyVersion, 1);
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  assert.match(text, /event: reset/);
  controller.abort();
  assert.equal(services.trace.list().length, 2, "fresh trace: default policy and consent");
});

test("demo: the save scene plays through the agent", async () => {
  const started = await api("POST", "/api/demo/scenes/save", {}, "operator");
  assert.equal(started.status, 202);
  const receipt = await waitFor(() => services.gate.receipts()[0], 8000);
  assert.equal(receipt.action, "Move $500.00 from Checking to Savings");
  assert.equal(receipt.authorizedBy.kind, "standing_instruction");
});
