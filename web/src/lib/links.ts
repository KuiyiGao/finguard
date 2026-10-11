import type { ApprovalRequest } from "@contracts";
import type { ToolStep } from "./turns.ts";

export type DeepLink = { kind: "approval" | "activity"; id: string };

export function parseLink(hash: string): DeepLink | null {
  const m = /^#(approval|activity)\/([^/?#]+)/.exec(hash);
  if (!m) return null;
  try {
    return { kind: m[1] as DeepLink["kind"], id: decodeURIComponent(m[2]!) };
  } catch {
    return null;
  }
}

export const currentLink = () => parseLink(typeof window === "undefined" ? "" : window.location.hash);

export function clearLink(): void {
  try {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  } catch {
  }
}

export type LinkTarget = { show: "approval"; approvalId: string } | { show: "activity"; callId: string | null };

export function resolveLink(link: DeepLink, input: { approvals: ApprovalRequest[]; steps: Map<string, ToolStep>; traceReady: boolean }): LinkTarget | null {
  if (link.kind === "approval" && input.approvals.some((a) => a.id === link.id)) return { show: "approval", approvalId: link.id };
  const step = link.kind === "activity" ? input.steps.get(link.id) : [...input.steps.values()].find((s) => s.approval?.id === link.id);
  if (!step && !input.traceReady) return null;
  return { show: "activity", callId: step?.call.id ?? null };
}
