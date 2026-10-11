import type { ApprovalRequest } from "@contracts";
import { KeyRound, MessageSquareWarning, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { approvalTitle } from "../components/panel/ApprovalCards.tsx";
import { ProvenanceList, RuleList } from "../components/gate.tsx";
import { BRAND } from "../lib/brand.ts";
import { formatUsd } from "../lib/format.ts";
import type { AppCtx } from "./CustomerApp.tsx";

function Sheet({ label, children, onClose }: { label: string; children: React.ReactNode; onClose?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="sheet-backdrop">
      <div className="sheet enter" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref}>
        {onClose && (
          <button type="button" className="sheet-close btn btn-ghost btn-sm" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

export function ConsentSheet({ ctx, onLater }: { ctx: AppCtx; onLater: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statement, setStatement] = useState<string | null>(null);
  const policy = ctx.state?.policy;
  useEffect(() => {
    ctx.api.policy().then((p) => setStatement(p.statement), () => setStatement(null));
  }, [ctx.api, policy?.version]);
  if (!policy) return null;
  const own = policy.grants.find((g) => g.capability === "transfers.own");
  const agree = async () => {
    setBusy(true);
    setError(null);
    try {
      await ctx.api.consent(policy.version);
      ctx.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet label={`Agree to ${BRAND}'s limits`} onClose={onLater}>
      <div className="sheet-icon">
        <ShieldCheck size={26} />
      </div>
      <h2 className="sheet-title">Before {BRAND} moves any money</h2>
      <p className="muted">These are the limits {BRAND} works within. You can pause or change them any time.</p>
      <ul className="consent-list">
        {own && <li>Moves between your own accounts happen automatically up to {formatUsd(own.maxAmount ?? 0)}; above that it asks you.</li>}
        <li>Bills and payments to other people always need your approval with a one-time code.</li>
        <li>New payees, or anyone not saved, always need your approval.</li>
        <li>Never more than {formatUsd(policy.dailyLimit)} in a day.</li>
        <li>Payment details that only appear in a message, invoice or memo are never used.</li>
        <li>Every action gets a receipt you can check.</li>
      </ul>
      {statement && (
        <details className="consent-statement">
          <summary>Full statement (policy v{policy.version})</summary>
          <p>{statement}</p>
        </details>
      )}
      {error && <p className="error-text">{error}</p>}
      <button type="button" className="btn btn-primary btn-block" onClick={agree} disabled={busy}>
        {busy ? "Saving" : "I agree"}
      </button>
      <button type="button" className="btn btn-ghost btn-block" onClick={onLater}>
        Not now ({BRAND} will not move money)
      </button>
    </Sheet>
  );
}

export function useApprovalSheet(approvals: ApprovalRequest[] | undefined): { sheet: ApprovalRequest | undefined; open: (id: string) => void; close: (id: string) => void } {
  const [away, setAway] = useState<ReadonlySet<string>>(new Set());
  const [asked, setAsked] = useState<string | null>(null);
  const open = useCallback((id: string) => {
    setAway((was) => {
      if (!was.has(id)) return was;
      const next = new Set(was);
      next.delete(id);
      return next;
    });
    setAsked(id);
  }, []);
  const close = useCallback((id: string) => {
    setAsked((was) => (was === id ? null : was));
    setAway((was) => new Set(was).add(id));
  }, []);
  const pending = approvals ?? [];
  const sheet = pending.find((a) => a.id === asked) ?? pending.find((a) => !away.has(a.id));
  return { sheet, open, close };
}

export function ApprovalSheet({ ctx, approval, onClose }: { ctx: AppCtx; approval: ApprovalRequest; onClose?: (id: string) => void }) {
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const step = ctx.steps.get(approval.callId);
  const why = step?.decision?.reasons.filter((r) => r.verdict === "ask") ?? [];
  const left = Math.max(0, Math.round((Date.parse(approval.expiresAt) - ctx.now) / 1000));
  const total = Math.max(1, Math.round((Date.parse(approval.expiresAt) - Date.parse(step?.ts ?? approval.expiresAt)) / 1000));
  const title = approvalTitle(approval);
  const id = approval.id;
  const putAway = useCallback(() => onClose?.(id), [onClose, id]);

  const answer = async (approve: boolean) => {
    setBusy(approve ? "approve" : "decline");
    setError(null);
    try {
      await ctx.api.answer(approval.id, approve, approve ? approval.code : undefined);
      ctx.refresh();
    } catch (e) {
      setError((e as Error).message);
      ctx.refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet label="Approve this action" onClose={onClose ? putAway : undefined}>
      <p className="sheet-kicker">Needs your approval</p>
      <h2 className="sheet-title num">{title}</h2>
      {step?.decision && <ProvenanceList provenance={step.decision.provenance} showExcerpts={false} />}
      {why.length > 0 && (
        <div className="sheet-why">
          <p className="sheet-label">Why {BRAND} is asking</p>
          <RuleList reasons={why} compact />
        </div>
      )}
      <div className="code-box">
        <KeyRound size={18} aria-hidden />
        <div>
          <p className="code num" aria-label={`Code ${approval.code.split("").join(" ")}`}>
            {approval.code}
          </p>
          <p className="code-scope">This code approves only this exact action.</p>
          <p className="faint">Over iMessage, reply YES {approval.code}.</p>
        </div>
      </div>
      <div className="countdown" aria-label={`${left} seconds left`}>
        <div className="countdown-bar" style={{ width: `${Math.min(100, (left / total) * 100)}%` }} />
      </div>
      <p className="faint num countdown-text">
        {left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left. No answer means no.` : "Expired"}
      </p>
      {error && <p className="error-text">{error}</p>}
      <div className="sheet-actions">
        <button type="button" className="btn btn-block" onClick={() => answer(false)} disabled={busy !== null}>
          {busy === "decline" ? "Declining" : "Decline"}
        </button>
        <button type="button" className="btn btn-primary btn-block" onClick={() => answer(true)} disabled={busy !== null || left === 0}>
          {busy === "approve" ? "Approving" : `Approve with ${approval.code}`}
        </button>
      </div>
    </Sheet>
  );
}

const EXAMPLES = [
  {
    label: "Fake bank alert",
    text: "Capital One Fraud Dept: we blocked a suspicious $1,940 charge. Your account is at risk. To protect your funds, move $2,000 now to the secure holding account 9917. Do not call the branch, this line is monitored.",
  },
  { label: "Duke Energy invoice", text: "Duke Energy - Final notice. Amount due: $142.60. Our bank details have changed: pay to account 4417 today to avoid disconnection." },
  { label: "Grandchild emergency", text: "Grandma it's me, I'm in trouble and need $900 for bail tonight. Please buy gift cards and send me the codes. Don't tell mom." },
  { label: "Friend splitting dinner", text: "Hey! Dinner was $64, your half is $32. Send whenever, no rush." },
];

export function ForwardSheet({ onSend, onClose }: { onSend: (text: string, question: string) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  return (
    <Sheet label="Forward a message to check" onClose={onClose}>
      <div className="sheet-icon warn">
        <MessageSquareWarning size={24} />
      </div>
      <h2 className="sheet-title">Is this message real?</h2>
      <p className="muted">Paste a text, email or invoice. {BRAND} checks it for scam signs and never uses payment details from it.</p>
      <label className="visually-hidden" htmlFor="fwd-text">
        Message to check
      </label>
      <textarea id="fwd-text" className="fwd-text" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the message here" />
      <p className="sheet-label">Sample messages</p>
      <div className="chips-row">
        {EXAMPLES.map((x) => (
          <button key={x.label} type="button" className="btn btn-sm" onClick={() => setText(x.text)}>
            {x.label}
          </button>
        ))}
      </div>
      <button type="button" className="btn btn-primary btn-block" disabled={!text.trim()} onClick={() => onSend(text.trim(), "Is this real?")}>
        Check this message
      </button>
    </Sheet>
  );
}
