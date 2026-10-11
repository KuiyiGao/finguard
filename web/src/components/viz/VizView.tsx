import type { Viz } from "@contracts";
import { Bars } from "./Bars.tsx";
import { Clauses } from "./Clauses.tsx";
import { Compare } from "./Compare.tsx";
import { Curve } from "./Curve.tsx";
import { Donut } from "./Donut.tsx";
import { Gauge } from "./Gauge.tsx";
import { Timeline } from "./Timeline.tsx";
import "./viz.css";

export function VizView({ viz, compact = false }: { viz: Viz; compact?: boolean }) {
  switch (viz.kind) {
    case "bars":
      return <Bars viz={viz} compact={compact} />;
    case "compare":
      return <Compare viz={viz} compact={compact} />;
    case "gauge":
      return <Gauge viz={viz} compact={compact} />;
    case "timeline":
      return <Timeline viz={viz} compact={compact} />;
    case "curve":
      return <Curve viz={viz} compact={compact} />;
    case "donut":
      return <Donut viz={viz} compact={compact} />;
    case "clauses":
      return <Clauses viz={viz} compact={compact} />;
    default:
      return null;
  }
}

export { Bars, Clauses, Compare, Curve, Donut, Gauge, Timeline };
export { CountUp } from "./motion.tsx";
