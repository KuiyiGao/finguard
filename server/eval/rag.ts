import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { HybridRetriever } from "../src/rag/hybrid.ts";
import { loadKnowledgeBaseSync } from "../src/rag/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = loadKnowledgeBaseSync(path.join(here, "..", "kb"));
const ids = new Set(docs.map((d) => d.id));
const { cases } = JSON.parse(fs.readFileSync(path.join(here, "rag-cases.json"), "utf8")) as { cases: { id: string; query: string; expected: string; pending?: boolean }[] };
const active = cases.filter((c) => ids.has(c.expected));
const pending = cases.filter((c) => !ids.has(c.expected));
const retriever = new HybridRetriever(docs);

type System = "bm25" | "dense" | "hybrid";
const systems: Record<System, (q: string) => Promise<string[]>> = {
  bm25: async (q) => (await retriever.lexical(q, { k: 10 })).map((h) => h.docId),
  dense: async (q) => (await retriever.denseRank(q)).slice(0, 10).map((r) => r.docId),
  hybrid: async (q) => (await retriever.search(q, { k: 10 })).map((h) => h.docId),
};

const results: Record<string, { recallAt1: number; recallAt3: number; mrr: number; p50Ms: number; ranks: Record<string, number | null> }> = {};
for (const [name, run] of Object.entries(systems) as [System, (q: string) => Promise<string[]>][]) {
  const ranks: Record<string, number | null> = {};
  const times: number[] = [];
  for (const c of active) {
    const started = performance.now();
    const ranked = await run(c.query);
    times.push(performance.now() - started);
    const i = ranked.indexOf(c.expected);
    ranks[c.id] = i < 0 ? null : i + 1;
  }
  const r = Object.values(ranks);
  const share = (ok: (rank: number | null) => boolean) => Math.round((r.filter(ok).length / r.length) * 1000) / 1000;
  times.sort((a, b) => a - b);
  results[name] = {
    recallAt1: share((x) => x === 1),
    recallAt3: share((x) => x !== null && x <= 3),
    mrr: Math.round((r.reduce<number>((s, x) => s + (x ? 1 / x : 0), 0) / r.length) * 1000) / 1000,
    p50Ms: Math.round((times[Math.floor(times.length / 2)] ?? 0) * 1000) / 1000,
    ranks,
  };
}

const out = {
  ranAt: new Date().toISOString(),
  kbDocs: docs.length,
  chunks: retriever.chunks.length,
  cases: { total: cases.length, run: active.length, pending: pending.map((c) => c.id) },
  settings: { rrfK: 60, dims: 512, embeddings: retriever.localModel, mrrCutoff: 10, collectionFilter: false },
  results,
};
fs.writeFileSync(path.join(here, "rag-result.json"), JSON.stringify(out, null, 2) + "\n");

console.log(`Retrieval eval: ${active.length} cases over ${docs.length} KB docs (${retriever.chunks.length} chunks); pending: ${pending.length ? pending.map((c) => c.id).join(", ") : "none"}`);
console.log("system   recall@1  recall@3  MRR@10  p50 ms");
for (const [name, r] of Object.entries(results)) console.log(`${name.padEnd(8)} ${r.recallAt1.toFixed(3).padStart(8)}  ${r.recallAt3.toFixed(3).padStart(8)}  ${r.mrr.toFixed(3).padStart(6)}  ${r.p50Ms.toFixed(3).padStart(6)}`);
const misses = active.filter((c) => results.hybrid!.ranks[c.id] !== 1).map((c) => `${c.id} (bm25 ${results.bm25!.ranks[c.id] ?? "-"}, hybrid ${results.hybrid!.ranks[c.id] ?? "-"})`);
if (misses.length) console.log(`hybrid not at rank 1: ${misses.join("; ")}`);
console.log("Wrote eval/rag-result.json");
