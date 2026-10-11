import type { SavingsReport } from "@contracts";
import { ChevronLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { EvidenceCard } from "../../components/evidence/EvidenceCard.tsx";
import { formatUsd } from "../../lib/format.ts";
import { savingsFindings } from "../../lib/normalize.ts";
import type { AppCtx } from "../CustomerApp.tsx";
import "./savings.css";

export function SavingsScreen({ ctx, onBack }: { ctx: AppCtx; onBack: () => void }) {
  const [report, setReport] = useState<SavingsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const receiptCount = ctx.events.filter((e) => e.type === "receipt_issued").length;

  useEffect(() => {
    let active = true;
    setError(null);
    setLoading(true);
    ctx.api.savings().then(
      (r) => active && setReport(r),
      (e: Error) => active && setError(e.message),
    ).finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
    };
  }, [ctx.api, reload, receiptCount]);

  const cards = report ? savingsFindings(report, { simulated: ctx.simulated }) : [];
  return (
    <div className="screen savings-screen">
      <button type="button" className="back-btn" onClick={onBack}>
        <ChevronLeft size={20} aria-hidden /> Back
      </button>
      <header className="screen-head">
        <p className="faint">Potential recurring benefit</p>
        <h1 className="num">{report ? `${formatUsd(report.totalMonthly)} / month` : "Savings report"}</h1>
        <p className="faint">See the evidence, review the assumptions, then choose an action. Estimates are not money already saved.</p>
      </header>
      <details className="card card-pad"><summary>Review with your advisor</summary><p className="faint">Use these records and assumptions to discuss an option with your existing advisor. No advisor approval or institutional endorsement is implied.</p></details>
      <details className="card card-pad"><summary>Recognize a suspicious transfer request</summary><p className="faint">FinGuard will never ask you to move money to a “safe account” to protect it from fraud. Forward suspicious messages in Chat and contact your bank using a number you already trust.</p></details>
      {loading && report && <p role="status">Refreshing estimates. Review the updated report before choosing an action.</p>}
      {error && (
        <div role="alert" className="card card-pad stack-sm">
          <p className="error-text">Could not refresh savings: {error}</p>
          <button className="btn" type="button" onClick={() => setReload((n) => n + 1)}>
            Retry report
          </button>
        </div>
      )}
      {!report && !error && (
        <p role="status" className="muted">
          Checking transactions and upcoming bills…
        </p>
      )}
      {report && (
        <>
          <p className="faint">Report from {new Date(report.generatedAt).toLocaleString()}</p>
          {cards.length === 0 ? (
            <p className="empty card">No savings opportunities found in this report.</p>
          ) : (
            <fieldset className="stack savings-cards" disabled={loading || Boolean(error)}>
              {cards.map((f) => (
                <EvidenceCard key={f.id} finding={f} onAsk={ctx.ask} />
              ))}
            </fieldset>
          )}
          {report.disclaimers.map((d) => (
            <p key={d} className="faint demo-note">
              {d}
            </p>
          ))}
        </>
      )}
    </div>
  );
}
