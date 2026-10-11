import type { Capability, CapabilityGrant, Finding, FindingsView } from "@contracts";
import { CircleCheck, Clock, Eye, MessageSquare, SlidersHorizontal } from "lucide-react";
import type { CSSProperties } from "react";
import type { Health, State } from "../../lib/api.ts";
import { describeCall } from "../../lib/describe.ts";
import { amountOf, formatUsd } from "../../lib/format.ts";
import type { ToolStep } from "../../lib/turns.ts";
import { ActionStatus } from "../evidence/ActionStatus.tsx";

const CAPABILITIES: { capability: Capability; name: string; note?: string }[] = [
  { capability: "transfers.own", name: "Move between your accounts" },
  { capability: "bills.pay", name: "Pay bills on file" },
  { capability: "transfers.external", name: "Send to other people", note: "If you ask by text, approve it in the app" },
  { capability: "subscriptions.manage", name: "Cancel subscriptions" },
];

export interface Tier {
  id: "auto" | "ask" | "off";
  label: string;
  detail?: string;
}

export function tierOf(grant: CapabilityGrant | undefined): Tier {
  if (!grant) return { id: "off", label: "Off" };
  const limit = grant.maxAmount !== undefined ? formatUsd(grant.maxAmount) : undefined;
  if (grant.approval === "never") return limit ? { id: "auto", label: `Automatic up to ${limit}`, detail: "Above that it stops" } : { id: "auto", label: "Automatic" };
  if (grant.approval === "over_limit") return limit ? { id: "auto", label: `Automatic up to ${limit}`, detail: "Above that it asks you" } : { id: "ask", label: "Asks you every time" };
  return { id: "ask", label: "Asks you every time", ...(limit ? { detail: `Up to ${limit} each` } : {}) };
}

const BADGE = { auto: "badge-allow", ask: "badge-ask", off: "badge-neutral" } as const;

const levelOf = (tier: Tier) => (tier.id === "off" ? 0 : tier.id === "ask" ? 1 : tier.label === "Automatic" ? 3 : 2);

function Level({ tier }: { tier: Tier }) {
  const level = levelOf(tier);
  return (
    <span className={`ap-level ap-level-${tier.id}`} role="img" aria-label={`Autonomy ${level} of 3`} title={`Autonomy ${level} of 3: ${tier.label}`}>
      {[0, 1, 2].map((i) => (
        <span key={i} className={`ap-seg${i < level ? " on" : ""}`} style={{ "--s": i } as CSSProperties} />
      ))}
    </span>
  );
}
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function handledToday(steps: Map<string, ToolStep>, now: number): ToolStep[] {
  const today = new Date(now).toDateString();
  return [...steps.values()]
    .filter((s) => s.receipt?.authorizedBy.kind === "standing_instruction" && new Date(s.receipt.executedAt).toDateString() === today)
    .sort((a, b) => Date.parse(b.receipt!.executedAt) - Date.parse(a.receipt!.executedAt));
}

function acted(f: Finding, steps: Map<string, ToolStep>): boolean {
  const action = f.action;
  if (!action) return false;
  return [...steps.values()].some(
    (s) => s.receipt && s.call.tool === action.tool && Object.entries(action.args).every(([k, v]) => k === "memo" || String(s.call.args[k]) === String(v) || (k === "amount" && amountOf(s.call.args[k]) === amountOf(v))),
  );
}

function watching(view: FindingsView | null, steps: Map<string, ToolStep>): Finding[] {
  return (view?.findings ?? []).filter((f) => f.from === "nudge" && !acted(f, steps));
}

export interface AutopilotProps {
  state: State | null;
  steps: Map<string, ToolStep>;
  now: number;
  health: Health | null;
  findings: FindingsView | null;
  compact?: boolean;
  onOpenLimits?: () => void;
}

export function Autopilot({ state, steps, now, health, findings, compact = false, onOpenLimits }: AutopilotProps) {
  const policy = state?.policy;
  if (!policy)
    return (
      <div className={`card ap${compact ? " ap-compact" : ""}`} aria-busy="true">
        <p className="faint">Loading your limits</p>
      </div>
    );
  const handled = handledToday(steps, now);
  const shownHandled = handled.slice(0, compact ? 3 : 5);
  const eyes = watching(findings, steps);
  const shownEyes = eyes.slice(0, compact ? 3 : 4);
  const imessage = health?.modes?.spectrum === "imessage";
  const schedule = health?.modes?.autopilot && health.modes.autopilot !== "off" ? health.modes.autopilot : undefined; // "every 30 min"
  const simulated = Boolean(findings?.findings.some((f) => f.simulated));

  return (
    <div className={`card ap${compact ? " ap-compact" : ""}${policy.paused ? " ap-paused" : ""}`}>
      {policy.paused ? (
        <ActionStatus state={{ kind: "stopped", text: "Paused: nothing moves until you resume" }} />
      ) : state?.needsConsent ? (
        <ActionStatus state={{ kind: "waiting", text: "Waiting for your agreement: nothing moves until you agree" }} />
      ) : null}

      <div className="ap-grid">
        <div className="ap-col">
          <ul className="plain ap-tiers" aria-label="What FinGuard may do on its own">
            {CAPABILITIES.map(({ capability, name, note }, i) => {
              const tier = tierOf(policy.grants.find((g) => g.capability === capability));
              return (
                <li key={capability} className="ap-tier fg-enter" style={{ "--i": i + 1 } as CSSProperties}>
                  <span className="ap-name">{name}</span>
                  <Level tier={tier} />
                  <span className="ap-detail">
                    <span className={`badge ${BADGE[tier.id]} ap-badge`}>{tier.label}</span>
                    {(tier.detail || (note && tier.id !== "off")) && <span>{[tier.detail, tier.id !== "off" ? note : undefined].filter(Boolean).join(". ")}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="ap-limit num">
            <span>Daily limit</span> <strong>{formatUsd(policy.dailyLimit)}</strong>
            {state && <span className="faint">, {formatUsd(state.spentToday ?? 0)} used today</span>}
          </p>
        </div>

        <div className="ap-col">
          <section className="ap-block" aria-label="Handled automatically today">
            <div className="ap-head">
              <h3 className="ev-h">
                Handled automatically today
                {handled.length > 0 && <span className="num"> ({handled.length})</span>}
              </h3>
              {simulated && handled.length > 0 && <span className="sim-tag">Simulated</span>}
            </div>
            {handled.length === 0 ? (
              <p className="faint">Nothing yet today</p>
            ) : (
              <ul className="plain ap-list">
                {shownHandled.map((s) => (
                  <li key={s.call.id}>
                    <CircleCheck aria-hidden className="ap-ok" />
                    <span className="num ap-what">{describeCall(s.call)}</span>
                    <span className="faint num">{time(s.receipt!.executedAt)}</span>
                  </li>
                ))}
                {handled.length > shownHandled.length && <li className="faint">+{handled.length - shownHandled.length} more in Activity</li>}
              </ul>
            )}
          </section>

          {shownEyes.length > 0 && (
            <section className="ap-block" aria-label="Watching">
              <h3 className="ev-h">Watching</h3>
              <ul className="plain ap-list">
                {shownEyes.map((f) => (
                  <li key={f.id}>
                    <Eye aria-hidden className="ap-eye" />
                    <span className="num ap-what">{f.title}</span>
                  </li>
                ))}
                {eyes.length > shownEyes.length && <li className="faint">+{eyes.length - shownEyes.length} more</li>}
              </ul>
            </section>
          )}

          <p className="ap-channel">
            <MessageSquare aria-hidden /> {imessage ? "Approvals and alerts by iMessage, and here" : "Approvals here in the app"}
          </p>
          {schedule && (
            <p className="ap-channel">
              <Clock aria-hidden /> Re-checks your money on its own {schedule}
            </p>
          )}
        </div>
      </div>

      {onOpenLimits && (
        <button type="button" className="btn ap-link" onClick={onOpenLimits}>
          <SlidersHorizontal size={15} aria-hidden /> Change limits in Settings
        </button>
      )}
    </div>
  );
}
