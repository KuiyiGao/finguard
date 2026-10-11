import type { Area, CashFlow, FindingsView, TraceEvent } from "@contracts";
import { useEffect, useState } from "react";
import type { ActionMemory } from "../components/evidence/EvidenceCard.tsx";
import type { Api, Health, State } from "../lib/api.ts";
import type { StreamStatus } from "../lib/events.ts";
import type { ToolStep, Turn } from "../lib/turns.ts";

export type Page = { id: "overview" } | { id: "area"; area: Area } | { id: "research" } | { id: "documents" } | { id: "activity" };

const AREAS: Area[] = ["everyday", "bills", "subscriptions", "investments", "loans", "contracts", "protection"];

export function parseHash(hash: string): Page {
  const [id, arg] = hash.replace(/^#\/?/, "").split("/");
  if (id === "area" && AREAS.includes(arg as Area)) return { id: "area", area: arg as Area };
  if (id === "research" || id === "documents" || id === "activity") return { id };
  return { id: "overview" };
}

export function hrefOf(page: Page): string {
  return page.id === "area" ? `#/area/${page.area}` : `#/${page.id}`;
}

export function useHashPage(): Page {
  const [page, setPage] = useState<Page>(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setPage(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return page;
}

export interface DeskCtx {
  api: Api;
  state: State | null;
  events: TraceEvent[];
  status: StreamStatus;
  generation: number;
  turns: Turn[];
  steps: Map<string, ToolStep>;
  findings: FindingsView | null;
  findingsError: string | null;
  reloadFindings: () => void;
  cashFlow: CashFlow | null;
  health: Health | null;
  now: number;
  ask: (question: string) => void;
  go: (page: Page) => void;
  openApproval: (id: string) => void;
  refresh: () => void;
  memory: Record<string, ActionMemory>;
}
