import type { OriginKind, RuleId, TraceEventType, Verdict } from "@contracts";
import { BRAND } from "./brand.ts";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatUsd(amount: number): string {
  return usd.format(amount);
}

export function amountOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const m = String(value ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

export function shortHash(hash: string | null | undefined, n = 8): string {
  return hash ? hash.slice(0, n) : "-";
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export const VERDICT_LABEL: Record<Verdict, string> = { allow: "Allowed", ask: "Needs approval", deny: "Blocked" };

export const ORIGIN_LABEL: Record<OriginKind, string> = {
  user: "You said",
  system: "Bank record",
  inbound_message: "Forwarded message",
  tool_text: "Memo or invoice text",
  skill_text: "Extension",
  kb: "Reference",
};

export const RULE_LABEL: Record<RuleId, string> = {
  consent: "Consent",
  paused: "Paused",
  capability: "Permission",
  limit: "Per-action limit",
  provenance: "Where values came from",
  scam: "Scam check",
  cooling_off: "New payee",
  daily_limit: "Daily limit",
  context: "Extensions",
  hash: "Extension integrity",
  velocity: "Velocity",
  cash_flow: "Upcoming bills",
  llm: "Second review",
};

export const EVENT_LABEL: Record<TraceEventType, string> = {
  consent_recorded: "Consent recorded",
  policy_changed: "Policy changed",
  user_message: "Message",
  inbound_shared: "Forwarded message",
  skill_loaded: "Extension loaded",
  skill_installed: "Extension installed",
  skill_disabled: "Extension disabled",
  tool_proposed: "Tool proposed",
  scam_assessed: "Scam check",
  decision: "SkillGate decision",
  approval_requested: "Approval requested",
  approval_resolved: "Approval answered",
  tool_executed: "Executed",
  receipt_issued: "Receipt",
  savings_report: "Savings report",
  agent_reply: BRAND,
  agent_step: "Agent step",
  turn_started: "Turn started",
  alert_sent: "Trusted contact alert",
  scenario_started: "Demo scene",
  nudge_sent: `${BRAND} noticed`,
  approval_reuse_blocked: "Reused code refused",
  eval_result: "Eval",
};

export function accountName(id: string): string {
  const name = id.replace(/^acct-/, "").replace(/[-_]/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}
