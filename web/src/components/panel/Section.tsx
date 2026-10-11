import { useId, type CSSProperties, type ReactNode } from "react";

export type PanelTier = "decide" | "checked" | "autopilot";

const STEP: Record<PanelTier, number> = { decide: 1, checked: 2, autopilot: 3 };

export function PanelSection({ tier, title, hint, status, statusTitle, attention = false, children }: { tier: PanelTier; title: string; hint?: ReactNode; status?: ReactNode; statusTitle?: string; attention?: boolean; children: ReactNode }) {
  const id = useId();
  const step = STEP[tier];
  return (
    <section className={`psec psec-${tier} fg-enter`} style={{ "--i": step - 1 } as CSSProperties} aria-labelledby={id}>
      <header className="psec-head">
        <span className="psec-step num" aria-hidden>
          {step}
        </span>
        <h2 id={id} className="psec-title">
          {title}
        </h2>
        {status && (
          <span className={`psec-status num${attention ? " psec-status-attn" : ""}`} title={statusTitle}>
            {status}
          </span>
        )}
        {hint && <p className="psec-hint muted">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

export function waitingLabel(approvals: number, card: boolean): string {
  const n = approvals > 0 ? approvals : card ? 1 : 0;
  return n === 0 ? "Nothing waiting" : `${n} waiting`;
}

export const clock = (ts: string | number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
