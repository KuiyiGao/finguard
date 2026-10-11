import { nudgeFinding, replyCitations, scamFinding } from "../../lib/normalize.ts";
import { Bell, Forward, MessageSquareWarning, Send, Sparkles } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { Citations, EvidenceCard } from "../../components/evidence/EvidenceCard.tsx";
import { StepRow } from "../../components/evidence/StepRow.tsx";
import { FinGuard } from "../../components/pixel/Sprite.tsx";
import { AgentTheater, TheaterSheet } from "../../components/theater/index.ts";
import { BRAND } from "../../lib/brand.ts";
import { alertLine, isMoneyStep, type Turn, type TurnItem } from "../../lib/turns.ts";
import type { AppCtx, ChatIntent } from "../CustomerApp.tsx";
import { ForwardSheet } from "../sheets.tsx";

const SUGGESTIONS = ["Where can I save this month?", "Move $300 to savings", "Pay my Duke Energy bill", "What's my balance?"];

function Bubble({ item, turn, ctx }: { item: TurnItem; turn: Turn; ctx: AppCtx }) {
  switch (item.kind) {
    case "nudge":
      return (
        <div className="chat-card">
          <p className="chat-kicker">
            <Sparkles size={13} aria-hidden /> {BRAND} noticed
          </p>
          <EvidenceCard finding={nudgeFinding(item.nudge, { simulated: ctx.simulated })} compact />
        </div>
      );
    case "user":
      return <div className="bubble bubble-me">{item.text}</div>;
    case "inbound":
      return (
        <div className="bubble-fwd">
          <span className="fwd-label">
            <Forward size={13} aria-hidden /> Forwarded
          </span>
          <p>{item.text}</p>
        </div>
      );
    case "reply":
      return (
        <>
          <div className="bubble bubble-steward">{replyCitations(item.text).text}</div>
          {item.citations && item.citations.length > 0 && (
            <div className="reply-cites">
              <Citations items={item.citations} inline />
            </div>
          )}
        </>
      );
    case "tool":
      return !isMoneyStep(item.step) ? null : (
        <div className="chat-card">
          <div className="card chat-step">
            <StepRow step={item.step} />
          </div>
        </div>
      );
    case "scam": {
      const text = turn.items.find((i) => i.kind === "inbound")?.text;
      return (
        <div className="chat-card">
          <EvidenceCard finding={scamFinding(item.assessment, { text, area: "protection", createdAt: item.ts, simulated: false })} compact />
        </div>
      );
    }
    case "alert":
      return (
        <div className="chat-note">
          <Bell size={13} aria-hidden /> {alertLine(item)}
        </div>
      );
    default:
      return null;
  }
}

export function ChatScreen({ ctx, intent, clearIntent }: { ctx: AppCtx; intent?: ChatIntent; clearIntent: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forwarding, setForwarding] = useState(false);
  const [watching, setWatching] = useState<string | null>(null);
  const watched = watching ? ctx.turns.find((t) => t.id === watching) : undefined;
  const end = useRef<HTMLDivElement>(null);
  const handled = useRef<ChatIntent | undefined>(undefined);
  const shown = ctx.turns.filter((t) => t.start?.kind !== "review");
  const count = shown.reduce((n, t) => n + t.items.length, 0);

  const send = async (message: string, inbound?: string) => {
    if (!message.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await ctx.api.chat(message.trim(), inbound ? { text: inbound } : undefined);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!intent || handled.current === intent) return;
    handled.current = intent;
    if (intent.text && intent.send) void send(intent.text);
    else if (intent.text) setText(intent.text);
    if (intent.forward) setForwarding(true);
    clearIntent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent, clearIntent]);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [count, busy]);

  return (
    <div className="chat">
      <div className="chat-log" aria-live="polite">
        {count === 0 && (
          <div className="chat-empty">
            <span className="chat-empty-mark" aria-hidden>
              <FinGuard size={56} label={BRAND} />
            </span>
            <p className="muted">Ask {BRAND} to find savings, move money within your limits, or check a message before you pay.</p>
          </div>
        )}
        {shown.map((t) => {
          const lastReply = t.items.reduce<number>((at, item, i) => (item.kind === "reply" ? i : at), -1);
          return t.items.map((item, i) => (
            <Fragment key={item.seq}>
              <Bubble item={item} turn={t} ctx={ctx} />
              {i === lastReply && <AgentTheater turn={t} mode="strip" className="chat-theater" onExpand={() => setWatching(t.id)} />}
            </Fragment>
          ));
        })}
        {busy && <div className="bubble bubble-steward typing">Checking</div>}
        <div ref={end} />
      </div>
      {count < 2 && (
        <div className="chips-row chat-suggest">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="btn btn-sm suggest" onClick={() => send(s)} disabled={busy}>
              {s}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error-text chat-error">{error}</p>}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void send(text);
        }}
      >
        <button type="button" className="btn btn-ghost composer-fwd" aria-label="Forward a message to check" onClick={() => setForwarding(true)}>
          <MessageSquareWarning size={20} />
        </button>
        <label className="visually-hidden" htmlFor="chat-input">
          Message {BRAND}
        </label>
        <input id="chat-input" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message ${BRAND}`} autoComplete="off" />
        <button type="submit" className="btn btn-primary composer-send" aria-label="Send" disabled={busy || !text.trim()}>
          <Send size={18} />
        </button>
      </form>
      {watched && <TheaterSheet turn={watched} onClose={() => setWatching(null)} />}
      {forwarding && (
        <ForwardSheet
          onClose={() => setForwarding(false)}
          onSend={(message, question) => {
            setForwarding(false);
            void send(question, message);
          }}
        />
      )}
    </div>
  );
}
