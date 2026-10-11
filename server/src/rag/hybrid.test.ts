import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { SERVER_ROOT } from "../config.ts";
import { StewardDb } from "../store/db.ts";
import { DIMS, fuse, HybridRetriever, LocalEmbedder, RRF_K, stem, terms } from "./hybrid.ts";
import { loadKnowledgeBaseSync, type KnowledgeDocument } from "./index.ts";

const docs = loadKnowledgeBaseSync(path.join(SERVER_ROOT, "kb"));

test("local embeddings are deterministic, 512-d and L2-normalized; stems are consistent", () => {
  const e = new LocalEmbedder(["a safe account scam", "late fees on bills"], "fp");
  const a = e.embed("move money to a safe account");
  const b = e.embed("move money to a safe account");
  assert.equal(a.length, DIMS);
  assert.deepEqual([...a], [...b]);
  assert.ok(Math.abs(Math.hypot(...a) - 1) < 1e-5);
  assert.deepEqual(["charged", "charges", "charge", "charging"].map(stem), ["charg", "charg", "charg", "charg"]);
  assert.deepEqual(terms("The fees are charged"), ["fee", "charg"]);
});

test("RRF fuses ranks with k = 60 and keeps the better list's excerpt", () => {
  const hit = (docId: string) => ({ docId, title: docId, excerpt: `lexical ${docId}`, score: 9 });
  const doc = (id: string): KnowledgeDocument => ({ id, title: id, collection: "scams", body: "x" });
  const chunk = (id: string) => ({ id: `${id}#0`, doc: doc(id), body: `dense ${id}`, hash: "h" });
  const fused = fuse(
    [{ docId: "a", hit: hit("a") }, { docId: "b", hit: hit("b") }],
    [{ docId: "b", chunk: chunk("b") }, { docId: "c", chunk: chunk("c") }],
    3,
  );
  assert.deepEqual(fused.map((h) => h.docId), ["b", "a", "c"]);
  assert.equal(fused[0]!.score, Math.round((1 / (RRF_K + 2) + 1 / (RRF_K + 1)) * 1e6) / 1e6);
  assert.equal(fused[1]!.excerpt, "lexical a");
  assert.equal(fused[2]!.excerpt, "dense c");
});

test("hybrid search honors collection and k, returns fused scores and cites exact doc ids", async () => {
  const r = new HybridRetriever(docs);
  const hits = await r.search("someone says my bank account is compromised and I must move money to a safe account", { collection: "scams", k: 2 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.docId, "kb:scams/safe-account");
  assert.ok(hits.every((h) => h.docId.startsWith("kb:scams/") && h.score > 0 && h.score <= 2 / (RRF_K + 1) + 1e-6));
  assert.ok(docs.some((d) => d.id === hits[1]!.docId));
  assert.deepEqual(await r.search("zzzz qqqq"), [], "no shared terms: no hits, hash collisions never count");
  await assert.rejects(r.search("x", { k: 0 }));
});

test("vectors are cached in SQLite by content hash; a KB change re-embeds", () => {
  const db = new StewardDb(":memory:");
  const first = new HybridRetriever(docs, { store: db });
  assert.equal(first.embedded.computed, first.chunks.length);
  const second = new HybridRetriever(docs, { store: db });
  assert.deepEqual(second.embedded, { ...second.embedded, reused: first.chunks.length, computed: 0 });
  const changed = docs.map((d, i) => (i === 0 ? { ...d, body: d.body + "\nOne more sentence." } : d));
  const third = new HybridRetriever(changed, { store: db });
  assert.notEqual(third.localModel, first.localModel, "IDF depends on the corpus, so the model id changes");
  assert.equal(third.embedded.computed, third.chunks.length);
  assert.deepEqual(db.stats().kbChunks.byModel, { [third.localModel]: third.chunks.length }, "old local vectors are dropped");
  db.close();
});

test("a failing remote embedder falls back to local vectors", async () => {
  const lines: string[] = [];
  const r = new HybridRetriever(docs, { remote: { model: "remote-x", embed: async () => { throw new Error("offline"); } }, log: (l) => lines.push(l) });
  assert.equal(await r.remoteReady, false);
  const hits = await r.search("gift card codes for support", { k: 1 });
  assert.equal(hits[0]!.docId, "kb:scams/gift-card-crypto");
  assert.match(lines.join("\n"), /remote embeddings unavailable/);
});
