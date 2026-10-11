import { performance } from "node:perf_hooks";
import type { Metrics } from "../metrics.ts";
import type { KbVectorRow } from "../store/db.ts";
import type { RagHit, Retriever } from "../types.ts";
import { sha256 } from "../util.ts";
import { BM25Retriever, type KnowledgeDocument } from "./index.ts";

export const DIMS = 512;
export const RRF_K = 60;
export const LOCAL_MODEL = "local-fh512-v1";
const MAX_K = 50;

type Collection = KnowledgeDocument["collection"];

export interface Chunk {
  id: string;
  doc: KnowledgeDocument;
  body: string;
  hash: string;
}

export interface VectorStore {
  kbVectors(model: string): Map<string, KbVectorRow>;
  putKbVectors(rows: KbVectorRow[]): void;
  dropKbModels?(prefix: string, keep: string): void;
}

export interface RemoteEmbedder {
  readonly model: string;
  embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]>;
}

const STOP = new Set(
  "a an and are as at be been but by can do does for from has have i if in into is it its me my of on or our so than that the their them then there these they this to was we were what when which who will with you your".split(" "),
);

export function stem(t: string): string {
  let w = t;
  if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => !STOP.has(t)).map(stem);
}

export function features(text: string): Map<string, number> {
  const ts = terms(text);
  const out = new Map<string, number>();
  const add = (f: string) => out.set(f, (out.get(f) ?? 0) + 1);
  ts.forEach((t, i) => {
    add(`u:${t}`);
    if (i > 0) add(`b:${ts[i - 1]}_${t}`);
  });
  return out;
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class LocalEmbedder {
  readonly model: string;
  private readonly idf = new Map<string, number>();
  private readonly unseenIdf: number;

  constructor(corpus: string[], fingerprint: string) {
    const df = new Map<string, number>();
    for (const text of corpus) for (const f of features(text).keys()) df.set(f, (df.get(f) ?? 0) + 1);
    const n = corpus.length;
    for (const [f, d] of df) this.idf.set(f, Math.log((n + 1) / (d + 1)) + 1);
    this.unseenIdf = Math.log(n + 1) + 1;
    this.model = `${LOCAL_MODEL}:${fingerprint}`;
  }

  embed(text: string): Float32Array {
    const v = new Float32Array(DIMS);
    for (const [f, count] of features(text)) {
      const h = fnv1a(f);
      const weight = (1 + Math.log(count)) * (this.idf.get(f) ?? this.unseenIdf);
      v[h % DIMS]! += (h & 0x80000000 ? -1 : 1) * weight;
    }
    return normalize(v);
  }
}

export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export function chunkDocuments(docs: KnowledgeDocument[]): Chunk[] {
  return docs.flatMap((doc) =>
    doc.body
      .split(/\n(?=## )/)
      .filter((s) => s.trim())
      .map((body, i) => ({ id: `${doc.id}#${i}`, doc, body, hash: sha256([doc.id, doc.collection, doc.title, body].join("\u0000")) })),
  );
}

const textOf = (c: Chunk) => `${c.doc.title}\n${c.body}`;

interface Ranked {
  docId: string;
  chunk?: Chunk;
  hit?: RagHit;
}

export interface HybridOptions {
  store?: VectorStore;
  remote?: RemoteEmbedder;
  metrics?: Metrics;
  log?: (line: string) => void;
}

export class HybridRetriever implements Retriever {
  readonly chunks: Chunk[];
  readonly embedded = { reused: 0, computed: 0, ms: 0 };
  private readonly bm25: BM25Retriever;
  private readonly local: LocalEmbedder;
  private readonly localVectors = new Map<string, Float32Array>();
  private readonly chunkTerms = new Map<string, Set<string>>();
  private remoteVectors?: Map<string, Float32Array>;
  readonly remoteReady: Promise<boolean>;

  constructor(docs: KnowledgeDocument[], private readonly o: HybridOptions = {}) {
    const started = performance.now();
    this.bm25 = new BM25Retriever(docs);
    this.chunks = chunkDocuments(docs);
    const fingerprint = sha256(this.chunks.map((c) => c.hash).sort().join("")).slice(0, 12);
    this.local = new LocalEmbedder(this.chunks.map(textOf), fingerprint);
    for (const c of this.chunks) this.chunkTerms.set(c.id, new Set(terms(textOf(c))));

    const cached = o.store?.kbVectors(this.local.model) ?? new Map<string, KbVectorRow>();
    const fresh: KbVectorRow[] = [];
    for (const c of this.chunks) {
      const row = cached.get(c.id);
      if (row && row.contentHash === c.hash && row.vector.length === DIMS) {
        this.localVectors.set(c.id, row.vector);
        this.embedded.reused++;
        continue;
      }
      const vector = this.local.embed(textOf(c));
      this.localVectors.set(c.id, vector);
      fresh.push({ chunkId: c.id, model: this.local.model, docId: c.doc.id, collection: c.doc.collection, contentHash: c.hash, vector });
    }
    this.embedded.computed = fresh.length;
    o.store?.putKbVectors(fresh);
    o.store?.dropKbModels?.(`${LOCAL_MODEL}:`, this.local.model);
    this.embedded.ms = Math.round((performance.now() - started) * 100) / 100;
    this.remoteReady = o.remote ? this.loadRemote(o.remote) : Promise.resolve(false);
  }

  get localModel(): string {
    return this.local.model;
  }

  private async loadRemote(remote: RemoteEmbedder): Promise<boolean> {
    try {
      const cached = this.o.store?.kbVectors(remote.model) ?? new Map<string, KbVectorRow>();
      const vectors = new Map<string, Float32Array>();
      const missing = this.chunks.filter((c) => {
        const row = cached.get(c.id);
        if (row && row.contentHash === c.hash) vectors.set(c.id, row.vector);
        return !vectors.has(c.id);
      });
      if (missing.length) {
        const embedded = await remote.embed(missing.map(textOf), "document");
        if (embedded.length !== missing.length) throw new Error(`expected ${missing.length} vectors, got ${embedded.length}`);
        const rows = missing.map((c, i) => ({ chunkId: c.id, model: remote.model, docId: c.doc.id, collection: c.doc.collection, contentHash: c.hash, vector: embedded[i]! }));
        rows.forEach((r) => vectors.set(r.chunkId, r.vector));
        this.o.store?.putKbVectors(rows);
      }
      this.remoteVectors = vectors;
      return true;
    } catch (err) {
      this.o.metrics?.inc("rag.remote.fallback");
      this.o.log?.(`rag: remote embeddings unavailable, using local ones (${err instanceof Error ? err.message : String(err)})`);
      return false;
    }
  }

  async search(query: string, opts: { collection?: Collection; k?: number } = {}): Promise<RagHit[]> {
    const k = opts.k ?? 3;
    if (!Number.isInteger(k) || k < 1 || k > MAX_K) throw new Error("k must be an integer from 1 to 50");
    if (query.length > 2000) throw new Error("Query too long");
    const lexical = await this.bm25.search(query, { collection: opts.collection, k: MAX_K });
    const dense = await this.denseRank(query, opts.collection);
    return fuse(lexical.map((hit) => ({ docId: hit.docId, hit })), dense, k);
  }

  lexical(query: string, opts: { collection?: Collection; k?: number } = {}): Promise<RagHit[]> {
    return this.bm25.search(query, opts);
  }

  async denseRank(query: string, collection?: Collection): Promise<Ranked[]> {
    const pool = this.chunks.filter((c) => !collection || c.doc.collection === collection);
    let scored: { chunk: Chunk; sim: number }[] | undefined;
    if (this.remoteVectors && this.o.remote) {
      try {
        const [q] = await this.o.remote.embed([query], "query");
        if (q) scored = pool.map((chunk) => ({ chunk, sim: dot(q, this.remoteVectors!.get(chunk.id) ?? new Float32Array(q.length)) }));
      } catch (err) {
        this.o.metrics?.inc("rag.remote.fallback");
        this.o.log?.(`rag: remote query embedding failed, using local (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    if (!scored) {
      const qTerms = new Set(terms(query));
      const q = this.local.embed(query);
      scored = pool
        .filter((chunk) => [...qTerms].some((t) => this.chunkTerms.get(chunk.id)!.has(t)))
        .map((chunk) => ({ chunk, sim: dot(q, this.localVectors.get(chunk.id)!) }));
    }
    const best = new Map<string, { chunk: Chunk; sim: number }>();
    for (const s of scored) if (s.sim > 0 && s.sim > (best.get(s.chunk.doc.id)?.sim ?? -Infinity)) best.set(s.chunk.doc.id, s);
    return [...best.values()].sort((a, b) => b.sim - a.sim || a.chunk.doc.id.localeCompare(b.chunk.doc.id)).map(({ chunk }) => ({ docId: chunk.doc.id, chunk }));
  }
}

export function fuse(lexical: Ranked[], dense: Ranked[], k: number): RagHit[] {
  const entries = new Map<string, { score: number; lexRank: number; bestRank: number; from: Ranked }>();
  const add = (list: Ranked[], isLexical: boolean) =>
    list.forEach((r, i) => {
      const rank = i + 1;
      const e = entries.get(r.docId) ?? { score: 0, lexRank: Infinity, bestRank: Infinity, from: r };
      e.score += 1 / (RRF_K + rank);
      if (isLexical) e.lexRank = rank;
      if (rank < e.bestRank) {
        e.bestRank = rank;
        e.from = r;
      }
      entries.set(r.docId, e);
    });
  add(lexical, true);
  add(dense, false);
  return [...entries.values()]
    .sort((a, b) => b.score - a.score || a.lexRank - b.lexRank || a.from.docId.localeCompare(b.from.docId))
    .slice(0, k)
    .map((e) => {
      const score = Math.round(e.score * 1e6) / 1e6;
      if (e.from.hit) return { ...e.from.hit, score };
      const doc = e.from.chunk!.doc;
      return { docId: doc.id, title: doc.title, excerpt: e.from.chunk!.body.slice(0, 600), ...(doc.source_url ? { url: doc.source_url } : {}), score };
    });
}

export function timedRetriever(inner: Retriever, metrics: Metrics): Retriever {
  return { search: (query, opts) => metrics.time("rag.search", () => inner.search(query, opts)) };
}
