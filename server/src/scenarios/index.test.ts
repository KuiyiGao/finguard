import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { SERVER_ROOT } from "../config.ts";
import { BM25Retriever, loadKnowledgeBaseSync } from "../rag/index.ts";
import { INVESTMENT_PITCH, LOAN_RELIEF_MESSAGE } from "./data.ts";
import { buildScenarios } from "./index.ts";

const rag = new BM25Retriever(loadKnowledgeBaseSync(path.join(SERVER_ROOT, "kb")));
const now = new Date("2026-10-10T16:00:00Z");

test("scenario cards are deterministic for a given now", async () => {
  const a = await buildScenarios({ now, retriever: rag });
  const b = await buildScenarios({ now, retriever: rag });
  assert.deepEqual(a, b);
  assert.equal(new Set(a.findings.map((f) => f.id)).size, a.findings.length, "ids are unique");
});

test("every scenario card is simulated, cites a public source and has a question to ask", async () => {
  const { findings, totals } = await buildScenarios({ now, retriever: rag });
  assert.deepEqual([...new Set(findings.map((f) => f.area))].sort(), ["contracts", "investments", "loans"]);
  for (const f of findings) {
    assert.equal(f.simulated, true, f.id);
    assert.equal(f.from, "scenario", f.id);
    assert.ok(f.citations.some((c) => c.url?.startsWith("https://")), `${f.id} cites a public source`);
    assert.ok(f.ask?.endsWith("?"), f.id);
    assert.equal(f.createdAt, now.toISOString());
    if (f.viz?.kind === "curve") for (const s of f.viz.series) assert.ok(s.points.length >= 12 && s.points.length <= 49, `${f.id} ${s.points.length} points`);
  }
  assert.deepEqual([totals.investments, totals.loans.balance, totals.contract.renewalCost], [33_980, 40_400, 408.88]);
});

test("the two scam messages are flagged by ScamShield and shown in their own areas", async () => {
  const { findings } = await buildScenarios({ now, retriever: rag });
  const cases = [
    { id: "scam:scenario-investment-pitch", area: "investments", doc: "kb:scams/investment-scam", text: INVESTMENT_PITCH.text },
    { id: "scam:scenario-loan-relief", area: "loans", doc: "kb:scams/loan-relief", text: LOAN_RELIEF_MESSAGE.text },
  ];
  for (const c of cases) {
    const f = findings.find((x) => x.id === c.id)!;
    assert.equal(f.area, c.area);
    assert.equal(f.tone, "block");
    assert.equal(f.citations[0]?.docId, c.doc);
    assert.ok(f.viz?.kind === "clauses" && f.viz.text === c.text && f.viz.spans.length > 0);
    assert.ok(f.evidence.filter((e) => e.origin === "message").every((e) => !e.trusted && e.quote));
  }
  const pitch = findings.find((x) => x.id === "scam:scenario-investment-pitch")!;
  assert.ok(pitch.viz?.kind === "clauses" && pitch.viz.spans.some((s) => pitch.viz?.kind === "clauses" && pitch.viz.text.slice(s.start, s.end) === "guaranteed 2% daily returns"));
});
