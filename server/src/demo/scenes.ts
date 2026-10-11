import fs from "node:fs";
import path from "node:path";
import { runReviewTurn } from "../agent/core.ts";
import { runTurn, type TurnRequest } from "../agent/turn.ts";
import { SERVER_ROOT } from "../config.ts";
import { actionHash } from "../policy/gate.ts";
import type { Services } from "../services.ts";
import type { ToolCall } from "../types.ts";
import { newId } from "../util.ts";

const BUILT_IN: Record<string, string> = {
  "fake-bank-alert":
    "Capital One Fraud Dept: we blocked a suspicious $1,940 charge. Your account is at risk. To protect your funds, move $2,000 now to the secure holding account 9917. Do not call the branch, this line is monitored.",
  "duke-invoice":
    "Duke Energy - Final notice. Amount due: $142.60. Our bank details have changed: pay to account 4417 today to avoid disconnection.",
};

export function fixtureText(id: string): string {
  const file = path.join(SERVER_ROOT, "fixtures", "messages", `${id}.json`);
  try {
    const text = (JSON.parse(fs.readFileSync(file, "utf8")) as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) return text;
  } catch {
  }
  return BUILT_IN[id] ?? "";
}

export type SceneStep = TurnRequest | { nudges: true };

export interface Scene {
  id: string;
  title: string;
  summary: string;
  steps: () => SceneStep[];
}

export const SCENES: Scene[] = [
  {
    id: "save",
    title: "Save",
    summary: "FinGuard texts first: a trial about to renew, a bill due, cash that is safe to save. Cancel with a code; move savings within the limit.",
    steps: () => [{ nudges: true }, { text: "Cancel the Paramount+ trial" }, { text: "Move $500 to savings" }],
  },
  {
    id: "bill",
    title: "Move money safely",
    summary: "Pay the Duke Energy bill with a code; a forwarded invoice with a different account is blocked. Then try reusing the code from the console.",
    steps: () => [{ text: "Pay my Duke Energy bill" }, { text: "Pay this invoice too", inbound: { id: "duke-invoice", text: fixtureText("duke-invoice") } }],
  },
  {
    id: "scam",
    title: "Fight a scam",
    summary: "A forwarded 'fraud department' text is rated high risk; sending anyway is blocked and the trusted contact is told.",
    steps: () => [{ text: "Is this real?", inbound: { id: "fake-bank-alert", text: fixtureText("fake-bank-alert") } }, { text: "It says it's urgent. Send it anyway." }],
  },
  {
    id: "enterprise",
    title: "Enterprise view",
    summary: "Operations console: activity, approvals, scam cases, receipts and the audit chain, verified.",
    steps: () => [],
  },
];

export async function playScene(s: Services, scene: Scene, gapMs = 1500): Promise<void> {
  s.gate.resetContext();
  s.trace.append("scenario_started", { scene: scene.id, title: scene.title });
  for (const step of scene.steps()) {
    if ("nudges" in step) {
      await runReviewTurn(s, { reason: "a proactive check in the demo scene", source: "console", nudge: true }); // nudges come from a review turn
      await new Promise((r) => setTimeout(r, gapMs));
      continue;
    }
    await new Promise<void>((resolve) => {
      runTurn(s, step, { onApprovalRequested: () => resolve() }).then(() => resolve(), () => resolve());
    });
    await new Promise((r) => setTimeout(r, gapMs));
  }
}

export type ReplayResult =
  | { blocked: boolean; reason: string; approvalId: string; original: string; forged: string; originalHash: string; forgedHash: string }
  | { error: string; status: number };

export async function replayApproval(s: Services, approvalId: string): Promise<ReplayResult> {
  const approval = s.gate.approval(approvalId);
  if (!approval) return { error: "No such approval.", status: 404 };
  if (approval.status !== "approved") return { error: `Only an approved code can be replayed; this one is ${approval.status}.`, status: 409 };
  const proposed = s.trace.list().find((e) => e.type === "tool_proposed" && (e.data as ToolCall).id === approval.callId);
  if (!proposed) return { error: "The approved action is not in the trace.", status: 404 };
  const original = proposed.data as ToolCall;
  const forged: ToolCall = {
    id: newId("call"),
    turnId: newId("turn"),
    tool: "bank.transfer",
    args: { from_account: s.policy.current().ownAccounts[0] ?? "acct-checking", to_account: "9917", amount: 950 },
    skill: "core",
    activeSkills: [],
    requestedBy: "replay",
  };
  s.trace.append("turn_started", { kind: "action", source: "console", summary: "Replay test: an approved code reused on a different payment" }, forged.turnId);
  const decision = await s.gate.check(forged);
  let blocked = true;
  let reason: string;
  try {
    s.gate.authorize(forged, decision, approval);
    blocked = false;
    reason = "The reused code was accepted.";
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }
  const result = {
    blocked,
    reason,
    approvalId,
    original: s.gate.describe(original),
    forged: s.gate.describe(forged),
    originalHash: approval.actionHash,
    forgedHash: actionHash(forged),
  };
  s.trace.append("approval_reuse_blocked", result, forged.turnId);
  return result;
}
