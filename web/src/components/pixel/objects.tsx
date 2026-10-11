import { useLayoutEffect, useRef, type CSSProperties } from "react";
import type { SpriteState, StageObject } from "./names.ts";
import "./mark.css";

export type GateState = "open" | "checking" | "allow" | "ask" | "locked";
export type SealState = "idle" | "working" | "pass" | "repair" | "fail";
export type PhoneState = "idle" | "working" | "sent";

function still(): boolean {
  if (typeof window === "undefined") return true;
  return (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) || document.visibilityState === "hidden";
}

const NUM = /-?\d*\.?\d+(?:e-?\d+)?/gi;

function useMorph(d: string, ms = 420) {
  const ref = useRef<SVGPathElement>(null);
  const shown = useRef(d);
  useLayoutEffect(() => {
    const el = ref.current;
    const from = shown.current;
    if (!el || from === d) return;
    const tokens = d.match(NUM) ?? [];
    const a = from.match(NUM)?.map(Number) ?? [];
    const b = tokens.map(Number);
    const parts = d.split(NUM);
    if (still() || a.length !== b.length) {
      shown.current = d;
      el.setAttribute("d", d);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      const s = 1.6;
      const e = 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
      const out = parts.map((part, i) => (i < b.length ? part + (a[i] === b[i] ? tokens[i] : (a[i]! + (b[i]! - a[i]!) * e).toFixed(2)) : part)).join("");
      shown.current = t < 1 ? out : d;
      el.setAttribute("d", shown.current);
      if (t < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [d, ms]);
  return ref;
}

const sizeStyle = (size?: number): CSSProperties | undefined => (size ? ({ "--obj-size": `${size}px` } as CSSProperties) : undefined);

export function Phone({ state = "idle", tone = "user", size, label = "Customer", className = "" }: { state?: PhoneState; tone?: "user" | "inbound"; size?: number; label?: string; className?: string }) {
  return (
    <span className={`obj obj-phone obj-${state} obj-tone-${tone} ${className}`} style={sizeStyle(size)} role="img" aria-label={label}>
      <span className="obj-halo" aria-hidden />
      <svg viewBox="0 0 48 48" aria-hidden focusable="false">
        <rect className="obj-phone-body" x="11" y="8" width="23" height="36" rx="5.5" />
        <rect className="obj-phone-screen" x="13.6" y="12" width="17.8" height="27.5" rx="2.6" />
        <rect className="obj-phone-line" x="16.4" y="30" width="11.5" height="2.2" rx="1.1" />
        <rect className="obj-phone-line" x="16.4" y="34" width="7.5" height="2.2" rx="1.1" />
        <g className="obj-bubble">
          <path className="obj-bubble-shape" d="M27 3h11a6 6 0 0 1 6 6v1a6 6 0 0 1-6 6H29l-5 4.5V15.2A6 6 0 0 1 21 10V9a6 6 0 0 1 6-6z" />
          <circle className="obj-dot" cx="27.5" cy="9.5" r="1.7" />
          <circle className="obj-dot" cx="32.5" cy="9.5" r="1.7" />
          <circle className="obj-dot" cx="37.5" cy="9.5" r="1.7" />
        </g>
      </svg>
    </span>
  );
}

const SHACKLE_OPEN = "M19 22.5V14.6A5 5 0 0 1 29 14.6V16.8";
const SHACKLE_SHUT = "M19 22.5V18.4A5 5 0 0 1 29 18.4V22.5";

export function GateRing({ state = "open", size, label = "SkillGate", className = "" }: { state?: GateState; size?: number; label?: string; className?: string }) {
  const shut = state === "ask" || state === "locked";
  const shackle = useMorph(shut ? SHACKLE_SHUT : SHACKLE_OPEN);
  return (
    <span className={`obj obj-gate obj-gate-${state} ${className}`} style={sizeStyle(size)} role="img" aria-label={label}>
      <span className="obj-halo" aria-hidden />
      <svg viewBox="0 0 48 48" aria-hidden focusable="false">
        <circle className="obj-gate-track" cx="24" cy="24" r="19" pathLength={100} />
        <circle className="obj-gate-ring" cx="24" cy="24" r="19" pathLength={100} />
        <circle className="obj-gate-scan" cx="24" cy="24" r="19" pathLength={100} />
        <g className="obj-lock">
          <path ref={shackle} className="obj-shackle" d={shut ? SHACKLE_SHUT : SHACKLE_OPEN} />
          <rect className="obj-lock-body" x="16" y="22" width="16" height="13" rx="3.2" />
          <g className="obj-glyph obj-glyph-key">
            <circle cx="24" cy="27" r="1.9" />
            <rect x="23.1" y="27.5" width="1.8" height="4.2" rx="0.9" />
          </g>
          <path className="obj-glyph obj-glyph-check obj-draw" d="M19.8 28.6l3 3 5.6-6" pathLength={1} />
          <path className="obj-glyph obj-glyph-x obj-draw" d="M20.6 25.2l6.8 6.8m0-6.8l-6.8 6.8" pathLength={1} />
          <g className="obj-glyph obj-glyph-code">
            <circle cx="19.5" cy="28.5" r="1.25" />
            <circle cx="22.5" cy="28.5" r="1.25" />
            <circle cx="25.5" cy="28.5" r="1.25" />
            <circle cx="28.5" cy="28.5" r="1.25" />
          </g>
        </g>
      </svg>
    </span>
  );
}

const ROSETTE = (() => {
  const pts: string[] = [];
  const n = 96;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 19 + 1.7 * Math.cos(a * 16);
    pts.push(`${(24 + Math.cos(a) * r).toFixed(2)} ${(24 + Math.sin(a) * r).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
})();

export function Seal({ state = "idle", size, label = "Evaluator", className = "" }: { state?: SealState; size?: number; label?: string; className?: string }) {
  return (
    <span className={`obj obj-seal obj-seal-${state} ${className}`} style={sizeStyle(size)} role="img" aria-label={label}>
      <span className="obj-halo" aria-hidden />
      <svg viewBox="0 0 48 48" aria-hidden focusable="false">
        <g className="obj-rosette">
          <path className="obj-seal-edge" d={ROSETTE} />
        </g>
        <circle className="obj-seal-inner" cx="24" cy="24" r="13" />
        <path className="obj-seal-mark obj-mark-check obj-draw" d="M17.6 24.6l4.6 4.6 8.4-9" pathLength={1} />
        <path className="obj-seal-mark obj-mark-repair obj-draw" d="M29.5 20.5A7 7 0 1 0 31 25.5m-1.5-5V16m0 4.5H25" pathLength={1} />
        <path className="obj-seal-mark obj-mark-x obj-draw" d="M19.5 19.5l9 9m0-9l-9 9" pathLength={1} />
      </svg>
    </span>
  );
}

type Status = "ok" | "warn" | "bad";

export function gateFor(state: SpriteState, status?: Status): GateState {
  if (status === "bad") return "locked";
  if (status === "warn") return "ask";
  if (status === "ok") return "allow";
  return state === "working" ? "checking" : "open";
}

export function sealFor(state: SpriteState, status?: Status): SealState {
  if (status === "bad") return "fail";
  if (status === "warn") return "repair";
  if (status === "ok") return "pass";
  return state === "working" ? "working" : "idle";
}

export function StageObjectIcon({ kind, state = "idle", status, size, label, className = "" }: { kind: StageObject; state?: SpriteState; status?: Status; size?: number; label: string; className?: string }) {
  if (kind === "skillgate") return <GateRing state={gateFor(state, status)} size={size} label={label} className={className} />;
  if (kind === "evaluator") return <Seal state={sealFor(state, status)} size={size} label={label} className={className} />;
  return <Phone state={state === "working" ? "working" : "idle"} size={size} label={label} className={className} />;
}
