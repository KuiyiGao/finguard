import type { Viz } from "@contracts";
import { formatValue } from "./format.ts";
import { CountUp, VizFrame } from "./motion.tsx";

export type GaugeViz = Extract<Viz, { kind: "gauge" }>;

const ARC = "M 20 100 A 80 80 0 0 1 180 100";

export function Gauge({ viz, compact = false }: { viz: GaugeViz; compact?: boolean }) {
  const max = viz.max > 0 ? viz.max : 100;
  const pct = Math.max(0, Math.min(1, viz.value / max)) * 100;
  const tone = viz.tone ?? "brand";
  const label = `Gauge. ${viz.label}: ${formatValue(viz.value, "number")} of ${formatValue(max, "number")}.`;
  if (compact)
    return (
      <VizFrame className="viz-meter" label={label}>
        <div className="viz-bar-head">
          <span className="viz-bar-label">{viz.label}</span>
          <span className="viz-bar-value num">
            <CountUp value={viz.value} unit="number" /> <span className="faint">of {formatValue(max, "number")}</span>
          </span>
        </div>
        <div className="viz-track">
          <div className={`viz-fill tone-${tone}`} style={{ width: `${pct}%` }} />
        </div>
      </VizFrame>
    );
  return (
    <VizFrame className="viz-gauge" label={label}>
      <div className="viz-gauge-dial">
        <svg viewBox="0 0 200 112" aria-hidden>
          <path className="viz-gauge-track" d={ARC} pathLength={100} />
          {pct > 0 && <path className={`viz-gauge-arc tone-${tone}`} d={ARC} pathLength={100} style={{ strokeDasharray: "100 100", strokeDashoffset: 100 - pct }} />}
        </svg>
        <div className="viz-gauge-center">
          <CountUp className="viz-gauge-value" value={viz.value} unit="number" duration={1100} />
          <span className="viz-gauge-max num">of {formatValue(max, "number")}</span>
        </div>
      </div>
      <p className="viz-gauge-label">{viz.label}</p>
    </VizFrame>
  );
}
