import type { Evidence, Finding, RagHit, TraceEvent } from "@contracts";
import { BookOpen, ChevronDown, ExternalLink, MessageCircle, Wallet } from "lucide-react";
import { createContext, useContext, useId, useRef, useState } from "react";
import type { Api } from "../../lib/api.ts";
import { BRAND } from "../../lib/brand.ts";
import { outcomeState, plainReason, stepState, type ActionState } from "../../lib/status.ts";
import type { ToolStep } from "../../lib/turns.ts";
import { AgentLine } from "../chain/AgentLine.tsx";
import { ChainControl } from "../chain/ChainControl.tsx";
import { findChainStep, hasEvidenceChain } from "../chain/model.ts";
import { CountUp } from "../viz/motion.tsx";
import { VizView } from "../viz/VizView.tsx";
import { ActionStatus } from "./ActionStatus.tsx";
import { AREA_ICON, AREA_TITLES, ORIGIN, TONE } from "./meta.ts";
import "./evidence.css";

export interface ActionMemory {
  callId?: string;
  state: ActionState;
}

export interface EvidenceEnv {
  api?: Api;
  canAct?: boolean;
  steps?: Map<string, ToolStep>;
  onAsk?: (question: string) => void;
  memory?: Record<string, ActionMemory>;
  remember?: (findingId: string, m: ActionMemory) => void;
  events?: TraceEvent[];
}

const Env = createContext<EvidenceEnv>({});
export const EvidenceProvider = Env.Provider;

export function EvidenceChip({ e }: { e: Pick<Evidence, "origin" | "trusted" | "source"> }) {
  const o = ORIGIN[e.origin] ?? (e.trusted ? ORIGIN.reference : ORIGIN.message);
  const Icon = o.icon;
  return (
    <span className={`ev-chip ev-chip-${e.origin}${e.trusted ? "" : " ev-chip-untrusted"}`} title={`${e.trusted ? "Trusted" : "Not trusted for payment details"}, ${e.source}`}>
      <Icon aria-hidden /> {o.label}
    </span>
  );
}

export function Citations({ items, inline = false }: { items: Pick<RagHit, "docId" | "title" | "url">[]; inline?: boolean }) {
  if (items.length === 0) return null;
  return (
    <ul className={`ev-list${inline ? " ev-cites-inline" : ""}`} aria-label="Sources">
      {items.map((c) => (
        <li key={c.docId} className="ev-cite">
          <span className="ev-chip ev-chip-reference">
            <BookOpen aria-hidden /> Reference
          </span>
          {c.url ? (
            <a href={c.url} target="_blank" rel="noreferrer noopener" className="ev-cite-link">
              {c.title} <ExternalLink aria-hidden />
            </a>
          ) : (
            <span>{c.title}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Metric({ finding, compact }: { finding: Finding; compact: boolean }) {
  const m = finding.metric;
  if (!m) return null;
  return (
    <div className={compact ? "ev-cmetric" : "ev-metric"}>
      <span className="ev-metric-value">
        <CountUp value={m.value} unit={m.unit} duration={1000} />
        {m.unit === "score" && <span className="ev-metric-of">/100</span>}
      </span>
      <span className="ev-metric-label">{m.label}</span>
      {compact && finding.simulated && <span className="sim-tag">Simulated</span>}
    </div>
  );
}

function useAction(finding: Finding, env: EvidenceEnv) {
  const saved = env.memory?.[finding.id];
  const [local, setLocal] = useState<ActionMemory | undefined>(saved);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const mem = env.memory ? saved : local;
  const step = mem?.callId ? env.steps?.get(mem.callId) : undefined;
  const live = step ? stepState(step) : undefined;
  const state = live && (live.kind !== "checking" || !mem || mem.state.kind === "waiting") ? live : mem?.state;
  const keep = (m: ActionMemory) => {
    setLocal(m);
    env.remember?.(finding.id, m);
  };
  const run = async () => {
    if (!finding.action || !env.api || submitting.current || (mem && state?.kind !== "stopped")) return;
    submitting.current = true;
    setBusy(true);
    keep({ state: { kind: "checking", text: "Checking with your limits" } });
    try {
      const out = await env.api.action(finding.action.tool, finding.action.args);
      keep({ callId: typeof out.callId === "string" ? out.callId : undefined, state: outcomeState(out) });
    } catch (e) {
      keep({ state: { kind: "unknown", text: `Outcome unconfirmed. Check Activity before taking another action: ${plainReason((e as Error).message)}` } });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return { state, busy, run, tried: Boolean(mem) && state?.kind !== "stopped", step };
}

export function EvidenceCard({ finding, compact = false, onAsk, chain = true, how = true, viz = true }: { finding: Finding; compact?: boolean; onAsk?: (question: string) => void; chain?: boolean; how?: boolean; viz?: boolean }) {
  const env = useContext(Env);
  const ask = onAsk ?? env.onAsk;
  const [open, setOpen] = useState(false);
  const [allEvidence, setAllEvidence] = useState(false);
  const titleId = useId();
  const action = useAction(finding, env);
  const tone = TONE[finding.tone] ?? TONE.info;
  const ToneIcon = tone.icon;
  const AreaIcon = AREA_ICON[finding.area] ?? Wallet;
  const full = !compact || open;
  const evidence = allEvidence ? finding.evidence : finding.evidence.slice(0, 4);
  const chainStep = action.step ?? findChainStep(finding, env.steps);

  const actions = (
    <>
      {(finding.action || (ask && finding.ask) || compact) && (
        <div className="ev-actions">
          {finding.action &&
            (env.canAct ? (
              !action.tried || action.state?.kind === "stopped" ? (
                <button type="button" className="btn btn-primary ev-btn" onClick={action.run} disabled={action.busy || action.tried}>
                  {action.busy ? "Checking" : action.tried ? "Check Activity" : finding.action.label}
                </button>
              ) : null
            ) : (
              <span className="ev-offer">
                Offered: <strong>{finding.action.label}</strong> (runs through SkillGate when the customer taps it)
              </span>
            ))}
          {ask && finding.ask && (
            <button type="button" className="btn ev-btn ev-ask" onClick={() => ask(finding.ask!)} title={finding.ask}>
              <MessageCircle aria-hidden /> {compact && !open ? "Ask" : `Ask ${BRAND}`}
            </button>
          )}
          {compact && (
            <button
              type="button"
              className={`btn btn-ghost ev-btn ev-more${open ? "" : " ev-icon-only"}`}
              aria-expanded={open}
              aria-label={open ? "Show less" : "Show the evidence"}
              title={open ? "Show less" : "Show the evidence"}
              onClick={() => setOpen(!open)}
            >
              {open && "Less"} <ChevronDown aria-hidden className={open ? "flip" : undefined} />
            </button>
          )}
        </div>
      )}
      {action.state && <ActionStatus state={action.state} />}
    </>
  );

  if (!full)
    return (
      <article className={`ev ev-compact tone-${tone.cls} enter`} aria-labelledby={titleId}>
        <div className="ev-crow">
          <span className="ev-icon" aria-hidden>
            <AreaIcon />
          </span>
          <div className="ev-cmain">
            <h3 id={titleId} className="ev-title num">
              {finding.title}
            </h3>
            <p className="ev-sub">
              <span className="ev-tone-word">
                <ToneIcon aria-hidden /> {tone.label}
              </span>
              {AREA_TITLES[finding.area] ?? finding.area}
              {finding.simulated && !finding.metric && <span className="sim-tag">Simulated</span>}
            </p>
          </div>
          <Metric finding={finding} compact />
        </div>
        {viz && finding.viz && (
          <div className="ev-viz ev-viz-compact">
            <VizView viz={finding.viz} compact />
          </div>
        )}
        {actions}
      </article>
    );

  return (
    <article className={`ev tone-${tone.cls} enter`} aria-labelledby={titleId}>
      <header className="ev-head">
        <span className="ev-area">
          <AreaIcon aria-hidden /> {AREA_TITLES[finding.area] ?? finding.area}
        </span>
        <span className="ev-tone">
          <ToneIcon aria-hidden /> {tone.label}
        </span>
        {finding.simulated && <span className="sim-tag">Simulated</span>}
      </header>
      <h3 id={titleId} className="ev-title num">
        {finding.title}
      </h3>
      <p className="ev-summary num">{finding.summary}</p>
      <Metric finding={finding} compact={false} />
      {viz && finding.viz && (
        <div className="ev-viz">
          <VizView viz={finding.viz} />
        </div>
      )}
      {finding.evidence.length > 0 && (
        <section className="ev-section" aria-label="Evidence">
          <h4 className="ev-h">Evidence</h4>
          <ul className="ev-list">
            {evidence.map((e, i) => (
              <li key={`${e.source}-${i}`} className={`ev-item${e.trusted ? "" : " ev-item-untrusted"}`}>
                <EvidenceChip e={e} />
                <span className="ev-item-label num">
                  {e.label}
                  {e.url && (
                    <a className="ev-link" href={e.url} target="_blank" rel="noreferrer noopener" aria-label="Open source">
                      <ExternalLink aria-hidden />
                    </a>
                  )}
                </span>
                {e.quote && <q className="ev-quote">{e.quote}</q>}
              </li>
            ))}
          </ul>
          {finding.evidence.length > 4 && (
            <button type="button" className="btn btn-ghost btn-sm ev-show-all" onClick={() => setAllEvidence(!allEvidence)}>
              {allEvidence ? "Show less" : `Show all ${finding.evidence.length}`}
            </button>
          )}
        </section>
      )}
      {finding.citations.length > 0 && (
        <section className="ev-section" aria-label="Sources">
          <h4 className="ev-h">Sources</h4>
          <Citations items={finding.citations} />
        </section>
      )}
      {finding.assumptions && (
        <details className="ev-how">
          <summary>How we calculated this</summary>
          <p className="num">{finding.assumptions}</p>
        </details>
      )}
      {actions}
      {how && finding.agent && <AgentLine finding={finding} agent={finding.agent} events={env.events} step={chainStep} steps={env.steps} status={action.state} />}
      {chain && hasEvidenceChain(finding) && <ChainControl finding={finding} step={chainStep} steps={env.steps} status={action.state} sample={finding.id.startsWith("sample-")} />}
    </article>
  );
}
