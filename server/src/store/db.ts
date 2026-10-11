import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { TraceLog } from "../audit/trace.ts";
import type { ApprovalRequest, AuthorizationReceipt, Decision, ToolCall, TraceEvent } from "../types.ts";
import { parseAmount } from "../util.ts";

let filterInstalled = false;
function loadSqlite(): typeof import("node:sqlite") {
  if (!filterInstalled) {
    filterInstalled = true;
    const printers = process.listeners("warning");
    process.removeAllListeners("warning");
    process.on("warning", (w) => {
      if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return;
      for (const print of printers) print.call(process, w);
    });
  }
  return createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
}

const PROJECTION = ["events", "decisions", "approvals", "receipts"] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, type TEXT NOT NULL, turn_id TEXT, hash TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_type ON events(type);
CREATE INDEX IF NOT EXISTS events_turn ON events(turn_id);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS decisions (call_id TEXT PRIMARY KEY, tool TEXT, verdict TEXT NOT NULL, rules TEXT NOT NULL, ts TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS decisions_verdict ON decisions(verdict);
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, call_id TEXT NOT NULL, status TEXT NOT NULL, ts TEXT NOT NULL, settled_ts TEXT);
CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, call_id TEXT NOT NULL, tool TEXT, amount REAL, authorized_by TEXT NOT NULL, ts TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS receipts_ts ON receipts(ts);
CREATE TABLE IF NOT EXISTS kb_chunks (
  chunk_id TEXT NOT NULL, model TEXT NOT NULL, doc_id TEXT NOT NULL, collection TEXT NOT NULL,
  content_hash TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL, embedded_at TEXT NOT NULL,
  PRIMARY KEY (chunk_id, model)
);`;

export interface ReceiptRow {
  id: string;
  callId: string;
  tool: string | null;
  amount: number | null;
  authorizedBy: string;
  ts: string;
}

export interface DbStats {
  events: { total: number; byType: Record<string, number> };
  decisions: { total: number; byVerdict: Record<string, number> };
  approvals: { total: number; byStatus: Record<string, number> };
  receiptsToday: { count: number; totalAmount: number };
  kbChunks: { total: number; byModel: Record<string, number> };
  db: { file: string; sizeBytes: number; rebuildMs: number; rebuiltEvents: number; projectionErrors: number };
}

export interface KbVectorRow {
  chunkId: string;
  model: string;
  docId: string;
  collection: string;
  contentHash: string;
  vector: Float32Array;
}

type Row = Record<string, unknown>;

export class StewardDb {
  readonly file: string;
  private readonly db: DatabaseSync;
  private readonly put: Record<"event" | "decision" | "approval" | "settle" | "receipt", StatementSync>;
  private readonly tools = new Map<string, string>();
  private unsubscribe?: () => void;
  private rebuild = { ms: 0, events: 0 };
  private errors = 0;
  private closed = false;

  constructor(file: string, private readonly log: (line: string) => void = () => {}) {
    const { DatabaseSync } = loadSqlite();
    this.file = file;
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    if (file !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
    this.put = {
      event: this.db.prepare("INSERT OR REPLACE INTO events (seq, ts, type, turn_id, hash, data) VALUES (?, ?, ?, ?, ?, ?)"),
      decision: this.db.prepare("INSERT OR REPLACE INTO decisions (call_id, tool, verdict, rules, ts) VALUES (?, ?, ?, ?, ?)"),
      approval: this.db.prepare("INSERT OR REPLACE INTO approvals (id, call_id, status, ts, settled_ts) VALUES (?, ?, ?, ?, NULL)"),
      settle: this.db.prepare("UPDATE approvals SET status = ?, settled_ts = ? WHERE id = ?"),
      receipt: this.db.prepare("INSERT OR REPLACE INTO receipts (id, call_id, tool, amount, authorized_by, ts) VALUES (?, ?, ?, ?, ?, ?)"),
    };
  }

  attach(trace: TraceLog): this {
    this.unsubscribe?.();
    const started = performance.now();
    const events = trace.list();
    this.tools.clear();
    this.db.exec("BEGIN");
    try {
      for (const table of PROJECTION) this.db.exec(`DELETE FROM ${table}`);
      for (const e of events) this.apply(e);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.rebuild = { ms: Math.round((performance.now() - started) * 100) / 100, events: events.length };
    this.unsubscribe = trace.subscribe((e) => this.project(e));
    return this;
  }

  project(e: TraceEvent): void {
    if (this.closed) return;
    try {
      this.apply(e);
    } catch (err) {
      this.errors++;
      this.log(`db: could not project event ${e.seq} (${e.type}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private apply(e: TraceEvent): void {
    this.put.event.run(e.seq, e.ts, e.type, e.turnId ?? null, e.hash, JSON.stringify(e.data ?? null));
    switch (e.type) {
      case "tool_proposed": {
        const call = e.data as ToolCall;
        if (call?.id) this.tools.set(call.id, call.tool);
        break;
      }
      case "decision": {
        const d = e.data as Decision;
        const rules = (d.reasons ?? []).map((r) => ({ rule: r.rule, verdict: r.verdict }));
        this.put.decision.run(d.callId, this.tools.get(d.callId) ?? null, d.verdict, JSON.stringify(rules), e.ts);
        break;
      }
      case "approval_requested": {
        const a = e.data as Omit<ApprovalRequest, "code">;
        this.put.approval.run(a.id, a.callId, a.status, e.ts);
        break;
      }
      case "approval_resolved": {
        const r = e.data as { approvalId: string; status: string };
        this.put.settle.run(r.status, e.ts, r.approvalId);
        break;
      }
      case "receipt_issued": {
        const r = e.data as AuthorizationReceipt;
        const amount = parseAmount(r.values?.find((v) => v.field === "amount")?.value);
        const by = r.authorizedBy?.kind === "approval" ? `approval:${r.authorizedBy.approvalId}` : `standing_instruction:v${r.authorizedBy?.policyVersion ?? "?"}`;
        this.put.receipt.run(r.id, r.callId, this.tools.get(r.callId) ?? null, amount, by, r.executedAt ?? e.ts);
        break;
      }
      default:
        break;
    }
  }

  private counts(sql: string, ...params: (string | number)[]): Record<string, number> {
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return Object.fromEntries(rows.map((r) => [String(r.k), Number(r.n)]));
  }

  stats(now = new Date()): DbStats {
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const byType = this.counts("SELECT type AS k, COUNT(*) AS n FROM events GROUP BY type ORDER BY type");
    const byVerdict = this.counts("SELECT verdict AS k, COUNT(*) AS n FROM decisions GROUP BY verdict ORDER BY verdict");
    const byStatus = this.counts("SELECT status AS k, COUNT(*) AS n FROM approvals GROUP BY status ORDER BY status");
    const byModel = this.counts("SELECT model AS k, COUNT(*) AS n FROM kb_chunks GROUP BY model ORDER BY model");
    const today = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM receipts WHERE ts >= ?").get(startOfDay.toISOString()) as Row;
    const pages = this.db.prepare("SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()").get() as Row;
    const sum = (o: Record<string, number>) => Object.values(o).reduce((s, n) => s + n, 0);
    return {
      events: { total: sum(byType), byType },
      decisions: { total: sum(byVerdict), byVerdict },
      approvals: { total: sum(byStatus), byStatus },
      receiptsToday: { count: Number(today.n), totalAmount: Math.round(Number(today.total) * 100) / 100 },
      kbChunks: { total: sum(byModel), byModel },
      db: { file: this.file === ":memory:" ? ":memory:" : path.basename(this.file), sizeBytes: Number(pages.bytes), rebuildMs: this.rebuild.ms, rebuiltEvents: this.rebuild.events, projectionErrors: this.errors },
    };
  }

  recentReceipts(n = 10): ReceiptRow[] {
    const limit = Math.max(1, Math.min(100, Math.floor(n) || 10));
    const rows = this.db.prepare("SELECT id, call_id, tool, amount, authorized_by, ts FROM receipts ORDER BY ts DESC, rowid DESC LIMIT ?").all(limit) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      callId: String(r.call_id),
      tool: r.tool === null ? null : String(r.tool),
      amount: r.amount === null ? null : Number(r.amount),
      authorizedBy: String(r.authorized_by),
      ts: String(r.ts),
    }));
  }

  query(sql: string, ...params: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  kbVectors(model: string): Map<string, KbVectorRow> {
    const rows = this.db.prepare("SELECT chunk_id, model, doc_id, collection, content_hash, vector FROM kb_chunks WHERE model = ?").all(model) as Row[];
    return new Map(
      rows.map((r) => {
        const blob = r.vector as Uint8Array;
        const vector = new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
        return [String(r.chunk_id), { chunkId: String(r.chunk_id), model: String(r.model), docId: String(r.doc_id), collection: String(r.collection), contentHash: String(r.content_hash), vector }];
      }),
    );
  }

  putKbVectors(rows: KbVectorRow[]): void {
    if (!rows.length || this.closed) return;
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO kb_chunks (chunk_id, model, doc_id, collection, content_hash, dims, vector, embedded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const at = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      for (const r of rows)
        insert.run(r.chunkId, r.model, r.docId, r.collection, r.contentHash, r.vector.length, new Uint8Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength), at);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  dropKbModels(prefix: string, keep: string): void {
    if (this.closed) return;
    this.db.prepare("DELETE FROM kb_chunks WHERE substr(model, 1, ?) = ? AND model != ?").run(prefix.length, prefix, keep);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.db.close();
  }
}

export function dbFile(dataDir: string, persist: boolean): string {
  return persist ? path.join(dataDir, "steward.db") : ":memory:";
}
