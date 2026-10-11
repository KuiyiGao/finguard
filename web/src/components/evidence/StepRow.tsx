import type { AuthorizationReceipt } from "@contracts";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { describeCall } from "../../lib/describe.ts";
import { clockTime, shortHash } from "../../lib/format.ts";
import { authorizedBy, stepState, type Audience } from "../../lib/status.ts";
import type { ToolStep } from "../../lib/turns.ts";
import { fieldDisplay, fieldLabel, OriginChip, ProvenanceList, RuleList, VerdictBadge } from "../gate.tsx";
import { ActionStatus } from "./ActionStatus.tsx";

export function ReceiptDetail({ receipt, audience = "customer", values = true }: { receipt: AuthorizationReceipt; audience?: Audience; values?: boolean }) {
  return (
    <div className="receipt">
      <dl className="kv">
        <dt>Authorized by</dt>
        <dd>{authorizedBy(receipt, audience)}</dd>
        <dt>Receipt</dt>
        <dd className="mono">{receipt.id}</dd>
        <dt>Consent</dt>
        <dd className="mono">{receipt.consentId}</dd>
        <dt>Executed</dt>
        <dd className="num">{clockTime(receipt.executedAt)}</dd>
        <dt>Action hash</dt>
        <dd className="hash" title={receipt.actionHash}>
          {shortHash(receipt.actionHash, 16)}
        </dd>
      </dl>
      {values && receipt.values.length > 0 && (
        <>
          <p className="sheet-label">Where each value came from</p>
          {receipt.values.map((v) => (
            <div key={v.field} className="prov-row">
              <span className="prov-field">{fieldLabel(v.field)}</span>
              <span className="prov-value num">{fieldDisplay(v.field, v.value)}</span>
              <OriginChip origin={v.origin} title={v.source} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export function StepRow({ step, audience = "customer", open: initial = false, meta, detail }: { step: ToolStep; audience?: Audience; open?: boolean; meta?: ReactNode; detail?: ReactNode }) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? initial;
  const id = useId();
  const d = step.decision;
  const state = stepState(step, audience);
  const operator = audience === "operator";
  const [flash, setFlash] = useState<"done" | "stopped" | null>(null);
  const was = useRef(state.kind);
  useEffect(() => {
    if (was.current === state.kind) return;
    was.current = state.kind;
    if (state.kind !== "done" && state.kind !== "stopped") return;
    setFlash(state.kind);
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [state.kind]);
  const reasons = d ? (operator ? d.reasons : d.reasons.filter((r) => r.verdict !== "allow")) : [];
  const canOpen = Boolean(step.receipt || reasons.length || d?.provenance.length || detail);
  return (
    <div className={`step-row step-${state.kind}${open ? " step-open" : ""}${flash ? ` step-flash-${flash}` : ""}`}>
      <div className="step-head">
        <ActionStatus title={describeCall(step.call)} state={state} />
        {d && operator && <VerdictBadge verdict={d.verdict} />}
        {meta && <span className="step-meta faint num">{meta}</span>}
        {canOpen && (
          <button type="button" className="btn btn-ghost btn-sm step-toggle" aria-expanded={open} aria-controls={id} aria-label={open ? "Hide details" : "Show why and the receipt"} onClick={() => setToggled(!open)}>
            <ChevronDown aria-hidden className={open ? "flip" : undefined} />
          </button>
        )}
      </div>
      {open && (
        <div id={id} className="step-detail">
          {reasons.length > 0 && <RuleList reasons={reasons} compact={!operator} />}
          {d && !operator && <ProvenanceList provenance={d.provenance} />}
          {step.receipt && <ReceiptDetail receipt={step.receipt} audience={audience} values={!(d && !operator && d.provenance.length)} />}
          {detail}
        </div>
      )}
    </div>
  );
}
