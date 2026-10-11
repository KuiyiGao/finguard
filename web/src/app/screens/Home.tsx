import { ChevronRight, Pause, Play, RotateCw, ShieldAlert, ShieldX } from "lucide-react";
import { useMemo, useState } from "react";
import { AgentBar } from "../../components/agent/AgentBar.tsx";
import { Autopilot } from "../../components/autopilot/Autopilot.tsx";
import { AreaTile } from "../../components/evidence/AreaTile.tsx";
import { EvidenceCard } from "../../components/evidence/EvidenceCard.tsx";
import { ApprovalCards } from "../../components/panel/ApprovalCards.tsx";
import { clock, PanelSection, waitingLabel } from "../../components/panel/Section.tsx";
import { CountUp } from "../../components/viz/motion.tsx";
import { VizView } from "../../components/viz/VizView.tsx";
import { BRAND } from "../../lib/brand.ts";
import { topAction } from "../../lib/findings.ts";
import { cashFlowFinding } from "../../lib/normalize.ts";
import { lastReview, reviewSentence } from "../../lib/review.ts";
import type { AppCtx } from "../CustomerApp.tsx";

function greeting(now: number): string {
  const h = new Date(now).getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function HomeScreen({ ctx, onConsent }: { ctx: AppCtx; onConsent: () => void }) {
  const { state } = ctx;
  const [busy, setBusy] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const policy = state?.policy;
  const view = ctx.findings;
  const cash = view?.findings.find((f) => f.from === "cash_flow") ?? (ctx.cashFlow ? cashFlowFinding(ctx.cashFlow, { simulated: ctx.simulated }) : undefined);
  const safe = cash?.metric?.value ?? ctx.cashFlow?.safeToMove;
  const top = view ? topAction(view.findings) : undefined;
  const review = useMemo(() => lastReview(ctx.events, view?.findings ?? []), [ctx.events, view]);

  const setPaused = async (paused: boolean) => {
    setBusy(true);
    setPauseError(null);
    try {
      await ctx.api.updatePolicy({ paused }, paused ? "pause all" : "resume");
      ctx.refresh();
      if (!paused) onConsent();
    } catch {
      setPauseError("Could not confirm the change. Refresh and check the pause status before relying on it.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen home">
      <header className="home-head">
        <div>
          <p className="home-kicker">
            {greeting(ctx.now)}
          </p>
          <h1>Your money today</h1>
        </div>
        {policy && !policy.paused && !state?.needsConsent && (
          <button type="button" className="pause-pill" onClick={() => setPaused(true)} disabled={busy} aria-label="Pause all money movement">
            <Pause size={15} aria-hidden /> Pause
          </button>
        )}
      </header>

      {pauseError && <p className="error-text" role="alert">{pauseError}</p>}
      {policy?.paused ? (
        <div className="banner banner-bad" role="status">
          <ShieldX size={18} aria-hidden />
          <span>
            <strong>Paused.</strong> No money moves until you resume.
          </span>
          <button type="button" className="btn btn-primary btn-sm banner-btn" onClick={() => setPaused(false)} disabled={busy}>
            <Play size={14} aria-hidden /> Resume
          </button>
        </div>
      ) : state?.needsConsent ? (
        <div className="banner banner-warn" role="status">
          <ShieldAlert size={18} aria-hidden />
          <span>
            <strong>{BRAND} is waiting for your agreement</strong> before it moves money.
          </span>
          <button type="button" className="btn btn-primary btn-sm banner-btn" onClick={onConsent}>
            Review
          </button>
        </div>
      ) : null}

      <AgentBar onAsk={(text) => ctx.go("chat", text ? { text, send: true } : undefined)} onForward={() => ctx.go("chat", { forward: true })} />

      <PanelSection tier="decide" title="Decide" status={waitingLabel((state?.approvals ?? []).length, Boolean(top))} attention={(state?.approvals ?? []).length > 0}>
        <ApprovalCards approvals={state?.approvals ?? []} now={ctx.now} onOpen={ctx.openApproval} />
        {top && <EvidenceCard key={top.id} finding={top} compact />}
      </PanelSection>

      <PanelSection tier="checked" title="Checked for you" statusTitle={review ? reviewSentence(review) : undefined} status={review ? `Checked ${clock(review.ts)}` : "Checking"}>
        <section className="hero" aria-label="Safe to move today">
          <div className="hero-top">
            <span className="hero-label">Safe to move today</span>
            {cash?.simulated && <span className="sim-tag">Simulated</span>}
          </div>
          {safe === undefined ? <span className="hero-value hero-wait">{ctx.findingsError ? "Unavailable" : "Checking"}</span> : <CountUp className="hero-value" value={safe} unit="usd" duration={1300} />}
          {cash && <p className="hero-note num">{cash.summary}</p>}
          {cash?.viz && (
            <div className="hero-viz">
              <VizView viz={cash.viz} compact />
            </div>
          )}
        </section>

        {view ? (
          <details className="tiles-fold">
            <summary className="tiles-sum">
              <span>
                All {view.areas.length} areas checked
                {(() => {
                  const look = view.areas.filter((a) => a.status !== "ok").length;
                  return look ? `, ${look} to review` : ", none to review";
                })()}
              </span>
              <ChevronRight size={16} aria-hidden className="tiles-chev" />
            </summary>
            <div className="tiles" role="group" aria-label="Your money areas">
              {view.areas.map((a, i) => (
                <AreaTile key={a.area} area={a} index={i} onOpen={() => ctx.openArea(a.area)} />
              ))}
            </div>
          </details>
        ) : ctx.findingsError ? (
          <div className="card card-pad empty-state">
            <p>Your money areas are not available right now.</p>
            <button type="button" className="btn btn-block" onClick={ctx.reloadFindings}>
              <RotateCw size={15} aria-hidden /> Try again
            </button>
          </div>
        ) : (
          <div className="tiles" aria-busy="true" aria-label="Loading">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="tile tile-skel" />
            ))}
          </div>
        )}
        {ctx.findingsError && view && (
          <p className="faint stale-note">
            <RotateCw size={12} aria-hidden /> Showing the last update; refreshing failed.
          </p>
        )}
      </PanelSection>

      <PanelSection tier="autopilot" title="Autopilot" status={state?.policy?.paused ? "Paused" : state?.needsConsent ? "Waiting for you" : "On"}>
        <Autopilot compact state={state} steps={ctx.steps} now={ctx.now} health={ctx.health} findings={view} onOpenLimits={() => ctx.go("settings")} />
      </PanelSection>
    </div>
  );
}
