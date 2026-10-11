import { Archive, CircleCheck, CircleMinus, ClipboardCopy, Clock, LoaderCircle, OctagonX, Puzzle, Search, ShieldCheck, ShieldX, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { EvidenceCard } from "../components/evidence/EvidenceCard.tsx";
import { ApiError } from "../lib/api.ts";
import { BRAND } from "../lib/brand.ts";
import { EVENT_LABEL, shortHash, timeAgo } from "../lib/format.ts";
import { SourceList, sourcesOf } from "./AreaPage.tsx";
import type { DeskCtx } from "./ctx.ts";
import { readBrief, readSkills, type Brief, type BriefStep, type SkillInfo } from "./readers.ts";

type Failure = { missing: boolean; message: string };

const failure = (e: unknown): Failure => ({ missing: e instanceof ApiError && (e.status === 404 || e.status === 501), message: (e as Error).message });

const STEP: Record<string, { label: string; icon: typeof CircleCheck; cls: string }> = {
  ok: { label: "Live", icon: CircleCheck, cls: "ok" },
  done: { label: "Done", icon: CircleCheck, cls: "ok" },
  cached_sample: { label: "Cached sample", icon: Archive, cls: "warn" },
  running: { label: "Running", icon: LoaderCircle, cls: "info" },
  failed: { label: "Failed", icon: OctagonX, cls: "bad" },
  error: { label: "Failed", icon: OctagonX, cls: "bad" },
  blocked: { label: "Blocked", icon: ShieldX, cls: "bad" },
  denied: { label: "Blocked", icon: ShieldX, cls: "bad" },
  skipped: { label: "Not needed", icon: CircleMinus, cls: "muted" },
};

function useSkills(ctx: DeskCtx) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    ctx.api.researchSkills().then(
      (raw) => {
        if (!live) return;
        setSkills(readSkills(raw));
        setError(null);
      },
      (e: unknown) => live && setError(failure(e)),
    );
    return () => {
      live = false;
    };
  }, [ctx.api, tick]);
  return { skills, error, reload: () => setTick((t) => t + 1) };
}

function StepRow({ step, hosts }: { step: BriefStep; hosts?: string[] }) {
  const s = STEP[step.status] ?? { label: step.status.replace(/_/g, " "), icon: Clock, cls: "muted" };
  const hostList = step.host ? [step.host] : (hosts ?? []);
  return (
    <tr>
      <td>
        <span className="dk-step-skill">
          <Puzzle aria-hidden /> {step.skill}
        </span>
        {step.note && <span className="dk-step-note faint">{step.note}</span>}
      </td>
      <td className="mono dk-step-host">
        {hostList.length
          ? hostList.map((h) => (
              <span key={h} className="dk-host">
                {h}
              </span>
            ))
          : "-"}
      </td>
      <td>
        <span className={`dk-step-status tone-${s.cls}`}>
          <s.icon aria-hidden className={step.status === "running" ? "spin" : undefined} /> {s.label}
        </span>
      </td>
      <td className="num dk-step-ms">{step.ms === undefined ? "-" : `${Math.round(step.ms)} ms`}</td>
    </tr>
  );
}

function Steps({ steps, hostsOf }: { steps: BriefStep[]; hostsOf: Map<string, string[]> }) {
  if (steps.length === 0) return <p className="faint">The service did not report its skill steps.</p>;
  return (
    <div className="dk-table-wrap">
      <table className="dk-steps">
        <thead>
          <tr>
            <th scope="col">Skill</th>
            <th scope="col">Source host</th>
            <th scope="col">Status</th>
            <th scope="col" className="dk-step-ms">
              Time
            </th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s, i) => (
            <StepRow key={`${s.skill}-${i}`} step={s} hosts={hostsOf.get(s.skill)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SkillsDrawer({ ctx, skills, error, researchOn, onClose }: { ctx: DeskCtx; skills: SkillInfo[] | null; error: Failure | null; researchOn: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [busy, setBusy] = useState(false);
  const [turnError, setTurnError] = useState<string | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, []);
  const turnOn = async () => {
    const policy = ctx.state?.policy;
    if (!policy || busy) return;
    setBusy(true);
    setTurnError(null);
    try {
      await ctx.api.updatePolicy({ grants: [...policy.grants, { capability: "research.read", approval: "never" }] }, "turn on the research skill pack (public data only)");
      ctx.refresh();
      close.current();
    } catch (e) {
      setTurnError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dk-drawer-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dk-drawer" role="dialog" aria-modal="true" aria-labelledby="skills-title" tabIndex={-1} ref={ref}>
        <header className="dk-drawer-head">
          <div className="dk-grow">
            <h2 id="skills-title">Research skills</h2>
            <p className="faint">Each skill declares what it may read and which hosts it may contact. SkillGate holds it to that manifest and to your limits.</p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {error ? (
          <div className="dk-empty">{error.missing ? "Research service not available." : `Skills could not be loaded: ${error.message}`}</div>
        ) : !skills ? (
          <div className="dk-skel" aria-busy="true" aria-label="Loading skills" />
        ) : skills.length === 0 ? (
          <div className="dk-empty">No research skills are installed.</div>
        ) : (
          <ul className="dk-skill-list">
            {skills.map((s) => (
              <li key={s.name} className="dk-skill card">
                <header className="dk-skill-head">
                  <Puzzle aria-hidden className="dk-skill-icon" />
                  <div className="dk-grow">
                    <h3>{s.name}</h3>
                    <p className="faint">
                      {s.publisher ? s.publisher : "Publisher not stated"}
                      {s.version && ` v${s.version}`}
                    </p>
                  </div>
                  <span className={`dk-pill tone-${researchOn ? "ok" : "muted"}`}>
                    <span className="dk-dot" aria-hidden />
                    {researchOn ? "On" : "Off"}
                  </span>
                </header>
                {s.description && <p className="dk-skill-desc">{s.description}</p>}
                <dl className="dk-manifest">
                  <dt>Capability</dt>
                  <dd>
                    <span className="dk-chips">
                      {s.capabilities.map((c) => (
                        <span key={c.capability} className="chip chip-kb" title={c.approval ? `Approval: ${c.approval}` : undefined}>
                          {c.capability}
                        </span>
                      ))}
                      {s.reads.map((r) => (
                        <span key={r} className="chip chip-kb">
                          {r}
                        </span>
                      ))}
                      {s.capabilities.length + s.reads.length === 0 && <span className="faint">Not declared</span>}
                    </span>
                  </dd>
                  <dt>Effects</dt>
                  <dd>{s.effects.length ? s.effects.join(", ") : "Not declared"}</dd>
                  <dt>Money fields</dt>
                  <dd>{s.moneyFields.length ? s.moneyFields.join(", ") : "None: it cannot move money"}</dd>
                  <dt>Hosts</dt>
                  <dd>
                    {s.hosts.length ? (
                      <span className="dk-chips">
                        {s.hosts.map((h) => (
                          <span key={h} className="chip chip-system mono">
                            {h}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="faint">No network hosts declared</span>
                    )}
                  </dd>
                  {s.hash && (
                    <>
                      <dt>Manifest hash</dt>
                      <dd className="mono" title={s.hash}>
                        {shortHash(s.hash, 12)}
                      </dd>
                    </>
                  )}
                </dl>
                {s.summary && <p className="dk-callout dk-callout-ok">{s.summary}</p>}
                {s.tools.length > 0 && (
                  <details className="dk-tools">
                    <summary>{s.tools.length} tools in this pack</summary>
                    <ul>
                      {s.tools.map((t) => (
                        <li key={t.name}>
                          <span className="mono dk-tool-name">{t.name}</span>
                          {t.description && <span className="faint">{t.description}</span>}
                          <span className="dk-chips">
                            {t.hosts.map((h) => (
                              <span key={h} className="chip chip-system mono">
                                {h}
                              </span>
                            ))}
                            {t.mode && <span className="chip chip-kb">{t.mode}</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        <footer className="dk-drawer-foot">
          {researchOn ? (
            <p className="faint">
              <ShieldCheck size={14} aria-hidden className="dk-inline-icon" /> Research is on in your limits (policy v{ctx.state?.policy.version}). It reads public data only.
            </p>
          ) : (
            <>
              <p className="faint">Turning it on adds “look up public data” to your limits. You will be asked to agree to the new version first.</p>
              {turnError && <p className="error-text">{turnError}</p>}
              <button type="button" className="btn btn-primary" onClick={turnOn} disabled={busy || !ctx.state || !skills?.length}>
                {busy ? "Saving" : "Turn on research"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function noteOf(b: Brief, hostsOf: Map<string, string[]>): string {
  const lines = [`Research note: ${b.title}`, ""];
  for (const f of b.findings) {
    lines.push(`- ${f.title}${f.simulated ? " (simulated)" : ""}`, `  ${f.summary}`);
    for (const c of f.citations) lines.push(`  Source: ${c.title}${c.url ? ` <${c.url}>` : ""}`);
    for (const e of f.evidence) if (e.url) lines.push(`  Source: ${e.label} <${e.url}>`);
  }
  lines.push("", "Steps:");
  for (const s of b.steps) lines.push(`- ${s.skill}: ${s.host ?? hostsOf.get(s.skill)?.join(", ") ?? "-"}, ${s.status}, ${s.ms ?? "-"} ms`);
  if (b.notes.length) lines.push("", ...b.notes);
  if (b.id) lines.push("", `Audit turn: ${b.id}`);
  return lines.join("\n");
}

const EXAMPLES = ["Apple", "Capital One", "JPMorgan Chase"];
const LIVE_TYPES = new Set(["agent_step", "skill_loaded", "tool_proposed", "tool_executed", "decision"]);

export function ResearchPage({ ctx }: { ctx: DeskCtx }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<{ query: string; fromSeq: number } | null>(null);
  const [briefs, setBriefs] = useState<(Brief & { query: string; at: string })[]>([]);
  const [shown, setShown] = useState(0);
  const [error, setError] = useState<Failure | null>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const pack = useSkills(ctx);
  const brief = briefs[shown];
  const researchOn = Boolean(ctx.state?.policy.grants.some((g) => g.capability === "research.read"));
  const hostsOf = useMemo(() => new Map((pack.skills ?? []).flatMap((s) => s.tools.map((t): [string, string[]] => [t.name, t.hosts]))), [pack.skills]);

  const run = async (q: string) => {
    const text = q.trim();
    if (!text || busy) return;
    setBusy({ query: text, fromSeq: ctx.events.at(-1)?.seq ?? 0 });
    setError(null);
    setCopied(false);
    try {
      const raw = await ctx.api.researchBrief(text);
      setBriefs((all) => [{ ...readBrief(raw, text), query: text, at: new Date().toISOString() }, ...all].slice(0, 8));
      setShown(0);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(null);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(query);
  };
  const copy = async () => {
    if (!brief) return;
    try {
      await navigator.clipboard.writeText(noteOf(brief, hostsOf));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const live = busy ? ctx.events.filter((e) => e.seq > busy.fromSeq && LIVE_TYPES.has(e.type)).slice(-8) : [];
  const blocked = brief ? brief.steps.length > 0 && brief.steps.every((s) => s.status === "denied" || s.status === "skipped") : false;

  return (
    <div className="dk-page">
      <header className="dk-page-head">
        <div className="dk-grow">
          <p className="dk-kicker">Research</p>
          <h1>Research a holding</h1>
          <p className="muted">Look up a company or ticker. Every step names the skill and the host it read from; every card shows its evidence and sources. Facts only, no buy or sell advice.</p>
        </div>
        <button type="button" className="btn" onClick={() => setSkillsOpen(true)} aria-haspopup="dialog">
          <Puzzle size={16} aria-hidden /> Skills
        </button>
      </header>

      {ctx.state && !researchOn && !pack.error && (
        <div className="dk-banner card" role="status">
          <ShieldX aria-hidden className="dk-banner-icon" />
          <p className="dk-grow">
            <strong>Research is off in your limits.</strong> Review what the research skill may read and from which hosts, then turn it on. Until then SkillGate blocks every research step.
          </p>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setSkillsOpen(true)}>
            Review the skill
          </button>
        </div>
      )}

      <form className="dk-search card" onSubmit={submit} role="search">
        <Search aria-hidden className="dk-search-icon" />
        <label htmlFor="research-q" className="visually-hidden">
          Company name or ticker
        </label>
        <input id="research-q" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Company name or ticker, e.g. Apple or AAPL" autoComplete="off" />
        <button type="submit" className="btn btn-primary" disabled={!query.trim() || busy !== null}>
          {busy ? "Researching" : "Research"}
        </button>
      </form>
      <div className="dk-examples">
        <span className="faint">Try</span>
        {EXAMPLES.map((x) => (
          <button
            key={x}
            type="button"
            className="btn btn-sm"
            disabled={busy !== null}
            onClick={() => {
              setQuery(x);
              void run(x);
            }}
          >
            {x}
          </button>
        ))}
        <span className="faint dk-disclaimer">Public sources only. Follow-up actions are proposals that pass SkillGate like any other.</span>
      </div>

      {busy && (
        <section className="card dk-pad dk-section" aria-live="polite" aria-busy="true">
          <h2 className="section-title">
            <LoaderCircle className="spin" size={14} aria-hidden /> Researching {busy.query}
          </h2>
          {live.length ? (
            <ul className="dk-live-steps">
              {live.map((e) => (
                <li key={e.seq} className="enter">
                  <span className="mono faint">#{e.seq}</span> {EVENT_LABEL[e.type] ?? e.type}
                </li>
              ))}
            </ul>
          ) : (
            <p className="faint">Running the research skills</p>
          )}
        </section>
      )}

      {error && (
        <div className={`card dk-empty${error.missing ? "" : " dk-error"}`} role="status">
          {error.missing ? (
            <>
              <strong>Research service not available.</strong>
              <p className="faint">The server has no research route yet. The rest of the desk works without it.</p>
            </>
          ) : (
            <p>Research failed: {error.message}</p>
          )}
          <button type="button" className="btn btn-sm" onClick={() => run(query)} disabled={!query.trim() || busy !== null}>
            Try again
          </button>
        </div>
      )}

      {briefs.length > 1 && (
        <div className="dk-tabs" role="tablist" aria-label="Recent briefs">
          {briefs.map((b, i) => (
            <button key={`${b.query}-${b.at}`} type="button" role="tab" aria-selected={i === shown} className="dk-tab" onClick={() => setShown(i)}>
              {b.title} <span className="faint">{timeAgo(b.at, ctx.now)}</span>
            </button>
          ))}
        </div>
      )}

      {brief ? (
        <>
          <section className="card dk-pad dk-section" aria-labelledby="brief-steps">
            <div className="dk-row">
              <h2 id="brief-steps" className="section-title">
                Skill steps, {brief.title}
              </h2>
              {brief.simulated && <span className="sim-tag">Simulated</span>}
              <span className="dk-push dk-row">
                {brief.id && (
                  <span className="faint mono" title={`Audit turn ${brief.id}`}>
                    turn {shortHash(brief.id.replace(/^turn_/, ""), 10)}
                  </span>
                )}
                <button type="button" className="btn btn-sm" onClick={copy} disabled={brief.findings.length === 0}>
                  <ClipboardCopy size={14} aria-hidden /> {copied ? "Copied" : "Copy research note"}
                </button>
              </span>
            </div>
            <Steps steps={brief.steps} hostsOf={hostsOf} />
            {blocked && !researchOn && (
              <p className="dk-callout">
                SkillGate blocked these steps because research is off in your limits.{" "}
                <button type="button" className="btn btn-sm" onClick={() => setSkillsOpen(true)}>
                  Review the skill
                </button>
              </p>
            )}
            {brief.notes.map((n) => (
              <p key={n} className="faint dk-note">
                {n}
              </p>
            ))}
          </section>
          {brief.findings.length === 0 ? (
            <div className="card dk-empty">{blocked ? "No facts yet: every step was blocked." : "The brief came back without findings."}</div>
          ) : (
            <div className="dk-card-grid dk-card-grid-wide">
              {brief.findings.map((f) => (
                <EvidenceCard key={f.id} finding={f} />
              ))}
            </div>
          )}
          {brief.findings.length > 0 && (
            <section className="card dk-pad dk-section" aria-labelledby="brief-sources">
              <h2 id="brief-sources" className="section-title">
                Sources
              </h2>
              <SourceList sources={sourcesOf(brief.findings, brief.references.map((r) => ({ id: r.id, title: r.title, url: r.url ?? "" })))} />
            </section>
          )}
        </>
      ) : (
        !busy &&
        !error && (
          <div className="card dk-empty dk-empty-lg">
            <Search aria-hidden className="dk-empty-icon" />
            <p>Search for a company or ticker to build a brief.</p>
            <p className="faint">Research skills read public data only: SEC filings, Treasury rates, the FDIC bank list and CFPB complaints, never account data. {BRAND} does not recommend buying, selling or holding any security.</p>
          </div>
        )
      )}

      {skillsOpen && <SkillsDrawer ctx={ctx} skills={pack.skills} error={pack.error} researchOn={researchOn} onClose={() => setSkillsOpen(false)} />}
    </div>
  );
}
