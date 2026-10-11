import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { ActionStatus } from "../components/evidence/ActionStatus.tsx";
import { AreaTile } from "../components/evidence/AreaTile.tsx";
import { EvidenceCard, EvidenceProvider } from "../components/evidence/EvidenceCard.tsx";
import { EvidenceChain } from "../components/chain/index.ts";
import { VizView } from "../components/viz/VizView.tsx";
import { AgentTheater, GateRing, OUTFIT_LABEL, OUTFIT_PROPS, OUTFITS, Phone, Seal, SKILL_LABEL, SKILL_NAMES, SkillIcon, FinGuard, StewardGlyph, StewardMark, type GateState, type Outfit, type SealState } from "../components/theater/index.ts";
import { ParticleField, type ParticleMode, type ParticleTone } from "../components/particles/index.ts";
import { BRAND } from "../lib/brand.ts";
import { SAMPLE_AREAS, SAMPLE_CHAIN_CONTRACT, SAMPLE_CHAIN_STEPS, SAMPLE_FINDINGS, SAMPLE_SCAM_STEP, SAMPLE_TURNS, SAMPLE_VIZ } from "./samples.ts";
import "./gallery.css";

type Theme = "system" | "light" | "dark";

export function Gallery() {
  const [theme, setTheme] = useState<Theme>("system");
  const [asked, setAsked] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    return () => {
      delete root.dataset.theme;
    };
  }, [theme]);

  return (
    <EvidenceProvider value={{ canAct: true, onAsk: setAsked }}>
      <main className="gal">
        <header className="gal-head">
          <div>
            <h1>{BRAND} gallery</h1>
            <p className="faint">
              <span className="gal-sample">Sample data</span> Every chart and card with made-up numbers for visual checks. Product screens only show numbers from the API.
            </p>
          </div>
          <div className="gal-tools">
            <div className="gal-seg" role="group" aria-label="Theme">
              {(
                [
                  ["system", Monitor],
                  ["light", Sun],
                  ["dark", Moon],
                ] as const
              ).map(([t, Icon]) => (
                <button key={t} type="button" className={theme === t ? "on" : ""} aria-pressed={theme === t} onClick={() => setTheme(t)}>
                  <Icon size={14} aria-hidden /> {t[0]!.toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn-sm" onClick={() => setRun((r) => r + 1)}>
              Replay animations
            </button>
          </div>
        </header>
        {asked && (
          <p className="gal-asked" role="status">
            Ask button pressed: “{asked}”
          </p>
        )}

        <div key={run}>
          <h2 className="section-title gal-h">Charts, one per kind, full and compact</h2>
          <section className="gal-grid">
            {SAMPLE_VIZ.map(({ name, viz }) => (
              <article key={name} className="card gal-cell">
                <p className="gal-kind">
                  <code>{name}</code> <span className="gal-sample">Sample</span>
                </p>
                <VizView viz={viz} />
                <p className="gal-kind gal-sub">compact</p>
                <VizView viz={viz} compact />
              </article>
            ))}
          </section>

          <h2 className="section-title gal-h">Evidence cards, every tone</h2>
          <section className="gal-grid">
            {SAMPLE_FINDINGS.map((f) => (
              <EvidenceCard key={f.id} finding={f} />
            ))}
          </section>

          <h2 className="section-title gal-h">Compact cards, lists and chat</h2>
          <section className="gal-grid gal-phone">
            {SAMPLE_FINDINGS.slice(1, 6).map((f) => (
              <EvidenceCard key={f.id} finding={f} compact />
            ))}
          </section>

          <h2 className="section-title gal-h">Area tiles, phone width</h2>
          <section className="tiles gal-tiles">
            {SAMPLE_AREAS.map((a, i) => (
              <AreaTile key={a.area} area={a} index={i} />
            ))}
          </section>

          <ChainSamples />

          <h2 className="section-title gal-h">Agent theater, sample turns</h2>
          <section className="gal-stack gal-theater">
            {SAMPLE_TURNS.map(({ name, turn }) => (
              <article key={name} className="card gal-cell">
                <p className="gal-kind">
                  {name} <span className="gal-sample">Sample</span>
                </p>
                <AgentTheater turn={turn} autoPlay />
                <p className="gal-kind gal-sub">strip (older turns, phone chat)</p>
                <AgentTheater turn={turn} mode="strip" />
              </article>
            ))}
          </section>

          <StewardSamples />
          <ObjectSamples />
          <ParticleSamples />

          <h2 className="section-title gal-h">Skill and service icons, lucide in a rounded square, 16, 32 and 48 px</h2>
          <section className="gal-icons">
            {SKILL_NAMES.map((name) => (
              <div key={name} className="gal-icon">
                <SkillIcon name={name} size={16} />
                <SkillIcon name={name} size={32} />
                <SkillIcon name={name} size={48} />
                <span className="gal-kind">
                  <code>{name}</code> {SKILL_LABEL[name]}
                </span>
              </div>
            ))}
          </section>

          <h2 className="section-title gal-h">Action status lines</h2>
          <section className="gal-stack">
            <ActionStatus title="Move $300.00 from Checking to Savings" state={{ kind: "done", text: "Done, receipt saved", receiptId: "rcpt_sample01" }} />
            <ActionStatus title="Pay Duke Energy bill $84.20" state={{ kind: "waiting", text: "Waiting for your code" }} />
            <ActionStatus title="Send $2,000.00 to account 9917" state={{ kind: "stopped", text: "Stopped: account 9917 appears only in the forwarded message" }} />
            <ActionStatus title="Cancel Spotify" state={{ kind: "checking", text: "Checking with your limits" }} />
          </section>
        </div>
      </main>
    </EvidenceProvider>
  );
}

type ChainStage = keyof typeof SAMPLE_CHAIN_STEPS;
const CHAIN_STAGES: [ChainStage, string][] = [
  ["before", "Before the tap"],
  ["waiting", "Waiting for the code"],
  ["receipt", "Approved, receipt"],
];

function ChainSamples() {
  const [stage, setStage] = useState<ChainStage>("receipt");
  const scam = SAMPLE_FINDINGS.find((f) => f.id === "sample-scam")!;
  return (
    <>
      <h2 className="section-title gal-h">Evidence chain, contract and scam message</h2>
      <div className="gal-seg" role="group" aria-label="Where the contract's action is in the trace">
        {CHAIN_STAGES.map(([id, label]) => (
          <button key={id} type="button" className={stage === id ? "on" : ""} aria-pressed={stage === id} onClick={() => setStage(id)}>
            {label}
          </button>
        ))}
      </div>
      <section className="gal-chains">
        <article className="card gal-cell">
          <EvidenceChain finding={SAMPLE_CHAIN_CONTRACT} step={SAMPLE_CHAIN_STEPS[stage]} sample />
        </article>
        <article className="card gal-cell">
          <EvidenceChain finding={scam} step={SAMPLE_SCAM_STEP} sample />
        </article>
      </section>
      <p className="gal-kind gal-sub">Phone width (390 px)</p>
      <section className="gal-grid gal-phone">
        <article className="card gal-cell">
          <EvidenceChain finding={SAMPLE_CHAIN_CONTRACT} step={SAMPLE_CHAIN_STEPS[stage]} sample />
        </article>
        <article className="card gal-cell">
          <EvidenceChain finding={scam} step={SAMPLE_SCAM_STEP} sample />
        </article>
      </section>
    </>
  );
}

function StewardSamples() {
  const [at, setAt] = useState(0);
  const swap: Outfit = OUTFITS[at % OUTFITS.length]!;
  return (
    <>
      <h2 className="section-title gal-h">FinGuard mark, six specialists, idle, working and status</h2>
      <section className="gal-cast">
        {OUTFITS.map((o) => (
          <article key={o} className="card gal-sprite">
            <div className="gal-sprite-row">
              <StewardMark outfit={o} size={64} />
              <StewardMark outfit={o} state="working" size={64} />
            </div>
            <div className="gal-sprite-row">
              <StewardMark outfit={o} size={40} status="ok" />
              <StewardMark outfit={o} size={40} status="warn" />
              <StewardMark outfit={o} size={40} status="bad" />
              <StewardMark outfit={o} size={24} />
            </div>
            <p className="gal-kind gal-outfit">
              <span>
                <StewardGlyph outfit={o} /> <code>{o}</code> {OUTFIT_LABEL[o]}
              </span>
              <span className="faint">{OUTFIT_PROPS[o]}</span>
            </p>
          </article>
        ))}
        <article className="card gal-sprite gal-swap">
          <div className="gal-sprite-row">
            <FinGuard outfit={swap} state="working" size={64} />
          </div>
          <button type="button" className="btn btn-sm" onClick={() => setAt((i) => i + 1)}>
            Hand off to the next specialist
          </button>
          <p className="gal-kind gal-outfit">
            <span>Hand-off: the glyph cross-fades, the ring changes color, a small pop</span>
          </p>
        </article>
      </section>
    </>
  );
}

const GATE_STATES: GateState[] = ["open", "checking", "allow", "ask", "locked"];
const SEAL_STATES: SealState[] = ["idle", "working", "pass", "repair", "fail"];

function ObjectSamples() {
  const [gate, setGate] = useState<GateState>("open");
  const [seal, setSeal] = useState<SealState>("idle");
  return (
    <>
      <h2 className="section-title gal-h">Stage objects, the customer, SkillGate and the evaluator are things, not characters</h2>
      <section className="gal-objects">
        <article className="card gal-cell gal-obj">
          <p className="gal-kind">SkillGate ring: the ring closes, the shackle morphs, the mark draws in</p>
          <GateRing state={gate} size={96} label={`SkillGate: ${gate}`} />
          <div className="gal-seg" role="group" aria-label="SkillGate state">
            {GATE_STATES.map((s) => (
              <button key={s} type="button" className={gate === s ? "on" : ""} aria-pressed={gate === s} onClick={() => setGate(s)}>
                {s}
              </button>
            ))}
          </div>
          <div className="gal-sprite-row">
            {GATE_STATES.map((s) => (
              <GateRing key={s} state={s} size={48} label={`SkillGate: ${s}`} />
            ))}
          </div>
        </article>
        <article className="card gal-cell gal-obj">
          <p className="gal-kind">Evaluator seal: it turns while it reads, then its mark draws itself</p>
          <Seal state={seal} size={96} label={`Evaluator: ${seal}`} />
          <div className="gal-seg" role="group" aria-label="Evaluator state">
            {SEAL_STATES.map((s) => (
              <button key={s} type="button" className={seal === s ? "on" : ""} aria-pressed={seal === s} onClick={() => setSeal(s)}>
                {s}
              </button>
            ))}
          </div>
          <div className="gal-sprite-row">
            {SEAL_STATES.map((s) => (
              <Seal key={s} state={s} size={48} label={`Evaluator: ${s}`} />
            ))}
          </div>
        </article>
        <article className="card gal-cell gal-obj">
          <p className="gal-kind">The customer: a phone (idle, typing, sent, a forwarded message)</p>
          <div className="gal-sprite-row">
            <Phone size={72} />
            <Phone state="working" size={72} />
            <Phone state="sent" size={72} />
            <Phone state="working" tone="inbound" size={72} label="Forwarded message" />
          </div>
          <div className="gal-sprite-row">
            <Phone size={48} />
            <Phone size={24} />
          </div>
        </article>
      </section>
    </>
  );
}

const PARTICLE_SAMPLES: { mode: ParticleMode; tone: ParticleTone; what: string }[] = [
  { mode: "idle", tone: "neutral", what: "Waiting: a few motes orbit FinGuard, a soft halo breathes" },
  { mode: "gather", tone: "untrusted", what: "Reading a forwarded message: warm motes drawn in along curves" },
  { mode: "stream", tone: "trusted", what: "Evidence moving to the next station: a cool ribbon" },
  { mode: "scan", tone: "untrusted", what: "Reading a document: sparks along a sweep" },
  { mode: "pass", tone: "ok", what: "SkillGate allows: particles flow through the gate" },
  { mode: "stop", tone: "bad", what: "SkillGate blocks: particles hit the gate and fall" },
  { mode: "burst", tone: "ok", what: "A reply approved or a receipt sealed: one burst, then calm" },
];

function ParticleSamples() {
  return (
    <>
      <h2 className="section-title gal-h">Particles, one sample per mode</h2>
      <section className="gal-pfs">
        {PARTICLE_SAMPLES.map(({ mode, tone, what }) => (
          <article key={mode} className="card gal-cell">
            <p className="gal-kind">
              <code>{mode}</code> <span className="gal-sample">Sample</span>
            </p>
            <div className={`gal-pf gal-pf-${mode}`}>
              {mode === "scan" ? (
                <span className="gal-pf-doc" data-pf="from" aria-hidden>
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              ) : mode === "gather" ? (
                <span data-pf="from">
                  <Phone state="working" tone="inbound" size={48} label="Forwarded message" />
                </span>
              ) : mode === "stream" || mode === "pass" || mode === "stop" ? (
                <span data-pf="from">
                  <FinGuard outfit={mode === "stream" ? "advisor" : "payments"} state="working" size={48} />
                </span>
              ) : null}
              {mode === "idle" || mode === "gather" ? (
                <span data-pf="to">
                  <FinGuard outfit={mode === "gather" ? "guardian" : "base"} state={mode === "gather" ? "working" : "idle"} size={72} />
                </span>
              ) : mode === "burst" ? (
                <span data-pf="to">
                  <Seal state="pass" size={72} />
                </span>
              ) : mode === "scan" ? null : (
                <span data-pf="to">
                  <GateRing state={mode === "stream" ? "checking" : mode === "pass" ? "allow" : "locked"} size={56} />
                </span>
              )}
              <ParticleField mode={mode} tone={tone} from={mode === "idle" || mode === "burst" ? null : '[data-pf="from"]'} to={mode === "scan" ? null : '[data-pf="to"]'} />
            </div>
            <p className="faint gal-pf-what">
              {what}, tone <code>{tone}</code>
            </p>
          </article>
        ))}
      </section>
    </>
  );
}
