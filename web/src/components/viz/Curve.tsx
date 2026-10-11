import type { Tone, Viz } from "@contracts";
import { useId } from "react";
import { compactUsd, formatValue } from "./format.ts";
import { stagger, VizFrame } from "./motion.tsx";

export type CurveViz = Extract<Viz, { kind: "curve" }>;

const W = 320;
const PAD = { l: 38, r: 10, t: 12, b: 22 };
const DEFAULT_TONES: (Tone | "brand")[] = ["brand", "muted", "info"];

export function Curve({ viz, compact = false }: { viz: CurveViz; compact?: boolean }) {
  const gid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const H = compact ? 96 : 156;
  const series = viz.series.filter((s) => s.points.length > 0);
  const n = Math.max(2, ...series.map((s) => s.points.length));
  const all = series.flatMap((s) => s.points);
  const lo = Math.min(0, ...all);
  const hi = Math.max(lo + 1, ...all);
  const x = (i: number) => PAD.l + (i / (n - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const line = (pts: number[]) => pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const grid = compact ? [lo, hi] : [lo, lo + (hi - lo) / 2, hi];
  const toneOf = (i: number) => series[i]?.tone ?? DEFAULT_TONES[i % DEFAULT_TONES.length]!;
  const label = `Line chart over ${viz.xLabel}. ${series
    .map((s) => `${s.label}: from ${formatValue(s.points[0] ?? 0, viz.unit)} to ${formatValue(s.points[s.points.length - 1] ?? 0, viz.unit)}`)
    .join("; ")}.`;
  const first = series[0];
  return (
    <VizFrame className={`viz-curve${compact ? " viz-compact" : ""}`} label={label}>
      <svg viewBox={`0 0 ${W} ${H}`} aria-hidden>
        <defs>
          <linearGradient id={`fill${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className={`tone-${toneOf(0)} viz-stop`} stopOpacity={0.28} />
            <stop offset="100%" className={`tone-${toneOf(0)} viz-stop`} stopOpacity={0} />
          </linearGradient>
        </defs>
        {grid.map((g, i) => (
          <g key={i}>
            <line className="viz-grid" x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} />
            <text className="viz-axis" x={PAD.l - 6} y={y(g) + 3.5} textAnchor="end">
              {compactUsd(g)}
            </text>
          </g>
        ))}
        {first && first.points.length > 1 && (
          <path className="viz-area" d={`${line(first.points)} L${x(first.points.length - 1).toFixed(1)} ${y(lo).toFixed(1)} L${x(0).toFixed(1)} ${y(lo).toFixed(1)} Z`} fill={`url(#fill${gid})`} />
        )}
        {series.map((s, i) => (
          <g key={s.label} className={`tone-${toneOf(i)}`} style={stagger(i)}>
            <path className="viz-line" d={line(s.points)} pathLength={1} />
            <circle className="viz-end" cx={x(s.points.length - 1)} cy={y(s.points[s.points.length - 1] ?? 0)} r={3.5} />
          </g>
        ))}
        <text className="viz-axis" x={PAD.l} y={H - 5}>
          0
        </text>
        <text className="viz-axis viz-axis-title" x={(PAD.l + W - PAD.r) / 2} y={H - 5} textAnchor="middle">
          {viz.xLabel}
        </text>
        <text className="viz-axis" x={W - PAD.r} y={H - 5} textAnchor="end">
          {n - 1}
        </text>
      </svg>
      <ul className="viz-legend">
        {series.map((s, i) => (
          <li key={s.label}>
            <span className={`viz-swatch tone-${toneOf(i)}`} aria-hidden />
            <span className="viz-legend-label">{s.label}</span>
            <span className="viz-legend-value num">{formatValue(s.points[s.points.length - 1] ?? 0, viz.unit)}</span>
          </li>
        ))}
      </ul>
    </VizFrame>
  );
}
