import type { Viz } from "@contracts";
import { formatValue } from "./format.ts";
import { CountUp, stagger, VizFrame } from "./motion.tsx";

export type BarsViz = Extract<Viz, { kind: "bars" }>;

export function Bars({ viz, compact = false }: { viz: BarsViz; compact?: boolean }) {
  const items = compact && viz.items.length > 5 ? [...viz.items.slice(0, 4), viz.items[viz.items.length - 1]!] : viz.items;
  const max = Math.max(0, ...items.map((x) => Math.abs(x.value))) || 1;
  const label = `Bar chart. ${items.map((x) => `${x.label}: ${formatValue(x.value, viz.unit)}`).join("; ")}.`;
  return (
    <VizFrame className={`viz-bars${compact ? " viz-compact" : ""}`} label={label}>
      {items.map((x, i) => {
        const pct = (Math.abs(x.value) / max) * 100;
        return (
          <div key={`${x.label}-${i}`} className="viz-bar" style={stagger(i)}>
            <div className="viz-bar-head">
              <span className="viz-bar-label">{x.label}</span>
              <CountUp className="viz-bar-value" value={x.value} unit={viz.unit} delay={i * 90} />
            </div>
            <div className="viz-track">
              <div className={`viz-fill tone-${x.tone ?? "brand"}`} style={{ width: x.value ? `max(3px, ${pct}%)` : 0 }} />
            </div>
          </div>
        );
      })}
    </VizFrame>
  );
}
