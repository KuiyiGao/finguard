import type { TraceEvent } from "@contracts";
import { useEffect, useRef, useState } from "react";
import type { Role } from "./api.ts";

export type StreamStatus = "connecting" | "live" | "offline";

export function useTrace(role: Role): { events: TraceEvent[]; status: StreamStatus; generation: number } {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [generation, setGeneration] = useState(0);
  const seen = useRef(new Set<number>());
  const traceId = useRef<string | null>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let pending: TraceEvent[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = pending;
      pending = [];
      setEvents((prev) => [...prev, ...batch]);
    };
    const open = () => {
      source = new EventSource(`/api/events?role=${role}`);
      source.onopen = () => setStatus("live");
      source.onerror = () => setStatus(source?.readyState === EventSource.CLOSED ? "offline" : "connecting");
      source.onmessage = (msg) => {
        const event = JSON.parse(msg.data as string) as TraceEvent;
        if (seen.current.has(event.seq)) return;
        seen.current.add(event.seq);
        pending.push(event);
        if (!frame) frame = requestAnimationFrame(flush);
      };
      const startOver = () => {
        seen.current = new Set();
        pending = [];
        setEvents([]);
        setGeneration((g) => g + 1);
      };
      source.addEventListener("hello", (msg) => {
        const id = (JSON.parse((msg as MessageEvent).data as string) as { trace: string | null }).trace;
        const changed = traceId.current !== null && id !== traceId.current;
        traceId.current = id;
        if (changed) {
          source?.close();
          startOver();
          setTimeout(open, 0);
        }
      });
      source.addEventListener("reset", () => {
        source?.close();
        startOver();
        traceId.current = null;
        setStatus("connecting");
        setTimeout(open, 300);
      });
    };
    open();
    return () => {
      source?.close();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [role]);

  return { events, status, generation };
}

export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
