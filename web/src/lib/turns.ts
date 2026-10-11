import type { ApprovalRequest, AuthorizationReceipt, Decision, Nudge, SavingsReport, ScamAssessment, ToolCall, TraceEvent, TurnKind } from "@contracts";
import { describeCall, isRead, plainIds } from "./describe.ts";
import { amountOf } from "./format.ts";

export interface ToolStep {
  call: ToolCall;
  ts: string;
  decision?: Decision;
  approval?: Omit<ApprovalRequest, "code">;
  approvedVia?: string;
  executed?: { ok: boolean; data: unknown; error?: string };
  receipt?: AuthorizationReceipt;
}

export interface AgentStep {
  agent: string;
  step: "route" | "scope" | "evaluate" | "repair" | "fallback";
  detail: string;
  tools?: string[];
  ok?: boolean;
  problems?: string[];
}

export interface TurnStart {
  kind: TurnKind;
  source: string;
  summary: string;
}

export type TurnItem =
  | { kind: "start"; ts: string; info: TurnStart; seq: number }
  | { kind: "user"; ts: string; text: string; seq: number; tap?: string } // tap: the call id of a tapped card
  | { kind: "agent"; ts: string; step: AgentStep; seq: number }
  | { kind: "inbound"; ts: string; text: string; id: string; seq: number }
  | { kind: "reply"; ts: string; text: string; seq: number; citations?: ReplyCitation[] }
  | { kind: "tool"; ts: string; step: ToolStep; seq: number }
  | { kind: "scam"; ts: string; assessment: ScamAssessment; seq: number }
  | { kind: "savings"; ts: string; report: SavingsReport; seq: number }
  | { kind: "alert"; ts: string; to: string | null; text: string; seq: number; delivered?: boolean }
  | { kind: "nudge"; ts: string; nudge: Nudge; seq: number }
  | { kind: "reuse"; ts: string; result: ReuseResult; seq: number };

export interface ReplyCitation {
  docId: string;
  title: string;
  url?: string;
}

export function turnCitations(turn: Turn | undefined): ReplyCitation[] {
  const seen = new Set<string>();
  const out: ReplyCitation[] = [];
  for (const item of turn?.items ?? [])
    if (item.kind === "reply")
      for (const c of item.citations ?? [])
        if (!seen.has(c.docId)) {
          seen.add(c.docId);
          out.push(c);
        }
  return out;
}

export interface ReuseResult {
  blocked: boolean;
  reason: string;
  approvalId: string;
  original: string;
  forged: string;
  originalHash: string;
  forgedHash: string;
}

export interface Turn {
  id: string;
  ts: string;
  lastSeq: number;
  items: TurnItem[];
  start?: TurnStart;
}

export function buildTurns(events: TraceEvent[]): { turns: Turn[]; steps: Map<string, ToolStep> } {
  const turns = new Map<string, Turn>();
  const steps = new Map<string, ToolStep>();
  let nudgeBatch = "";
  let previous: TraceEvent | undefined;
  const turnOf = (e: TraceEvent) => {
    if (e.type === "nudge_sent" && previous?.type !== "nudge_sent") nudgeBatch = `nudges-${e.seq}`;
    const id = e.turnId ?? (e.type === "nudge_sent" ? nudgeBatch : `sys-${e.seq}`);
    let t = turns.get(id);
    if (!t) turns.set(id, (t = { id, ts: e.ts, lastSeq: e.seq, items: [] }));
    t.lastSeq = e.seq;
    return t;
  };
  for (const e of events) {
    const d = e.data as Record<string, unknown>;
    switch (e.type) {
      case "nudge_sent":
        turnOf(e).items.push({ kind: "nudge", ts: e.ts, nudge: e.data as Nudge, seq: e.seq });
        break;
      case "approval_reuse_blocked":
        turnOf(e).items.push({ kind: "reuse", ts: e.ts, result: e.data as ReuseResult, seq: e.seq });
        break;
      case "user_message":
        if (!String(d.messageId ?? "").startsWith("tap:")) turnOf(e).items.push({ kind: "user", ts: e.ts, text: String(d.text), seq: e.seq });
        else turnOf(e).items.push({ kind: "user", ts: e.ts, text: `Tapped: ${plainIds(String(d.text))}`, seq: e.seq, tap: String(d.messageId).slice(4) });
        break;
      case "inbound_shared":
        turnOf(e).items.push({ kind: "inbound", ts: e.ts, text: String(d.text), id: String(d.inboundId), seq: e.seq });
        break;
      case "agent_reply":
        turnOf(e).items.push({ kind: "reply", ts: e.ts, text: String(d.text), seq: e.seq, ...(Array.isArray(d.citations) ? { citations: d.citations as ReplyCitation[] } : {}) });
        break;
      case "agent_step":
        if (e.turnId) turnOf(e).items.push({ kind: "agent", ts: e.ts, step: e.data as AgentStep, seq: e.seq });
        break;
      case "turn_started":
        if (e.turnId) {
          const t = turnOf(e);
          t.start = e.data as TurnStart;
          t.items.push({ kind: "start", ts: e.ts, info: t.start, seq: e.seq });
        }
        break;
      case "tool_proposed": {
        const step: ToolStep = { call: e.data as ToolCall, ts: e.ts };
        steps.set(step.call.id, step);
        turnOf(e).items.push({ kind: "tool", ts: e.ts, step, seq: e.seq });
        break;
      }
      case "decision": {
        const step = steps.get(String(d.callId));
        if (step) step.decision = e.data as Decision;
        turnOf(e);
        break;
      }
      case "approval_requested": {
        const step = steps.get(String(d.callId));
        if (step) step.approval = e.data as Omit<ApprovalRequest, "code">;
        break;
      }
      case "approval_resolved": {
        const step = steps.get(String(d.callId));
        if (step?.approval) {
          step.approval = { ...step.approval, status: d.status as ApprovalRequest["status"] };
          step.approvedVia = String(d.via ?? "");
        }
        break;
      }
      case "tool_executed": {
        const step = steps.get(String(d.callId));
        if (step) step.executed = { ok: Boolean(d.ok), data: d.data, error: d.error as string | undefined };
        break;
      }
      case "receipt_issued": {
        const step = steps.get(String(d.callId));
        if (step) step.receipt = e.data as AuthorizationReceipt;
        break;
      }
      case "scam_assessed": {
        const a = e.data as ScamAssessment;
        if (a.subject.kind === "message") turnOf(e).items.push({ kind: "scam", ts: e.ts, assessment: a, seq: e.seq });
        break;
      }
      case "savings_report":
        turnOf(e).items.push({ kind: "savings", ts: e.ts, report: e.data as SavingsReport, seq: e.seq });
        break;
      case "alert_sent":
        turnOf(e).items.push({ kind: "alert", ts: e.ts, to: (d.to as string | null) ?? null, text: String(d.text), seq: e.seq, delivered: d.delivered === true });
        break;
      default:
        break;
    }
    previous = e;
  }
  for (const t of turns.values())
    for (const item of t.items) {
      const call = item.kind === "user" && item.tap ? steps.get(item.tap)?.call : undefined;
      if (item.kind === "user" && call) item.text = `Tapped: ${describeCall(call)}`;
    }
  return { turns: [...turns.values()].filter((t) => t.items.length > 0), steps };
}

export function turnById(events: TraceEvent[], turnId: string): Turn | undefined {
  return buildTurns(events.filter((e) => e.turnId === turnId || e.type === "decision" || e.type === "approval_requested" || e.type === "approval_resolved" || e.type === "tool_executed" || e.type === "receipt_issued")).turns.find((t) => t.id === turnId);
}

export function alertLine(alert: { to: string | null; delivered?: boolean }): string {
  const who = alert.to ?? "your trusted contact";
  return alert.delivered ? `${who} was alerted` : `Alert for ${who} recorded`;
}

export const isMoneyDecision = (d: Decision) => d.reasons.some((r) => r.rule === "consent");

const MONEY_TOOLS = new Set(["bank.move_own", "bank.pay_bill", "bank.transfer", "subscriptions.cancel"]);

export function isMoneyStep(step: ToolStep): boolean {
  const tool = step.call.tool;
  if (isRead(tool) || /^(research|household|documents)\./.test(tool)) return false;
  return MONEY_TOOLS.has(tool) || (step.decision ? isMoneyDecision(step.decision) : false);
}

export interface GateStats {
  reviewed: number;
  allowed: number;
  asked: number;
  denied: number;
  keptUsd: number;
  movedUsd: number;
  avgMs: number;
  scamHigh: number;
}

export function gateStats(steps: Iterable<ToolStep>, events: TraceEvent[]): GateStats {
  const s: GateStats = { reviewed: 0, allowed: 0, asked: 0, denied: 0, keptUsd: 0, movedUsd: 0, avgMs: 0, scamHigh: 0 };
  let ms = 0;
  for (const step of steps) {
    const d = step.decision;
    if (!d || !isMoneyDecision(d)) continue;
    s.reviewed += 1;
    ms += d.latencyMs;
    const amount = amountOf(step.call.args.amount) ?? 0;
    if (d.verdict === "allow") s.allowed += 1;
    if (d.verdict === "ask") s.asked += 1;
    if (d.verdict === "deny") {
      s.denied += 1;
      s.keptUsd += amount;
    }
    if (step.receipt) s.movedUsd += amount;
  }
  s.avgMs = s.reviewed ? Math.round((ms / s.reviewed) * 10) / 10 : 0;
  s.scamHigh = events.filter((e) => e.type === "scam_assessed" && (e.data as ScamAssessment).risk === "high").length;
  s.keptUsd = Math.round(s.keptUsd * 100) / 100;
  s.movedUsd = Math.round(s.movedUsd * 100) / 100;
  return s;
}
