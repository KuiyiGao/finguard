import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GENESIS, TraceLog } from "./trace.ts";

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "steward-trace-")), "trace.jsonl");
}

function writeLines(file: string, edit: (lines: string[]) => string[]): void {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  fs.writeFileSync(file, edit(lines).join("\n") + "\n");
}

test("events form a hash chain starting at genesis", () => {
  const log = new TraceLog();
  const a = log.append("user_message", { text: "hi" }, "turn_1");
  const b = log.append("agent_reply", { text: "hello" }, "turn_1");
  assert.equal(a.seq, 1);
  assert.equal(a.prevHash, GENESIS);
  assert.equal(b.prevHash, a.hash);
  assert.deepEqual(log.verify(), { ok: true, count: 2 });
});

test("persists to JSONL and continues the chain after a reload", () => {
  const file = tempFile();
  const first = new TraceLog(file);
  first.append("user_message", { text: "one" });
  first.append("user_message", { text: "two" });
  const reloaded = new TraceLog(file);
  assert.equal(reloaded.list().length, 2);
  const third = reloaded.append("user_message", { text: "three" });
  assert.equal(third.seq, 3);
  assert.equal(third.prevHash, first.last()!.hash);
  assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 3);
  assert.ok(new TraceLog(file).verify().ok);
});

test("editing one stored line fails verification at that seq", () => {
  const file = tempFile();
  const log = new TraceLog(file);
  for (const amount of [100, 200, 300, 400]) log.append("receipt_issued", { amount });
  writeLines(file, (lines) => lines.map((l, i) => (i === 2 ? l.replace('"amount":300', '"amount":3000') : l)));
  const result = new TraceLog(file).verify();
  assert.deepEqual(result, { ok: false, count: 4, badSeq: 3, reason: "content does not match its hash" });
});

test("deleting a stored line breaks the link at the next seq", () => {
  const file = tempFile();
  const log = new TraceLog(file);
  for (const n of [1, 2, 3]) log.append("user_message", { n });
  writeLines(file, (lines) => lines.filter((_, i) => i !== 1));
  const result = new TraceLog(file).verify();
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.badSeq, 3);
  assert.equal(!result.ok && result.reason, "broken link to the previous event");
});

test("an unreadable line is reported instead of crashing", () => {
  const file = tempFile();
  const log = new TraceLog(file);
  for (const n of [1, 2, 3]) log.append("user_message", { n });
  writeLines(file, (lines) => lines.map((l, i) => (i === 1 ? l.slice(0, 20) : l)));
  const result = new TraceLog(file).verify();
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.badSeq, 2);
  assert.match(!result.ok ? result.reason : "", /line 2/);
});

test("stored events are snapshots of the caller's data", () => {
  const log = new TraceLog();
  const data = { amount: 10 };
  log.append("receipt_issued", data);
  data.amount = 99;
  assert.deepEqual(log.list()[0]!.data, { amount: 10 });
  assert.ok(log.verify().ok);
});

test("subscribers get every new event until they unsubscribe", () => {
  const log = new TraceLog();
  const seen: number[] = [];
  const stop = log.subscribe((e) => seen.push(e.seq));
  log.append("user_message", {});
  log.subscribe(() => {
    throw new Error("a broken subscriber");
  });
  log.append("user_message", {});
  stop();
  log.append("user_message", {});
  assert.deepEqual(seen, [1, 2]);
  assert.equal(log.list(1).length, 2);
});

test("routine checks hash only new events; a full check rehashes everything", () => {
  const log = new TraceLog();
  for (let i = 0; i < 50; i++) log.append("user_message", { i });
  assert.deepEqual(log.verify(), { ok: true, count: 50 });
  log.append("user_message", { i: 50 });
  assert.deepEqual(log.verify(), { ok: true, count: 51 });
  (log.list()[10]!.data as { i: number }).i = 999;
  assert.equal(log.verify().ok, true);
  const full = log.verify({ full: true });
  assert.equal(full.ok, false);
  assert.equal(!full.ok && full.badSeq, 11);
  assert.equal(log.list(49).length, 2);
  assert.equal(log.first()?.seq, 1);
  assert.equal(log.size, 51);
});
