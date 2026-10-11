import type { Area, FindingsView } from "@contracts";
import { BookOpen, ExternalLink, LayoutGrid } from "lucide-react";
import { useState } from "react";
import { EvidenceCard } from "../components/evidence/EvidenceCard.tsx";
import { AREA_ICON, AREA_TITLES, STATUS } from "../components/evidence/meta.ts";

export function FindingsPanel({ view, error }: { view: FindingsView | null; error: string | null }) {
  const [area, setArea] = useState<Area | "all">("all");
  if (!view)
    return <div className="card empty">{error ? `Findings are not available: ${error}` : "Loading findings"}</div>;
  const count = (a: Area) => view.findings.filter((f) => f.area === a).length;
  const shown = area === "all" ? view.findings : view.findings.filter((f) => f.area === area);
  return (
    <div className="con-findings">
      <div className="con-filter" role="group" aria-label="Filter findings by area">
        <button type="button" className="con-filter-chip" aria-pressed={area === "all"} onClick={() => setArea("all")}>
          <LayoutGrid size={14} aria-hidden /> All <span className="con-filter-n num">{view.findings.length}</span>
        </button>
        {view.areas.map((a) => {
          const Icon = AREA_ICON[a.area] ?? LayoutGrid;
          const st = STATUS[a.status] ?? STATUS.ok;
          return (
            <button key={a.area} type="button" className={`con-filter-chip tone-${st.cls}`} aria-pressed={area === a.area} onClick={() => setArea(a.area)} title={`${a.title}: ${st.label}. ${a.headline}`}>
              <Icon size={14} aria-hidden /> {a.title || AREA_TITLES[a.area]}
              {a.status !== "ok" && <span className="tile-dot" aria-label={st.label} />}
              <span className="con-filter-n num">{count(a.area)}</span>
            </button>
          );
        })}
      </div>
      {shown.length === 0 ? (
        <div className="card empty">Nothing in this area right now.</div>
      ) : (
        <div className="con-findings-grid">
          {shown.map((f) => (
            <EvidenceCard key={f.id} finding={f} />
          ))}
        </div>
      )}
      {view.references.length > 0 && (
        <section className="card con-refs" aria-label="Public sources">
          <h3 className="section-title">
            <BookOpen size={14} aria-hidden /> Every public source the cards cite
          </h3>
          <ul>
            {view.references.map((r) => (
              <li key={r.id}>
                <a href={r.url} target="_blank" rel="noreferrer noopener">
                  {r.title} <ExternalLink size={12} aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
