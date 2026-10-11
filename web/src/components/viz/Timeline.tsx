import type { Viz } from "@contracts";
import { formatValue, shortDate } from "./format.ts";
import { CountUp, stagger, VizFrame } from "./motion.tsx";

export type TimelineViz = Extract<Viz, { kind: "timeline" }>;

export function Timeline({ viz, compact = false }: { viz: TimelineViz; compact?: boolean }) {
  const items = compact ? viz.items.slice(0, 3) : viz.items;
  const label = `Timeline. ${items.map((x) => `${shortDate(x.date)}: ${x.label}${x.amount === undefined ? "" : ` ${formatValue(x.amount, "usd")}`}`).join("; ")}.`;
  return (
    <VizFrame className={`viz-timeline${compact ? " viz-compact" : ""}`} label={label}>
      <span className="viz-tl-line" aria-hidden />
      <ol>
        {items.map((x, i) => (
          <li key={`${x.date}-${i}`} className="viz-tl-item" style={stagger(i)}>
            <span className="viz-tl-date num">{shortDate(x.date)}</span>
            <span className={`viz-tl-dot tone-${x.tone ?? "brand"}`} aria-hidden />
            <span className="viz-tl-label">{x.label}</span>
            {x.amount !== undefined && <CountUp className="viz-tl-amount" value={x.amount} unit="usd" delay={i * 160} />}
          </li>
        ))}
      </ol>
      {compact && viz.items.length > items.length && <p className="viz-more faint">+{viz.items.length - items.length} more</p>}
    </VizFrame>
  );
}
