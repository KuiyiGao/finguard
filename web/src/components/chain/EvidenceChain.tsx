import type { Finding, Reason } from "@contracts";
import {
  Calculator,
  Check,
  CircleCheck,
  Clock,
  ExternalLink,
  FileText,
  Hash,
  KeyRound,
  Landmark,
  Link2,
  MessageSquareWarning,
  OctagonX,
  ReceiptText,
  RotateCcw,
  Route,
  ShieldCheck,
  ShieldX,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { describeCall, sourceKind } from "../../lib/describe.ts";
import { RULE_LABEL, shortHash } from "../../lib/format.ts";
import type { ActionState } from "../../lib/status.ts";
import type { ToolStep } from "../../lib/turns.ts";
import { ORIGIN } from "../evidence/meta.ts";
import { ReceiptDetail } from "../evidence/StepRow.tsx";
import { fieldDisplay, fieldLabel, VerdictBadge } from "../gate.tsx";
import { formatValue, type ValueUnit } from "../viz/format.ts";
import { stillMode, useCountUp, useInView } from "../viz/motion.tsx";
import { flyPill, magnet } from "./fly.ts";
import { InkLayer, useInkGeometry } from "./ink.tsx";
import { Gate, Quiet, Seal, useParticleField, type GateState, type ParticleProps } from "./marks.tsx";
import { announce, buildChain, findChainStep, STATION_ORDER, STATION_TITLES, type ChainItem, type ChainModel, type StationId, type StationState } from "./model.ts";
import "../evidence/evidence.css";
import "../viz/viz.css";
import "./chain.css";

export interface EvidenceChainProps {
  finding: Finding;
  step?: ToolStep;
  steps?: Map<string, ToolStep>;
  status?: ActionState;
  sample?: boolean;
  autoplay?: boolean;
  className?: string;
}

interface Timing {
  fast: number;
  base: number;
  slow: number;
  stage: number;
  stagger: number;
}

function cssMs(name: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return raw.endsWith("ms") ? n : raw.endsWith("s") ? n * 1000 : n;
}

function timing(): Timing {
  return { fast: cssMs("--motion-fast", 120), base: cssMs("--motion-base", 220), slow: cssMs("--motion-slow", 420), stage: cssMs("--motion-stage", 700), stagger: cssMs("--stagger", 40) };
}

interface Plan {
  station: Record<StationId, number>;
  mark: number[];
  key: number[];
  note: number[];
  fly: number[];
  land: number[];
  term: number[];
  result: number;
  toGate: number;
  scanEnd: number;
  hand: number;
  flyDur: number;
  termDur: number;
  end: number;
}

function planOf(m: ChainModel, t: Timing): Plan {
  const hand = Math.round(t.stage * 0.6);
  const flyDur = t.slow + t.base;
  const termDur = t.slow + t.fast;
  const per = Math.round(t.slow * 1.85);
  const mark = m.marks.map((_, k) => t.base + k * per);
  const key = mark.map((at) => at + Math.round(t.slow * 0.8));
  const note = mark.map((at) => at + t.slow);
  const fly: number[] = [];
  const land: number[] = [];
  const again = new Map<number, number>();
  m.items.forEach((it, i) => {
    if (!it.n) return;
    const n = again.get(it.n) ?? 0;
    again.set(it.n, n + 1);
    fly[i] = mark[it.n - 1]! + Math.round(t.slow * 1.05) + n * t.stagger * 3;
    land[i] = fly[i]! + flyDur;
  });
  const lastLand = land.length ? Math.max(...land.filter((x) => x !== undefined)) : t.base;
  let extra = 0;
  m.items.forEach((it, i) => {
    if (it.n) return;
    fly[i] = -1;
    land[i] = lastLand + t.base + Math.min(extra++, 7) * t.stagger * 3;
  });
  const flown = fly.filter((x) => x !== undefined && x >= 0);
  const evidence = flown.length ? Math.min(...flown) : land.length ? Math.min(...land) : t.base + hand;
  const scanEnd = mark.length ? mark[mark.length - 1]! + Math.round(t.slow * 1.4) : t.base;
  const eEnd = Math.max(evidence, ...land.filter((x) => x !== undefined)) + t.base;
  const calc = eEnd + hand;
  const term = m.calc.terms.map((_, i) => calc + t.base + i * Math.round(t.fast * 2.5));
  const result = term.length ? term[term.length - 1]! + Math.round(termDur * 0.8) : calc + t.base;
  const action = result + 600 + hand;
  const toGate = action + t.base * 2;
  const permission = toGate + Math.round(flyDur * 0.85);
  const rules = Math.min(5, m.permission.passed.length + m.permission.blocking.length);
  const receipt = permission + t.slow + rules * t.stagger + t.base * 2 + hand;
  return { station: { source: 0, evidence, calc, action, permission, receipt }, mark, key, note, fly, land, term, result, toGate, scanEnd, hand, flyDur, termDur, end: receipt + t.stage * 2 };
}

function useClock(times: number[], end: number, run: boolean, token: number): number {
  const [now, setNow] = useState(() => (stillMode() ? Infinity : -1));
  const plan = useRef({ times, end });
  plan.current = { times, end };
  useEffect(() => {
    if (!run) return;
    if (stillMode()) {
      setNow(Infinity);
      return;
    }
    setNow(-1);
    const cues = [...new Set(plan.current.times.filter((x) => Number.isFinite(x) && x >= 0))].sort((a, b) => a - b);
    const ids = cues.map((t) => window.setTimeout(() => setNow((n) => (n === Infinity ? n : Math.max(n, t))), t));
    ids.push(window.setTimeout(() => setNow(Infinity), plan.current.end));
    return () => ids.forEach((id) => window.clearTimeout(id));
  }, [run, token]);
  return now;
}

const STATE_WORD: Record<StationState, string> = { done: "Done", active: "In progress", stopped: "Stopped", pending: "Not reached yet" };
const STATION_ICON: Record<StationId, LucideIcon> = {
  source: FileText,
  evidence: Waypoints,
  calc: Calculator,
  action: Route,
  permission: ShieldCheck,
  receipt: ReceiptText,
};

const rise = (i: number): CSSProperties => ({ "--i": i }) as CSSProperties;

function Body({ late, className, children }: { late: boolean; className?: string; children: ReactNode }) {
  const [wasLate] = useState(late);
  return <div className={`ch-body${wasLate ? " ch-late" : ""}${className ? ` ${className}` : ""}`}>{children}</div>;
}

function Count({ value, unit, run }: { value: number; unit: ValueUnit; run: boolean }) {
  const v = useCountUp(value, { duration: 600, run });
  const final = formatValue(value, unit);
  return (
    <span className="countup num">
      <span className="countup-ghost" aria-hidden>
        {final}
      </span>
      <span className="countup-live" aria-hidden>
        {formatValue(run ? v : 0, unit)}
      </span>
      <span className="visually-hidden">{final}</span>
    </span>
  );
}

function OriginTag({ item }: { item: Pick<ChainItem, "origin" | "trusted" | "source"> }) {
  const o = ORIGIN[item.origin];
  const Icon = o?.icon ?? FileText;
  return (
    <span className={`ev-chip ev-chip-${item.origin}${item.trusted ? "" : " ev-chip-untrusted"}`} title={`${item.trusted ? "Trusted" : "Not trusted for payment details"}, ${item.source}`}>
      <Icon aria-hidden /> {o?.label ?? item.origin}
    </span>
  );
}

function withNumbers(s: string): ReactNode[] {
  return s.split(/(\$?\d[\d,]*(?:\.\d+)?%?)/g).map((part, i) => (i % 2 ? <strong key={i} className="ch-num num">{part}</strong> : part));
}

const RULE_ICON = { allow: CircleCheck, ask: Clock, deny: ShieldX } as const;

function Rules({ reasons, more }: { reasons: Reason[]; more: number }) {
  return (
    <ul className="ch-rules">
      {reasons.map((r, i) => {
        const Icon = RULE_ICON[r.verdict];
        return (
          <li key={`${r.rule}-${i}`} className={`ch-rule ch-rule-${r.verdict} ch-rise`} style={rise(i + 3)}>
            <Icon aria-hidden className="ch-rule-icon" />
            <span>
              <strong>{RULE_LABEL[r.rule] ?? r.rule}</strong> <span className="ch-rule-text">{r.message}</span>
            </span>
          </li>
        );
      })}
      {more > 0 && (
        <li className="ch-rule-more ch-rise" style={rise(reasons.length + 3)}>
          +{more} more {more === 1 ? "rule" : "rules"} passed
        </li>
      )}
    </ul>
  );
}

export function EvidenceChain({ finding, step: given, steps, status, sample = false, autoplay = true, className = "" }: EvidenceChainProps) {
  const phone = useMemo(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 639px)").matches, []);
  const step = given ?? findChainStep(finding, steps);
  const model = useMemo(() => buildChain(finding, step, status), [finding, step, status]);
  const [t] = useState(timing);
  const [still] = useState(stillMode);
  const plan = useMemo(() => planOf(model, t), [model, t]);
  const [ref, seen] = useInView<HTMLElement>();
  const [token, setToken] = useState(0);
  const times = useMemo(
    () => [...Object.values(plan.station), ...Object.values(plan.station).map((x) => x - plan.hand), ...plan.mark, ...plan.key, ...plan.note, ...plan.fly, ...plan.land, ...plan.term, plan.result, plan.toGate, plan.scanEnd],
    [plan],
  );
  const now = useClock(times, plan.end, autoplay && seen, token);
  const done = now === Infinity;
  const docRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const flyRef = useRef<SVGSVGElement>(null);
  const formulaRef = useRef<HTMLDivElement>(null);
  const [said, setSaid] = useState("");
  const geo = useInkGeometry(textRef, model.marks);
  const Particles = useParticleField();

  const reached = (s: StationId) => model.states[s] !== "pending";
  const lit = (s: StationId) => reached(s) && now >= plan.station[s];
  const linkLit = (s: StationId) => reached(s) && now >= plan.station[s] - plan.hand;
  const at = (x: number | undefined) => x !== undefined && x >= 0 && now >= x;

  const prevLit = useRef<Set<StationId>>(new Set());
  const prevKey = useRef<string>("");
  useEffect(() => {
    const on = STATION_ORDER.filter(lit);
    const fresh = on.filter((s) => !prevLit.current.has(s));
    prevLit.current = new Set(on);
    const key = `${model.permission.state}|${model.permission.headline}|${model.receipt.state}|${model.receipt.id ?? ""}`;
    const changed = prevKey.current && prevKey.current !== key && done;
    prevKey.current = key;
    if (fresh.length && !(done && fresh.length === on.length && fresh.length > 2)) setSaid(announce(fresh[fresh.length - 1]!, model));
    else if (changed) setSaid(announce(model.receipt.state === "done" || model.receipt.state === "active" ? "receipt" : "permission", model));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, model]);

  useEffect(() => {
    if (done || now < 0 || !geo) return;
    const box = docRef.current;
    const k = plan.mark.indexOf(now);
    if (!box || k < 0) return;
    const first = geo.lines[k]?.[0];
    if (!first) return;
    box.scrollTo({ top: Math.max(0, first.y - box.clientHeight / 3), behavior: "smooth" });
  }, [now, done, plan, geo]);

  useLayoutEffect(() => {
    if (done || now < 0 || stillMode()) return;
    const root = ref.current;
    const layer = flyRef.current;
    if (!root || !layer) return;
    plan.fly.forEach((x, i) => {
      if (x !== now) return;
      const it = model.items[i];
      const li = listRef.current?.querySelector<HTMLElement>(`[data-item="${i}"]`);
      const k = (it?.n ?? 0) - 1;
      const src = textRef.current?.querySelector<HTMLElement>(`[data-key="${k}"]`) ?? textRef.current?.querySelector<HTMLElement>(`[data-mark-text="${k}"]`);
      const box = docRef.current?.getBoundingClientRect();
      if (!li || !src || !box) return;
      const r = src.getClientRects()[0] ?? src.getBoundingClientRect();
      const from = new DOMRect(Math.min(Math.max(r.left, box.left), box.right - 24), Math.min(Math.max(r.top, box.top), box.bottom - 16), Math.min(r.width, box.width), r.height);
      flyPill(layer, root, from, li.getBoundingClientRect(), { tone: model.marks[k]?.tone ?? "warn", duration: plan.flyDur });
    });
    plan.term.forEach((x, i) => {
      if (x !== now) return;
      const el = formulaRef.current?.querySelector<HTMLElement>(`[data-term="${i}"]`);
      if (!el) return;
      const term = model.calc.terms[i];
      const idx = term?.from ? model.items.findIndex((it) => it.label === term.from!.label) : -1;
      const src = idx >= 0 ? listRef.current?.querySelector<HTMLElement>(`[data-item="${idx}"]`) : null;
      magnet(el, src ? src.getBoundingClientRect() : null, plan.termDur);
    });
    if (now === plan.toGate && reached("permission")) {
      const a = root.querySelector<HTMLElement>(".ch-action");
      const g = root.querySelector<SVGElement>(".ch-gate");
      if (a && g) flyPill(layer, root, a.getBoundingClientRect(), g.getBoundingClientRect(), { tone: "brand", duration: plan.flyDur, toRadius: 28 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, done, plan, model]);

  const prevPerm = useRef(model.permission.state);
  useEffect(() => {
    const was = prevPerm.current;
    prevPerm.current = model.permission.state;
    if (!done || stillMode() || was !== "pending" || model.permission.state === "pending") return;
    const root = ref.current;
    const layer = flyRef.current;
    const a = root?.querySelector<HTMLElement>(".ch-action");
    const g = root?.querySelector<SVGElement>(".ch-gate");
    if (root && layer && a && g) flyPill(layer, root, a.getBoundingClientRect(), g.getBoundingClientRect(), { tone: "brand", duration: plan.flyDur, toRadius: 28 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.permission.state, done]);

  const [liveFx, setLiveFx] = useState<ParticleProps | null>(null);
  const prevFx = useRef({ gate: "", receipt: model.receipt.state });
  const gateNow: GateState = model.permission.state === "stopped" ? "locked" : model.permission.state === "done" ? "allowed" : model.permission.code === "waiting" ? "waiting" : model.permission.state === "active" ? "checking" : "idle";
  useEffect(() => {
    const was = prevFx.current;
    prevFx.current = { gate: gateNow, receipt: model.receipt.state };
    if (!done || still || !was.gate) return;
    let next: ParticleProps | null = null;
    if (model.receipt.state === "done" && was.receipt !== "done") next = { mode: "burst", tone: "ok", from: ".ch-seal" };
    else if (gateNow !== was.gate)
      next =
        gateNow === "locked"
          ? { mode: "stop", tone: "bad", to: ".ch-gate" }
          : gateNow === "allowed"
            ? { mode: "pass", tone: "ok", from: ".ch-gate" }
            : gateNow === "idle"
              ? null
              : { mode: "stream", tone: "neutral", from: ".ch-action", to: ".ch-gate" };
    if (!next) return;
    setLiveFx(next);
    const id = window.setTimeout(() => setLiveFx(null), t.stage * 2);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateNow, model.receipt.state, done]);

  const replay = () => {
    prevLit.current = new Set();
    docRef.current?.scrollTo({ top: 0 });
    setToken((x) => x + 1);
  };

  const m = model;
  const p = m.permission;
  const r = m.receipt;
  const blockingShown = p.blocking.slice(0, 3);
  const passedShown = p.passed.slice(0, Math.max(0, 5 - blockingShown.length));
  const morePassed = p.passed.length - passedShown.length;
  const SourceIcon = m.kind === "message" ? MessageSquareWarning : m.kind === "records" ? Landmark : FileText;
  const untrusted = m.items.filter((i) => !i.trusted);
  const trusted = m.items.filter((i) => i.trusted);
  const ends = p.state === "stopped" ? "the decision" : "the receipt";

  const current = plan.mark.reduce((acc, x, k) => (now >= x ? k : acc), -1);
  const lastLine = current >= 0 ? geo?.lines[current]?.[geo.lines[current]!.length - 1] : undefined;
  const scanning = !done && now >= 0 && now < plan.scanEnd && m.marks.length > 0;
  const beamY = now >= plan.scanEnd ? (geo?.h ?? 0) : lastLine ? lastLine.y + lastLine.h + 2 : 0;

  const gateState: GateState = !lit("permission") ? "idle" : p.state === "stopped" ? "locked" : p.state === "done" ? "allowed" : p.code === "waiting" ? "waiting" : p.state === "active" ? "checking" : "idle";

  let fx: ParticleProps | null = null;
  if (!still && now >= 0) {
    if (!done) {
      if (scanning && now < plan.station.evidence) fx = { mode: "scan", tone: m.kind === "records" ? "trusted" : "untrusted", from: ".ch-beam" };
      else if (now < plan.station.calc) {
        const i = plan.fly.reduce((acc, x, j) => (x >= 0 && now >= x ? j : acc), -1);
        const it = m.items[i];
        fx = it?.n ? { mode: "stream", tone: it.trusted ? "trusted" : "untrusted", from: `[data-mark="${it.n - 1}"]`, to: `[data-item="${i}"]` } : { mode: "scan", tone: "untrusted", from: ".ch-beam" };
      } else if (now < plan.station.action) fx = { mode: "stream", tone: "trusted", from: ".ch-items", to: ".ch-formula" };
      else if (now < plan.station.permission) fx = reached("permission") ? { mode: "stream", tone: "neutral", from: ".ch-action", to: ".ch-gate" } : { mode: "idle", tone: "neutral" };
      else if (now < plan.station.receipt || !reached("receipt")) fx = gateState === "locked" ? { mode: "stop", tone: "bad", to: ".ch-gate" } : gateState === "allowed" ? { mode: "pass", tone: "ok", from: ".ch-gate" } : { mode: "idle", tone: "warn" };
      else fx = r.state === "done" ? { mode: "burst", tone: "ok", from: ".ch-seal" } : { mode: "idle", tone: "neutral" };
    }
  }

  const station = (id: StationId, n: number, word: string | null, body: ReactNode) => {
    const isLit = lit(id);
    const state = m.states[id];
    const Icon = STATION_ICON[id];
    const DotIcon = !isLit ? null : state === "stopped" ? OctagonX : state === "active" ? Clock : Check;
    const next = STATION_ORDER[n];
    return (
      <li
        key={id}
        className={`ch-station ch-${id} ch-${state}${isLit ? " is-lit" : ""}${id === "source" || id === "evidence" ? " ch-e" : ""}${id === "permission" ? " ch-p" : ""}`}
        aria-label={`${n}. ${STATION_TITLES[id]}: ${isLit ? (word ?? STATE_WORD[state]) : STATE_WORD.pending}`}
      >
        {next && (
          <svg className={`ch-link${linkLit(next) ? " is-lit" : ""} ch-link-${m.states[next]}`} aria-hidden focusable="false" preserveAspectRatio="none" viewBox="0 0 10 10">
            <line className="ch-link-track ch-link-v" x1="5" y1="0" x2="5" y2="10" />
            <line className="ch-link-draw ch-link-v" x1="5" y1="0" x2="5" y2="10" pathLength={1} />
            <line className="ch-link-track ch-link-h" x1="0" y1="5" x2="10" y2="5" />
            <line className="ch-link-draw ch-link-h" x1="0" y1="5" x2="10" y2="5" pathLength={1} />
          </svg>
        )}
        <div className="ch-card">
          <div className="ch-top">
            <span className="ch-dot" aria-hidden>
              <span className="ch-dot-n num">{n}</span>
              {DotIcon && <DotIcon className="ch-dot-icon" />}
            </span>
            <span className="ch-name">
              <Icon aria-hidden className="ch-name-icon" /> {STATION_TITLES[id]}
            </span>
            <span className="ch-word">{isLit ? (word ?? STATE_WORD[state]) : reached(id) ? "" : STATE_WORD.pending}</span>
          </div>
          {body}
        </div>
      </li>
    );
  };

  const sourceBody = (
    <Body late={false}>
      <p className="ch-src-meta">
        <SourceIcon aria-hidden className="ch-src-icon" />
        <span className="ch-src-title" title={m.sourceRef}>
          {m.sourceTitle}
        </span>
      </p>
      {m.text ? (
        <div className="ch-doc" ref={docRef} tabIndex={0} role="region" aria-label={`${m.sourceTitle} with ${m.marks.length} highlighted ${m.marks.length === 1 ? "passage" : "passages"}`}>
          <div className={`ch-doc-text${m.marks.length ? " has-notes" : ""}`} ref={textRef}>
            <p className="ch-doc-p">{docParts(m, (k) => at(plan.mark[k]), (k) => at(plan.note[k]))}</p>
            <InkLayer geo={geo} marks={m.marks} markOn={(k) => at(plan.mark[k])} keyOn={(k) => at(plan.key[k])} slow={t.slow} />
            {m.marks.length > 0 && <span className={`ch-beam${scanning ? " is-on" : ""}`} style={{ transform: `translateY(${Math.round(beamY)}px)` }} aria-hidden />}
          </div>
        </div>
      ) : (
        <p className="ch-empty">No document or message on this card; its evidence is bank records and your settings.</p>
      )}
      {m.marks.length > 0 && (
        <p className="ch-note">
          {m.marks.length} {m.marks.length === 1 ? "passage" : "passages"} marked automatically. {m.kind === "message" ? "Message" : "Document"} text is quoted as evidence, never trusted for payment details.
        </p>
      )}
    </Body>
  );

  const item = (it: ChainItem, i: number) => {
    const tone = it.n ? (m.marks[it.n - 1]?.tone ?? "warn") : it.trusted ? "info" : "warn";
    return (
      <li key={it.key} data-item={i} className={`ch-item tone-${tone}${it.trusted ? " ch-item-trusted" : " ch-item-untrusted"}${at(plan.land[i]) ? " is-on" : ""}`}>
        <span className={`ch-item-n${it.n ? "" : " ch-item-n-plain"}`} aria-hidden>
          {it.n ?? (it.trusted ? <Check /> : <span className="ch-item-dot" />)}
        </span>
        <span className="ch-item-main">
          <span className="ch-item-label num">
            {it.n && <span className="visually-hidden">Highlight {it.n}: </span>}
            {it.label}
          </span>
          <span className="ch-item-meta">
            <OriginTag item={it} />
            {sourceKind(it.source) && (
              <span className="ch-item-src" title={it.source}>
                {sourceKind(it.source)}
              </span>
            )}
          </span>
        </span>
      </li>
    );
  };
  const shownItems = m.items.slice(0, 8);
  const evidenceBody = (
    <Body late={false}>
      <ol className="ch-items" ref={listRef}>
        {shownItems.map((it, i) => item(it, i))}
      </ol>
      {m.items.length > shownItems.length && <p className="ch-note">+{m.items.length - shownItems.length} more on the card</p>}
      <p className="ch-legend ch-rise" style={rise(0)}>
        <span className="ch-key ch-key-warm" aria-hidden /> {untrusted.length} from text, not trusted
        {trusted.length > 0 && (
          <>
            <span className="ch-key ch-key-cool" aria-hidden /> {trusted.length} from your records
          </>
        )}
      </p>
    </Body>
  );

  const c = m.calc;
  const calcBody = (
    <Body late={false}>
      {c.caption && (
        <p className="ch-calc-cap ch-rise" style={rise(0)}>
          {c.caption}
        </p>
      )}
      {c.terms.length > 0 ? (
        <div className="ch-formula" role="group" aria-label="Formula" ref={formulaRef}>
          {c.terms.map((term, i) => (
            <span key={i} className="ch-term-wrap">
              <span data-term={i} className={`ch-term${at(plan.term[i]) ? " is-on" : ""}`}>
                <span className="ch-term-num num">{term.text}</span>
                {term.note && <span className="ch-term-note">{term.note}</span>}
                {term.from && (
                  <span className={`ch-term-from${term.from.trusted ? " cool" : " warm"}`} title={term.from.label}>
                    {term.from.n ? `#${term.from.n} ` : ""}
                    {ORIGIN[term.from.origin]?.label ?? term.from.origin}
                  </span>
                )}
              </span>
              {c.ops[i] && (
                <span className={`ch-op${at(plan.term[i + 1]) ? " is-on" : ""}`} aria-label={c.ops[i] === "×" ? "times" : c.ops[i] === "+" ? "plus" : c.ops[i]}>
                  {c.ops[i]}
                </span>
              )}
            </span>
          ))}
          {c.result && (
            <span className="ch-term-wrap">
              <span className={`ch-op${now >= plan.result ? " is-on" : ""}`} aria-label="equals">
                =
              </span>
              <span className={`ch-term ch-result${now >= plan.result ? " is-on" : ""}`}>
                <span className="ch-term-num num">
                  <Count value={c.result.value} unit={c.result.unit} run={now >= plan.result} />
                </span>
                {c.result.label && <span className="ch-term-note">{c.result.label}</span>}
              </span>
            </span>
          )}
        </div>
      ) : (
        <>
          {c.result && (
            <p className={`ch-big ch-result-solo${now >= plan.result ? " is-on" : ""}`}>
              <span className="ch-big-num num">
                <Count value={c.result.value} unit={c.result.unit} run={now >= plan.result} />
                {c.result.unit === "score" && <span className="ch-of">/100</span>}
              </span>
              {c.result.label && <span className="ch-term-note">{c.result.label}</span>}
            </p>
          )}
          {c.sentence && (
            <p className="ch-sentence num ch-rise" style={rise(1)}>
              {withNumbers(c.sentence)}
            </p>
          )}
          {!c.result && !c.sentence && <p className="ch-empty">No calculation on this card.</p>}
        </>
      )}
      {c.citation && (
        <p className="ch-cite ch-rise" style={rise(3)}>
          <span className="ev-chip ev-chip-reference">Official source</span>{" "}
          {c.citation.url ? (
            <a href={c.citation.url} target="_blank" rel="noreferrer noopener" className="ch-cite-link">
              {c.citation.title}
              {c.citation.host && <span className="ch-cite-host">, {c.citation.host}</span>} <ExternalLink aria-hidden />
            </a>
          ) : (
            <span>{c.citation.title}</span>
          )}
        </p>
      )}
    </Body>
  );

  const actionBody = (
    <Body late={done}>
      {m.action ? (
        <>
          <p className="ch-action ch-rise num" style={rise(0)}>
            {describeCall(m.action)}
          </p>
          <dl className="ch-args ch-rise" style={rise(1)}>
            {Object.entries(m.action.args)
              .filter(([k, v]) => k !== "memo" && v !== undefined && v !== null && String(v) !== "")
              .slice(0, 4)
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{fieldLabel(k)}</dt>
                  <dd className="num">{fieldDisplay(k, String(v))}</dd>
                </div>
              ))}
          </dl>
          {m.action.byMessage && (
            <p className="ch-warn ch-rise" style={rise(2)}>
              <MessageSquareWarning aria-hidden /> Its account and amount appear only in the message.
            </p>
          )}
        </>
      ) : (
        <p className="ch-empty">No action proposed. {m.kind === "message" ? "The safe move is not to pay." : ""}</p>
      )}
    </Body>
  );

  const badge =
    p.verdict === "ask" && p.code === "approved" ? (
      <VerdictBadge verdict="allow" large label="Approved" />
    ) : p.verdict === "ask" && p.code === "declined" ? (
      <VerdictBadge verdict="deny" large label="Not approved" />
    ) : p.verdict ? (
      <VerdictBadge verdict={p.verdict} large />
    ) : (
      <span className="badge badge-neutral">SkillGate</span>
    );
  const permBody = (
    <div className="ch-perm">
      <Gate state={gateState} />
      <Body key={`${p.state}|${p.code ?? ""}|${p.verdict ?? ""}`} late={done}>
        {p.state === "pending" ? (
          <>
            <p className="ch-headline">{p.headline}</p>
            {p.note && <p className="ch-empty">{p.note}</p>}
          </>
        ) : (
          <>
            <p className="ch-verdict ch-rise" style={rise(0)}>
              {badge}
              {p.total > 0 && (
                <span className="ch-count num">
                  {p.passed.length} of {p.total} rules passed
                </span>
              )}
            </p>
            <p className={`ch-headline ch-headline-${p.state} ch-rise`} style={rise(1)}>
              {p.headline}
            </p>
            {p.code && (
              <p className={`ch-bind ch-bind-${p.code} ch-rise`} style={rise(2)}>
                <span className="ch-bind-code">
                  <KeyRound aria-hidden /> {p.code === "waiting" ? "Your code" : p.code === "approved" ? "Code accepted" : "Code refused"}
                </span>
                <svg className="ch-bind-link" viewBox="0 0 44 14" aria-hidden focusable="false">
                  <path d="M3 7C13 1.5 31 12.5 41 7" pathLength={1} />
                  <circle cx="3" cy="7" r="2.2" />
                  <circle cx="41" cy="7" r="2.2" />
                </svg>
                <span className="ch-bind-hash mono" title={p.actionHash ? `Action hash ${p.actionHash}` : undefined}>
                  <Hash aria-hidden /> {p.actionHash ? shortHash(p.actionHash) : "this action"}
                </span>
                <span className="visually-hidden">The code is bound to this exact action.</span>
              </p>
            )}
            {(blockingShown.length > 0 || passedShown.length > 0) && <Rules reasons={[...blockingShown, ...passedShown]} more={morePassed} />}
          </>
        )}
      </Body>
    </div>
  );

  const approvalHash = step?.approval?.actionHash;
  const receiptBody = (
    <Body key={`${r.state}|${r.id ?? ""}`} late={done}>
      {r.id && step?.receipt ? (
        <>
          <div className="ch-receipt-row">
            <div className="ch-rise" style={rise(0)}>
              <ReceiptDetail receipt={step.receipt} values={false} />
            </div>
            <Seal hash={r.actionHash} />
          </div>
          {approvalHash && r.actionHash && (
            <p className={`ch-match${approvalHash === r.actionHash ? "" : " ch-mismatch"}`}>
              {approvalHash === r.actionHash ? <Link2 aria-hidden className="ch-match-link" /> : <OctagonX aria-hidden />}
              {approvalHash === r.actionHash ? "Same hash as the action you approved" : "Hash differs from the approved action"}
            </p>
          )}
        </>
      ) : (
        <p className={r.state === "pending" ? "ch-empty" : `ch-headline ch-headline-${r.state} ch-rise`} style={rise(0)}>
          {r.state === "pending" ? (p.state === "stopped" ? r.headline : "A receipt with the action hash closes the chain.") : r.headline}
        </p>
      )}
    </Body>
  );

  const words: Record<StationId, string | null> = {
    source: m.marks.length ? `${m.marks.length} marked` : null,
    evidence: m.items.length ? `${m.items.length} ${m.items.length === 1 ? "piece" : "pieces"}` : null,
    calc: c.terms.length || c.result ? "Computed" : null,
    action: m.action ? "Proposed" : null,
    permission: p.state === "active" ? (p.code === "waiting" ? "Needs your code" : "Checking") : p.state === "done" ? (p.code === "approved" ? "Approved" : "Allowed") : p.state === "stopped" ? "Stopped" : null,
    receipt: r.state === "done" ? "Sealed" : r.state === "stopped" ? "Stopped" : r.state === "active" ? "Running" : null,
  };

  return (
    <section
      ref={ref}
      className={`ch ch-kind-${m.kind} ch-tone-${finding.tone}${done ? " is-done" : ""}${now < 0 ? " is-idle" : ""}${still ? " is-still" : ""} ${className}`}
      aria-label={`Evidence chain: ${finding.title}`}
    >
      <header className="ch-head">
        <div className="ch-head-main">
          <h3 className="ch-title">
            <Waypoints aria-hidden /> Evidence chain
            {sample && <span className="ch-sample">Sample data</span>}
            {!sample && finding.simulated && <span className="sim-tag">Simulated</span>}
          </h3>
          <p className="ch-sub">
            From the {m.kind === "message" ? "message" : m.kind === "document" ? "document" : "records"} to {ends}: every number and every step traced.
          </p>
        </div>
        <button type="button" className="btn btn-sm ch-replay" onClick={replay} disabled={now >= 0 && !done && !still} aria-label="Replay the evidence chain">
          <RotateCcw aria-hidden /> Replay
        </button>
      </header>
      <ol className="ch-stations">
        {station("source", 1, words.source, sourceBody)}
        {station("evidence", 2, words.evidence, evidenceBody)}
        {station("calc", 3, words.calc, calcBody)}
        {station("action", 4, words.action, actionBody)}
        {station("permission", 5, words.permission, permBody)}
        {station("receipt", 6, words.receipt, receiptBody)}
      </ol>
      <svg ref={flyRef} className="ch-fly-layer" aria-hidden focusable="false" />
      {Particles && (done ? liveFx : fx) && (
        <Quiet>
          <Particles {...(done ? liveFx : fx)!} intensity={phone ? 0.3 : 0.7} className="ch-particles" />
        </Quiet>
      )}
      <p className="visually-hidden" aria-live="polite" aria-atomic="true">
        {said}
      </p>
    </section>
  );
}

function docParts(m: ChainModel, on: (k: number) => boolean, noteOn: (k: number) => boolean): ReactNode[] {
  const text = m.text ?? "";
  const out: ReactNode[] = [];
  let at = 0;
  m.marks.forEach((mk, k) => {
    if (mk.start > at) out.push(text.slice(at, mk.start));
    const passage = text.slice(mk.start, mk.end);
    const key = mk.key;
    out.push(
      <mark key={`m${k}`} data-mark={k} className={`ch-mark tone-${mk.tone}${on(k) ? " is-on" : ""}`}>
        <span className="ch-mark-n" aria-hidden>
          {mk.n}
        </span>
        <span className="visually-hidden">
          Highlight {mk.n}, {mk.label}:{" "}
        </span>
        <span className="ch-mark-text" data-mark-text={k}>
          {key ? (
            <>
              {passage.slice(0, key.start)}
              <span className="ch-figure" data-key={k}>
                {passage.slice(key.start, key.end)}
              </span>
              {passage.slice(key.end)}
            </>
          ) : (
            passage
          )}
        </span>
      </mark>,
      <span key={`n${k}`} className={`ch-mnote tone-${mk.tone}${noteOn(k) ? " is-on" : ""}`} aria-hidden>
        {mk.note}
      </span>,
    );
    at = mk.end;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}
