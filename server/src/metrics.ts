import { performance } from "node:perf_hooks";

export const WINDOW = 500;
const MAX_SERIES = 300;
const OVERFLOW = "other";

export interface LatencySummary {
  count: number;
  window: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

export interface MetricsSnapshot {
  since: string;
  uptimeS: number;
  counters: Record<string, number>;
  latencyMs: Record<string, LatencySummary>;
}

class Ring {
  private readonly buf = new Float64Array(WINDOW);
  private size = 0;
  private next = 0;
  count = 0;

  add(ms: number): void {
    this.buf[this.next] = ms;
    this.next = (this.next + 1) % WINDOW;
    this.size = Math.min(this.size + 1, WINDOW);
    this.count++;
  }

  summary(): LatencySummary {
    const sorted = Array.from(this.buf.subarray(0, this.size)).sort((a, b) => a - b);
    const rank = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const sum = sorted.reduce((s, n) => s + n, 0);
    return { count: this.count, window: sorted.length, p50: r2(rank(0.5)), p95: r2(rank(0.95)), max: r2(sorted.at(-1) ?? 0), mean: r2(sorted.length ? sum / sorted.length : 0) };
  }
}

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly latencies = new Map<string, Ring>();
  private readonly since = new Date();

  private key<T>(map: Map<string, T>, name: string): string {
    return map.has(name) || map.size < MAX_SERIES ? name : OVERFLOW;
  }

  inc(name: string, by = 1): void {
    const key = this.key(this.counters, name);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  observe(name: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const key = this.key(this.latencies, name);
    let ring = this.latencies.get(key);
    if (!ring) this.latencies.set(key, (ring = new Ring()));
    ring.add(ms);
  }

  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await fn();
    } catch (err) {
      this.inc(`${name}.errors`);
      throw err;
    } finally {
      this.observe(name, performance.now() - started);
    }
  }

  summary(name: string): LatencySummary | undefined {
    return this.latencies.get(name)?.summary();
  }

  counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  snapshot(): MetricsSnapshot {
    const sorted = <T>(map: Map<string, T>) => [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
    return {
      since: this.since.toISOString(),
      uptimeS: Math.round((Date.now() - this.since.getTime()) / 1000),
      counters: Object.fromEntries(sorted(this.counters)),
      latencyMs: Object.fromEntries(sorted(this.latencies).map(([k, ring]) => [k, ring.summary()])),
    };
  }
}
