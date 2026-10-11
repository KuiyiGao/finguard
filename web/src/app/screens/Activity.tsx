import { ReceiptText } from "lucide-react";
import { useEffect, useRef } from "react";
import { StepRow } from "../../components/evidence/StepRow.tsx";
import { timeAgo } from "../../lib/format.ts";
import { isMoneyStep } from "../../lib/turns.ts";
import type { AppCtx } from "../CustomerApp.tsx";

export function ActivityScreen({ ctx, openId }: { ctx: AppCtx; openId?: string }) {
  const steps = [...ctx.steps.values()].filter((s) => isMoneyStep(s) && s.decision && (s.receipt || s.decision.verdict === "deny" || s.approval)).reverse();
  const scrolled = useRef<string | null>(null);

  useEffect(() => {
    if (!openId || scrolled.current === openId) return;
    const row = document.getElementById(`act-${openId}`);
    if (!row) return;
    scrolled.current = openId;
    row.scrollIntoView({ block: "center" });
  });

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Activity</h1>
        <p className="faint">Every money action has a receipt. Open one to see who authorized it and where each value came from.</p>
      </header>
      {steps.length === 0 ? (
        <div className="empty card empty-block">
          <ReceiptText aria-hidden className="empty-icon" />
          <p>No money actions yet.</p>
        </div>
      ) : (
        <ul className="stack plain">
          {steps.map((s) => (
            <li key={s.call.id} id={`act-${s.call.id}`} className="card">
              <StepRow step={s} meta={timeAgo(s.ts, ctx.now)} open={s.call.id === openId} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
