import type { Area, Finding } from "@contracts";
import { BookOpen, ExternalLink, RotateCw, Wallet } from "lucide-react";
import { EvidenceCard } from "../components/evidence/EvidenceCard.tsx";
import { AREA_ICON, AREA_TITLES } from "../components/evidence/meta.ts";
import { formatUsd } from "../lib/format.ts";
import { useState } from "react";
import { agentName } from "./agents.ts";
import type { DeskCtx } from "./ctx.ts";
import { StatusPill } from "./Overview.tsx";
import { hostOf } from "./readers.ts";

const SEVERITY: Record<Finding["tone"], number> = { block: 0, warn: 1, save: 2, info: 3 };

export function sourcesOf(findings: Finding[], references: { id: string; title: string; url: string }[]) {
  const byId = new Map(references.map((r) => [r.id, r]));
  const out = new Map<string, { title: string; url?: string; cards: number }>();
  const add = (key: string, title: string, url?: string) => {
    const s = out.get(key) ?? { title, url, cards: 0 };
    s.cards += 1;
    out.set(key, s);
  };
  for (const f of findings) {
    const seen = new Set<string>();
    for (const c of f.citations) {
      const ref = byId.get(c.docId);
      const key = ref?.url ?? c.url ?? c.docId;
      if (seen.has(key)) continue;
      seen.add(key);
      add(key, ref?.title ?? c.title, ref?.url ?? c.url);
    }
    for (const e of f.evidence) {
      if (!e.url || seen.has(e.url)) continue;
      seen.add(e.url);
      add(e.url, e.label, e.url);
    }
  }
  return [...out.values()].sort((a, b) => b.cards - a.cards || a.title.localeCompare(b.title));
}

export function SourceList({ sources }: { sources: { title: string; url?: string; cards: number }[] }) {
  if (sources.length === 0) return <p className="faint">No public sources cited here.</p>;
  return (
    <ul className="dk-sources">
      {sources.map((s) => (
        <li key={`${s.url ?? s.title}`}>
          <BookOpen aria-hidden className="dk-src-icon" />
          <span className="dk-src-main">
            {s.url ? (
              <a href={s.url} target="_blank" rel="noreferrer noopener">
                {s.title} <ExternalLink aria-hidden className="dk-ext" />
              </a>
            ) : (
              <span>{s.title}</span>
            )}
            <span className="faint dk-src-host">{hostOf(s.url) ?? "Knowledge base"}</span>
          </span>
          <span className="faint num dk-src-n">
            {s.cards} {s.cards === 1 ? "card" : "cards"}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function AreaPage({ ctx, area }: { ctx: DeskCtx; area: Area }) {
  const view = ctx.findings;
  const summary = view?.areas.find((a) => a.area === area);
  const findings = (view?.findings ?? []).filter((f) => f.area === area).sort((a, b) => SEVERITY[a.tone] - SEVERITY[b.tone] || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const Icon = AREA_ICON[area] ?? Wallet;
  const sources = view ? sourcesOf(findings, view.references) : [];
  const [agent, setAgent] = useState<string | null>(null);
  const byAgent = new Map<string, number>();
  for (const f of findings) if (f.agent) byAgent.set(f.agent, (byAgent.get(f.agent) ?? 0) + 1);
  const shown = agent ? findings.filter((f) => (f.agent ?? "other") === agent) : findings;

  return (
    <div className="dk-page">
      <header className="dk-page-head">
        <span className="dk-page-icon" aria-hidden>
          <Icon />
        </span>
        <div className="dk-grow">
          <p className="dk-kicker">Area</p>
          <h1>{summary?.title ?? AREA_TITLES[area] ?? area}</h1>
          {summary && <p className="muted num">{summary.headline}</p>}
        </div>
        {summary && (
          <div className="dk-head-side">
            <StatusPill status={summary.status} />
            {summary.amount && (
              <p className="dk-head-amount">
                <span className="num">{formatUsd(summary.amount.value)}</span>
                <span className="faint">{summary.amount.label}</span>
              </p>
            )}
          </div>
        )}
      </header>

      {!view ? (
        ctx.findingsError ? (
          <div className="card dk-empty">
            <p>This area could not be loaded: {ctx.findingsError}</p>
            <button type="button" className="btn" onClick={ctx.reloadFindings}>
              <RotateCw size={15} aria-hidden /> Try again
            </button>
          </div>
        ) : (
          <div className="dk-card-grid" aria-busy="true" aria-label="Loading">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="card dk-skel dk-skel-tall" />
            ))}
          </div>
        )
      ) : findings.length === 0 ? (
        <div className="card dk-empty">Nothing in this area yet.</div>
      ) : (
        <>
          {byAgent.size > 0 && (
            <div className="dk-filter" role="group" aria-label="Filter by agent">
              <span className="faint">Found by</span>
              <button type="button" className="dk-tab" aria-pressed={agent === null} onClick={() => setAgent(null)}>
                All <span className="faint num">{findings.length}</span>
              </button>
              {[...byAgent].map(([a, n]) => (
                <button key={a} type="button" className="dk-tab" aria-pressed={agent === a} onClick={() => setAgent(agent === a ? null : a)}>
                  {agentName(a)} <span className="faint num">{n}</span>
                </button>
              ))}
              {findings.some((f) => !f.agent) && (
                <button type="button" className="dk-tab" aria-pressed={agent === "other"} onClick={() => setAgent(agent === "other" ? null : "other")}>
                  Other <span className="faint num">{findings.filter((f) => !f.agent).length}</span>
                </button>
              )}
            </div>
          )}
          <div className="dk-card-grid">
            {shown.map((f) => (
              <EvidenceCard key={f.id} finding={f} />
            ))}
          </div>
        </>
      )}

      {view && (
        <section className="dk-section card dk-pad" aria-labelledby="area-sources">
          <h2 id="area-sources" className="section-title">
            Sources
          </h2>
          <SourceList sources={sources} />
        </section>
      )}
    </div>
  );
}
