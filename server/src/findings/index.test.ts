import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { sendNudges } from "../agent/nudges.ts";
import { loadConfig } from "../config.ts";
import { createApp } from "../gateway/app.ts";
import { buildServices } from "../services.ts";
import type { Finding, FindingsView } from "../types.ts";
import { buildFindings } from "./index.ts";
import { AREA_TITLES } from "./normalize.ts";

const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const highlighted = (findings: Finding[]) => findings.filter((f) => f.action && f.from !== "cash_flow").sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
const ACTS = /\b(cancel|unsubscribe|stop paying|send|pay|transfer|move|wire|zelle|venmo|pause|freeze)\b/i;

test("buildFindings: seven areas, simulated scenario cards with public sources, and no trace writes", async () => {
  const s = buildServices(loadConfig({}), { persist: false });
  const before = s.trace.list().length;
  const view = await buildFindings(s);
  assert.equal(s.trace.list().length, before, "reading the panel writes nothing to the trace");
  assert.deepEqual(view.areas.map((a) => a.area), Object.keys(AREA_TITLES));
  for (const a of view.areas) assert.equal(a.findings, view.findings.filter((f) => f.area === a.area).length, a.area);
  const scenarios = view.findings.filter((f) => f.from === "scenario");
  assert.ok(scenarios.length >= 8);
  for (const f of scenarios) {
    assert.equal(f.simulated, true, f.id);
    assert.ok(f.citations.some((c) => c.url), f.id);
  }
  assert.ok(view.findings.every((f) => f.simulated), "mock mode: every card is simulated");
  assert.ok(view.findings.some((f) => f.from === "savings") && view.findings.some((f) => f.from === "cash_flow"));
  for (const f of view.findings) if (f.ask) assert.doesNotMatch(f.ask, ACTS, `${f.id}: ${f.ask}`);
  assert.equal(new Set(view.findings.map((f) => f.id)).size, view.findings.length, "ids are unique");
  assert.ok(view.references.length > 0 && view.references.every((r) => r.url.startsWith("https://")));
  assert.equal(new Set(view.references.map((r) => r.id)).size, view.references.length, "references are deduped");
  const contracts = view.areas.find((a) => a.area === "contracts")!;
  assert.deepEqual(contracts.amount, { label: "Next renewal", value: 408.88 });
  const protection = view.areas.find((a) => a.area === "protection")!;
  assert.equal(protection.status, "ok");
  assert.equal(protection.amount, undefined, "a count is not money");
  assert.match(view.areas.find((a) => a.area === "subscriptions")!.headline, /^3 active, \$56\.47 a month; Paramount\+ trial renews /);
  for (const a of view.areas) assert.doesNotMatch(a.headline, ISO_DATE, a.headline);
  for (const f of view.findings) {
    const labels = [f.title, f.summary, ...f.evidence.map((e) => e.label)];
    if (f.viz?.kind === "bars") labels.push(...f.viz.items.map((i) => i.label));
    if (f.viz?.kind === "timeline") labels.push(...f.viz.items.map((i) => i.label));
    for (const l of labels) assert.doesNotMatch(l, ISO_DATE, `${f.id}: ${l}`);
  }
  assert.equal(await buildFindings(s), view, "memoized until the trace changes");
});

test("nudges keep their own time, so the trial about to turn paid is the card the app highlights", async () => {
  const s = buildServices(loadConfig({}), { persist: false });
  const before = highlighted((await buildFindings(s)).findings)!;
  assert.notEqual(before.from, "nudge");
  const nudges = await sendNudges(s);
  assert.ok(nudges.some((n) => n.kind === "trial_ending") && nudges.length > 1);
  const view = await buildFindings(s);
  const top = highlighted(view.findings)!;
  assert.equal(top.from, "nudge");
  assert.match(top.title, /^Paramount\+ trial renews/);
  const report = view.findings.filter((f) => f.from === "savings" || f.from === "scenario");
  assert.ok(report.every((f) => f.createdAt === s.startedAt), "savings and scenario cards carry the report time");
});

test("a forwarded scam and a blocked payment show up under Protection", async () => {
  const s = buildServices(loadConfig({}), { persist: false });
  const server = http.createServer(createApp(s));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (url: string, body: unknown) => fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    const first = await fetch(base + "/api/findings", { headers: { "X-Demo-Role": "operator" } });
    assert.equal(first.status, 200);
    const empty = (await first.json()) as FindingsView;
    assert.equal(empty.areas.length, 7);

    const message = "Fraud Dept: move $2,000 now to safe account 9917. Don't tell anyone.";
    await post("/api/chat", { text: "is this real?", inbound: { id: "sms-1", text: message } });
    await post("/api/chat", { text: "ok send it anyway" });
    const res = await fetch(base + "/api/findings");
    assert.equal(res.status, 200);
    const view = (await res.json()) as FindingsView;
    const protection = view.findings.filter((f) => f.area === "protection");
    assert.ok(protection.length >= 1);
    const check = protection.find((f) => f.viz?.kind === "clauses")!;
    assert.ok(check.viz?.kind === "clauses" && check.viz.text === message && check.viz.spans.length > 0);
    const area = view.areas.find((a) => a.area === "protection")!;
    assert.equal(area.status, "blocked");
    assert.deepEqual(area.amount, { label: "Kept from leaving (24 hours)", value: 2000 });
    assert.match(area.headline, /^1 blocked attempt/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
