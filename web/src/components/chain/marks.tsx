import { Component, useEffect, useState, type ComponentType, type ReactNode } from "react";

export type GateState = "idle" | "checking" | "waiting" | "allowed" | "locked";

export function Gate({ state }: { state: GateState }) {
  return (
    <svg className={`ch-gate ch-gate-${state}`} viewBox="0 0 56 56" aria-hidden focusable="false">
      <circle className="ch-gate-halo" cx="28" cy="28" r="23" />
      <circle className="ch-gate-track" cx="28" cy="28" r="22" />
      <circle className="ch-gate-ring" cx="28" cy="28" r="22" pathLength={100} />
      <g className="ch-gate-dots">
        <circle cx="21" cy="28" r="2" />
        <circle cx="28" cy="28" r="2" />
        <circle cx="35" cy="28" r="2" />
      </g>
      <g className="ch-gate-key">
        <circle cx="22.5" cy="28" r="4.6" />
        <path d="M27.1 28h10.4M34 28v3.6M30.6 28v2.6" />
      </g>
      <path className="ch-gate-check" d="M19 28.6l6.2 6.2 12.2-13.2" pathLength={1} />
      <g className="ch-gate-lock">
        <path className="ch-gate-shackle" d="M22.5 27v-4.2a5.5 5.5 0 0 1 11 0V27" />
        <rect x="19.5" y="26.5" width="17" height="12.5" rx="2.6" />
      </g>
    </svg>
  );
}

export function Seal({ hash }: { hash?: string }) {
  return (
    <span className="ch-seal" aria-hidden>
      <svg viewBox="0 0 88 88" focusable="false">
        <circle className="ch-seal-o" cx="44" cy="44" r="40" />
        <circle className="ch-seal-i" cx="44" cy="44" r="33" />
        <text className="ch-seal-t" x="44" y="42" textAnchor="middle">
          SEALED
        </text>
        {hash && (
          <text className="ch-seal-h" x="44" y="56" textAnchor="middle">
            {hash.slice(0, 8)}
          </text>
        )}
      </svg>
    </span>
  );
}

export type ParticleMode = "idle" | "gather" | "stream" | "scan" | "pass" | "stop" | "burst";
export type ParticleTone = "trusted" | "untrusted" | "ok" | "warn" | "bad" | "neutral";
export interface ParticleProps {
  mode: ParticleMode;
  tone?: ParticleTone;
  from?: string | Element;
  to?: string | Element;
  intensity?: number;
  className?: string;
}

const FIELD = import.meta.glob<Record<string, unknown>>("../particles/ParticleField.tsx");

export function useParticleField(): ComponentType<ParticleProps> | null {
  const [comp, setComp] = useState<ComponentType<ParticleProps> | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const k of Object.keys(FIELD)) {
        try {
          const c = (await FIELD[k]!()).ParticleField;
          if (c && (typeof c === "function" || typeof c === "object")) {
            if (live) setComp(() => c as ComponentType<ParticleProps>);
            return;
          }
        } catch {
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  return comp;
}

export class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
