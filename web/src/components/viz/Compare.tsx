import type { Viz } from "@contracts";
import { ArrowRight } from "lucide-react";
import { formatValue } from "./format.ts";
import { CountUp, stagger, VizFrame } from "./motion.tsx";

export type CompareViz = Extract<Viz, { kind: "compare" }>;

export function Compare({ viz, compact = false }: { viz: CompareViz; compact?: boolean }) {
  const max = Math.max(Math.abs(viz.before.value), Math.abs(viz.after.value)) || 1;
  const worse = viz.after.value > viz.before.value;
  const cols = [
    { key: "before", ...viz.before, tone: "muted" },
    { key: "after", ...viz.after, tone: worse ? "warn" : "ok" },
  ];
  const label = `Comparison. ${viz.before.label}: ${formatValue(viz.before.value, viz.unit)}; ${viz.after.label}: ${formatValue(viz.after.value, viz.unit)}.`;
  return (
    <VizFrame className={`viz-compare${compact ? " viz-compact" : ""}`} label={label}>
      {cols.map((c, i) => (
        <div key={c.key} className="viz-col" style={stagger(i)}>
          <CountUp className="viz-col-value" value={c.value} unit={viz.unit} delay={i * 250} />
          <div className="viz-col-track">
            <div className={`viz-col-fill tone-${c.tone}`} style={{ height: c.value ? `max(4px, ${(Math.abs(c.value) / max) * 100}%)` : 0 }} />
          </div>
          <span className="viz-col-label">{c.label}</span>
          {i === 0 && <ArrowRight className="viz-col-arrow" aria-hidden />}
        </div>
      ))}
    </VizFrame>
  );
}
