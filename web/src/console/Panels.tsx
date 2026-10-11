import type { ApprovalRequest, AuthorizationReceipt, DelegationPolicy, ScamAssessment, TraceEvent } from "@contracts";
import { PhonePicker } from "../components/demo/DemoControls.tsx";
import { BellRing, Blocks, Clock, Gauge, Link2, Play, Receipt, RotateCcw, ShieldAlert, ShieldCheck, ShieldX, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { EvidenceCard } from "../components/evidence/EvidenceCard.tsx";
import { ReceiptDetail } from "../components/evidence/StepRow.tsx";
import { scamFinding } from "../lib/normalize.ts";
import { plainIds } from "../lib/describe.ts";
import { authorizedBy } from "../lib/status.ts";
import type { Api, EvalResult, State, VerifyResult } from "../lib/api.ts";
import { clockTime, EVENT_LABEL, formatUsd, shortHash, timeAgo } from "../lib/format.ts";
import type { GateStats } from "../lib/turns.ts";

export function Kpis({ stats }: { stats: GateStats }) {
  const items = [
    { label: "Money actions reviewed", value: String(stats.reviewed) },
    { label: "Allowed by limits", value: String(stats.allowed), tone: "allow" },
    { label: "Sent for approval", value: String(stats.asked), tone: "ask" },
    { label: "Blocked", value: String(stats.denied), tone: "deny" },
    { label: "Kept from leaving", value: formatUsd(stats.keptUsd), tone: "deny" },
    { label: "Moved with receipts", value: formatUsd(stats.movedUsd) },
    { label: "High-risk scam texts", value: String(stats.scamHigh), tone: stats.scamHigh ? "deny" : undefined },
    { label: "Avg review time", value: `${stats.avgMs} ms` },
  ];
  return (
    <section className="con-kpis" aria-label="SkillGate summary">
      {items.map((k) => (
        <div key={k.label} className={`card con-kpi${k.tone ? ` con-kpi-${k.tone}` : ""}`}>
          <span className="con-kpi-value num">{k.value}</span>
          <span className="con-kpi-label">{k.label}</span>
        </div>
      ))}
    </section>
  );
}

function Panel({ title, icon, children, action }: { title: string; icon: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="card con-panel">
      <header className="con-panel-head">
        <h2 className="section-title">
          {icon} {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export function ApprovalsPanel({ approvals, now }: { approvals: ApprovalRequest[]; now: number }) {
  return (
    <Panel title="Waiting for the customer" icon={<Clock size={14} />}>
      {approvals.length === 0 ? (
        <p className="empty">No approvals pending.</p>
      ) : (
        <ul className="con-list">
          {approvals.map((a) => {
            const left = Math.max(0, Math.round((Date.parse(a.expiresAt) - now) / 1000));
            return (
              <li key={a.id}>
                <p>{plainIds(a.summary)}</p>
                <p className="faint num">
                  expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}, action <span className="hash">{shortHash(a.actionHash)}</span>
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export function ScamPanel({ events }: { events: TraceEvent[] }) {
  const cases = events
    .filter((e) => e.type === "scam_assessed" && (e.data as ScamAssessment).risk !== "low")
    .slice(-6)
    .reverse();
  return (
    <Panel title="Scam cases" icon={<ShieldAlert size={14} />}>
      {cases.length === 0 ? (
        <p className="empty">No warning signs so far.</p>
      ) : (
        <ul className="con-list">
          {cases.map((e) => (
            <li key={e.seq}>
              <EvidenceCard finding={scamFinding(e.data as ScamAssessment, { area: "protection", createdAt: e.ts, simulated: false })} compact />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function ReceiptsPanel({ receipts }: { receipts: AuthorizationReceipt[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Panel title="Receipts" icon={<Receipt size={14} />}>
      {receipts.length === 0 ? (
        <p className="empty">No money has moved yet.</p>
      ) : (
        <ul className="con-list">
          {receipts.slice(0, 6).map((r) => (
            <li key={r.id}>
              <button type="button" className="con-receipt-btn" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                <span className="num">{plainIds(r.action)}</span>
                <span className="faint">
                  {authorizedBy(r, "operator")}, {clockTime(r.executedAt)}
                </span>
              </button>
              {open === r.id && (
                <div className="con-receipt-detail">
                  <ReceiptDetail receipt={r} audience="operator" />
                  <p className="faint">trace #{r.traceSeq}</p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function AuditPanel({ events, api, generation }: { events: TraceEvent[]; api: Api; generation: number }) {
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const verify = async () => {
    setBusy(true);
    try {
      setResult(await api.verify());
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const id = setTimeout(() => void verify(), 1000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, events.length]);
  const tail = events.slice(-6);
  return (
    <Panel
      title="Audit chain"
      icon={<Blocks size={14} />}
      action={
        <button type="button" className="btn btn-sm" onClick={verify} disabled={busy}>
          {busy ? "Verifying" : "Verify"}
        </button>
      }
    >
      {result && (
        <p className={`con-verify ${result.ok ? "ok" : "bad"}`} role="status">
          {result.ok ? <ShieldCheck size={16} aria-hidden /> : <ShieldX size={16} aria-hidden />}
          {result.ok ? `Chain intact, ${result.count} ${result.count === 1 ? "event" : "events"}.` : `Chain broken at event #${result.badSeq}: ${result.reason}.`}
        </p>
      )}
      <ol className="con-chain" aria-label="Latest trace events">
        {tail.map((e, i) => (
          <li key={e.seq} className="con-block enter">
            {i > 0 && <Link2 className="con-link" size={14} aria-hidden />}
            <span className="con-block-seq num">#{e.seq}</span>
            <span className="con-block-type">{EVENT_LABEL[e.type]}</span>
            <span className="hash" title={e.hash}>
              {shortHash(e.hash)}
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function grantLine(policy: DelegationPolicy, capability: string, label: string): string {
  const g = policy.grants.find((x) => x.capability === capability);
  if (!g) return `${label}: not allowed`;
  const max = g.maxAmount === undefined ? "" : formatUsd(g.maxAmount);
  if (g.approval === "never") return `${label}: automatic${max ? ` up to ${max}` : ""}`;
  if (g.approval === "always") return `${label}: approval every time${max ? `, max ${max}` : ""}`;
  return `${label}: automatic up to ${max}, approval above`;
}

export function PolicyPanel({ state }: { state: State | null }) {
  if (!state) return null;
  const p = state.policy;
  const used = Math.min(100, (state.spentToday / Math.max(1, p.dailyLimit)) * 100);
  return (
    <Panel title={`Customer policy v${p.version}`} icon={<ShieldCheck size={14} />}>
      <div className="con-policy">
        <p>
          {state.consent ? (
            <span className="badge badge-allow">Consent on file</span>
          ) : (
            <span className="badge badge-deny">No consent for v{p.version}</span>
          )}{" "}
          {p.paused && <span className="badge badge-deny">Paused</span>}
        </p>
        <ul className="con-plain">
          <li>{grantLine(p, "transfers.own", "Between own accounts")}</li>
          <li>{grantLine(p, "bills.pay", "Bills")}</li>
          <li>{grantLine(p, "transfers.external", "To other people")}</li>
          <li>New payees: approval for the first {Math.round(p.newPayeeCoolingOffMinutes / 60)} hours</li>
          {p.trustedContact && <li>Trusted contact: {p.trustedContact.name}</li>}
        </ul>
        <div className="con-meter" aria-label="Daily limit used">
          <div className="con-meter-bar" style={{ width: `${used}%` }} />
        </div>
        <p className="faint num">
          {formatUsd(state.spentToday)} of {formatUsd(p.dailyLimit)} daily limit used, policy <span className="hash">{shortHash(state.policyHash)}</span>
        </p>
      </div>
    </Panel>
  );
}

export function DemoPanel({ api }: { api: Api }) {
  const [scenes, setScenes] = useState<{ id: string; title: string; summary: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | undefined>();
  useEffect(() => {
    api.scenes().then(setScenes, (e: Error) => setError(e.message));
    api.health().then((h) => setPhone(h.phoneUrl), () => undefined);
  }, [api]);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Panel title="Demo scenes" icon={<Play size={14} />}>
      <div className="con-demo">
        {phone && (
          <p className="con-phone">
            <Smartphone size={14} aria-hidden /> Phone: <a href={phone} className="mono">{phone}</a>
          </p>
        )}
        {scenes
          .filter((s) => s.id !== "enterprise")
          .map((s) => (
            <button key={s.id} type="button" className="btn con-scene" title={s.summary} disabled={busy !== null} onClick={() => run(s.id, () => api.playScene(s.id))}>
              <Play size={14} aria-hidden /> {s.title}
            </button>
          ))}
        <PhonePicker />
        <button
          type="button"
          className="btn con-scene"
          disabled={busy !== null}
          onClick={() =>
            run("alerts", async () => {
              const sent = await api.runNudges();
              setAlerts(sent.length ? `${sent.length} ${sent.length === 1 ? "alert" : "alerts"}: ${sent.map((n) => n.title).join("; ")}` : "Nothing needs an alert right now.");
            })
          }
        >
          <BellRing size={14} aria-hidden /> {busy === "alerts" ? "Checking" : "Run FinGuard's check (sends alerts)"}
        </button>
        {alerts && <p className="faint">{alerts}</p>}
        <div className="con-row">
          <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => run("reset", () => api.reset(false))}>
            <RotateCcw size={13} aria-hidden /> Reset
          </button>
          <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => run("reset-consent", () => api.reset(true))}>
            <RotateCcw size={13} aria-hidden /> Reset and agree
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
      </div>
    </Panel>
  );
}

export function EvalPanel({ api, generation }: { api: Api; generation: number }) {
  const [result, setResult] = useState<EvalResult | null | undefined>(undefined);
  useEffect(() => {
    api.evalResult().then(setResult, () => setResult(null));
  }, [api, generation]);
  return (
    <Panel title="Eval scorecard" icon={<Gauge size={14} />}>
      {result === undefined ? (
        <p className="empty">Loading</p>
      ) : result === null ? (
        <p className="empty">Not run yet.</p>
      ) : (
        <div className="con-policy">
          <p className="con-kpi-value num">
            {result.passed}/{result.total} <span className="faint" style={{ fontSize: 13, fontWeight: 500 }}>cases match the expected verdict</span>
          </p>
          <ul className="con-plain">
            {Object.entries(result.byCategory).map(([name, c]) => (
              <li key={name} className="num">
                {name}: {c.passed}/{c.total}
              </li>
            ))}
          </ul>
          <p className="faint">ran {timeAgo(result.ranAt)}</p>
        </div>
      )}
    </Panel>
  );
}
