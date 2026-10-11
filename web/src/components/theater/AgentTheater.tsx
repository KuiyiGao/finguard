import { ChevronDown, ChevronLeft, ChevronRight, Clapperboard, MessageSquareWarning, Pause, Play, Receipt, RotateCcw, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { BRAND } from "../../lib/brand.ts";
import type { Turn } from "../../lib/turns.ts";
import { VerdictBadge } from "../gate.tsx";
import { GateRing, OUTFIT_LABEL, Phone, Seal, SkillIcon, skillForTool, StewardGlyph, StewardMark, type GateState, type SealState, type SkillName, type SpriteStatus } from "../pixel/Sprite.tsx";
import { stillMode } from "../viz/motion.tsx";
import { beatsOf, outfitsOf, requestOf, SOURCE_SHORT, sourcesOf, type Beat, type RequestKind, type Spot } from "./stage.ts";
import { theaterSteps, theaterSummary, turnLabel, type TheaterStep } from "./steps.ts";
import "./theater.css";

const ParticleField = lazy(() => import("../particles/ParticleField.tsx").then((m) => ({ default: m.ParticleField })));

const PREF_KEY = "steward-theater-autoplay";
let autoPref = (() => {
  try {
    return localStorage.getItem(PREF_KEY) === "1";
  } catch {
    return false;
  }
})();
const prefSubs = new Set<() => void>();

export function useTheaterAutoPlay(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (fn) => (prefSubs.add(fn), () => prefSubs.delete(fn)),
    () => autoPref,
  );
  const set = useCallback((next: boolean) => {
    autoPref = next;
    try {
      localStorage.setItem(PREF_KEY, next ? "1" : "0");
    } catch {
    }
    prefSubs.forEach((fn) => fn());
  }, []);
  return [on, set];
}

const latestByScope = new Map<string, Map<string, { seq: number; review: boolean }>>();
const latestSubs = new Set<() => void>();
const latestOf = (scope: string) => {
  let best: string | null = null;
  let seq = -1;
  let review: string | null = null;
  let reviewSeq = -1;
  for (const [id, t] of latestByScope.get(scope) ?? []) {
    if (t.review) {
      if (t.seq > reviewSeq) [review, reviewSeq] = [id, t.seq];
    } else if (t.seq > seq) [best, seq] = [id, t.seq];
  }
  return best ?? review;
};

export function useIsLatestTurn(turn: Turn, scope = "console"): boolean {
  const review = turn.start?.kind === "review";
  useEffect(() => {
    const m = latestByScope.get(scope) ?? new Map<string, { seq: number; review: boolean }>();
    latestByScope.set(scope, m);
    m.set(turn.id, { seq: turn.lastSeq, review });
    latestSubs.forEach((fn) => fn());
    return () => {
      m.delete(turn.id);
      latestSubs.forEach((fn) => fn());
    };
  }, [turn.id, turn.lastSeq, scope, review]);
  return useSyncExternalStore(
    (fn) => (latestSubs.add(fn), () => latestSubs.delete(fn)),
    () => latestOf(scope) === turn.id,
  );
}

function beatMs(step: TheaterStep | undefined): number {
  if (!step) return 1600;
  if (step.quick) return 1000;
  if (step.action === "reply" || step.verdict === "deny" || step.action === "reject" || step.action === "route") return 2400;
  return 1800;
}

function usePlayer(steps: TheaterStep[], autoPlay: boolean) {
  const count = steps.length;
  const [still] = useState(stillMode);
  const [index, setIndex] = useState(() => (autoPlay && !still ? 0 : count - 1));
  const [playing, setPlaying] = useState(autoPlay && !still);
  const [touched, setTouched] = useState(false);
  const seen = useRef(count);

  useEffect(() => {
    const before = seen.current;
    seen.current = count;
    if (count > before && !playing) setIndex((i) => (i >= before - 1 ? count - 1 : i));
  }, [count, playing]);

  useEffect(() => {
    if (!playing || index >= count - 1) return;
    const t = window.setTimeout(() => setIndex((i) => Math.min(i + 1, count - 1)), beatMs(steps[index]));
    return () => window.clearTimeout(t);
  }, [playing, index, count, steps]);

  const atEnd = index >= count - 1;
  return {
    index: Math.max(0, Math.min(index, count - 1)),
    playing: playing && !atEnd,
    touched,
    still,
    play: () => {
      setTouched(true);
      if (atEnd) setIndex(0);
      setPlaying(true);
    },
    pause: () => (setTouched(true), setPlaying(false)),
    go: (i: number) => {
      setTouched(true);
      setPlaying(false);
      setIndex(Math.max(0, Math.min(i, count - 1)));
    },
  };
}

function statusOf(step: TheaterStep): SpriteStatus | undefined {
  if (step.verdict === "deny" || step.ok === false) return "bad";
  if (step.verdict === "ask") return "warn";
  if (step.ok === true || step.verdict === "allow") return "ok";
  return undefined;
}

function actorName(step: TheaterStep, beat: Beat): string {
  switch (step.actor) {
    case "customer":
      return "Customer";
    case "skillgate":
      return "SkillGate";
    case "evaluator":
      return "Evaluator";
    case "service":
      return step.service ? SOURCE_SHORT[step.service] : "Service";
    case "reply":
      return BRAND;
    default:
      return `${BRAND}, ${OUTFIT_LABEL[beat.outfit].toLowerCase()}`;
  }
}

const GATE_WORD: Record<GateState, string> = { open: "open", checking: "checking", allow: "allowed", ask: "needs approval", locked: "blocked" };
const SEAL_WORD: Record<SealState, string> = { idle: "waiting", working: "reading", pass: "passed", repair: "repaired", fail: "rejected" };
const TONE_VAR: Record<string, string> = { trusted: "var(--origin-system)", untrusted: "var(--origin-inbound)", ok: "var(--allow)", warn: "var(--ask)", bad: "var(--deny)", neutral: "var(--brand)" };
const NOTCH: Record<Spot, string> = { req: "12%", seal: "12%", steward: "38%", gate: "65%", src: "88%" };
const sel = (s?: Spot) => (s ? `[data-spot="${s}"]` : null);

function RequestObject({ kind, state, label }: { kind: RequestKind; state: Beat["req"]; label: string }) {
  if (kind === "phone" || kind === "inbound") return <Phone state={state} tone={kind === "inbound" ? "inbound" : "user"} label={label} />;
  if (kind === "review")
    return (
      <span className="obj th-review" role="img" aria-label={label}>
        <span className="obj-halo" aria-hidden />
        <SkillIcon name="db" size={32} title={label} />
      </span>
    );
  return (
    <span className={`obj th-doc obj-${state}`} role="img" aria-label={label}>
      <span className="obj-halo" aria-hidden />
      <svg viewBox="0 0 48 48" aria-hidden focusable="false">
        <path className="th-doc-page" d="M13 4h16l9 9v28a3 3 0 0 1-3 3H13a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z" />
        <path className="th-doc-fold" d="M29 4v6a3 3 0 0 0 3 3h6" />
        <rect className="th-doc-line" x="15" y="18" width="16" height="2.2" rx="1.1" />
        <rect className="th-doc-mark" x="14" y="23" width="19" height="4.4" rx="1.2" />
        <rect className="th-doc-line" x="15" y="30.5" width="17" height="2.2" rx="1.1" />
        <rect className="th-doc-line" x="15" y="35.5" width="11" height="2.2" rx="1.1" />
      </svg>
    </span>
  );
}

function Place({ id, focus, label, children }: { id: Spot; focus: Spot; label: string; children: ReactNode }) {
  return (
    <div className={`th-place th-place-${id}${focus === id ? " on" : ""}`}>
      <span className="th-anchor" data-spot={id}>
        {children}
      </span>
      <span className="th-label" aria-hidden>
        {label}
      </span>
    </div>
  );
}

function StewardPlace({ beat, still }: { beat: Beat; still: boolean }) {
  const working = beat.focus === "steward" && !still;
  const tone = beat.focus === "steward" && beat.fx.tone !== "neutral" ? TONE_VAR[beat.fx.tone] : undefined;
  const style = tone ? ({ "--mk-glow": tone } as CSSProperties) : undefined;
  return (
    <div className={`th-place th-place-steward${beat.focus === "steward" ? " on" : ""}`} style={style}>
      <span className="th-anchor th-steward" data-spot="steward">
        <StewardMark outfit={beat.outfit} state={working ? "working" : "idle"} label={`${BRAND}, acting as ${OUTFIT_LABEL[beat.outfit].toLowerCase()}`} />
      </span>
      <span className="th-label" aria-hidden>
        {OUTFIT_LABEL[beat.outfit]}
      </span>
    </div>
  );
}

function Bubble({ step, beat, index, count }: { step: TheaterStep; beat: Beat; index: number; count: number }) {
  const scope = step.action === "scope" || step.action === "reject";
  return (
    <div className={`th-bubble th-bubble-${step.parcel ? "warm" : (statusOf(step) ?? "plain")}`} style={{ "--x": NOTCH[beat.focus] } as CSSProperties} key={step.key}>
      <p className="th-bubble-head">
        <span className="th-who">{actorName(step, beat)}</span>
        <strong>{step.title}</strong>
        {step.verdict && (step.action === "check" || step.action === "reuse" || step.action === "approve") && <VerdictBadge verdict={step.verdict} />}
        <span className="th-count num">
          {index + 1}/{count}
        </span>
      </p>
      <p className="th-detail">{step.detail}</p>
      {(step.parcel || step.host || step.manifest || step.receiptId || (step.tools && step.tools.length > 0)) && (
        <p className="th-chips">
          {step.parcel && (
            <span className={`chip chip-${step.parcel === "inbound" ? "inbound_message" : "tool_text"}`}>
              <MessageSquareWarning aria-hidden /> {step.parcel === "inbound" ? "Forwarded message, untrusted" : "Memo text, untrusted"}
            </span>
          )}
          {step.tools?.map((t) => (
            <span key={t} className={`th-tool${step.action === "reject" ? " th-tool-denied" : ""}`} title={scope ? (step.action === "reject" ? "Not in this outfit's tool manifest" : "In this outfit's tool manifest") : undefined}>
              <SkillIcon name={skillForTool(t)} size={16} /> {t}
            </span>
          ))}
          {step.host && <span className="th-tool mono">host {step.host}</span>}
          {step.manifest && <span className="th-tool">{step.manifest}</span>}
          {step.receiptId && (
            <span className="th-tool mono">
              <Receipt aria-hidden /> {step.receiptId}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

export interface AgentTheaterProps {
  turn: Turn;
  mode?: "full" | "strip";
  autoPlay?: boolean;
  onExpand?: () => void;
  cta?: string;
  className?: string;
}

export function AgentTheater({ turn, mode = "full", autoPlay = false, onExpand, cta, className = "" }: AgentTheaterProps) {
  const steps = useMemo(() => theaterSteps(turn), [turn]);
  if (!steps.length) return null;
  if (mode === "strip") return <TheaterStrip steps={steps} turn={turn} onExpand={onExpand} cta={cta} className={className} />;
  return <TheaterStage steps={steps} turn={turn} autoPlay={autoPlay} className={className} />;
}

function TheaterStage({ steps, turn, autoPlay, className }: { steps: TheaterStep[]; turn: Turn; autoPlay: boolean; className: string }) {
  const p = usePlayer(steps, autoPlay);
  const [auto, setAuto] = useTheaterAutoPlay();
  const beats = useMemo(() => beatsOf(steps), [steps]);
  const req = useMemo(() => requestOf(turn, steps), [turn, steps]);
  const sources = useMemo(() => sourcesOf(steps), [steps]);
  const step = steps[p.index]!;
  const beat = beats[p.index]!;
  const kind = turnLabel(turn.start);
  const srcs: SkillName[] = sources.length ? sources : ["bank"];
  const active = beat.source && srcs.includes(beat.source) ? beat.source : srcs[0]!;
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = list.current;
    const btn = el?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!el || !btn) return;
    const delta = btn.getBoundingClientRect().left - el.getBoundingClientRect().left;
    el.scrollTo({ left: Math.max(0, el.scrollLeft + delta - (el.clientWidth - btn.offsetWidth) / 2), behavior: p.still ? "auto" : "smooth" });
  }, [p.index, p.still]);
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    if (e.key === "ArrowRight") p.go(p.index + 1);
    else if (e.key === "ArrowLeft") p.go(p.index - 1);
    else if (e.key === "Home") p.go(0);
    else if (e.key === "End") p.go(steps.length - 1);
    else if ((e.key === " " || e.key === "k") && target === e.currentTarget) p.playing ? p.pause() : p.play();
    else return;
    e.preventDefault();
  };
  return (
    <section className={`th ${className}`} aria-label={`Agent theater: how ${BRAND} handled this turn`} tabIndex={0} onKeyDown={onKey} data-still={p.still ? "" : undefined}>
      <header className="th-head">
        <span className="th-title">
          <Clapperboard aria-hidden /> <span className="th-title-text">Watch {BRAND} work</span>
          {kind && <span className="th-kind">{kind}</span>}
        </span>
        <div className="th-controls" role="group" aria-label="Replay controls">
          <button type="button" className="th-btn" onClick={() => p.go(0)} aria-label="Back to the first step" disabled={p.index === 0}>
            <RotateCcw aria-hidden />
          </button>
          <button type="button" className="th-btn" onClick={() => p.go(p.index - 1)} aria-label="Previous step" disabled={p.index === 0}>
            <ChevronLeft aria-hidden />
          </button>
          <button type="button" className="th-btn th-btn-main" onClick={p.playing ? p.pause : p.play} aria-label={p.playing ? "Pause" : p.index >= steps.length - 1 ? "Replay from the start" : "Play"}>
            {p.playing ? <Pause aria-hidden /> : <Play aria-hidden />}
            <span className="th-btn-word">{p.playing ? "Pause" : p.index >= steps.length - 1 ? "Replay" : "Play"}</span>
          </button>
          <button type="button" className="th-btn" onClick={() => p.go(p.index + 1)} aria-label="Next step" disabled={p.index >= steps.length - 1}>
            <ChevronRight aria-hidden />
          </button>
          <button type="button" className={`th-btn th-auto${auto ? " on" : ""}`} aria-pressed={auto} onClick={() => setAuto(!auto)} title="Play each new turn automatically (projector mode)">
            Auto-play
          </button>
        </div>
      </header>

      <Bubble step={step} beat={beat} index={p.index} count={steps.length} />

      <div className={`th-stage th-focus-${beat.focus}`}>
        <Suspense fallback={null}>
          <ParticleField mode={beat.fx.mode} tone={beat.fx.tone} from={sel(beat.fx.from)} to={sel(beat.fx.to)} intensity={0.7} className="th-particles" />
        </Suspense>
        <Place id="req" focus={beat.focus} label={req.label}>
          <RequestObject kind={req.kind} state={beat.req} label={req.label === "You" ? "The customer's phone" : req.label} />
        </Place>
        <StewardPlace beat={beat} still={p.still} />
        <Place id="gate" focus={beat.focus} label="SkillGate">
          <GateRing state={beat.gate} label={`SkillGate: ${GATE_WORD[beat.gate]}`} />
        </Place>
        <Place id="seal" focus={beat.focus} label="Evaluator">
          <Seal state={beat.seal} label={`Evaluator: ${SEAL_WORD[beat.seal]}`} />
        </Place>
        <div className={`th-place th-place-src${beat.focus === "src" ? " on" : ""}${sources.length ? "" : " th-unused"}`}>
          <span className="th-srcs">
            {srcs.map((k) => (
              <span key={k} className={`th-src${k === active ? " on" : ""}`} data-spot={k === active ? "src" : undefined}>
                <SkillIcon name={k} size={32} />
              </span>
            ))}
          </span>
          <span className="th-label" aria-hidden>
            {SOURCE_SHORT[active]}
          </span>
        </div>
      </div>

      <ol className="th-steps" aria-label="Steps" ref={list}>
        {steps.map((s, i) => (
          <li key={s.key}>
            <button
              type="button"
              className={`th-step th-step-${statusOf(s) ?? "plain"}${s.parcel ? " th-step-warm" : ""}${i === p.index ? " on" : i < p.index ? " past" : ""}`}
              aria-current={i === p.index ? "step" : undefined}
              onClick={() => p.go(i)}
            >
              <span className="th-step-n num">{i + 1}</span>
              <span className="th-step-t">{s.title}</span>
            </button>
          </li>
        ))}
      </ol>

      <p className="visually-hidden" aria-live="polite">
        {p.touched || p.playing ? `Step ${p.index + 1} of ${steps.length}. ${actorName(step, beat)}: ${step.title}. ${step.detail}` : ""}
      </p>
    </section>
  );
}

function TheaterStrip({ steps, turn, onExpand, cta, className }: { steps: TheaterStep[]; turn: Turn; onExpand?: () => void; cta?: string; className: string }) {
  const [open, setOpen] = useState(false);
  const beats = useMemo(() => beatsOf(steps), [steps]);
  const outfit = [...beats].reverse().find((b) => b.outfit !== "base")?.outfit ?? "base";
  const worn = outfitsOf(beats)
    .map((o) => OUTFIT_LABEL[o].toLowerCase())
    .join(", then ");
  const kind = turnLabel(turn.start);
  const summary = [kind, theaterSummary(steps)].filter(Boolean).join(", ");
  const expanded = !onExpand && open;
  const label = cta ?? `How ${BRAND} did it`;
  const Arrow = onExpand ? ChevronRight : ChevronDown;
  return (
    <div className={`th-strip-wrap ${className}`}>
      <button type="button" className="th-strip" onClick={() => (onExpand ? onExpand() : setOpen(!open))} aria-expanded={onExpand ? undefined : expanded} aria-label={`${label}: ${BRAND} as ${worn}. ${summary}`}>
        <StewardGlyph outfit={outfit} size={14} className="th-strip-glyph" />
        <span className="th-strip-text">
          <strong>{label}</strong>
          {summary && <span className="faint">, {summary}</span>}
        </span>
        <Arrow className={`th-strip-icon${expanded ? " flip" : ""}`} aria-hidden />
      </button>
      {expanded && <AgentTheater turn={turn} autoPlay />}
    </div>
  );
}

export function TheaterSheet({ turn, onClose }: { turn: Turn; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, []);
  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet enter th-sheet" role="dialog" aria-modal="true" aria-label={`Watch ${BRAND} work`} tabIndex={-1} ref={ref}>
        <button type="button" className="sheet-close btn btn-ghost btn-sm" aria-label="Close" onClick={onClose}>
          <X size={18} />
        </button>
        <AgentTheater turn={turn} autoPlay />
      </div>
    </div>
  );
}
