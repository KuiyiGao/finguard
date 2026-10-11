import type { TraceEvent } from "@contracts";
import { Database, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, type Api } from "../lib/api.ts";
import { formatUsd } from "../lib/format.ts";

interface Latency {
  count: number;
  p50: number;
  p95: number;
  max?: number;
}

interface Metrics {
  uptimeS?: number;
  counters?: Record<string, number>;
  latencyMs?: Record<string, Latency>;
  agent?: { name?: string; mode?: string; model?: string };
}

interface DbStats {
  events?: { total: number };
  decisions?: { total: number; byVerdict?: Record<string, number> };
  approvals?: { total: number };
  receiptsToday?: { count: number; totalAmount: number };
  kbChunks?: { total: number };
  db?: { file?: string; sizeBytes?: number; rebuildMs?: number; projectionErrors?: number };
}

function usePoll<T>(load: () => Promise<T>, key: unknown): T | null | undefined {
  const [data, setData] = useState<T | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const run = () =>
      load().then(
        (d) => live && setData(d),
        (e: unknown) => {
          if (!live) return;
          if (e instanceof ApiError && (e.status === 404 || e.status === 503)) setData(null);
        },
      );
    const first = setTimeout(run, 600);
    const id = setInterval(run, 5000);
    return () => {
      live = false;
      clearTimeout(first);
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return data;
}

const ms = (n: number) => (n < 10 ? n.toFixed(1) : Math.round(n).toString());
const label = (name: string) => name.replace(/^http:/, "").replace(/[._]/g, " ");

function LatencyRows({ rows }: { rows: [string, Latency][] }) {
  const max = Math.max(1, ...rows.map(([, l]) => l.p95));
  return (
    <ul className="infra-lat">
      {rows.map(([name, l]) => (
        <li key={name} title={`${l.count} samples, max ${ms(l.max ?? l.p95)} ms`}>
          <span className="infra-name">{label(name)}</span>
          <span className="infra-bars" aria-hidden>
            <span className="infra-p95" style={{ width: `${(l.p95 / max) * 100}%` }} />
            <span className="infra-p50" style={{ width: `${(l.p50 / max) * 100}%` }} />
          </span>
          <span className="infra-ms num">
            {ms(l.p50)} / {ms(l.p95)} ms
          </span>
        </li>
      ))}
    </ul>
  );
}

export function InfraPanel({ api, events }: { api: Api; events: TraceEvent[] }) {
  const tick = Math.floor(events.length / 5); // refresh as the trace grows, without a call per event
  const metrics = usePoll(api.metrics as () => Promise<Metrics>, tick);
  const raw = usePoll(api.dbStats as () => Promise<{ stats?: DbStats } & DbStats>, tick);
  if (metrics === null && raw === null) return null;
  const db = raw ? (raw.stats ?? raw) : raw;
  const series = Object.entries(metrics?.latencyMs ?? {}).filter(([, l]) => l && typeof l.p50 === "number" && typeof l.p95 === "number");
  const stages = series.filter(([n]) => !n.startsWith("http:"));
  const routes = series
    .filter(([n]) => n.startsWith("http:") && !n.includes("/api/events"))
    .sort((a, b) => b[1].p95 - a[1].p95)
    .slice(0, 6);
  return (
    <section className="card con-panel infra" aria-label="Infrastructure">
      <header className="con-panel-head">
        <h2 className="section-title">
          <Server size={14} /> Infra
        </h2>
        {metrics?.agent?.mode && (
          <span className="badge badge-neutral" title={metrics.agent.model ?? metrics.agent.name}>
            agent: {metrics.agent.mode}
          </span>
        )}
      </header>
      {metrics === undefined && raw === undefined && <p className="empty">Loading</p>}
      {metrics && (
        <div className="infra-block">
          <p className="infra-h">
            Latency p50 / p95 <span className="infra-key" aria-hidden><i className="k50" /> p50 <i className="k95" /> p95</span>
          </p>
          {stages.length + routes.length === 0 ? (
            <p className="faint infra-note">No samples yet.</p>
          ) : (
            <>
              {stages.length > 0 && <LatencyRows rows={stages} />}
              {routes.length > 0 && (
                <details className="infra-more" open={stages.length === 0}>
                  <summary>Slowest API routes</summary>
                  <LatencyRows rows={routes} />
                </details>
              )}
            </>
          )}
        </div>
      )}
      {db && (
        <div className="infra-block">
          <p className="infra-h">
            <Database size={13} aria-hidden /> Read model{db.db?.file ? `, ${db.db.file}` : ""}
          </p>
          <dl className="infra-counts">
            {db.events && (
              <div>
                <dt>Events</dt>
                <dd className="num">{db.events.total}</dd>
              </div>
            )}
            {db.decisions && (
              <div>
                <dt>Decisions</dt>
                <dd className="num">{db.decisions.total}</dd>
              </div>
            )}
            {db.approvals && (
              <div>
                <dt>Approvals</dt>
                <dd className="num">{db.approvals.total}</dd>
              </div>
            )}
            {db.receiptsToday && (
              <div>
                <dt>Receipts today</dt>
                <dd className="num">
                  {db.receiptsToday.count} <span className="faint">{formatUsd(db.receiptsToday.totalAmount)}</span>
                </dd>
              </div>
            )}
            {db.kbChunks && (
              <div>
                <dt>KB chunks</dt>
                <dd className="num">{db.kbChunks.total}</dd>
              </div>
            )}
            {db.db?.sizeBytes !== undefined && (
              <div>
                <dt>Size</dt>
                <dd className="num">{Math.round(db.db.sizeBytes / 1024)} KB</dd>
              </div>
            )}
          </dl>
          {db.decisions?.byVerdict && (
            <p className="faint infra-note num">
              {Object.entries(db.decisions.byVerdict)
                .map(([v, n]) => `${n} ${v}`)
                .join(", ")}
              {db.db?.projectionErrors ? `, ${db.db.projectionErrors} projection errors` : ""}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
