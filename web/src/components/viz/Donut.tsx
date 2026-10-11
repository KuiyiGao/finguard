import type { Viz } from "@contracts";
import { formatValue } from "./format.ts";
import { CountUp, stagger, VizFrame } from "./motion.tsx";

export type DonutViz = Extract<Viz, { kind: "donut" }>;

const PALETTE = 6;

export function Donut({ viz, compact = false }: { viz: DonutViz; compact?: boolean }) {
  const items = viz.items.filter((x) => x.value > 0);
  const total = items.reduce((s, x) => s + x.value, 0) || 1;
  const gap = items.length > 1 ? 1.2 : 0;
  let start = 0;
  const segs = items.map((x, i) => {
    const len = (x.value / total) * 100;
    const seg = { ...x, i, start, len: Math.max(0.01, len - gap) };
    start += len;
    return seg;
  });
  const top = items.reduce<(typeof items)[number] | undefined>((a, b) => (!a || b.value > a.value ? b : a), undefined);
  const label = `Donut chart. ${items.map((x) => `${x.label}: ${formatValue(x.value, viz.unit)}`).join("; ")}.`;
  return (
    <VizFrame className={`viz-donut${compact ? " viz-compact" : ""}`} label={label}>
      <div className="viz-donut-body">
        <div className="viz-donut-ring">
          <svg viewBox="0 0 120 120" aria-hidden>
            <circle className="viz-donut-track" cx="60" cy="60" r="46" />
            {segs.map((s) => (
              <circle
                key={`${s.label}-${s.i}`}
                className={`viz-seg pal-${s.i % PALETTE}`}
                cx="60"
                cy="60"
                r="46"
                pathLength={100}
                style={{ ...stagger(s.i), strokeDasharray: `${s.len} ${100 - s.len}`, strokeDashoffset: -s.start }}
              />
            ))}
          </svg>
          {top && !compact && (
            <div className="viz-donut-center">
              <CountUp className="viz-donut-value" value={top.value} unit={viz.unit} />
              <span className="viz-donut-caption">{top.label}</span>
            </div>
          )}
        </div>
        <ul className="viz-legend">
          {items.map((x, i) => (
            <li key={`${x.label}-${i}`} style={stagger(i)}>
              <span className={`viz-swatch pal-${i % PALETTE}`} aria-hidden />
              <span className="viz-legend-label">{x.label}</span>
              <span className="viz-legend-value num">{formatValue(x.value, viz.unit)}</span>
            </li>
          ))}
        </ul>
      </div>
    </VizFrame>
  );
}
