import { CircleCheck, Clock, LoaderCircle, OctagonX } from "lucide-react";
import type { ActionState } from "../../lib/status.ts";

const ICON = { done: CircleCheck, waiting: Clock, stopped: OctagonX, checking: LoaderCircle, unknown: Clock } as const;

export function ActionStatus({ state, title }: { state: ActionState; title?: string }) {
  const Icon = ICON[state.kind];
  return (
    <div className={`act act-${state.kind}`} role="status">
      <Icon className={`act-icon${state.kind === "checking" ? " spin" : ""}`} aria-hidden />
      <span className="act-body">
        {title && <span className="act-title num">{title}</span>}
        <span className="act-text">{state.text}</span>
      </span>
    </div>
  );
}
