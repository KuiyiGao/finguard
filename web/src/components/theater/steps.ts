import type { ToolCall, Verdict } from "@contracts";
import { BRAND } from "../../lib/brand.ts";
import { describeCall, isRead, plainIds } from "../../lib/describe.ts";
import { formatUsd, VERDICT_LABEL } from "../../lib/format.ts";
import { replyCitations, signalText } from "../../lib/normalize.ts";
import { firstReason } from "../../lib/status.ts";
import { alertLine, type AgentStep, type ToolStep, type Turn, type TurnItem, type TurnStart } from "../../lib/turns.ts";
import { skillForTool, SPRITE_LABEL, type SkillName, type SpriteName } from "../pixel/Sprite.tsx";

export type Lane = "customer" | "orchestrator" | "specialist" | "skillgate" | "service" | "evaluator" | "reply";
export const LANES: Lane[] = ["customer", "orchestrator", "specialist", "skillgate", "service", "evaluator", "reply"];

export type TheaterAction =
  | "start"
  | "ask"
  | "forward"
  | "route"
  | "scope"
  | "reject"
  | "fallback"
  | "inspect"
  | "call"
  | "check"
  | "approve"
  | "execute"
  | "alert"
  | "report"
  | "nudge"
  | "reuse"
  | "evaluate"
  | "repair"
  | "reply";

export interface TheaterStep {
  key: string;
  seq: number;
  lane: Lane;
  from?: Lane;
  to?: Lane;
  actor: SpriteName | "service" | "reply";
  specialist: SpriteName;
  service?: SkillName;
  action: TheaterAction;
  title: string;
  detail: string;
  verdict?: Verdict;
  ok?: boolean;
  tools?: string[];
  skill?: SkillName;
  host?: string;
  manifest?: string;
  parcel?: "inbound" | "tooltext"; // untrusted content involved
  receiptId?: string;
  problems?: string[];
  quick?: boolean;
}

const KIND_LABEL: Record<string, string> = { chat: "Chat", review: "Review", action: "Action", document: "Document", research: "Research", inbound: "Inbound" };
const SOURCE_LABEL: Record<string, string> = { app: "app", imessage: "iMessage", desk: "desk", console: "console", system: "system" };

export function turnLabel(start: TurnStart | undefined): string | undefined {
  if (!start) return undefined;
  return `${KIND_LABEL[start.kind] ?? start.kind}, ${SOURCE_LABEL[start.source] ?? start.source}`;
}

const SPECIALISTS: SpriteName[] = ["guardian", "payments", "savings", "advisor", "research"];
const spriteOf = (agent: string): SpriteName => (SPECIALISTS.includes(agent as SpriteName) ? (agent as SpriteName) : "advisor");

export function hostOf(tool: string): string | undefined {
  if (tool.startsWith("research.sec_")) return "data.sec.gov";
  if (tool === "research.treasury_rates") return "api.fiscaldata.treasury.gov";
  if (tool === "research.fdic_bank") return "api.fdic.gov";
  if (tool === "research.cfpb_complaints") return "www.consumerfinance.gov";
  return undefined;
}

const callTitle = (step: ToolStep) => describeCall(step.call);

export const clip = (text: string, n = 160) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

const REQUESTED_BY: Record<ToolCall["requestedBy"], string> = { app: "you tapped it", model: "FinGuard's agent", replay: "replay" };

function parseRoute(detail: string): { id: string; source?: string; why: string } {
  const m = /^(\w+)\s*(?:\(([^)]+)\))?\s*:?\s*(.*)$/.exec(detail.trim());
  return m ? { id: m[1]!, source: m[2], why: m[3] ?? "" } : { id: detail, why: "" };
}

function toolName(t: string): string {
  return t.replace(/\(.*\)$/, "").replace(/^(bank|subscriptions|research|household|documents)\./, "").replace(/_/g, " ");
}

export function theaterSteps(turn: Turn): TheaterStep[] {
  const items = [...turn.items].sort((a, b) => a.seq - b.seq);
  const firstRoute = items.find((i): i is Extract<TurnItem, { kind: "agent" }> => i.kind === "agent" && i.step.step === "route");
  let specialist: SpriteName = firstRoute ? spriteOf(parseRoute(firstRoute.step.detail).id) : "advisor";
  let service: SkillName | undefined;
  const out: TheaterStep[] = [];
  const push = (s: Omit<TheaterStep, "specialist" | "service"> & { service?: SkillName }) => {
    if (s.service) service = s.service;
    out.push({ ...s, specialist, service });
  };

  for (const item of items) {
    const key = `${item.kind}-${item.seq}`;
    switch (item.kind) {
      case "start": {
        const fromCustomer = ["app", "imessage", "desk"].includes(item.info.source);
        push({
          key,
          seq: item.seq,
          lane: fromCustomer ? "customer" : "orchestrator",
          actor: fromCustomer ? "customer" : "orchestrator",
          action: "start",
          title: turnLabel(item.info)!,
          detail: item.info.summary ? clip(plainIds(item.info.summary)) : "A new turn starts.",
        });
        break;
      }
      case "user":
        push({ key, seq: item.seq, lane: "customer", from: "customer", to: "orchestrator", actor: "customer", action: "ask", title: "Customer asks", detail: clip(item.text) });
        break;
      case "inbound": {
        const guardianReads = specialist === "guardian";
        push({
          key,
          seq: item.seq,
          lane: guardianReads ? "specialist" : "customer",
          from: "customer",
          to: guardianReads ? "specialist" : "customer",
          actor: guardianReads ? "guardian" : "customer",
          action: "forward",
          parcel: "inbound",
          title: "Forwarded message, untrusted",
          detail: guardianReads
            ? `Handed to the guardian as data, never as instructions: “${clip(item.text, 110)}”`
            : `Held outside the agent: the orchestrator and this specialist never read it. “${clip(item.text, 90)}”`,
        });
        break;
      }
      case "agent":
        agentBeat(item.step, key, item.seq);
        break;
      case "tool":
        toolBeats(item.step, key, item.seq);
        break;
      case "scam": {
        const a = item.assessment;
        const flags = a.redFlags.map((f) => signalText(f.signal).label);
        push({
          key,
          seq: item.seq,
          lane: "specialist",
          actor: specialist,
          action: "inspect",
          parcel: "inbound",
          skill: "scan",
          ok: a.risk === "low",
          verdict: a.risk === "high" ? "deny" : a.risk === "medium" ? "ask" : "allow",
          title: `ScamShield: ${a.risk} risk (${a.score}/100)`,
          detail: flags.length ? `Red flags: ${flags.slice(0, 5).join(", ")}${flags.length > 5 ? ` and ${flags.length - 5} more` : ""}.` : "No red flags found.",
        });
        break;
      }
      case "savings":
        push({
          key,
          seq: item.seq,
          lane: "specialist",
          from: "specialist",
          to: "service",
          actor: specialist,
          action: "report",
          skill: "db",
          service: "db",
          title: "Savings report, computed in code",
          detail: `${formatUsd(item.report.totalMonthly)}/mo across ${item.report.recommendations.length} findings`,
        });
        break;
      case "alert":
        push({
          key,
          seq: item.seq,
          lane: "service",
          from: "specialist",
          to: "service",
          actor: "service",
          action: "alert",
          skill: "imessage",
          service: "imessage",
          ok: true,
          title: alertLine(item),
          detail: clip(item.text),
        });
        break;
      case "nudge":
        push({ key, seq: item.seq, lane: "orchestrator", from: "orchestrator", to: "customer", actor: "orchestrator", action: "nudge", skill: "db", title: `${BRAND} noticed`, detail: clip(`${item.nudge.title}. ${item.nudge.body}`) });
        break;
      case "reuse":
        push({
          key,
          seq: item.seq,
          lane: "skillgate",
          from: "customer",
          to: "skillgate",
          actor: "skillgate",
          action: "reuse",
          verdict: item.result.blocked ? "deny" : "allow",
          ok: item.result.blocked,
          title: item.result.blocked ? "Reused approval code refused" : "Reused approval code accepted",
          detail: `Approved for ${item.result.original}, tried on ${item.result.forged}. ${item.result.reason}`,
        });
        break;
      case "reply":
        push({ key, seq: item.seq, lane: "reply", from: "evaluator", to: "reply", actor: "reply", action: "reply", title: `${BRAND} replies`, detail: clip(replyCitations(item.text).text, 220) });
        break;
    }
  }
  return out;

  function agentBeat(s: AgentStep, key: string, seq: number) {
    if (s.step === "route") {
      const r = parseRoute(s.detail);
      specialist = spriteOf(r.id);
      const call = items.find((i): i is Extract<TurnItem, { kind: "tool" }> => i.kind === "tool")?.step.call;
      const tapped = r.source === "by tool";
      const how = tapped ? REQUESTED_BY[call?.requestedBy ?? "app"] : r.source === "rules" ? "by rules" : r.source === "by kind" ? "by the kind of document" : r.source ? "by model" : "";
      const why = tapped && call ? describeCall(call) : r.why;
      push({
        key,
        seq,
        lane: "orchestrator",
        from: "orchestrator",
        to: "specialist",
        actor: "orchestrator",
        action: "route",
        ok: s.ok,
        title: `Routes to ${SPRITE_LABEL[specialist]}`,
        detail: `${why ? why.charAt(0).toUpperCase() + why.slice(1) : "Picked one specialist"}${how ? ` (${how})` : ""}. Forwarded text is never part of this choice.`,
      });
      return;
    }
    if (s.step === "scope") {
      const who = spriteOf(s.agent);
      if (s.ok === false) {
        const tool = s.tools?.[0] ?? "a tool";
        push({
          key,
          seq,
          lane: "specialist",
          actor: who,
          action: "reject",
          ok: false,
          verdict: "deny",
          tools: s.tools,
          skill: skillForTool(tool),
          title: `Scope gate shut: ${toolName(tool)}`,
          detail: s.detail.charAt(0).toUpperCase() + s.detail.slice(1),
        });
        return;
      }
      push({
        key,
        seq,
        lane: "specialist",
        actor: who,
        action: "scope",
        ok: true,
        tools: s.tools,
        title: `${SPRITE_LABEL[who]} gets ${s.tools?.length ?? 0} tools, nothing else`,
        detail: s.detail.charAt(0).toUpperCase() + s.detail.slice(1),
      });
      return;
    }
    if (s.step === "evaluate") {
      push({
        key,
        seq,
        lane: "evaluator",
        from: "specialist",
        to: "evaluator",
        actor: "evaluator",
        action: "evaluate",
        ok: s.ok !== false,
        problems: s.problems,
        title: s.ok === false ? "Evaluator rejects the draft" : "Evaluator passes the draft",
        detail: s.ok === false ? (s.problems?.length ? s.problems.join("; ") : s.detail) : "Grounded in this turn's records, honest, cited and in scope.",
      });
      return;
    }
    if (s.step === "repair") {
      push({ key, seq, lane: "evaluator", actor: "evaluator", action: "repair", ok: true, title: "Evaluator repairs the reply", detail: s.detail.charAt(0).toUpperCase() + s.detail.slice(1) });
      return;
    }
    const onOrchestrator = s.agent === "orchestrator";
    push({
      key,
      seq,
      lane: onOrchestrator ? "orchestrator" : "specialist",
      actor: onOrchestrator ? "orchestrator" : spriteOf(s.agent),
      action: "fallback",
      ok: false,
      title: "Falls back to the rules brain",
      detail: s.detail.charAt(0).toUpperCase() + s.detail.slice(1),
    });
  }

  function toolBeats(st: ToolStep, key: string, seq: number) {
    const tool = st.call.tool;
    const read = isRead(tool) || tool.startsWith("research.");
    const skill = skillForTool(tool);
    const host = hostOf(tool);
    const pack = st.call.skill && st.call.skill !== "core" ? st.call.skill : undefined;
    const caller: SpriteName = pack === "research" || tool.startsWith("research.") ? "research" : specialist;
    const manifest = pack ? `${pack} skill pack${pack === "research" ? ": research.read only, public data, no account data" : ""}` : undefined;
    const saved = specialist;
    specialist = caller;
    push({
      key: `${key}-call`,
      seq,
      lane: "specialist",
      from: "specialist",
      to: "skillgate",
      actor: caller,
      action: "call",
      skill,
      host,
      manifest,
      quick: read,
      title: read ? `${SPRITE_LABEL[caller]} asks to read` : `${SPRITE_LABEL[caller]} proposes an action`,
      detail: callTitle(st),
    });
    const d = st.decision;
    const untrusted = d?.provenance.find((p) => p.status === "untrusted_only")?.origins.find((o) => !o.trusted);
    const parcel = untrusted ? (untrusted.kind === "inbound_message" ? "inbound" : "tooltext") : undefined;
    push({
      key: `${key}-gate`,
      seq,
      lane: "skillgate",
      actor: "skillgate",
      action: "check",
      skill,
      verdict: d?.verdict,
      ok: d ? d.verdict !== "deny" : undefined,
      parcel,
      host,
      manifest,
      quick: read && d?.verdict === "allow",
      title: d ? `SkillGate: ${VERDICT_LABEL[d.verdict]}` : "SkillGate is reviewing",
      detail: d
        ? d.verdict === "allow"
          ? `All ${d.reasons.length} checks passed${d.latencyMs ? ` in ${d.latencyMs} ms` : ""}.`
          : `${firstReason(d).replace(/^\w/, (c) => c.toUpperCase())}.`
        : "Checking consent, limits and where every money value came from.",
    });
    const a = st.approval;
    if (a) {
      const done = a.status === "approved";
      push({
        key: `${key}-approve`,
        seq,
        lane: "customer",
        from: "skillgate",
        to: "customer",
        actor: "customer",
        action: "approve",
        verdict: a.status === "pending" ? "ask" : done ? "allow" : "deny",
        ok: a.status === "pending" ? undefined : done,
        title: a.status === "pending" ? "Waiting for the customer's code" : done ? "Customer approved this exact action" : a.status === "expired" ? "No answer: counted as declined" : "Customer declined",
        detail: a.status === "pending" ? "The 4-digit code is bound to this action's hash; operators never see it." : done ? `Approved${st.approvedVia ? ` via ${st.approvedVia}` : ""}; the code cannot cover any other action.` : "Nothing runs without the customer's yes.",
      });
    }
    if (st.executed) {
      const svc = tool.startsWith("research.") ? skill : "bank";
      push({
        key: `${key}-run`,
        seq,
        lane: "service",
        from: a ? "customer" : "skillgate",
        to: "service",
        actor: "service",
        action: "execute",
        skill: svc,
        service: svc,
        host,
        ok: st.executed.ok,
        receiptId: st.receipt?.id,
        quick: read,
        title: st.executed.ok ? (st.receipt ? "Bank executes it, receipt issued" : host ? `Data returned from ${host}` : "Bank returns the data") : "The service returned an error",
        detail: st.executed.ok ? (st.receipt ? `Receipt saved: ${plainIds(st.receipt.action)}` : host ? `Public data only, from ${host}.` : "Read only; nothing changed.") : clip(st.executed.error ?? "Error"),
      });
    }
    specialist = saved;
  }
}

export function theaterSummary(steps: TheaterStep[]): string {
  const route = steps.find((s) => s.action === "route");
  const gates = steps.filter((s) => s.action === "check" && s.verdict);
  const denied = gates.filter((s) => s.verdict === "deny").length;
  const asked = gates.filter((s) => s.verdict === "ask").length;
  const scam = steps.find((s) => s.action === "inspect");
  const evals = steps.filter((s) => s.action === "evaluate");
  const parts: string[] = [];
  if (route) parts.push(route.title.replace("Routes to ", ""));
  if (scam) parts.push(scam.title.replace(/ \(\d+\/100\)/, ""));
  if (steps.some((s) => s.action === "reject")) parts.push("scope gate shut");
  if (gates.length) parts.push(denied ? `SkillGate blocked ${denied}` : asked ? `SkillGate asked ${asked}` : `SkillGate allowed ${gates.length}`);
  if (steps.some((s) => s.receiptId)) parts.push("receipt");
  if (evals.length) parts.push(evals.every((s) => s.ok) ? "evaluator passed" : "evaluator repaired");
  return parts.join(", ");
}
