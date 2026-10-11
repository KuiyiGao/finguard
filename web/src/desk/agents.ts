import type { AgentRole, TraceEvent, TurnKind } from "@contracts";

export const AGENT_LABEL: Record<AgentRole, string> = {
  orchestrator: "Orchestrator",
  guardian: "Guardian",
  payments: "Payments",
  savings: "Savings",
  advisor: "Advisor",
  evaluator: "Evaluator",
};

export const TURN_LABEL: Record<TurnKind, string> = {
  chat: "Chat",
  review: "Review",
  action: "Action",
  document: "Document",
  research: "Research",
  inbound: "Forwarded message",
};

export const agentName = (a: string | undefined) => (a ? (AGENT_LABEL[a as AgentRole] ?? a.charAt(0).toUpperCase() + a.slice(1)) : "Other");

type Started = { kind?: TurnKind; source?: string; summary?: string };

export function newestTurn(events: TraceEvent[]): { turnId: string; kind?: TurnKind; summary?: string; events: TraceEvent[] } | null {
  const reviews = new Set(events.filter((e) => e.type === "turn_started" && (e.data as Started)?.kind === "review").map((e) => e.turnId));
  const last = [...events].reverse().find((e) => e.turnId && !reviews.has(e.turnId)) ?? [...events].reverse().find((e) => e.turnId);
  if (!last?.turnId) return null;
  const mine = events.filter((e) => e.turnId === last.turnId);
  const started = mine.find((e) => e.type === "turn_started")?.data as Started | undefined;
  return { turnId: last.turnId, kind: started?.kind, summary: started?.summary, events: mine };
}
