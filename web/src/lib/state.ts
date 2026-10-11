import type { TraceEvent } from "@contracts";
import { useEffect, useState } from "react";
import type { Api, State } from "./api.ts";

const REFRESH_ON = new Set(["approval_requested", "approval_resolved", "receipt_issued", "policy_changed", "consent_recorded"]);

export function useServerState(api: Api, events: TraceEvent[], generation: number): { state: State | null; error: string | null; refresh: () => void } {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const relevant = events.filter((e) => REFRESH_ON.has(e.type)).length;

  useEffect(() => {
    let live = true;
    api.state().then(
      (s) => {
        if (!live) return;
        setState(s);
        setError(null);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [api, relevant, generation, tick]);

  return { state, error, refresh: () => setTick((t) => t + 1) };
}
