import type { AreaSummary, Finding } from "@contracts";
import { ArrowRight, MessageSquareWarning, RotateCw, ScrollText, Search, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { Autopilot } from "../components/autopilot/Autopilot.tsx";
import { EvidenceCard } from "../components/evidence/EvidenceCard.tsx";
import { AREA_ICON, STATUS, TONE } from "../components/evidence/meta.ts";
import { ApprovalCards } from "../components/panel/ApprovalCards.tsx";
import { clock, PanelSection, waitingLabel } from "../components/panel/Section.tsx";
import { CountUp } from "../components/viz/motion.tsx";
import { VizView } from "../components/viz/VizView.tsx";
import { formatUsd, timeAgo } from "../lib/format.ts";
import { cashFlowFinding } from "../lib/normalize.ts";
import { ApiError } from "../lib/api.ts";
import { topAction } from "../lib/findings.ts";
import { lastReview, reviewSentence } from "../lib/review.ts";
import { hrefOf, type DeskCtx } from "./ctx.ts";

const SEVERITY: Record<Finding["tone"], number> = { block: 0, warn: 1, save: 2, info: 3 };

export function topFinding(findings: Finding[], skip?: string): Finding | undefined {
  const withViz = findings.filter((f) => f.viz);
  const pool = withViz.filter((f) => f.id !== skip).length ? withViz.filter((f) => f.id !== skip) : withViz;
  return [...pool].sort((a, b) => SEVERITY[a.tone] - SEVERITY[b.tone] || Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

export function StatusPill({ status }: { status: AreaSummary["status"] }) {
  const st = STATUS[status] ?? STATUS.ok;
  return (
    <span className={`dk-pill tone-${st.cls}`}>
      <span className="dk-dot" aria-hidden />
      {st.label}
    </span>
  );
}

function AreaPanel({ area, finding }: { area: AreaSummary; finding?: Finding }) {
  const Icon = AREA_ICON[area.area] ?? Wallet;
  const tone = finding ? (TONE[finding.tone] ?? TONE.info) : undefined;
  return (
    <article className={`dk-area card tone-${(STATUS[area.status] ?? STATUS.ok).cls}`} aria-labelledby={`area-${area.area}`}>
      <header className="dk-area-head">
        <span className="dk-area-icon" aria-hidden>
          <Icon />
        </span>
        <h2 id={`area-${area.area}`} className="dk-area-title">
          <a href={hrefOf({ id: "area", area: area.area })}>{area.title}</a>
        </h2>
        <StatusPill status={area.status} />
      </header>
      <p className="dk-area-headline num">{area.headline}</p>
      {area.amount && (
        <p className="dk-area-amount">
          <span className="num">{formatUsd(area.amount.value)}</span> <span className="faint">{area.amount.label}</span>
        </p>
      )}
      {finding?.viz ? (
        <figure className="dk-area-viz">
          <figcaption className="dk-area-cap num">
            {tone && <tone.icon aria-hidden className={`dk-cap-icon tone-${tone.cls}`} />}
            {finding.title}
            {finding.simulated && <span className="sim-tag">Simulated</span>}
          </figcaption>
          <VizView viz={finding.viz} />
        </figure>
      ) : (
        <p className="dk-area-empty faint">No chart for this area yet.</p>
      )}
      <footer className="dk-area-foot">
        <span className="faint num">
          {area.findings} {area.findings === 1 ? "finding" : "findings"}
        </span>
        <a className="dk-link" href={hrefOf({ id: "area", area: area.area })}>
          Open {area.title} <ArrowRight aria-hidden />
        </a>
      </footer>
    </article>
  );
}

export function Overview({ ctx }: { ctx: DeskCtx }) {
  const view = ctx.findings;
  const simulated = view ? view.findings.some((f) => f.simulated) : true;
  const cash = view?.findings.find((f) => f.from === "cash_flow") ?? (ctx.cashFlow ? cashFlowFinding(ctx.cashFlow, { simulated }) : undefined);
  const safe = cash?.metric?.value ?? ctx.cashFlow?.safeToMove;
  const next = view ? topAction(view.findings) : undefined;
  const review = useMemo(() => lastReview(ctx.events, view?.findings ?? []), [ctx.events, view]);
  const [reviewing, setReviewing] = useState(false);
  const [reviewNote, setReviewNote] = useState<string | null>(null);
  const reviewAgain = async () => {
    setReviewing(true);
    setReviewNote(null);
    try {
      await ctx.api.agentReview();
      ctx.reloadFindings();
    } catch (e) {
      setReviewNote(e instanceof ApiError && e.status === 404 ? "The review service is not available yet." : `Review failed: ${(e as Error).message}`);
    } finally {
      setReviewing(false);
    }
  };

  return (
    <div className="dk-page">
      <header className="dk-page-head">
        <div className="dk-grow">
          <p className="dk-kicker">Overview</p>
          <h1>Your money, every area</h1>
          <p className="faint num">
            {view
              ? `${view.findings.length} findings across ${view.areas.length} areas, updated ${timeAgo(view.generatedAt, ctx.now)}`
              : ctx.findingsError
                ? "Findings are not available right now."
                : "Loading findings"}
            {simulated && view && <span className="sim-tag dk-inline-tag">Simulated</span>}
          </p>
        </div>
        <div className="dk-head-side">
          <button type="button" className="btn" onClick={reviewAgain} disabled={reviewing}>
            <RotateCw size={15} aria-hidden className={reviewing ? "spin" : undefined} /> {reviewing ? "Reviewing" : "Review again"}
          </button>
          {reviewNote && <p className="faint dk-head-note">{reviewNote}</p>}
        </div>
      </header>

      <PanelSection tier="decide" title="Decide" status={waitingLabel((ctx.state?.approvals ?? []).length, Boolean(next))} attention={(ctx.state?.approvals ?? []).length > 0}>
        <div className="dk-decide">
          <div className="dk-stack">
            <ApprovalCards approvals={ctx.state?.approvals ?? []} now={ctx.now} onOpen={ctx.openApproval} />
            <a className="dk-start-card card" href={hrefOf({ id: "documents" })}>
              <span className="dk-start-icon dk-start-warn" aria-hidden>
                <MessageSquareWarning />
              </span>
              <span className="dk-grow">
                <strong>Is this message real?</strong>
              </span>
              <ArrowRight aria-hidden className="dk-start-arrow" />
            </a>
          </div>
          <section className="dk-next" aria-label="Needs a decision">
            {next ? (
              <EvidenceCard key={next.id} finding={next} />
            ) : view ? (
              <div className="card dk-empty">Nothing waiting on you.</div>
            ) : (
              <div className="card dk-skel" aria-busy="true" aria-label="Loading" />
            )}
          </section>
        </div>
      </PanelSection>

      <PanelSection tier="checked" title="Checked for you" statusTitle={review ? reviewSentence(review) : undefined} status={review ? `Checked ${clock(review.ts)}` : "Checking"}>
        <div className="dk-hero-row">
          <section className="dk-hero card" aria-label="Safe to move today">
            <div className="dk-hero-top">
              <span className="dk-hero-label">Safe to move today</span>
              {cash?.simulated && <span className="sim-tag">Simulated</span>}
            </div>
            {safe === undefined ? <span className="dk-hero-value faint">Checking</span> : <CountUp className="dk-hero-value" value={safe} unit="usd" duration={1200} />}
            {cash && <p className="dk-hero-note num">{cash.summary}</p>}
            {cash?.viz && (
              <div className="dk-hero-viz">
                <VizView viz={cash.viz} />
              </div>
            )}
          </section>
          <nav className="dk-start dk-start-stack" aria-label="Start here">
            <a className="dk-start-card card" href={hrefOf({ id: "documents" })}>
              <span className="dk-start-icon" aria-hidden>
                <ScrollText />
              </span>
              <span className="dk-grow">
                <strong>Read the fine print</strong>
              </span>
              <ArrowRight aria-hidden className="dk-start-arrow" />
            </a>
            <a className="dk-start-card card" href={hrefOf({ id: "research" })}>
              <span className="dk-start-icon" aria-hidden>
                <Search />
              </span>
              <span className="dk-grow">
                <strong>Research a holding</strong>
              </span>
              <ArrowRight aria-hidden className="dk-start-arrow" />
            </a>
          </nav>
        </div>

        <section aria-label="Areas" className="dk-section">
          <h3 className="section-title">Areas</h3>
          {view ? (
            <div className="dk-area-grid">
              {view.areas.map((a) => (
                <AreaPanel
                  key={a.area}
                  area={a}
                  finding={topFinding(
                    view.findings.filter((f) => f.area === a.area),
                    cash?.id,
                  )}
                />
              ))}
            </div>
          ) : ctx.findingsError ? (
            <div className="card dk-empty">
              <p>The areas could not be loaded: {ctx.findingsError}</p>
              <button type="button" className="btn" onClick={ctx.reloadFindings}>
                <RotateCw size={15} aria-hidden /> Try again
              </button>
            </div>
          ) : (
            <div className="dk-area-grid" aria-busy="true" aria-label="Loading areas">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="card dk-skel dk-skel-tall" />
              ))}
            </div>
          )}
        </section>
      </PanelSection>

      <PanelSection tier="autopilot" title="Autopilot" status={ctx.state?.policy?.paused ? "Paused" : ctx.state?.needsConsent ? "Waiting for you" : "On"}>
        <Autopilot state={ctx.state} steps={ctx.steps} now={ctx.now} health={ctx.health} findings={view} />
      </PanelSection>
    </div>
  );
}
