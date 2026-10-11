import type { Finding, TraceEvent, TurnKind } from "@contracts";
import { BRAND } from "./brand.ts";

type Started = { kind?: TurnKind; source?: string; summary?: string };

export interface Review {
  ts: string;
  summary?: string;
  specialists: number;
  checks: number;
  findings: number;
}

export function lastReview(events: TraceEvent[], findings: Finding[]): Review | null {
  const start = [...events].reverse().find((e) => e.type === "turn_started" && (e.data as Started)?.kind === "review");
  if (!start?.turnId) return null;
  const mine = events.filter((e) => e.turnId === start.turnId);
  const agents = new Set(mine.filter((e) => e.type === "agent_step").map((e) => String((e.data as { agent?: string })?.agent ?? "")).filter(Boolean));
  return {
    ts: start.ts,
    summary: (start.data as Started).summary,
    specialists: agents.size,
    checks: mine.filter((e) => e.type === "decision").length,
    findings: findings.filter((f) => f.turnId === start.turnId).length,
  };
}

const count = (n: number, word: string) => (n ? `${n} ${word}${n === 1 ? "" : "s"}` : "");

export function reviewSentence(review: Review): string {
  const counts = [count(review.specialists, "specialist"), count(review.checks, "check"), count(review.findings, "finding")].filter(Boolean);
  const at = new Date(review.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${BRAND} reviewed your money at ${at}${counts.length ? `: ${counts.join(", ")}` : ""}`;
}
