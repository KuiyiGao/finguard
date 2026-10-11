import { buildScenarios } from "../scenarios/index.ts";
import { cite, shortDate, usd0 } from "../scenarios/common.ts";
import type { Services } from "../services.ts";
import type { AgentRole, Area, AreaSummary, CashFlow, Decision, Finding, FindingsView, Nudge, SavingsReport, ScamAssessment, ToolCall, TraceEvent } from "../types.ts";
import { AREA_TITLES, cashFlowFinding, nudgeFinding, savingsFindings, scamFinding } from "./normalize.ts";

type Row = Record<string, unknown>;

const DAY = 86_400_000;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd = (n: number) => USD.format(n);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const TONE_ORDER: Record<Finding["tone"], number> = { block: 0, warn: 1, save: 2, info: 3 };

const memo = new WeakMap<Services, { key: string; view: Promise<FindingsView> }>();

export async function buildFindings(s: Services, opts: { turnId?: string; inputs?: FindingsInputs } = {}): Promise<FindingsView> {
  if (opts.turnId) {
    const view = await compute(s, new Date(), opts.inputs);
    return { ...view, findings: view.findings.map((f) => ({ ...f, turnId: opts.turnId, agent: agentFor(f) })) };
  }
  const now = new Date();
  const head = s.trace.last();
  const key = [s.startedAt, head?.seq ?? 0, head?.hash ?? "-", now.toISOString().slice(0, 13)].join("|");
  const hit = memo.get(s);
  if (hit && hit.key === key) return hit.view;
  const view = compute(s, now);
  memo.set(s, { key, view });
  view.catch(() => {
    if (memo.get(s)?.view === view) memo.delete(s);
  });
  return view;
}

export interface FindingsInputs {
  accounts?: Row[];
  bills?: Row[];
  subs?: Row[];
  savings?: SavingsReport | null;
  flow?: CashFlow | null;
  scenarios?: Awaited<ReturnType<typeof buildScenarios>>;
}

export function agentFor(f: Finding): AgentRole {
  if (f.from === "scam" || f.area === "protection" || f.id.startsWith("scam:")) return "guardian";
  if (f.from === "cash_flow") return "payments";
  if (f.from === "research" || f.area === "loans" || f.area === "contracts" || f.area === "investments") return "advisor";
  if (f.from === "savings" || f.area === "subscriptions") return "savings";
  if (f.area === "bills") return "payments";
  return f.action?.tool.startsWith("bank.") ? "payments" : "savings";
}

async function compute(s: Services, now: Date, inputs: FindingsInputs = {}): Promise<FindingsView> {
  const simulated = s.config.nessieMode === "mock";
  const createdAt = now.toISOString();
  const reportTime = Date.parse(s.startedAt) <= now.getTime() ? s.startedAt : createdAt;
  const events = s.trace.list();
  const read = async (tool: string): Promise<Row[]> => {
    try {
      const result = await s.tools.get(tool)?.run({});
      return result?.ok && Array.isArray(result.data) ? (result.data as Row[]) : [];
    } catch {
      return [];
    }
  };
  const [accounts, bills, subs] = await Promise.all([inputs.accounts ?? read("bank.get_accounts"), inputs.bills ?? read("bank.list_bills"), inputs.subs ?? read("subscriptions.list")]);
  const findings: Finding[] = [];

  try {
    const report = inputs.savings !== undefined ? inputs.savings : await s.savings();
    if (report) findings.push(...savingsFindings({ ...report, generatedAt: reportTime }, { simulated }));
  } catch (err) {
    s.log(`findings: savings report unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const nudges = new Map<string, Nudge>();
  for (const e of events.filter((x) => x.type === "nudge_sent").slice(-5)) {
    const n = e.data as Nudge;
    nudges.delete(`${n.kind}|${n.title}`);
    nudges.set(`${n.kind}|${n.title}`, n);
  }
  const sentAt = nudgeTimes(events);
  findings.push(...[...nudges.values()].reverse().map((n) => ({ ...nudgeFinding(n, { simulated }), createdAt: sentAt.get(n.id) ?? n.createdAt })));

  const flow: CashFlow | null = inputs.flow !== undefined ? inputs.flow : await s.cashFlow(s.policy.current().ownAccounts[0] ?? "").catch(() => null);
  if (flow) findings.push({ ...cashFlowFinding(flow, { createdAt: reportTime, simulated }), citations: await cite(s.rag, "kb:savings/overdraft", "overdraft cash buffer upcoming bills") });

  for (const e of events.filter((x) => x.type === "scam_assessed").slice(-5).reverse()) {
    const a = e.data as ScamAssessment;
    findings.push(scamFinding(a, { text: inboundText(a, e, events), area: "protection", createdAt: e.ts, simulated }));
  }

  const gymRow = subs.find((x) => x.id === "sub-gym");
  const gym =
    gymRow && typeof gymRow.price === "number" && typeof gymRow.renews === "string"
      ? { id: "sub-gym", price: gymRow.price, renews: gymRow.renews, status: String(gymRow.status ?? "active") }
      : undefined;
  const scenarios = inputs.scenarios ?? (await buildScenarios({ now, retriever: s.rag, policy: () => s.policy.current(), gym }));
  findings.push(...scenarios.findings.map((f) => ({ ...f, createdAt: reportTime })));

  const order = Object.keys(AREA_TITLES) as Area[];
  const sorted = findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => order.indexOf(a.f.area) - order.indexOf(b.f.area) || TONE_ORDER[a.f.tone] - TONE_ORDER[b.f.tone] || a.i - b.i)
    .map(({ f }) => f);

  const references = new Map<string, { id: string; title: string; url: string }>();
  for (const f of sorted) for (const c of f.citations) if (c.url && !references.has(c.docId)) references.set(c.docId, { id: c.docId, title: c.title, url: c.url });

  return {
    generatedAt: createdAt,
    areas: summarize(s, now, sorted, { accounts, bills, subs, flow, events, totals: scenarios.totals }),
    findings: sorted,
    references: [...references.values()],
  };
}

const URGENCY: Record<Nudge["kind"], number> = { trial_ending: 4, bill_due: 3, price_increase: 2, subscription_renewing: 1, safe_to_save: 0 };

function nudgeTimes(events: TraceEvent[]): Map<string, string> {
  const batches: TraceEvent[][] = [];
  let prevSeq = Number.NaN;
  for (const e of events) {
    if (e.type !== "nudge_sent") continue;
    if (e.seq === prevSeq + 1 && batches.length) batches.at(-1)!.push(e);
    else batches.push([e]);
    prevSeq = e.seq;
  }
  const times = new Map<string, string>();
  for (const batch of batches) {
    const end = Math.max(...batch.map((e) => Date.parse(e.ts)));
    if (!Number.isFinite(end)) continue;
    for (const e of batch) {
      const n = e.data as Nudge;
      times.set(n.id, new Date(end + (URGENCY[n.kind] ?? 0)).toISOString());
    }
  }
  return times;
}

function inboundText(a: ScamAssessment, e: TraceEvent, events: TraceEvent[]): string | undefined {
  const shared = events.filter((x) => x.type === "inbound_shared" && x.seq < e.seq) as TraceEvent<{ inboundId?: string; text?: string }>[];
  const id = a.subject.ref.replace(/^inbound:/, "");
  const match = shared.filter((x) => x.data.inboundId === id).at(-1) ?? shared.filter((x) => x.turnId && x.turnId === e.turnId).at(-1) ?? shared.at(-1);
  return typeof match?.data.text === "string" ? match.data.text : undefined;
}

function daysUntil(date: string, now: Date): number {
  return Math.round((Date.parse(`${date.slice(0, 10)}T00:00:00Z`) - Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)) / DAY);
}

const inDays = (n: number) => (n <= 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);

function summarize(
  s: Services,
  now: Date,
  findings: Finding[],
  d: { accounts: Row[]; bills: Row[]; subs: Row[]; flow: CashFlow | null; events: TraceEvent[]; totals: Awaited<ReturnType<typeof buildScenarios>>["totals"] },
): AreaSummary[] {
  const inArea = (area: Area) => findings.filter((f) => f.area === area);
  const generic = (area: Area): AreaSummary["status"] => (inArea(area).some((f) => f.tone !== "info") ? "attention" : "ok");
  const summary = (area: Area, status: AreaSummary["status"], headline: string, amount?: { label: string; value: number }): AreaSummary => ({
    area,
    title: AREA_TITLES[area],
    status,
    headline,
    ...(amount ? { amount } : {}),
    findings: inArea(area).length,
  });

  const balances = round2(d.accounts.reduce((sum, a) => sum + (typeof a.balance === "number" ? a.balance : 0), 0));
  const flow = d.flow;
  const everyday = summary(
    "everyday",
    flow && flow.safeToMove === 0 ? "attention" : generic("everyday"),
    flow
      ? flow.safeToMove > 0
        ? `${usd(flow.safeToMove)} safe to move after bills due in ${flow.horizonDays} days`
        : `Bills due in the next ${flow.horizonDays} days use up the room in checking`
      : `Balances total ${usd(balances)}`,
    { label: "Total balances", value: balances },
  );

  const unpaid = d.bills
    .filter((b) => b.status !== "paid" && typeof b.amount === "number" && typeof b.due === "string")
    .sort((a, b) => String(a.due).localeCompare(String(b.due)));
  const next = unpaid[0];
  const nextDays = next ? daysUntil(String(next.due), now) : null;
  const billsArea = summary(
    "bills",
    nextDays !== null && nextDays <= 3 ? "attention" : generic("bills"),
    next ? `${String(next.payee ?? "Next bill")} ${usd(Number(next.amount))} due ${inDays(nextDays!)}` : "No bills due",
    next ? { label: "Next bill", value: Number(next.amount) } : undefined,
  );

  const active = d.subs.filter((x) => x.status === "active" && typeof x.price === "number");
  const monthly = round2(active.reduce((sum, x) => sum + Number(x.price), 0));
  const byRenewal = active.filter((x) => typeof x.renews === "string").sort((a, b) => String(a.renews).localeCompare(String(b.renews)));
  const upcoming = byRenewal.find((x) => x.trial === true) ?? byRenewal[0];
  const nextEvent = upcoming ? `${String(upcoming.merchant ?? "A subscription")}${upcoming.trial === true ? " trial" : ""} renews ${inDays(daysUntil(String(upcoming.renews), now))}` : "";
  const subscriptions = summary(
    "subscriptions",
    generic("subscriptions"),
    active.length ? `${active.length} active, ${usd(monthly)} a month${nextEvent ? `; ${nextEvent}` : ""}` : "No active subscriptions",
    { label: "Monthly total", value: monthly },
  );

  const t = d.totals;
  const risky = (area: Area) => inArea(area).filter((f) => f.id.startsWith("scam:") && (f.tone === "block" || f.tone === "warn")).length;
  const investments = summary(
    "investments",
    generic("investments"),
    [risky("investments") ? `${plural(risky("investments"), "risky pitch")} flagged` : "", `fees could cost about ${usd0(t.feeDrag)} over 20 years (illustrative)`]
      .filter(Boolean)
      .join("; ")
      .replace(/^./, (c) => c.toUpperCase()),
    { label: "Simulated total", value: t.investments },
  );
  const loans = summary(
    "loans",
    generic("loans"),
    t.loans.refinanceMonthlySaving > 0 ? `Refinancing could save ${usd(t.loans.refinanceMonthlySaving)} a month (simulated offer)` : `${usd(t.loans.balance)} owed (simulated)`,
    { label: "Simulated balance", value: t.loans.balance },
  );
  const c = t.contract;
  const contracts = summary(
    "contracts",
    generic("contracts"),
    c.cancelled ? "CloudGym cancelled; no renewal pending" : `CloudGym renews ${shortDate(c.renewal)}; notice due ${inDays(c.daysToDeadline)}`,
    c.cancelled ? undefined : { label: "Next renewal", value: c.renewalCost },
  );

  const since = now.getTime() - DAY;
  const calls = new Map<string, ToolCall>();
  for (const e of d.events) if (e.type === "tool_proposed") calls.set((e.data as ToolCall).id, e.data as ToolCall);
  const blocked = d.events
    .filter((e) => e.type === "decision" && Date.parse(e.ts) >= since && (e.data as Decision).verdict === "deny")
    .map((e) => calls.get((e.data as Decision).callId))
    .filter((call): call is ToolCall => !!call && typeof call.args.amount === "number");
  const blockedAmount = round2(blocked.reduce((sum, call) => sum + Number(call.args.amount), 0));
  const pending = s.gate.pendingApprovals().length;
  const protection = summary(
    "protection",
    blocked.length > 0 ? "blocked" : pending > 0 || inArea("protection").some((f) => f.tone === "block" || f.tone === "warn") ? "attention" : "ok",
    `${plural(blocked.length, "blocked attempt")} in 24 hours; ${plural(pending, "approval")} pending`,
    blockedAmount > 0 ? { label: "Kept from leaving (24 hours)", value: blockedAmount } : undefined,
  );

  return [everyday, billsArea, subscriptions, investments, loans, contracts, protection];
}
