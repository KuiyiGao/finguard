import { ChevronRight } from "lucide-react";
import { BRAND } from "../../lib/brand.ts";
import { FinGuard } from "../pixel/Sprite.tsx";

const PROMPTS = ["Pay my Duke Energy bill", "Move $200 to savings"];

export function AgentBar({ onAsk, onForward }: { onAsk: (text?: string) => void; onForward: () => void }) {
  return (
    <section className="agent-bar card fg-enter" aria-label={`Ask ${BRAND}`}>
      <button type="button" className="agent-ask" onClick={() => onAsk()}>
        <span className="agent-mark" aria-hidden>
          <FinGuard size={40} label={BRAND} />
        </span>
        <span className="agent-ask-text">
          <strong>Ask {BRAND}</strong>
          <span>Payments, scam checks and transfers, each reviewed by SkillGate.</span>
        </span>
        <ChevronRight aria-hidden className="agent-chev" />
      </button>
      <div className="agent-chips" role="group" aria-label="Try one">
        <button type="button" className="agent-chip" onClick={() => onAsk(PROMPTS[0])}>
          {PROMPTS[0]}
        </button>
        <button type="button" className="agent-chip agent-chip-warn" onClick={onForward}>
          Is this message real?
        </button>
        <button type="button" className="agent-chip" onClick={() => onAsk(PROMPTS[1])}>
          {PROMPTS[1]}
        </button>
      </div>
    </section>
  );
}
