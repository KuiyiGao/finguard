import type { Finding, FindingsView, TraceEvent } from "@contracts";
import { useEffect, useState } from "react";
import { ApiError, type Api } from "./api.ts";

export function useFindings(api: Api, events: TraceEvent[], generation: number): { view: FindingsView | null; error: string | null; missing: boolean; reload: () => void } {
  const [view, setView] = useState<FindingsView | null>(null);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const count = events.length;
  useEffect(() => {
    let live = true;
    const id = setTimeout(
      () =>
        api.findings().then(
          (v) => {
            if (!live) return;
            setView(v);
            setError(null);
            setMissing(false);
          },
          (e: Error) => {
            if (!live) return;
            setMissing(e instanceof ApiError && e.status === 404);
            setError(e.message);
          },
        ),
      count === 0 ? 0 : 450,
    );
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [api, count, generation, tick]);
  return { view, error, missing, reload: () => setTick((t) => t + 1) };
}

export const isIdleCash = (f: Finding) => f.from === "savings" && /(^|[:-])idle-cash$/.test(f.id);

export function topAction(findings: Finding[]): Finding | undefined {
  return findings.filter((f) => f.action && f.from !== "cash_flow" && !isIdleCash(f)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}
