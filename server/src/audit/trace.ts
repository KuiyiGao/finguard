import fs from "node:fs";
import path from "node:path";
import type { TraceEvent, TraceEventType } from "../types.ts";
import { canonicalJson, nowIso, sha256 } from "../util.ts";

export const GENESIS = "0".repeat(64);

export function hashEvent(e: Omit<TraceEvent, "hash">): string {
  const body = canonicalJson({ seq: e.seq, ts: e.ts, turnId: e.turnId, type: e.type, data: e.data });
  return sha256(e.prevHash + body);
}

export type VerifyResult = { ok: true; count: number } | { ok: false; count: number; badSeq: number; reason: string };

export class TraceLog {
  private events: TraceEvent[] = [];
  private listeners = new Set<(e: TraceEvent) => void>();
  private unreadable?: { line: number; afterSeq: number };
  private checked = { count: 0, prevHash: GENESIS };

  constructor(private readonly file?: string) {
    if (file && fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.trim()) return;
        try {
          this.events.push(JSON.parse(line) as TraceEvent);
        } catch {
          this.unreadable ??= { line: i + 1, afterSeq: this.events.at(-1)?.seq ?? 0 };
        }
      });
    }
  }

  append<T>(type: TraceEventType, data: T, turnId?: string): TraceEvent<T> {
    const prev = this.events.at(-1);
    const snapshot = JSON.parse(JSON.stringify(data ?? null)) as T;
    const partial = { seq: (prev?.seq ?? 0) + 1, ts: nowIso(), turnId, type, data: snapshot, prevHash: prev?.hash ?? GENESIS };
    const event: TraceEvent<T> = { ...partial, hash: hashEvent(partial) };
    this.events.push(event);
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(event) + "\n");
    }
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
      }
    }
    return event;
  }

  list(afterSeq = 0): TraceEvent[] {
    if (afterSeq <= 0) return this.events.slice();
    if (this.events[afterSeq - 1]?.seq === afterSeq) return this.events.slice(afterSeq);
    return this.events.filter((e) => e.seq > afterSeq);
  }

  last(): TraceEvent | undefined {
    return this.events.at(-1);
  }

  first(): TraceEvent | undefined {
    return this.events[0];
  }

  get size(): number {
    return this.events.length;
  }

  subscribe(fn: (e: TraceEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  verify({ full = false } = {}): VerifyResult {
    const count = this.events.length;
    const bad = this.unreadable;
    const unreadable = bad && { ok: false as const, count, badSeq: bad.afterSeq + 1, reason: `line ${bad.line} of the trace file is not valid JSON` };
    const from = full || unreadable ? { count: 0, prevHash: GENESIS } : this.checked;
    let prevHash = from.prevHash;
    for (let i = from.count; i < count; i++) {
      const e = this.events[i]!;
      if (unreadable && e.seq > bad.afterSeq) return unreadable;
      if (e.prevHash !== prevHash) return { ok: false, count, badSeq: e.seq, reason: "broken link to the previous event" };
      if (hashEvent(e) !== e.hash) return { ok: false, count, badSeq: e.seq, reason: "content does not match its hash" };
      prevHash = e.hash;
    }
    if (unreadable) return unreadable;
    this.checked = { count, prevHash };
    return { ok: true, count };
  }
}
