import { Activity, LayoutGrid, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { EvidenceProvider } from "../components/evidence/EvidenceCard.tsx";
import { api, ApiError, type Api } from "../lib/api.ts";
import { BRAND } from "../lib/brand.ts";
import { useNow, useTrace } from "../lib/events.ts";
import { useFindings } from "../lib/findings.ts";
import { useServerState } from "../lib/state.ts";
import { buildTurns, gateStats } from "../lib/turns.ts";
import { TurnCard } from "./Activity.tsx";
import { FindingsPanel } from "./Findings.tsx";
import { InfraPanel } from "./Infra.tsx";
import { ApprovalsPanel, AuditPanel, DemoPanel, EvalPanel, Kpis, PolicyPanel, ReceiptsPanel, ScamPanel } from "./Panels.tsx";
import "./console.css";

const operator = api("operator");
const customer = api("customer");
const panel: Api = {
  ...operator,
  findings: () => operator.findings().catch((e: unknown) => (e instanceof ApiError && e.status === 403 ? customer.findings() : Promise.reject(e))),
};

export function Console({ embedded = false }: { embedded?: boolean }) {
  const { events, status, generation } = useTrace("operator");
  const { state, error } = useServerState(operator, events, generation);
  const findings = useFindings(panel, events, generation);
  const [tab, setTab] = useState<"feed" | "findings">("feed");
  const now = useNow(1000);
  const { turns, steps } = useMemo(() => buildTurns(events), [events]);
  const stats = useMemo(() => gateStats(steps.values(), events), [steps, events]);
  const recent = [...turns].reverse().slice(0, 40);

  return (
    <EvidenceProvider value={{ canAct: false, steps, events }}>
      <div className={`console${embedded ? " console-embedded" : ""}`}>
        <header className="con-header">
          <div className="con-brand">
            <span className="logo" aria-hidden>
              <ShieldCheck size={18} />
            </span>
            <div>
              <div className="con-title">
                <h1>{BRAND} Operations</h1>
                <span className="sim-tag">Simulated</span>
              </div>
            </div>
          </div>
          <div className="con-status" role="status">
            <span className={`live-dot${status === "live" ? " live" : ""}`} aria-hidden />
            {status === "live" ? "Live" : status === "connecting" ? "Connecting" : "Offline: is the server running on :8787?"}
            <span className="badge badge-neutral">Operator view</span>
          </div>
        </header>

        {error && <p className="error-text con-error">Server: {error}</p>}
        <Kpis stats={stats} />

        <div className="con-grid">
          <section className="con-feed" aria-label={tab === "feed" ? "Live activity" : "Findings"}>
            <div className="con-tabs" role="tablist" aria-label="Main view">
              <button type="button" role="tab" aria-selected={tab === "feed"} className="con-tab" onClick={() => setTab("feed")}>
                <Activity size={15} aria-hidden /> Live activity
              </button>
              <button type="button" role="tab" aria-selected={tab === "findings"} className="con-tab" onClick={() => setTab("findings")}>
                <LayoutGrid size={15} aria-hidden /> Findings
                {findings.view && <span className="con-tab-n num">{findings.view.findings.length}</span>}
              </button>
            </div>
            {tab === "findings" ? (
              <FindingsPanel view={findings.view} error={findings.error} />
            ) : recent.length === 0 ? (
              <div className="card empty">Nothing yet. Play a demo scene or use the customer app.</div>
            ) : (
              recent.map((t) => <TurnCard key={t.id} turn={t} api={operator} />)
            )}
          </section>
          <aside className="con-side">
            <DemoPanel api={operator} />
            <ApprovalsPanel approvals={state?.approvals ?? []} now={now} />
            <ScamPanel events={events} />
            <AuditPanel events={events} api={operator} generation={generation} />
            <details className="con-more">
              <summary>More: receipts, limits, infrastructure, eval</summary>
              <ReceiptsPanel receipts={state?.receipts ?? []} />
              <PolicyPanel state={state} />
              <InfraPanel api={operator} events={events} />
              <EvalPanel api={operator} generation={generation} />
            </details>
          </aside>
        </div>
      </div>
    </EvidenceProvider>
  );
}
