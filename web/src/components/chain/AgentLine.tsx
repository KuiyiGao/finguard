import type { AgentRole, Finding, TraceEvent } from "@contracts";
import { ChevronDown, Clapperboard } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useMemo, useState } from "react";
import { BRAND } from "../../lib/brand.ts";
import type { ActionState } from "../../lib/status.ts";
import { turnById, type ToolStep } from "../../lib/turns.ts";
import { outfitOf, SPRITE_LABEL, StewardGlyph } from "../pixel/Sprite.tsx";
import { AgentTheater, TheaterSheet } from "../theater/AgentTheater.tsx";
import { ChainLoading, ChainSheet } from "./ChainControl.tsx";

const EvidenceChain = lazy(() => import("./EvidenceChain.tsx").then((m) => ({ default: m.EvidenceChain })));

const PHONE = "(max-width: 639px)";
const isPhone = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE).matches;

export function AgentLine({ finding, agent, events, step, steps, status }: { finding: Finding; agent: AgentRole; events?: TraceEvent[]; step?: ToolStep; steps?: Map<string, ToolStep>; status?: ActionState }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState(isPhone);
  const regionId = useId();
  useEffect(() => {
    if (open) setPhone(isPhone());
  }, [open]);
  const turn = useMemo(() => (open && finding.turnId && events ? turnById(events, finding.turnId) : undefined), [open, finding.turnId, events]);
  const name = SPRITE_LABEL[agent] ?? agent;
  return (
    <>
      <p className="ev-agent">
        <StewardGlyph outfit={outfitOf(agent)} size={14} className="ev-agent-glyph" />
        <span className="ev-agent-text">
          Found by <strong>{BRAND}</strong>, {name}
        </span>
        <button type="button" className="btn btn-ghost btn-sm ev-agent-how" aria-expanded={open} aria-controls={phone ? undefined : regionId} onClick={() => setOpen(!open)}>
          <Clapperboard aria-hidden /> How {BRAND} found this
          {!phone && <ChevronDown aria-hidden className={open ? "flip" : undefined} />}
        </button>
      </p>
      {open && !phone && (
        <div id={regionId} className="ch-inline">
          {turn ? (
            <AgentTheater turn={turn} autoPlay />
          ) : (
            <Suspense fallback={<ChainLoading />}>
              <EvidenceChain finding={finding} step={step} steps={steps} status={status} />
            </Suspense>
          )}
        </div>
      )}
      {open && phone && (turn ? <TheaterSheet turn={turn} onClose={() => setOpen(false)} /> : <ChainSheet finding={finding} step={step} steps={steps} status={status} onClose={() => setOpen(false)} />)}
    </>
  );
}
