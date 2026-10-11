import { Check, Minus, X } from "lucide-react";
import type { ToolStep } from "../lib/turns.ts";
import "./pipeline.css";

type StageState = "done" | "active" | "fail" | "skip";

export function stagesOf(step: ToolStep): { label: string; state: StageState }[] {
  const d = step.decision;
  const a = step.approval;
  const checked: StageState = !d ? "active" : d.verdict === "deny" ? "fail" : "done";
  let approved: { label: string; state: StageState };
  if (!d || d.verdict === "deny") approved = { label: "Approval", state: "skip" };
  else if (d.verdict === "allow") approved = { label: "Within limits", state: "done" };
  else if (!a || a.status === "pending") approved = { label: "Your code", state: "active" };
  else approved = { label: "Your code", state: a.status === "approved" ? "done" : "fail" };
  const blocked = checked === "fail" || approved.state === "fail";
  const executed: StageState = step.executed ? (step.executed.ok ? "done" : "fail") : blocked ? "skip" : approved.state === "done" ? "active" : "skip";
  return [
    { label: "Proposed", state: "done" },
    { label: "SkillGate", state: checked },
    approved,
    { label: "Executed", state: executed },
    { label: "Receipt", state: step.receipt ? "done" : blocked || executed === "fail" ? "skip" : executed === "done" ? "active" : "skip" },
  ];
}

const ICON = { done: Check, fail: X, skip: Minus, active: null } as const;

export function Pipeline({ step, compact = false, animate = false }: { step: ToolStep; compact?: boolean; animate?: boolean }) {
  const stages = stagesOf(step);
  return (
    <ol className={`pipeline${compact ? " pipeline-compact" : ""}${animate ? " pipeline-animate" : ""}`} aria-label="Action progress">
      {stages.map((s, i) => {
        const Icon = ICON[s.state];
        return (
          <li key={i} className={`stage stage-${s.state}`} style={{ "--i": i } as React.CSSProperties}>
            <span className="stage-dot" aria-hidden>
              {Icon ? <Icon size={11} strokeWidth={3} /> : null}
            </span>
            <span className="stage-label">
              {s.label}
              <span className="visually-hidden">: {s.state === "done" ? "done" : s.state === "fail" ? "stopped" : s.state === "active" ? "in progress" : "not reached"}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
