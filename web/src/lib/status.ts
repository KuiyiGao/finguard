import type { ApprovalRequest, AuthorizationReceipt, Decision } from "@contracts";
import { sortReasons } from "../components/gate.tsx";
import type { ToolStep } from "./turns.ts";

export type Audience = "customer" | "operator";

export interface ActionState {
  kind: "checking" | "done" | "waiting" | "stopped" | "unknown";
  text: string;
  receiptId?: string;
}

export function plainReason(message: string | undefined): string {
  const m = (message ?? "").trim().replace(/^(blocked|denied|stopped|error)\s*:\s*/i, "").replace(/\.\s*$/, "");
  if (!m) return "it did not pass your limits";
  return /^[A-Z][a-z]*(?![A-Za-z])/.test(m) ? m.charAt(0).toLowerCase() + m.slice(1) : m;
}

export function firstReason(decision: Decision | undefined): string {
  const r = decision ? sortReasons(decision.reasons).find((x) => x.verdict !== "allow") : undefined;
  return plainReason(r?.message);
}

const stopped = (why: string): ActionState => ({ kind: "stopped", text: `Stopped: ${why}` });

const DONE_WITH_RECEIPT = "Done, receipt saved";

function fromApproval(status: ApprovalRequest["status"] | undefined, via?: string, audience: Audience = "customer"): ActionState | null {
  if (status === "denied") return stopped(via?.includes("wrong") ? "the code did not match" : audience === "operator" ? "the customer declined" : "you declined");
  if (status === "expired") return stopped("no answer in time");
  return null;
}

export function authorizedBy(r: AuthorizationReceipt, audience: Audience = "customer"): string {
  const who = audience === "operator" ? "The customer" : "You";
  return r.authorizedBy.kind === "approval" ? `${who}, with the code, in ${r.channel === "imessage" ? "iMessage" : "the app"}` : `${audience === "operator" ? "The customer's" : "Your"} standing limit (policy v${r.authorizedBy.policyVersion})`;
}

export function stepState(step: ToolStep, audience: Audience = "customer"): ActionState {
  const d = step.decision;
  if (step.receipt) return { kind: "done", text: DONE_WITH_RECEIPT, receiptId: step.receipt.id };
  if (step.executed) return step.executed.ok ? { kind: "done", text: "Done" } : { kind: "unknown", text: "Execution not confirmed. Check Activity before retrying." };
  if (!d) return { kind: "checking", text: "Checking" };
  if (d.verdict === "deny") return stopped(firstReason(d));
  const closed = fromApproval(step.approval?.status, step.approvedVia, audience);
  if (closed) return closed;
  if (d.verdict === "ask" && step.approval?.status !== "approved") return { kind: "waiting", text: audience === "operator" ? "Waiting for the customer's code (hidden from operators)" : "Waiting for your code" };
  return { kind: "checking", text: d.verdict === "allow" ? "Within your limits, finishing" : "Approved, finishing" };
}

export function outcomeState(out: Record<string, unknown>): ActionState {
  const decision = out.decision as Decision | undefined;
  switch (out.status) {
    case "executed":
      return { kind: "done", text: DONE_WITH_RECEIPT, receiptId: (out.receipt as AuthorizationReceipt | undefined)?.id };
    case "awaiting_approval":
      return { kind: "waiting", text: "Waiting for your code" };
    case "denied":
      return stopped(firstReason(decision));
    case "not_approved":
      return fromApproval((out.approval as ApprovalRequest | undefined)?.status) ?? stopped("you declined");
    case "failed":
      return { kind: "unknown", text: "Execution not confirmed. Check Activity before retrying." };
    case "blocked":
      return stopped(plainReason(typeof out.error === "string" ? out.error : undefined));
    default:
      return { kind: "unknown", text: "Outcome unconfirmed. Check Activity before retrying." };
  }
}
