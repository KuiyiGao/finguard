import { useEffect, useRef, type CSSProperties, type JSX } from "react";
import { Field, type ParticleMode, type ParticleTone } from "./engine.ts";

export type { ParticleMode, ParticleTone } from "./engine.ts";

export interface ParticleFieldProps {
  mode: ParticleMode;
  tone?: ParticleTone;
  from?: string | HTMLElement | null;
  to?: string | HTMLElement | null;
  intensity?: number;
  className?: string;
}

const STYLE: CSSProperties = { position: "absolute", inset: 0, display: "block", width: "100%", height: "100%", pointerEvents: "none" };

export function ParticleField({ mode, tone = "neutral", from = null, to = null, intensity = 0.6, className }: ParticleFieldProps): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const field = useRef<Field | null>(null);

  useEffect(() => {
    const f = new Field(canvas.current!);
    field.current = f;
    return () => {
      f.destroy();
      if (field.current === f) field.current = null;
    };
  }, []);

  useEffect(() => {
    field.current?.set({ mode, tone, from, to, intensity });
  }, [mode, tone, from, to, intensity]);

  return <canvas ref={canvas} className={className ? `pf-canvas ${className}` : "pf-canvas"} style={STYLE} aria-hidden="true" />;
}
