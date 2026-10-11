import { Bell, ExternalLink, MessageSquareWarning, ShieldAlert, User } from "lucide-react";
import { useMemo } from "react";
import { StepRow } from "../components/evidence/StepRow.tsx";
import { clockTime, formatUsd, shortHash } from "../lib/format.ts";
import { RISK_WORDS } from "../lib/normalize.ts";
import { gateStats, isMoneyStep, type Turn } from "../lib/turns.ts";
import { BRAND } from "../lib/brand.ts";
import { plainIds } from "../lib/describe.ts";
import { TURN_LABEL } from "./agents.ts";
import type { DeskCtx } from "./ctx.ts";

function clip(text: string, n = 120): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

function TurnRow({ turn }: { turn: Turn }) {
  const opener = turn.items.find((i) => i.kind === "user" || i.kind === "inbound" || i.kind === "nudge" || i.kind === "alert");
  const tools = turn.items.flatMap((i) => (i.kind === "tool" && i.step.decision && isMoneyStep(i.step) ? [i.step] : []));
  const scams = turn.items.flatMap((i) => (i.kind === "scam" ? [i.assessment] : []));
  const replies = turn.items.filter((i) => i.kind === "reply").length;
  const nudges = turn.items.flatMap((i) => (i.kind === "nudge" ? [i.nudge] : []));
  const title =
    opener?.kind === "user"
      ? opener.text
      : opener?.kind === "inbound"
        ? `Forwarded: ${opener.text}`
        : opener?.kind === "nudge"
          ? `${BRAND} noticed ${nudges.length} ${nudges.length === 1 ? "thing" : "things"}`
          : opener?.kind === "alert"
            ? opener.text
            : turn.start
              ? `${TURN_LABEL[turn.start.kind] ?? turn.start.kind}: ${plainIds(turn.start.summary)}`
              : "System activity";
  const Icon = opener?.kind === "inbound" ? MessageSquareWarning : opener?.kind === "nudge" ? Bell : opener?.kind === "alert" ? ShieldAlert : User;

  return (
    <li className="dk-turn">
      <span className="dk-turn-time num faint">{clockTime(turn.ts)}</span>
      <div className="dk-turn-main">
        <p className="dk-turn-title">
          <Icon aria-hidden className={`dk-turn-icon${opener?.kind === "inbound" ? " warn" : ""}`} /> <span className="num">{clip(title)}</span>
          {turn.start && <span className="badge badge-neutral dk-push">{TURN_LABEL[turn.start.kind] ?? turn.start.kind}</span>}
        </p>
        {nudges.length > 0 && <p className="faint dk-turn-sub num">{nudges.map((n) => n.title).join(", ")}</p>}
        {scams.map((a) => (
          <p key={a.id} className="dk-turn-sub">
            <span className={`dk-pill tone-${a.risk === "high" ? "bad" : a.risk === "medium" ? "warn" : "ok"}`}>
              <span className="dk-dot" aria-hidden />
              Scam check: {RISK_WORDS[a.risk] ?? a.risk}
            </span>{" "}
            <span className="faint num">score {a.score}/100</span>
          </p>
        ))}
        {tools.length > 0 && (
          <ul className="dk-turn-steps">
            {tools.map((s) => (
              <li key={s.call.id}>
                <StepRow step={s} meta={s.decision ? `${s.decision.latencyMs} ms` : undefined} />
              </li>
            ))}
          </ul>
        )}
        {replies > 0 && tools.length === 0 && scams.length === 0 && (
          <p className="faint dk-turn-sub num">
            {replies} {replies === 1 ? "reply" : "replies"}
          </p>
        )}
      </div>
    </li>
  );
}

export function ActivityPage({ ctx }: { ctx: DeskCtx }) {
  const stats = useMemo(() => gateStats(ctx.steps.values(), ctx.events), [ctx.steps, ctx.events]);
  const recent = [...ctx.turns].reverse().slice(0, 40);
  const kept = ctx.findings?.areas.find((a) => a.area === "protection")?.amount;
  const kpis = [
    { label: "Money actions checked", value: String(stats.reviewed) },
    { label: "Allowed", value: String(stats.allowed) },
    { label: "Needed approval", value: String(stats.asked) },
    { label: "Blocked", value: String(stats.denied) },
    { label: "Receipts", value: String(ctx.state?.receipts.length ?? 0) },
    ...(kept ? [{ label: kept.label, value: formatUsd(kept.value) }] : []),
  ];

  return (
    <div className="dk-page">
      <header className="dk-page-head">
        <div className="dk-grow">
          <p className="dk-kicker">Activity</p>
          <h1>Decisions and receipts</h1>
          <p className="muted">Every money action is checked against your limits and leaves a receipt in a hash-chained audit trail.</p>
        </div>
        <a className="btn" href="/console">
          <ExternalLink size={15} aria-hidden /> Operations console
        </a>
      </header>
      <dl className="dk-kpis">
        {kpis.map((k) => (
          <div key={k.label} className="dk-kpi card">
            <dt className="faint">{k.label}</dt>
            <dd className="num">{k.value}</dd>
          </div>
        ))}
      </dl>
      <section className="card dk-section" aria-labelledby="turns-h">
        <div className="dk-row dk-pad-x">
          <h2 id="turns-h" className="section-title">
            Recent turns
          </h2>
          <span className="faint num dk-push">
            {ctx.events.length} trace events{ctx.state?.trace.head ? `, head ${shortHash(ctx.state.trace.head)}` : ""}
          </span>
        </div>
        {recent.length === 0 ? (
          <p className="dk-empty">Nothing yet. Ask {BRAND} something, or play a demo scene from the console.</p>
        ) : (
          <ul className="dk-turns">
            {recent.map((t) => (
              <TurnRow key={t.id} turn={t} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
