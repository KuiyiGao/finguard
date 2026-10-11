import type { Area } from "@contracts";
import { ChevronLeft, MessageCircle, PiggyBank, Wallet } from "lucide-react";
import { useState } from "react";
import { EvidenceCard } from "../../components/evidence/EvidenceCard.tsx";
import { AREA_ICON, AREA_TITLES, STATUS } from "../../components/evidence/meta.ts";
import { CountUp } from "../../components/viz/motion.tsx";
import { BRAND } from "../../lib/brand.ts";
import type { AppCtx } from "../CustomerApp.tsx";
import { SavingsScreen } from "../savings/SavingsScreen.tsx";

const SAVINGS_AREAS = new Set<Area>(["everyday", "bills", "subscriptions"]);

export function AreaScreen({ ctx, area }: { ctx: AppCtx; area: Area }) {
  const [report, setReport] = useState(false);
  const summary = ctx.findings?.areas.find((a) => a.area === area);
  const findings = ctx.findings?.findings.filter((f) => f.area === area) ?? [];
  const title = summary?.title ?? AREA_TITLES[area];
  const st = STATUS[summary?.status ?? "ok"] ?? STATUS.ok;
  const Icon = AREA_ICON[area] ?? Wallet;
  const asks = [...new Set(findings.map((f) => f.ask).filter((q): q is string => Boolean(q)))].slice(0, 3);
  if (asks.length === 0) asks.push(`What should I know about my ${title.toLowerCase()}?`);

  if (report) return <SavingsScreen ctx={ctx} onBack={() => setReport(false)} />;
  return (
    <div className="screen area">
      <button type="button" className="back-btn" onClick={() => ctx.openArea(null)}>
        <ChevronLeft size={20} aria-hidden /> Home
      </button>
      <header className={`area-head tone-${st.cls} area-${summary?.status ?? "ok"}`}>
        <span className="area-icon" aria-hidden>
          <Icon />
        </span>
        <div className="area-title">
          <h1>{title}</h1>
          <p className="area-status">
            <span className="tile-dot" aria-hidden /> {st.label}
          </p>
        </div>
        {summary?.amount && (
          <div className="area-amount">
            <CountUp value={summary.amount.value} unit="usd" />
            <span>{summary.amount.label}</span>
          </div>
        )}
      </header>
      {summary && <p className="area-headline num">{summary.headline}</p>}

      {!ctx.findings ? (
        <p className="empty card">{ctx.findingsError ? "This area is not available right now." : "Loading"}</p>
      ) : findings.length === 0 ? (
        <p className="empty card">Nothing needs you here right now.</p>
      ) : (
        <div className="stack area-cards">
          {findings.map((f) => (
            <EvidenceCard key={f.id} finding={f} />
          ))}
        </div>
      )}

      {SAVINGS_AREAS.has(area) && (
        <button type="button" className="btn btn-block" onClick={() => setReport(true)}>
          <PiggyBank size={16} aria-hidden /> Full savings report
        </button>
      )}

      <section className="stack-sm" aria-label={`Ask ${BRAND} about this`}>
        <h2 className="section-title">Ask {BRAND} about this</h2>
        <div className="ask-chips">
          {asks.map((q) => (
            <button key={q} type="button" className="ask-chip" onClick={() => ctx.ask(q)}>
              <MessageCircle size={15} aria-hidden /> {q}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
