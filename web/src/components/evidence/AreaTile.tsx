import type { AreaSummary } from "@contracts";
import { ChevronRight, Wallet } from "lucide-react";
import { formatUsd } from "../../lib/format.ts";
import { stagger } from "../viz/motion.tsx";
import { AREA_ICON, STATUS } from "./meta.ts";
import "./evidence.css";

export function AreaTile({ area, index = 0, onOpen }: { area: AreaSummary; index?: number; onOpen?: () => void }) {
  const Icon = AREA_ICON[area.area] ?? Wallet;
  const st = STATUS[area.status] ?? STATUS.ok;
  return (
    <button type="button" className={`tile tone-${st.cls} tile-${area.status}`} style={stagger(index)} onClick={onOpen}>
      <span className="tile-top">
        <span className="tile-icon" aria-hidden>
          <Icon />
        </span>
        <span className="tile-status">
          <span className="tile-dot" aria-hidden />
          {st.label}
        </span>
      </span>
      <span className="tile-title">
        {area.title}
        <ChevronRight className="tile-chev" aria-hidden />
      </span>
      <span className="tile-headline num">{area.headline}</span>
      {area.amount && (
        <span className="tile-amount">
          <span className="tile-amount-value num">{formatUsd(area.amount.value)}</span>
          <span className="tile-amount-label">{area.amount.label}</span>
        </span>
      )}
    </button>
  );
}
