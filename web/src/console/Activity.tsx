import type { Nudge, SavingsReport } from "@contracts";
import { nudgeFinding, replyCitations, scamFinding } from "../lib/normalize.ts";
import { Bell, Bot, KeyRound, MessageSquareWarning, PiggyBank, Sparkles, User } from "lucide-react";
import { useState } from "react";
import { Citations, EvidenceCard } from "../components/evidence/EvidenceCard.tsx";
import { StepRow } from "../components/evidence/StepRow.tsx";
import { DecisionMeta, VerdictBadge } from "../components/gate.tsx";
import { Pipeline } from "../components/Pipeline.tsx";
import { ProvenanceGraph } from "../components/ProvenanceGraph.tsx";
import { AgentTheater, useIsLatestTurn, useTheaterAutoPlay } from "../components/theater/index.ts";
import type { Api } from "../lib/api.ts";
import { BRAND } from "../lib/brand.ts";
import { describeCall, isRead } from "../lib/describe.ts";
import { clockTime, formatUsd, shortHash } from "../lib/format.ts";
import { alertLine, type ReuseResult, type ToolStep, type Turn, type TurnItem } from "../lib/turns.ts";

function ReplayButton({ api, approvalId }: { api: Api; approvalId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.replay(approvalId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={run} disabled={busy} title="Tries this approved code on a $950 transfer to account 9917">
        <KeyRound size={13} aria-hidden /> {busy ? "Trying" : "Try to reuse this code"}
      </button>
      {error && <span className="error-text">{error}</span>}
    </>
  );
}

function ReuseCard({ result }: { result: ReuseResult }) {
  return (
    <div className={`con-reuse ${result.blocked ? "" : "con-reuse-bad"}`}>
      <span className="con-item-label">
        <KeyRound size={14} aria-hidden /> Approved code reused on another payment
      </span>
      <p>
        Code approved for <strong className="num">{result.original}</strong>, tried on <strong className="num">{result.forged}</strong>.
      </p>
      <p className="con-reuse-verdict">{result.blocked ? `Refused: ${result.reason}` : result.reason}</p>
      <p className="faint">
        bound to <span className="hash">{shortHash(result.originalHash)}</span> ≠ requested <span className="hash">{shortHash(result.forgedHash)}</span>
      </p>
    </div>
  );
}

function NudgeItem({ nudge }: { nudge: Nudge }) {
  return (
    <div className="con-nudge-wrap">
      <span className="con-item-label con-brand-label">
        <Sparkles size={14} aria-hidden /> {BRAND} noticed
      </span>
      <EvidenceCard finding={nudgeFinding(nudge, { simulated: true })} compact />
    </div>
  );
}

function StepCard({ step, api }: { step: ToolStep; api: Api }) {
  const d = step.decision;
  if (isRead(step.call.tool))
    return (
      <div className="con-read">
        {d ? <VerdictBadge verdict={d.verdict} /> : <span className="badge badge-neutral">Reviewing</span>}
        <span>{describeCall(step.call)}</span>
        {step.executed && <span className="faint">{step.executed.ok ? "done" : step.executed.error}</span>}
      </div>
    );
  return (
    <div className="con-stepgroup">
      <StepRow
        step={step}
        audience="operator"
        open={d?.verdict === "deny"}
        meta={d ? `${d.latencyMs} ms` : undefined}
        detail={
          <>
            {d && <Pipeline step={step} animate />}
            {d && <ProvenanceGraph provenance={d.provenance} />}
            {d?.provenance
              .filter((p) => p.status === "untrusted_only")
              .map((p) => {
                const o = p.origins.find((x) => !x.trusted);
                return o?.excerpt ? (
                  <p key={p.field} className="con-excerpt">
                    “{o.excerpt}” <span className="faint">({o.source})</span>
                  </p>
                ) : null;
              })}
            {d?.scam && d.scam.redFlags.length > 0 && <EvidenceCard finding={scamFinding(d.scam, { area: "protection", createdAt: step.ts, simulated: false })} compact />}
            {d && <DecisionMeta decision={d} />}
          </>
        }
      />
      {step.executed && !step.executed.ok && <p className="error-text">Bank error: {step.executed.error}</p>}
      {step.receipt && step.approval?.status === "approved" && (
        <div className="con-row">
          <ReplayButton api={api} approvalId={step.approval.id} />
        </div>
      )}
    </div>
  );
}

function SavingsItem({ report }: { report: SavingsReport }) {
  return (
    <div className="con-savings">
      <PiggyBank size={16} aria-hidden />
      <span>
        Savings report: <strong className="num">{formatUsd(report.totalMonthly)}/mo</strong> across {report.recommendations.length} findings
      </span>
    </div>
  );
}

function Item({ item, api, turn }: { item: TurnItem; api: Api; turn: Turn }) {
  switch (item.kind) {
    case "agent":
    case "start":
      return null;
    case "nudge":
      return <NudgeItem nudge={item.nudge} />;
    case "reuse":
      return <ReuseCard result={item.result} />;
    case "user":
      return (
        <div className="con-msg con-msg-user">
          <User size={15} aria-hidden />
          <span>{item.text}</span>
        </div>
      );
    case "inbound":
      return (
        <div className="con-inbound">
          <span className="con-item-label">
            <MessageSquareWarning size={14} aria-hidden /> Forwarded message, untrusted
          </span>
          <p>{item.text}</p>
        </div>
      );
    case "reply":
      return (
        <>
          <div className="con-msg con-msg-agent">
            <Bot size={15} aria-hidden />
            <span>{replyCitations(item.text).text}</span>
          </div>
          {item.citations && item.citations.length > 0 && (
            <div className="con-cites">
              <Citations items={item.citations} inline />
            </div>
          )}
        </>
      );
    case "tool":
      return <StepCard step={item.step} api={api} />;
    case "scam":
      return (
        <EvidenceCard
          finding={scamFinding(item.assessment, { text: turn.items.find((i) => i.kind === "inbound")?.text, area: "protection", createdAt: item.ts, simulated: false })}
        />
      );
    case "savings":
      return <SavingsItem report={item.report} />;
    case "alert":
      return (
        <div className="con-alert">
          <Bell size={15} aria-hidden /> {alertLine(item)}: <span className="muted">{item.text}</span>
        </div>
      );
  }
}

export function TurnCard({ turn, api }: { turn: Turn; api: Api }) {
  const latest = useIsLatestTurn(turn);
  const [autoPlay] = useTheaterAutoPlay();
  return (
    <article className="card con-turn enter">
      <header className="con-turn-head">
        <span className="faint num">{clockTime(turn.ts)}</span>
        <span className="faint mono">{turn.id.startsWith("sys-") ? "" : turn.id.startsWith("nudges-") ? `${BRAND} reached out first` : turn.id}</span>
      </header>
      <div className="con-theater">
        <AgentTheater key={latest ? "full" : "strip"} turn={turn} mode={latest ? "full" : "strip"} autoPlay={latest && autoPlay} />
      </div>
      <div className="con-turn-body">
        {turn.items.map((item) => (
          <Item key={item.seq} item={item} api={api} turn={turn} />
        ))}
      </div>
    </article>
  );
}
