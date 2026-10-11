import type { CashFlow } from "@contracts";
import { Activity as ActivityIcon, FileInput, LayoutDashboard, Monitor, Moon, Search, ShieldCheck, Sun, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppCtx } from "../app/CustomerApp.tsx";
import { ApprovalSheet, ConsentSheet, useApprovalSheet } from "../app/sheets.tsx";
import { EvidenceProvider, type ActionMemory, type EvidenceEnv } from "../components/evidence/EvidenceCard.tsx";
import { api, type Health } from "../lib/api.ts";
import { BRAND } from "../lib/brand.ts";
import { useNow, useTrace } from "../lib/events.ts";
import { useFindings } from "../lib/findings.ts";
import { useServerState } from "../lib/state.ts";
import { buildTurns } from "../lib/turns.ts";
import { ActivityPage } from "./ActivityPage.tsx";
import { AreaPage } from "./AreaPage.tsx";
import { hrefOf, useHashPage, type DeskCtx, type Page } from "./ctx.ts";
import { DocumentsPage } from "./Documents.tsx";
import { Overview } from "./Overview.tsx";
import { ResearchPage } from "./Research.tsx";
import { SidePanel } from "./SidePanel.tsx";
import "../app/app.css"; // the approval and consent sheets, shared with the phone
import "./desk.css";

const customer = api("customer");

type Theme = "system" | "light" | "dark";
const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const t = localStorage.getItem("desk-theme");
      return t === "system" || t === "dark" ? t : "light"; // light unless the viewer chose otherwise
    } catch {
      return "light";
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      localStorage.setItem("desk-theme", theme);
    } catch {
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "system" ? "light" : t === "light" ? "dark" : "system"))];
}

const same = (a: Page, b: Page) => a.id === b.id && (a.id !== "area" || (b.id === "area" && a.area === b.area));

export function Desk() {
  const page = useHashPage();
  const { events, status, generation } = useTrace("customer");
  const { state, refresh } = useServerState(customer, events, generation);
  const findings = useFindings(customer, events, generation);
  const [cashFlow, setCashFlow] = useState<CashFlow | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [memory, setMemory] = useState<Record<string, ActionMemory>>({});
  const [consentLater, setConsentLater] = useState(false);
  const [draft, setDraft] = useState<{ text: string; n: number } | null>(null);
  const [theme, cycleTheme] = useTheme();
  const now = useNow(1000);
  const { turns, steps } = useMemo(() => buildTurns(events), [events]);
  const receipts = events.filter((e) => e.type === "receipt_issued").length;
  const { sheet, open: openApproval, close: closeApproval } = useApprovalSheet(state?.approvals);

  useEffect(() => {
    customer.cashFlow().then(setCashFlow, () => setCashFlow(null));
  }, [receipts, generation]);
  useEffect(() => {
    customer.health().then(setHealth, () => setHealth(null));
  }, [generation]);
  useEffect(() => setMemory({}), [generation]);
  useEffect(() => setConsentLater(false), [generation, state?.policy.version]);
  useEffect(() => {
    document.title = `${BRAND} Desk`;
  }, []);
  useEffect(() => {
    document.querySelector(".dk-main")?.scrollTo({ top: 0 });
  }, [page]);

  const go = useCallback((next: Page) => {
    window.location.hash = hrefOf(next);
  }, []);
  const ask = useCallback((question: string) => setDraft((d) => ({ text: question, n: (d?.n ?? 0) + 1 })), []);

  const ctx: DeskCtx = {
    api: customer,
    state,
    events,
    status,
    generation,
    turns,
    steps,
    findings: findings.view,
    findingsError: findings.error,
    reloadFindings: findings.reload,
    cashFlow,
    health,
    now,
    ask,
    go,
    openApproval,
    refresh,
    memory,
  };
  const env: EvidenceEnv = {
    api: customer,
    canAct: Boolean(state && !state.needsConsent && !state.policy.paused),
    steps,
    events,
    onAsk: ask,
    memory,
    remember: (id, m) => setMemory((all) => ({ ...all, [id]: m })),
  };
  const sheetCtx: AppCtx = {
    api: customer,
    state,
    events,
    turns,
    steps,
    accounts: null,
    cashFlow,
    findings: findings.view,
    findingsError: findings.error,
    reloadFindings: findings.reload,
    health,
    simulated: findings.view ? findings.view.findings.some((f) => f.simulated) : true,
    now,
    go: () => go({ id: "overview" }),
    openArea: (area) => go(area ? { id: "area", area } : { id: "overview" }),
    openApproval,
    ask,
    refresh,
  };
  const later = useCallback(() => setConsentLater(true), []);
  const ThemeIcon = THEME_ICON[theme];

  const nav = (target: Page, label: string, Icon: LucideIcon, extra?: ReactNode) => (
    <a href={hrefOf(target)} className={`dk-nav${same(page, target) ? " active" : ""}`} aria-current={same(page, target) ? "page" : undefined}>
      <Icon aria-hidden className="dk-nav-icon" />
      <span className="dk-nav-label">{label}</span>
      {extra}
    </a>
  );

  return (
    <EvidenceProvider value={env}>
      <div className="desk">
        <a className="dk-skip" href="#dk-main" onClick={(e) => (e.preventDefault(), document.getElementById("dk-main")?.focus())}>
          Skip to content
        </a>
        <nav className="dk-rail" aria-label="Desk">
          <div className="dk-brand">
            <span className="dk-mark" aria-hidden>
              <ShieldCheck size={18} />
            </span>
            <span>
              <strong>{BRAND}</strong>
              <span className="dk-brand-sub">Desk</span>
            </span>
          </div>
          {nav({ id: "overview" }, "Overview", LayoutDashboard)}
          <p className="dk-rail-h">Agent tools</p>
          {nav({ id: "documents" }, "Documents", FileInput)}
          {nav({ id: "research" }, "Research", Search)}
          <p className="dk-rail-h">What the agent did</p>
          {nav({ id: "activity" }, "Activity", ActivityIcon, state && state.receipts.length > 0 ? <span className="dk-count num" title="Receipts">
                {state.receipts.length}
                <span className="visually-hidden"> receipts</span>
              </span> : undefined)}
          <div className="dk-rail-foot">
            <span className="dk-live" role="status">
              <span className={`live-dot${status === "live" ? " live" : ""}`} aria-hidden />
              {status === "live" ? "Live" : status === "connecting" ? "Connecting" : "Offline"}
            </span>
            <button type="button" className="dk-foot-link dk-theme" onClick={cycleTheme} aria-label={`Theme: ${theme}. Change theme`}>
              <ThemeIcon aria-hidden /> Theme: {theme}
            </button>
          </div>
        </nav>

        <main className="dk-main" id="dk-main" tabIndex={-1}>
          {page.id === "overview" && <Overview ctx={ctx} />}
          {page.id === "area" && <AreaPage key={page.area} ctx={ctx} area={page.area} />}
          <div hidden={page.id !== "research"}>
            <ResearchPage ctx={ctx} />
          </div>
          <div hidden={page.id !== "documents"}>
            <DocumentsPage ctx={ctx} />
          </div>
          {page.id === "activity" && <ActivityPage ctx={ctx} />}
        </main>

        <SidePanel ctx={ctx} draft={draft} />

        {state?.needsConsent && !consentLater && <ConsentSheet ctx={sheetCtx} onLater={later} />}
        {sheet && !state?.needsConsent && <ApprovalSheet key={sheet.id} ctx={sheetCtx} approval={sheet} onClose={closeApproval} />}
      </div>
    </EvidenceProvider>
  );
}
