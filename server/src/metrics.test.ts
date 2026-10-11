import assert from "node:assert/strict";
import { test } from "node:test";
import { Metrics, WINDOW } from "./metrics.ts";

test("latency summaries report nearest-rank p50/p95/max over the window", () => {
  const m = new Metrics();
  for (let i = 1; i <= 100; i++) m.observe("x", i);
  const s = m.summary("x")!;
  assert.deepEqual({ count: s.count, window: s.window, p50: s.p50, p95: s.p95, max: s.max, mean: s.mean }, { count: 100, window: 100, p50: 50, p95: 95, max: 100, mean: 50.5 });
});

test("the ring buffer keeps only the last WINDOW samples", () => {
  const m = new Metrics();
  for (let i = 0; i < WINDOW; i++) m.observe("x", 1000); // old, slow samples roll out
  for (let i = 0; i < WINDOW; i++) m.observe("x", 1);
  const s = m.summary("x")!;
  assert.equal(s.count, 2 * WINDOW);
  assert.equal(s.window, WINDOW);
  assert.equal(s.max, 1);
});

test("time() records failures and counts them; counters add up; bad samples are ignored", async () => {
  const m = new Metrics();
  await m.time("op", async () => "ok");
  await assert.rejects(m.time("op", async () => { throw new Error("boom"); }));
  m.inc("calls");
  m.inc("calls", 2);
  m.observe("op", Number.NaN);
  m.observe("op", -1);
  const snap = m.snapshot();
  assert.equal(snap.latencyMs.op!.count, 2);
  assert.equal(snap.counters["op.errors"], 1);
  assert.equal(snap.counters.calls, 3);
});

test("series names are bounded", () => {
  const m = new Metrics();
  for (let i = 0; i < 1000; i++) m.inc(`n${i}`);
  const names = Object.keys(m.snapshot().counters);
  assert.ok(names.length <= 301, `${names.length} series`);
  assert.ok(m.counter("other") > 0);
});
