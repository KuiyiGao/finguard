import type { ApprovalRequest } from "@contracts";
import { Clock } from "lucide-react";
import { useRef, type CSSProperties } from "react";
import { plainIds } from "../../lib/describe.ts";

export const approvalTitle = (a: Pick<ApprovalRequest, "summary">) => plainIds(a.summary.split(/\.\s/)[0] ?? "");

export function ApprovalCards({ approvals, now, onOpen }: { approvals: ApprovalRequest[]; now: number; onOpen: (id: string) => void }) {
  const seen = useRef(new Map<string, number>());
  if (approvals.length === 0) return null;
  return (
    <ul className="plain apv-list" aria-label="Waiting for your approval">
      {approvals.map((a) => {
        const left = Math.max(0, Math.round((Date.parse(a.expiresAt) - now) / 1000));
        if (!seen.current.has(a.id)) seen.current.set(a.id, Math.max(left, 1));
        const share = Math.min(1, left / seen.current.get(a.id)!);
        return (
          <li key={a.id} className="card apv">
            <div className="apv-top">
              <span className="apv-kicker">
                <Clock size={13} aria-hidden /> Needs your approval
              </span>
              <span className="apv-left faint num">{left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left` : "Expired"}</span>
            </div>
            <p className="apv-title num">{approvalTitle(a)}</p>
            <button type="button" className="btn btn-primary ev-btn apv-btn" onClick={() => onOpen(a.id)}>
              Review and decide
            </button>
            <span className={`apv-bar${share < 0.25 ? " apv-bar-late" : ""}`} style={{ "--p": share } as CSSProperties} aria-hidden />
          </li>
        );
      })}
    </ul>
  );
}
