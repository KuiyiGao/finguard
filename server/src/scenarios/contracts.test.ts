import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { SERVER_ROOT } from "../config.ts";
import { BM25Retriever, loadKnowledgeBaseSync } from "../rag/index.ts";
import { CLAUSE_RULES, contractFindings, contractTerms, extractClauses } from "./contracts.ts";
import { contractText } from "./data.ts";

const text = contractText();
const now = new Date("2026-10-10T16:00:00Z");
const gym = { id: "sub-gym", price: 29.99, renews: "2026-10-22", status: "active" };
const rag = new BM25Retriever(loadKnowledgeBaseSync(path.join(SERVER_ROOT, "kb")));

test("the simulated agreement is 150 to 250 words", () => {
  const words = text.split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 150 && words <= 250, `${words} words`);
});

test("each clause span covers exactly the words its rule matched", () => {
  const clauses = extractClauses(text);
  assert.deepEqual(clauses.map((c) => c.label).sort(), ["Arbitration", "Auto-renews", "Early termination fee", "Extra fee", "How to cancel", "Price can change"]);
  for (const c of clauses) {
    const m = CLAUSE_RULES.find((r) => r.label === c.label)!.re.exec(text)!;
    assert.equal(c.start, m.index, c.label);
    assert.equal(c.quote, m[0].trimEnd(), c.label);
    assert.equal(text.slice(c.start, c.end), c.quote, c.label);
  }
  const span = (label: string) => {
    const c = clauses.find((x) => x.label === label)!;
    return text.slice(c.start, c.end);
  };
  assert.equal(span("Early termination fee"), "early termination fee of $199");
  assert.equal(span("Extra fee"), "annual maintenance fee of $49");
  assert.match(span("Auto-renews"), /^renews automatically for additional 12-month terms/);
  assert.match(span("How to cancel"), /^send written notice by certified mail .* at least 30 days before your renewal date$/);
  assert.match(span("Price can change"), /^may change your monthly dues or any fee with 30 days notice$/);
  assert.match(span("Arbitration"), /^binding arbitration/);
  for (let i = 1; i < clauses.length; i++) assert.ok(clauses[i]!.start >= clauses[i - 1]!.end, "sorted, no overlap");
  assert.deepEqual(extractClauses("Month to month. Leave whenever you like."), []);
});

test("money terms come from the clauses and the subscription record", () => {
  const terms = contractTerms(now, extractClauses(text), gym);
  assert.equal(terms.annualFee, 49);
  assert.equal(terms.earlyTerminationFee, 199);
  assert.equal(terms.noticeDays, 30);
  assert.equal(terms.renewalCost, Math.round((12 * 29.99 + 49) * 100) / 100);
  assert.equal(terms.renewalCost, 408.88);
  assert.deepEqual([terms.nextCharge, terms.deadline, terms.renewal, terms.daysToDeadline], ["2026-10-22", "2026-10-22", "2026-11-21", 12]);
});

test("the contract cards: clauses, renewal cost, cancel action through SkillGate, simulated and cited", async () => {
  const { findings, cancelled } = await contractFindings({ now, retriever: rag, gym });
  assert.equal(cancelled, false);
  const [review, dates] = findings;
  assert.equal(review!.viz?.kind, "clauses");
  assert.equal(review!.metric?.value, 408.88);
  assert.deepEqual(review!.action, { label: "Cancel CloudGym before it renews", tool: "subscriptions.cancel", args: { subscription_id: "sub-gym" } });
  assert.ok(review!.evidence.filter((e) => e.origin === "document").every((e) => !e.trusted && e.quote && text.includes(e.quote)));
  assert.ok(review!.citations.some((c) => c.docId === "kb:contracts/auto-renewal" && c.url?.startsWith("https://")));
  assert.equal(dates!.viz?.kind, "timeline");
  assert.equal(dates!.metric?.value, 12);
  for (const f of findings) assert.ok(f.simulated && f.from === "scenario" && f.ask);
  const after = await contractFindings({ now, retriever: rag, gym: { ...gym, status: "cancelled" } });
  assert.equal(after.findings.length, 1);
  assert.equal(after.findings[0]!.action, undefined, "nothing left to cancel");
});
