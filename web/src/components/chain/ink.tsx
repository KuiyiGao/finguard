import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import type { Mark } from "./model.ts";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface InkGeo {
  w: number;
  h: number;
  lines: Box[][];
  keys: (Box | null)[];
}

const rel = (r: DOMRect, base: DOMRect): Box => ({ x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });

export function useInkGeometry(ref: RefObject<HTMLElement | null>, marks: Mark[]): InkGeo | null {
  const [geo, setGeo] = useState<InkGeo | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const base = el.getBoundingClientRect();
      const lines = marks.map((_, k) => {
        const t = el.querySelector(`[data-mark-text="${k}"]`);
        if (!t) return [];
        const out: Box[] = [];
        for (const r of Array.from(t.getClientRects())) {
          if (r.width < 2) continue;
          const b = rel(r, base);
          const last = out[out.length - 1];
          if (last && Math.abs(last.y - b.y) < 3) {
            const x0 = Math.min(last.x, b.x);
            const x1 = Math.max(last.x + last.w, b.x + b.w);
            last.x = x0;
            last.w = x1 - x0;
            last.h = Math.max(last.h, b.h);
          } else out.push(b);
        }
        return out;
      });
      const keys = marks.map((_, k) => {
        const kEl = el.querySelector(`[data-key="${k}"]`);
        return kEl ? rel(kEl.getBoundingClientRect(), base) : null;
      });
      setGeo({ w: el.clientWidth, h: el.scrollHeight, lines, keys });
    };
    measure();
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    ro?.observe(el);
    void document.fonts?.ready.then(schedule);
    return () => {
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref, marks]);
  return geo;
}

function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const f = (n: number) => n.toFixed(1);

export function strokePath(b: Box, seed: number): { d: string; width: number } {
  const width = Math.max(9, b.h * 0.8);
  const x0 = b.x + width * 0.22;
  const x1 = b.x + b.w - width * 0.22;
  const cy = b.y + b.h * 0.56;
  const j = (i: number) => (rand(seed * 5 + i) - 0.5) * 2.4;
  const c1 = x0 + (x1 - x0) * 0.33;
  const c2 = x0 + (x1 - x0) * 0.7;
  return { d: `M${f(x0)} ${f(cy + j(1))}C${f(c1)} ${f(cy + j(2) * 1.4)} ${f(c2)} ${f(cy + j(3) * 1.4)} ${f(x1)} ${f(cy + j(4))}`, width };
}

export function circlePath(b: Box, seed: number): string {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const rx = b.w / 2 + 7;
  const ry = b.h / 2 + 4;
  const a0 = -2.5 + rand(seed) * 0.5;
  const n = 30;
  let d = "";
  for (let i = 0; i <= n; i++) {
    const p = i / n;
    const t = a0 + p * Math.PI * 2 * 1.13;
    const wob = 1 + 0.05 * Math.sin(t * 2 + seed) + p * 0.08;
    d += `${i ? "L" : "M"}${f(cx + rx * wob * Math.cos(t))} ${f(cy + ry * wob * Math.sin(t) - p * 1.6)}`;
  }
  return d;
}

export function underlinePath(b: Box, seed: number): string {
  const y = b.y + b.h + 1;
  const x0 = b.x - 2;
  const x1 = b.x + b.w + 3;
  return `M${f(x0)} ${f(y + (rand(seed) - 0.5) * 1.2)}Q${f((x0 + x1) / 2)} ${f(y + 3.4)} ${f(x1)} ${f(y - 0.8)}`;
}

export function InkLayer({ geo, marks, markOn, keyOn, slow }: { geo: InkGeo | null; marks: Mark[]; markOn: (k: number) => boolean; keyOn: (k: number) => boolean; slow: number }) {
  if (!geo) return null;
  return (
    <svg className="ch-ink" width={geo.w} height={geo.h} viewBox={`0 0 ${geo.w} ${geo.h}`} aria-hidden focusable="false">
      {marks.map((m, k) => {
        const lines = geo.lines[k] ?? [];
        const total = lines.reduce((a, b) => a + b.w, 0) || 1;
        let acc = 0;
        const key = geo.keys[k];
        return (
          <g key={k} className={`ch-ink-mark tone-${m.tone}${markOn(k) ? " is-on" : ""}`}>
            {lines.map((b, j) => {
              const { d, width } = strokePath(b, k * 7 + j);
              const style = { "--d": `${Math.round((acc / total) * slow)}ms`, "--dur": `${Math.max(90, Math.round((b.w / total) * slow))}ms` } as CSSProperties;
              acc += b.w;
              return <path key={j} className="ch-ink-stroke" d={d} strokeWidth={width} pathLength={1} style={style} />;
            })}
            {key && m.key && <path className={`ch-ink-key${keyOn(k) ? " is-on" : ""}`} d={m.key.shape === "circle" ? circlePath(key, k + 3) : underlinePath(key, k + 3)} pathLength={1} />}
          </g>
        );
      })}
    </svg>
  );
}
