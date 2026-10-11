import type { TraceEvent } from "@contracts";
import { Clapperboard, MessageCircle, Send } from "lucide-react";
import { Component, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Citations } from "../components/evidence/EvidenceCard.tsx";
import { StepRow } from "../components/evidence/StepRow.tsx";
import { AgentTheater, theaterSteps, turnById, useTheaterAutoPlay } from "../components/theater/index.ts";
import { BRAND } from "../lib/brand.ts";
import { describeCall, plainIds } from "../lib/describe.ts";
import { EVENT_LABEL, timeAgo } from "../lib/format.ts";
import { replyCitations } from "../lib/normalize.ts";
import { isMoneyStep } from "../lib/turns.ts";
import { agentName, newestTurn, TURN_LABEL } from "./agents.ts";
import type { DeskCtx } from "./ctx.ts";

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const STEP_TYPES = new Set(["turn_started", "agent_step", "skill_loaded", "tool_proposed", "decision", "scam_assessed", "tool_executed", "receipt_issued", "approval_requested", "agent_reply", "user_message", "inbound_shared"]);

function detail(e: TraceEvent): string {
  const d = (e.data ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case "tool_proposed":
      return describeCall(e.data as Parameters<typeof describeCall>[0]);
    case "decision":
      return String(d.verdict ?? "");
    case "scam_assessed":
      return `${String(d.risk ?? "")} risk`;
    case "skill_loaded":
      return String(d.skill ?? d.name ?? "");
    case "agent_step":
      return `${agentName(typeof d.agent === "string" ? d.agent : undefined)}: ${String(d.detail ?? d.summary ?? d.text ?? d.step ?? "")}`;
    case "turn_started":
      return plainIds(String(d.summary ?? d.source ?? ""));
    case "user_message":
    case "inbound_shared":
      return String(d.text ?? "").slice(0, 60);
    case "agent_reply":
      return replyCitations(String(d.text ?? "")).text.slice(0, 60);
    default:
      return "";
  }
}

function StepFeed({ ctx }: { ctx: DeskCtx }) {
  const turn = newestTurn(ctx.events);
  const recent = turn ? turn.events.filter((e) => STEP_TYPES.has(e.type)).slice(-8).reverse() : [];
  if (!turn || recent.length === 0) return <p className="faint dk-theater-empty">The agent is idle. Steps appear here as it works.</p>;
  return (
    <>
      <p className="dk-feed-turn">
        <span className="dk-pill tone-info">{turn.kind ? TURN_LABEL[turn.kind] : "Turn"}</span>
        <span className="faint dk-feed-detail">{turn.summary ? plainIds(turn.summary) : `${turn.events.length} events`}</span>
      </p>
      <ol className="dk-feed">
        {recent.map((e) => (
          <li key={e.seq} className="enter">
            <span className="dk-feed-label">{EVENT_LABEL[e.type] ?? e.type}</span>
            <span className="dk-feed-detail num" title={detail(e)}>
              {detail(e)}
            </span>
            <span className="faint num dk-feed-time">{timeAgo(e.ts, ctx.now)}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

function Theater({ ctx }: { ctx: DeskCtx }) {
  const newestId = newestTurn(ctx.events)?.turnId;
  const turn = useMemo(() => (newestId ? turnById(ctx.events, newestId) : undefined), [ctx.events, newestId]);
  const playable = useMemo(() => (turn ? theaterSteps(turn).length > 0 : false), [turn]);
  const [autoPlay] = useTheaterAutoPlay();
  const fallback = <StepFeed ctx={ctx} />;
  return (
    <section className="dk-theater card" aria-labelledby="theater-h">
      <header className="dk-side-head">
        <Clapperboard aria-hidden />
        <h2 id="theater-h">Agent theater</h2>
        <span className="faint dk-push">{turn?.start ? `${TURN_LABEL[turn.start.kind] ?? turn.start.kind}, ${timeAgo(turn.ts, ctx.now)}` : turn ? timeAgo(turn.ts, ctx.now) : "Idle"}</span>
      </header>
      <div className="dk-theater-body">
        {turn && playable ? (
          <Boundary key={turn.id} fallback={fallback}>
            <AgentTheater key={turn.id} turn={turn} autoPlay={autoPlay} className="dk-th" />
          </Boundary>
        ) : (
          fallback
        )}
      </div>
    </section>
  );
}

const SUGGESTIONS = ["What can I save this month?", "What bills are due soon?", "Explain my subscriptions"];

function Chat({ ctx, draft }: { ctx: DeskCtx; draft: { text: string; n: number } | null }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(0);
  const end = useRef<HTMLDivElement>(null);
  const items = ctx.turns
    .filter((t) => t.start?.kind !== "review")
    .flatMap((t) => t.items)
    .filter((i) => i.kind === "user" || i.kind === "reply" || i.kind === "inbound" || i.kind === "tool");
  const shown = items.filter((i) => i.kind !== "tool" || isMoneyStep(i.step)).slice(-14);

  const send = async (message: string) => {
    const m = message.trim();
    if (!m) return;
    setBusy(true);
    setError(null);
    try {
      await ctx.api.chat(m);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!draft || handled.current === draft.n) return;
    handled.current = draft.n;
    void send(draft.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
  useEffect(() => {
    const log = end.current?.parentElement;
    if (log) log.scrollTop = log.scrollHeight;
  }, [shown.length, busy]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!busy) void send(text);
  };

  return (
    <section className="dk-chat card" aria-labelledby="chat-h">
      <header className="dk-side-head">
        <MessageCircle aria-hidden />
        <h2 id="chat-h">Ask {BRAND}</h2>
        {ctx.state && ctx.state.approvals.length > 0 && (
          <button type="button" className="dk-pill tone-warn dk-push dk-pill-btn" onClick={() => ctx.openApproval(ctx.state!.approvals[0]!.id)}>
            Approval waiting
          </button>
        )}
      </header>
      <div className="dk-chat-log" aria-live="polite">
        {shown.length === 0 && <p className="faint dk-chat-empty">Ask about any card, or have {BRAND} move money within your limits. Payments still need your code.</p>}
        {shown.map((i) => {
          if (i.kind === "user")
            return (
              <p key={i.seq} className="dk-bubble dk-bubble-me num">
                {i.text}
              </p>
            );
          if (i.kind === "reply")
            return (
              <div key={i.seq} className="dk-reply">
                <p className="dk-bubble num">{replyCitations(i.text).text}</p>
                {i.citations && i.citations.length > 0 && <Citations items={i.citations} inline />}
              </div>
            );
          if (i.kind === "inbound")
            return (
              <p key={i.seq} className="dk-bubble dk-bubble-inbound num">
                <span className="chip chip-inbound_message">Forwarded</span> {i.text.slice(0, 140)}
                {i.text.length > 140 ? "…" : ""}
              </p>
            );
          if (i.kind === "tool")
            return (
              <div key={i.seq} className="card dk-chat-step">
                <StepRow step={i.step} />
              </div>
            );
          return null;
        })}
        {busy && <p className="dk-bubble faint">Checking</p>}
        <div ref={end} />
      </div>
      {shown.length < 2 && (
        <div className="dk-suggest">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="btn btn-sm" onClick={() => send(s)} disabled={busy}>
              {s}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error-text dk-chat-error">{error}</p>}
      <form className="dk-composer" onSubmit={submit}>
        <label htmlFor="desk-chat" className="visually-hidden">
          Message {BRAND}
        </label>
        <input id="desk-chat" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message ${BRAND}`} autoComplete="off" />
        <button type="submit" className="btn btn-primary" aria-label="Send" disabled={busy || !text.trim()}>
          <Send size={16} aria-hidden />
        </button>
      </form>
    </section>
  );
}

export function SidePanel({ ctx, draft }: { ctx: DeskCtx; draft: { text: string; n: number } | null }) {
  return (
    <aside className="dk-side" aria-label="Agent">
      <Theater ctx={ctx} />
      <Chat ctx={ctx} draft={draft} />
    </aside>
  );
}
