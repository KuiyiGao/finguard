import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runTurn } from "../agent/turn.ts";
import { TraceLog } from "../audit/trace.ts";
import { loadConfig } from "../config.ts";
import { buildServices } from "../services.ts";
import { StewardDb } from "./db.ts";

function sampleTrace(): TraceLog {
  const trace = new TraceLog();
  trace.append("user_message", { messageId: "m1", text: "move $300 to savings" }, "t1");
  trace.append("tool_proposed", { id: "c1", turnId: "t1", tool: "bank.move_own", args: { amount: 300 } }, "t1");
  trace.append("decision", { callId: "c1", verdict: "allow", reasons: [{ rule: "limit", verdict: "allow", message: "ok" }], provenance: [], latencyMs: 1 }, "t1");
  trace.append("receipt_issued", { id: "r1", callId: "c1", values: [{ field: "amount", value: "$300.00" }], authorizedBy: { kind: "standing_instruction", policyVersion: 1 }, executedAt: new Date().toISOString() }, "t1");
  trace.append("tool_proposed", { id: "c2", turnId: "t2", tool: "bank.transfer", args: { amount: 2000 } }, "t2");
  trace.append("decision", { callId: "c2", verdict: "ask", reasons: [{ rule: "limit", verdict: "ask", message: "over" }], provenance: [], latencyMs: 1 }, "t2");
  trace.append("approval_requested", { id: "a1", callId: "c2", status: "pending" }, "t2");
  return trace;
}

test("the projection is rebuilt from the trace and follows new events", () => {
  const trace = sampleTrace();
  const db = new StewardDb(":memory:").attach(trace);
  let stats = db.stats();
  assert.equal(stats.events.total, 7);
  assert.deepEqual(stats.decisions.byVerdict, { allow: 1, ask: 1 });
  assert.deepEqual(stats.approvals.byStatus, { pending: 1 });
  assert.deepEqual(stats.receiptsToday, { count: 1, totalAmount: 300 });
  assert.equal(stats.db.rebuiltEvents, 7);
  assert.ok(stats.db.sizeBytes > 0);

  trace.append("approval_resolved", { approvalId: "a1", callId: "c2", status: "denied", via: "app" }, "t2");
  stats = db.stats();
  assert.deepEqual(stats.approvals.byStatus, { denied: 1 });
  assert.equal(stats.events.total, 8);
  assert.equal(db.query("SELECT settled_ts FROM approvals WHERE id = 'a1'")[0]!.settled_ts !== null, true);
  assert.deepEqual(db.recentReceipts(5).map((r) => [r.id, r.tool, r.amount, r.authorizedBy]), [["r1", "bank.move_own", 300, "standing_instruction:v1"]]);

  const again = new StewardDb(":memory:").attach(trace);
  const strip = (s: ReturnType<StewardDb["stats"]>) => ({ ...s, db: undefined });
  assert.deepEqual(strip(again.stats()), strip(db.stats()));
  db.close();
  again.close();
  trace.append("user_message", { messageId: "m2", text: "after close" }, "t3"); // a closed projection ignores events
});

test("a file database is rebuilt on open and keeps kb vectors across rebuilds", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "steward-db-"));
  const file = path.join(dir, "steward.db");
  const trace = sampleTrace();
  const first = new StewardDb(file).attach(trace);
  first.putKbVectors([{ chunkId: "kb:x#0", model: "m", docId: "kb:x", collection: "scams", contentHash: "h", vector: new Float32Array([0.5, -0.25]) }]);
  first.close();
  const second = new StewardDb(file).attach(new TraceLog());
  assert.equal(second.stats().events.total, 0);
  assert.deepEqual([...second.kbVectors("m").values()].map((r) => [r.chunkId, [...r.vector]]), [["kb:x#0", [0.5, -0.25]]]);
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("services keep the read model in sync with real turns", async () => {
  const s = buildServices(loadConfig({ APPROVAL_TTL_SECONDS: "5" }), { persist: false });
  s.policy.recordConsent("app");
  await runTurn(s, { text: "move $120 to savings" });
  const db = s.db!;
  const stats = db.stats();
  assert.equal(stats.events.total, s.trace.list().length);
  assert.equal(stats.decisions.byVerdict.allow, 1);
  assert.deepEqual(db.recentReceipts(1).map((r) => [r.tool, r.amount]), [["bank.move_own", 120]]);
  assert.equal(stats.receiptsToday.totalAmount, s.gate.spentToday());
});
