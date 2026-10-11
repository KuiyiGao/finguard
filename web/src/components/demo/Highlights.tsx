import type { TraceEvent } from "@contracts";
import { Check, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type DirectorView } from "../../lib/api.ts";
import { describeCall } from "../../lib/describe.ts";
import { useTrace } from "../../lib/events.ts";

/** Where the phone goes for each step, and the part of it to frame. */
const VIEW: Record<number, { tab: string; spot: string; last?: boolean }> = {
  1: { tab: "home", spot: ".app-connection" },
  2: { tab: "home", spot: ".psec-decide" },
  3: { tab: "home", spot: "[role=dialog]" },
  4: { tab: "activity", spot: ".step-row" },
  5: { tab: "chat", spot: ".bubble-steward", last: true },
  6: { tab: "chat", spot: ".bubble-steward", last: true },
  7: { tab: "home", spot: ".ap" },
  8: { tab: "home", spot: ".psec-checked" },
  9: { tab: "home", spot: ".psec-checked" },
  10: { tab: "activity", spot: ".app-screen" },
  11: { tab: "home", spot: ".agent-bar" },
};

/** What the audit trace says is happening, in a few words per event. */
function flowOf(e: TraceEvent): { text: string; tone: string } | null {
  const d = e.data as Record<string, any>;
  switch (e.type) {
    case "tool_proposed":
      return d?.tool?.startsWith("bank.") || d?.tool?.startsWith("subscriptions.") ? { text: `Agent proposes ${describeCall({ tool: String(d.tool), args: d.args ?? {} })}`, tone: "info" } : null;
    case "decision":
      return { text: `SkillGate ${d.verdict === "allow" ? "allows" : d.verdict === "ask" ? "asks for a code" : "denies"}`, tone: d.verdict === "deny" ? "bad" : d.verdict === "ask" ? "warn" : "ok" };
    case "scam_assessed":
      return d.risk && d.risk !== "low" ? { text: `ScamShield: ${d.risk} risk`, tone: d.risk === "high" ? "bad" : "warn" } : null;
    case "approval_resolved":
      return { text: `Approval ${d.status}`, tone: d.status === "approved" ? "ok" : "bad" };
    case "receipt_issued":
      return { text: `Receipt ${String(d.id ?? "").slice(0, 12)}`, tone: "ok" };
    case "nudge_sent":
      return { text: `Alert: ${d.title}`, tone: "info" };
    default:
      return null;
  }
}

function spotlight(n: number | undefined) {
  document.querySelectorAll(".hl-spot").forEach((el) => el.classList.remove("hl-spot"));
  const view = n ? VIEW[n] : undefined;
  if (!view) return;
  window.location.hash = `#tab/${view.tab}`;
  window.setTimeout(() => {
    const all = document.querySelectorAll<HTMLElement>(`.stage-phone ${view.spot}`);
    const el = view.last ? all[all.length - 1] : all[0];
    if (!el) return;
    el.classList.add("hl-spot");
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, 700);
}

/** The demo on one panel: one button, the line to say, what the system did, and the phone framed. */
export function Highlights() {
  const operator = useMemo(() => api("operator"), []);
  const { events } = useTrace("operator");
  const [view, setView] = useState<DirectorView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fromSeq, setFromSeq] = useState(0);
  const lastSpot = useRef<number>(0);
  const load = useCallback(() => operator.director().then(setView, () => undefined), [operator]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);
  const latest = view?.log.at(-1);
  useEffect(() => {
    const n = latest?.n ?? 0;
    if (n === lastSpot.current) return;
    lastSpot.current = n;
    spotlight(n || undefined);
  }, [latest?.n]);
  useEffect(() => {
    if (!latest) return;
    const id = window.setInterval(() => spotlight(latest.n), 4000);
    return () => window.clearInterval(id);
  }, [latest]);
  const act = async (fn: () => Promise<DirectorView>, restart = false) => {
    setBusy(true);
    setError(null);
    setFromSeq(events.at(-1)?.seq ?? 0);
    try {
      const v = await fn();
      setView(v);
      if (restart) {
        lastSpot.current = 0;
        spotlight(undefined);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const next = view?.next ? view.steps[view.next - 1] : undefined;
  const running = busy || Boolean(view?.running);
  const say = !view ? "" : !latest ? view.intro : !next ? `${view.steps[latest.n - 1]?.say ?? ""} ${view.outro}` : (view.steps[latest.n - 1]?.say ?? "");
  const flow = events.filter((e) => e.seq > fromSeq).map(flowOf).filter((f): f is { text: string; tone: string } => Boolean(f)).slice(-5);
  return (
    <section className="hl" aria-label="Demo">
      <header className="hl-head">
        <ol className="hl-dots" aria-label="Progress">
          {view?.steps.map((s) => (
            <li key={s.n} className={view.log.some((e) => e.n === s.n) ? "done" : s.n === view.next ? "now" : ""} title={s.title} />
          ))}
        </ol>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => act(() => operator.directorRestart(), true)} disabled={running} aria-label="Restart">
          <RotateCcw size={15} aria-hidden />
        </button>
      </header>
      <button type="button" className="btn btn-primary hl-next" disabled={running || !next} onClick={() => act(() => operator.directorNext())}>
        <Play size={18} aria-hidden /> {running ? "Running" : next ? next.title : "Done"}
      </button>
      {error && <p className="error-text">{error}</p>}
      {say && <p className="hl-say">{say}</p>}
      {(running || flow.length > 0) && (
        <ol className="hl-flow" aria-label="What is happening">
          {flow.map((f, i) => (
            <li key={`${i}-${f.text}`} className={`hl-flow-${f.tone}`}>
              {f.tone === "ok" && <Check size={13} aria-hidden />}
              {f.text}
            </li>
          ))}
          {running && <li className="hl-flow-wait">Working</li>}
        </ol>
      )}
      {latest && (
        <div className="hl-result card">
          {latest.lines.slice(0, 3).map((l, j) => (
            <p key={j} className={`hl-r hl-${l.tone ?? "info"}`}>
              <b>{l.label}</b> {l.text}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
