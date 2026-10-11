import type { Area, CashFlow, FindingsView, TraceEvent } from "@contracts";
import { Activity as ActivityIcon, Clock, House, MessageCircle, Settings as SettingsIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EvidenceProvider, type ActionMemory, type EvidenceEnv } from "../components/evidence/EvidenceCard.tsx";
import { api, type Account, type Api, type Health, type State } from "../lib/api.ts";
import { BRAND } from "../lib/brand.ts";
import { useNow, useTrace } from "../lib/events.ts";
import { useFindings } from "../lib/findings.ts";
import { clearLink, currentLink, resolveLink, type DeepLink } from "../lib/links.ts";
import { useServerState } from "../lib/state.ts";
import { buildTurns, type ToolStep, type Turn } from "../lib/turns.ts";
import { ActivityScreen } from "./screens/Activity.tsx";
import { AreaScreen } from "./screens/Area.tsx";
import { ChatScreen } from "./screens/Chat.tsx";
import { HomeScreen } from "./screens/Home.tsx";
import { SettingsScreen } from "./screens/Settings.tsx";
import { ApprovalSheet, ConsentSheet, useApprovalSheet } from "./sheets.tsx";
import "./app.css";

const customer = api("customer");

export type Tab = "home" | "chat" | "activity" | "settings";

export interface AppCtx {
  api: Api;
  state: State | null;
  events: TraceEvent[];
  turns: Turn[];
  steps: Map<string, ToolStep>;
  accounts: Account[] | null;
  cashFlow: CashFlow | null;
  findings: FindingsView | null;
  findingsError: string | null;
  reloadFindings: () => void;
  health: Health | null;
  simulated: boolean;
  now: number;
  go: (tab: Tab, intent?: ChatIntent) => void;
  openArea: (area: Area | null) => void;
  openApproval: (id: string) => void;
  ask: (question: string) => void;
  refresh: () => void;
}

export type ChatIntent = { text?: string; forward?: boolean; send?: boolean };

const TABS: { id: Tab; label: string; icon: typeof House }[] = [
  { id: "home", label: "Home", icon: House },
  { id: "chat", label: BRAND, icon: MessageCircle },
  { id: "activity", label: "Activity", icon: ActivityIcon },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

export function CustomerApp({ framed }: { framed?: boolean }) {
  const { events, generation } = useTrace("customer");
  const { state, error: stateError, refresh: refreshState } = useServerState(customer, events, generation);
  const findings = useFindings(customer, events, generation);
  const [link, setLink] = useState<DeepLink | null>(currentLink);
  const [tab, setTab] = useState<Tab>(() => (currentLink()?.kind === "activity" ? "activity" : "home"));
  const [area, setArea] = useState<Area | null>(null);
  const [focusCall, setFocusCall] = useState<string | null>(null);
  const [intent, setIntent] = useState<ChatIntent | undefined>();
  const [reload, setReload] = useState(0);
  const [health, setHealth] = useState<Health | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const refresh = useCallback(() => { refreshState(); findings.reload(); setReload(t => t + 1); }, [refreshState, findings.reload]);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [consentLater, setConsentLater] = useState(false);
  const [cashFlow, setCashFlow] = useState<CashFlow | null>(null);
  const [memory, setMemory] = useState<Record<string, ActionMemory>>({});
  const now = useNow(1000);
  const { turns, steps } = useMemo(() => buildTurns(events), [events]);
  const receipts = events.filter((e) => e.type === "receipt_issued").length;
  const { sheet, open: openApproval, close: closeApproval } = useApprovalSheet(state?.approvals);

  useEffect(() => {
    let active = true;
    setDataError(null);
    customer.health().then(status => { if (active) setHealth(status); }, () => { if (active) setHealth(null); });
    Promise.all([customer.accounts(), customer.cashFlow()]).then(
      ([bank, cash]) => { if (active) { setAccounts(bank.accounts); setCashFlow(cash); } },
      () => { if (active) { setDataError("Could not refresh your account data. Showing the last successful update, if available."); } },
    );
    return () => { active = false; };
  }, [receipts, generation, reload]);
  useEffect(() => setMemory({}), [generation]);
  useEffect(() => setConsentLater(false), [generation, state?.policy.version]);

  const go = useCallback((next: Tab, chatIntent?: ChatIntent) => {
    setIntent(chatIntent);
    setArea(null);
    setFocusCall(null);
    setTab(next);
  }, []);
  const ask = useCallback((question: string) => go("chat", { text: question, send: true }), [go]);
  const openArea = useCallback((next: Area | null) => {
    setArea(next);
    document.querySelector(".app-screen")?.scrollTo({ top: 0 });
  }, []);
  useEffect(() => {
    const onHash = () => {
      const tab = /^#tab\/(home|chat|activity|settings)$/.exec(window.location.hash)?.[1] as Tab | undefined;
      if (tab) {
        setArea(null);
        setTab(tab);
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
        return;
      }
      const next = currentLink();
      if (next) setLink(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [traceWaited, setTraceWaited] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setTraceWaited(true), 2000);
    return () => window.clearTimeout(id);
  }, []);
  useEffect(() => {
    if (!link || !state) return;
    const target = resolveLink(link, { approvals: state.approvals, steps, traceReady: traceWaited });
    if (!target) return;
    setArea(null);
    if (target.show === "approval") {
      setFocusCall(null);
      setTab("home");
      openApproval(target.approvalId);
    } else {
      setFocusCall(target.callId);
      setTab("activity");
    }
    clearLink();
    setLink(null);
  }, [link, state, steps, traceWaited, openApproval]);

  const simulated = findings.view ? findings.view.findings.some((f) => f.simulated) : true;
  const ctx: AppCtx = {
    api: customer,
    state,
    events,
    turns,
    steps,
    accounts,
    cashFlow,
    findings: findings.view,
    findingsError: findings.error,
    reloadFindings: findings.reload,
    health,
    simulated,
    now,
    go,
    openArea,
    openApproval,
    ask,
    refresh,
  };
  const env: EvidenceEnv = {
    api: customer,
    canAct: Boolean(!stateError && state && !state.needsConsent && !state.policy.paused),
    steps,
    events,
    onAsk: ask,
    memory,
    remember: (id, m) => setMemory((all) => ({ ...all, [id]: m })),
  };
  const waiting = state?.approvals ?? [];
  const isFramed = framed ?? (typeof window !== "undefined" && window.innerWidth > 520);

  const app = (
    <EvidenceProvider value={env}>
      <div className="app" data-tab={tab}>
        <div className="app-statusbar" aria-hidden>
          <span className="num app-statusbar-time">{new Date(now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
          <span className="app-statusbar-brand">{BRAND}</span>
        </div>
        <main className="app-screen">
          <div className="app-connection" role="status">
            <span className={`live-dot${health && health.modes?.nessie !== "mock" ? " live" : ""}`} aria-hidden />
            {health ? (health.modes?.nessie === "mock" ? "Simulated bank data" : "Live Nessie sandbox, simulated settlement") : stateError || dataError ? "Demo server unavailable" : "Connecting to the demo server…"}
          </div>
          {(stateError || dataError) && <div className="banner banner-warn app-connection-error" role="alert">
            <span>{stateError ? "Cannot refresh permissions. Actions are unavailable until the connection recovers." : dataError}</span>
            <button type="button" className="btn btn-sm" onClick={refresh}>Retry</button>
          </div>}
          {!sheet && waiting.length > 0 && !state?.needsConsent && (tab !== "home" || area !== null) && (
            <div className="banner banner-warn app-approval-banner" role="status">
              <Clock size={18} aria-hidden />
              <span>
                <strong>{waiting.length === 1 ? "An approval is waiting" : `${waiting.length} approvals are waiting`}</strong> for your decision.
              </span>
              <button type="button" className="btn btn-primary btn-sm banner-btn" onClick={() => openApproval(waiting[0]!.id)}>
                Review
              </button>
            </div>
          )}
          {tab === "home" && !area && <HomeScreen ctx={ctx} onConsent={() => setConsentLater(false)} />}
          {tab === "home" && area && <AreaScreen ctx={ctx} area={area} />}
          {tab === "chat" && <ChatScreen ctx={ctx} intent={intent} clearIntent={() => setIntent(undefined)} />}
          {tab === "activity" && <ActivityScreen ctx={ctx} openId={focusCall ?? undefined} />}
          {tab === "settings" && <SettingsScreen ctx={ctx} />}
        </main>
        <nav className="app-tabs" aria-label="Sections">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" className={tab === id ? "active" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => go(id)}>
              <Icon size={21} aria-hidden />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        {state?.needsConsent && !consentLater && <ConsentSheet ctx={ctx} onLater={() => setConsentLater(true)} />}
        {sheet && !state?.needsConsent && <ApprovalSheet key={sheet.id} ctx={ctx} approval={sheet} onClose={closeApproval} />}
      </div>
    </EvidenceProvider>
  );

  if (!isFramed) return app;
  return (
    <div className="phone-wrap">
      <div className="phone">
        <div className="phone-island" aria-hidden />
        {app}
      </div>
    </div>
  );
}
