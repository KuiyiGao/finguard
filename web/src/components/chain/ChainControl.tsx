import type { Finding } from "@contracts";
import { ChevronDown, Waypoints, X } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import type { ActionState } from "../../lib/status.ts";
import type { ToolStep } from "../../lib/turns.ts";
import "./chain.css";

const EvidenceChain = lazy(() => import("./EvidenceChain.tsx").then((m) => ({ default: m.EvidenceChain })));

export function ChainLoading() {
  return (
    <p className="ch-loading faint" aria-busy="true">
      Loading the evidence chain
    </p>
  );
}

const PHONE = "(max-width: 639px)";

function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(PHONE);
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

export function ChainSheet({ finding, step, steps, status, sample, onClose }: { finding: Finding; step?: ToolStep; steps?: Map<string, ToolStep>; status?: ActionState; sample?: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const previous = document.activeElement as HTMLElement | null;
    if (!d.open) d.showModal();
    return () => {
      if (d.open) d.close();
      previous?.focus?.();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="ch-sheet"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="ch-sheet-bar">
        <p className="ch-sheet-title" id={titleId}>
          {finding.title}
        </p>
        <button type="button" className="btn btn-ghost ch-sheet-close" aria-label="Close the evidence chain" onClick={onClose}>
          <X size={20} aria-hidden />
        </button>
      </div>
      <div className="ch-sheet-body">
        <Suspense fallback={<ChainLoading />}>
          <EvidenceChain finding={finding} step={step} steps={steps} status={status} sample={sample} />
        </Suspense>
      </div>
    </dialog>
  );
}

export function ChainControl({ finding, step, steps, status, sample }: { finding: Finding; step?: ToolStep; steps?: Map<string, ToolStep>; status?: ActionState; sample?: boolean }) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const regionId = useId();
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost ch-toggle"
        aria-expanded={open}
        aria-controls={phone ? undefined : regionId}
        aria-haspopup={phone ? "dialog" : undefined}
        onClick={() => setOpen(!open)}
      >
        <Waypoints aria-hidden /> {open && !phone ? "Hide the evidence chain" : "Show the evidence chain"}
        {!phone && <ChevronDown aria-hidden className={open ? "flip" : undefined} />}
      </button>
      {open && !phone && (
        <div id={regionId} className="ch-inline">
          <Suspense fallback={<ChainLoading />}>
            <EvidenceChain finding={finding} step={step} steps={steps} status={status} sample={sample} />
          </Suspense>
        </div>
      )}
      {open && phone && <ChainSheet finding={finding} step={step} steps={steps} status={status} sample={sample} onClose={() => setOpen(false)} />}
    </>
  );
}
