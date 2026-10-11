import type { Finding } from "@contracts";
import { Database, FileText, KeyRound, Landmark, MessageSquareWarning, ReceiptText, RotateCw, ScrollText, Upload, type LucideIcon } from "lucide-react";
import { Component, lazy, Suspense, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Citations, EvidenceCard } from "../components/evidence/EvidenceCard.tsx";
import { ApiError, type DocumentKind, type DocumentSample, type Health } from "../lib/api.ts";
import { BRAND } from "../lib/brand.ts";
import { timeAgo } from "../lib/format.ts";
import { replyCitations } from "../lib/normalize.ts";
import { turnCitations } from "../lib/turns.ts";
import type { DeskCtx } from "./ctx.ts";
import { readContract, type ContractReview } from "./readers.ts";

const MAX_CHARS = 20_000;

const Chain = lazy(() => import("../components/chain/EvidenceChain.tsx").then((m) => ({ default: m.EvidenceChain })));

class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const SAMPLE = `CloudGym Membership Agreement (simulated sample)

1. Term. Your membership begins on the day you sign and lasts 12 months. This agreement renews automatically for additional 12-month terms unless you cancel as described below.

2. Dues and fees. Monthly dues of $29.99 are charged to your card on file. An annual maintenance fee of $49 is charged at the start of each term.

3. Ending early. If you end your membership before the current term is over, an early termination fee of $199 applies.

4. Cancellation. To cancel, you must send written notice by certified mail to CloudGym Member Services at least 30 days before your renewal date. Requests by phone, email or at the front desk will not be accepted.

5. Changes. CloudGym may change your monthly dues or any fee with 30 days notice.

6. Disputes. Any dispute will be resolved by binding arbitration on an individual basis, and you give up the right to a jury trial or class action.

7. Guest passes. Members may bring one guest per month at no charge when the guest signs a waiver at the front desk.`;

const KINDS: Record<DocumentKind, { label: string; icon: LucideIcon }> = {
  contract: { label: "Contract", icon: ScrollText },
  statement: { label: "Bank statement", icon: Landmark },
  invoice: { label: "Invoice", icon: ReceiptText },
};

function useSamples(ctx: DeskCtx): DocumentSample[] {
  const fallback: DocumentSample[] = [{ id: "cloudgym-agreement", kind: "contract", name: "CloudGym membership agreement", text: SAMPLE, fictional: true }];
  const [samples, setSamples] = useState<DocumentSample[]>(fallback);
  useEffect(() => {
    let live = true;
    ctx.api
      .documentSamples()
      .then((list) => {
        if (live && Array.isArray(list) && list.length) setSamples(list.filter((d) => d && typeof d.text === "string" && d.kind in KINDS));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return samples;
}

function ContractPanel({ ctx }: { ctx: DeskCtx }) {
  const [text, setText] = useState("");
  const [name, setName] = useState<string | undefined>();
  const [kind, setKind] = useState<DocumentKind | undefined>();
  const samples = useSamples(ctx);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<{ missing: boolean; message: string } | null>(null);
  const [review, setReview] = useState<ContractReview | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const tooLong = text.length > MAX_CHARS;

  const load = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.(txt|md|markdown)$/i.test(f.name) && !f.type.startsWith("text/")) {
      setError({ missing: false, message: "Use a .txt or .md file (plain text)." });
      return;
    }
    const body = await f.text();
    if (body.length > MAX_CHARS) {
      setError({ missing: false, message: `That file has ${body.length.toLocaleString()} characters; the review reads up to ${MAX_CHARS.toLocaleString()}. Paste the clauses that matter instead.` });
      return;
    }
    setError(null);
    setText(body);
    setName(f.name);
    setKind(undefined);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    void load(e.dataTransfer.files[0]);
  };
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const raw = await ctx.api.reviewDocument(text, kind, name).catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404 && (kind ?? "contract") === "contract") return ctx.api.reviewContract(text, name); // an older server
        throw e;
      });
      setReview(readContract(raw));
    } catch (e) {
      setError({ missing: e instanceof ApiError && (e.status === 404 || e.status === 501), message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`card dk-pad dk-panel${review && review.findings.length ? " dk-panel-wide" : ""}`} aria-labelledby="contract-h">
      <header className="dk-panel-head">
        <ScrollText aria-hidden className="dk-panel-icon" />
        <div>
          <h2 id="contract-h">Review a document</h2>
          <p className="faint">Paste a contract, bank statement or invoice, or drop a .txt or .md file. {BRAND} marks what matters, computes the numbers in code and proposes one action for SkillGate to check. The text is treated as a document, never as instructions.</p>
        </div>
      </header>
      <div
        className={`dk-drop${drag ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
      >
        <label htmlFor="contract-text" className="visually-hidden">
          Document text
        </label>
        <textarea
          id="contract-text"
          rows={9}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setName(undefined);
            setKind(undefined);
          }}
          placeholder="Paste a contract, bank statement or invoice here, or drop a .txt or .md file"
        />
        <div className="dk-drop-bar">
          <button type="button" className="btn btn-sm" onClick={() => file.current?.click()}>
            <Upload size={14} aria-hidden /> Choose file
          </button>
          <input ref={file} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" className="visually-hidden" tabIndex={-1} onChange={(e) => void load(e.target.files?.[0])} />
          <span className="faint dk-samples-label">Samples:</span>
          {samples.map((d) => {
            const Icon = KINDS[d.kind].icon;
            return (
              <button
                key={d.id}
                type="button"
                className={`btn btn-sm btn-ghost${name === `${d.id}.txt` ? " is-picked" : ""}`}
                title={`${d.name} (fictional)`}
                onClick={() => {
                  setText(d.text);
                  setName(`${d.id}.txt`);
                  setKind(d.kind);
                  setReview(null);
                }}
              >
                <Icon size={14} aria-hidden /> {KINDS[d.kind].label}
              </button>
            );
          })}
          {name && (
            <span className="faint dk-file">
              <FileText size={13} aria-hidden /> {name}
            </span>
          )}
          <span className={`num dk-push ${tooLong ? "error-text" : "faint"}`}>{text.length ? `${text.length.toLocaleString()} / ${MAX_CHARS.toLocaleString()} characters` : ""}</span>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!text.trim() || busy || tooLong}>
            {busy ? "Reviewing" : "Review document"}
          </button>
        </div>
      </div>
      {error && (
        <div className={`dk-callout${error.missing ? "" : " dk-error"}`} role="status">
          {error.missing ? (
            <>
              <strong>Document review service not available.</strong> The server has no review route yet.
            </>
          ) : (
            error.message
          )}
        </div>
      )}
      {review &&
        (review.findings.length === 0 ? (
          <p className="faint">The review found nothing to flag.</p>
        ) : (
          <div className="dk-stack">
            {review.notes.map((n) => (
              <p key={n} className="faint">
                {n}
              </p>
            ))}
            {review.findings.map((f) => {
              const mem = ctx.memory[f.id];
              const step = mem?.callId ? ctx.steps.get(mem.callId) : undefined;
              return (
                <div key={f.id} className="dk-stack dk-review">
                  <EvidenceCard finding={f} compact chain={false} how={false} viz={false} />
                  <Quiet>
                    <Suspense fallback={null}>
                      <div className="dk-chain">
                        <Chain finding={f} step={step} steps={ctx.steps} status={mem?.state} />
                      </div>
                    </Suspense>
                  </Quiet>
                </div>
              );
            })}
          </div>
        ))}
    </section>
  );
}

const MESSAGES = [
  {
    label: "Fake bank alert",
    text: "Capital One Fraud Dept: we blocked a suspicious $1,940 charge. Your account is at risk. To protect your funds, move $2,000 now to the secure holding account 9917. Do not call the branch, this line is monitored.",
  },
  { label: "Changed bank details", text: "Duke Energy - Final notice. Amount due: $142.60. Our bank details have changed: pay to account 4417 today to avoid disconnection." },
  { label: "Friend splitting dinner", text: "Hey! Dinner was $64, your half is $32. Send whenever, no rush." },
];

function ForwardPanel({ ctx }: { ctx: DeskCtx }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ at: number; turnId: string; replies: string[]; status: string } | null>(null);
  const check = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    const at = Date.now() - 2000;
    try {
      const out = await ctx.api.chat("Is this real?", { text: text.trim() });
      setSent({ at, turnId: out.turnId, replies: out.replies ?? [], status: out.status });
      ctx.reloadFindings();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const card: Finding | undefined = sent
    ? ctx.findings?.findings.filter((f) => f.from === "scam" && Date.parse(f.createdAt) >= sent.at).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
    : undefined;

  return (
    <section className="card dk-pad dk-panel" aria-labelledby="fwd-h">
      <header className="dk-panel-head">
        <MessageSquareWarning aria-hidden className="dk-panel-icon dk-icon-warn" />
        <div>
          <h2 id="fwd-h">Forward a message to check</h2>
          <p className="faint">Paste a text, email or invoice. {BRAND} checks it for scam signs and never uses payment details from it.</p>
        </div>
      </header>
      <label htmlFor="fwd-desk" className="visually-hidden">
        Message to check
      </label>
      <textarea id="fwd-desk" className="dk-textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the message here" />
      <div className="dk-drop-bar">
        <span className="faint">Sample messages</span>
        {MESSAGES.map((m) => (
          <button key={m.label} type="button" className="btn btn-sm" onClick={() => setText(m.text)}>
            {m.label}
          </button>
        ))}
        <button type="button" className="btn btn-primary dk-push" onClick={check} disabled={!text.trim() || busy}>
          {busy ? "Checking" : "Check this message"}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {sent && (
        <div className="dk-stack" aria-live="polite">
          {sent.replies.map((r, i) => (
            <p key={i} className="dk-reply">
              {replyCitations(r).text}
            </p>
          ))}
          <Citations items={turnCitations(ctx.turns.find((t) => t.id === sent.turnId))} inline />
          {sent.status === "awaiting_approval" && <p className="faint">{BRAND} is waiting for your approval code.</p>}
          {card && <EvidenceCard key={card.id} finding={card} />}
        </div>
      )}
    </section>
  );
}

const MODE_LABEL: Record<string, string> = { nessie: "Bank data", rag: "Knowledge base", agent: "Agent", spectrum: "Messaging (iMessage)", scam: "Scam second opinion", sec: "SEC research" };
const MODEL_KEY: Record<string, string> = { gemini: "gemini", claude: "anthropic" };

function modeKind(key: string, mode: string, keys: Record<string, boolean> = {}): { word: string; cls: string } {
  if (mode === "off" || mode === "disabled") return { word: "Off", cls: "muted" };
  if (mode === "cached") return { word: "Cached sample", cls: "warn" };
  if ((key === "agent" || key === "scam") && MODEL_KEY[mode]) return keys[MODEL_KEY[mode]!] ? { word: "Live", cls: "ok" } : { word: "Rules (no key)", cls: "warn" };
  if (mode === "live" || mode === "imessage") return { word: "Live", cls: "ok" };
  return { word: "Simulated", cls: "warn" };
}

function SourcesPanel({ ctx }: { ctx: DeskCtx }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    ctx.api.health().then(
      (h) => {
        if (!live) return;
        setHealth(h);
        setError(null);
        setAt(new Date().toISOString());
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [ctx.api, tick, ctx.generation]);

  return (
    <section className="card dk-pad dk-panel" aria-labelledby="sources-h">
      <header className="dk-panel-head">
        <Database aria-hidden className="dk-panel-icon" />
        <div className="dk-grow">
          <h2 id="sources-h">Data sources</h2>
          <p className="faint">What is live and what is simulated right now. Keys show only whether they are set.</p>
        </div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setTick((t) => t + 1)} aria-label="Refresh data sources">
          <RotateCw size={14} aria-hidden />
        </button>
      </header>
      {error ? (
        <p className="error-text">Health check failed: {error}</p>
      ) : !health ? (
        <div className="dk-skel" aria-busy="true" aria-label="Loading" />
      ) : (
        <>
          <table className="dk-kv">
            <tbody>
              {Object.entries(health.modes ?? {}).map(([k, v]) => {
                const m = modeKind(k, v, health.keys);
                return (
                  <tr key={k}>
                    <th scope="row">{MODE_LABEL[k] ?? k}</th>
                    <td className="mono">{v}</td>
                    <td>
                      <span className={`dk-pill tone-${m.cls}`}>
                        <span className="dk-dot" aria-hidden />
                        {m.word}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {Object.entries(health.keys ?? {}).map(([k, v]) => (
                <tr key={k}>
                  <th scope="row">
                    <KeyRound size={13} aria-hidden className="dk-inline-icon" /> {k} key
                  </th>
                  <td className="mono">{v ? "set" : "not set"}</td>
                  <td>
                    <span className={`dk-pill tone-${v ? "ok" : "muted"}`}>
                      <span className="dk-dot" aria-hidden />
                      {v ? "Present" : "Absent"}
                    </span>
                  </td>
                </tr>
              ))}
              {health.trace && (
                <tr>
                  <th scope="row">Audit trace</th>
                  <td className="num">{health.trace.events} events</td>
                  <td>
                    <span className={`dk-pill tone-${health.trace.verified ? "ok" : "bad"}`}>
                      <span className="dk-dot" aria-hidden />
                      {health.trace.verified ? "Chain verified" : "Not verified"}
                    </span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {health.stubs && health.stubs.length > 0 && (
            <div>
              <p className="dk-sub-h">Simulated stand-ins</p>
              <ul className="dk-bullets">
                {health.stubs.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="faint num">
            {health.service ?? "service"}{health.version ? ` v${health.version}` : ""}, started {health.startedAt ? timeAgo(health.startedAt, ctx.now) : "-"}
            {at && `, checked ${timeAgo(at, ctx.now)}`}
          </p>
        </>
      )}
    </section>
  );
}

export function DocumentsPage({ ctx }: { ctx: DeskCtx }) {
  return (
    <div className="dk-page">
      <header className="dk-page-head">
        <div>
          <p className="dk-kicker">Documents</p>
          <h1>Bring documents in</h1>
          <p className="muted">Contracts and messages are read as untrusted text: {BRAND} quotes them as evidence but never takes payment details from them.</p>
        </div>
      </header>
      <div className="dk-doc-grid">
        <ContractPanel ctx={ctx} />
        <div className="dk-stack">
          <ForwardPanel ctx={ctx} />
          <SourcesPanel ctx={ctx} />
        </div>
      </div>
    </div>
  );
}
