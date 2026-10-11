import { withBankExecution } from '../bank/index.ts';
import { performance } from "node:perf_hooks";
import type { TraceLog } from "../audit/trace.ts";
import type { Metrics } from "../metrics.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ApprovalRequest, AuthorizationReceipt, Decision, ToolCall, ToolResult } from "../types.ts";
import { GateError, type Gate } from "./gate.ts";

export type RunOutcome =
  | { status: "denied"; decision: Decision }
  | { status: "not_approved"; decision: Decision; approval: ApprovalRequest }
  | { status: "blocked"; decision: Decision; approval?: ApprovalRequest; error: string }
  | { status: "failed"; decision: Decision; approval?: ApprovalRequest; error: string }
  | { status: "executed"; decision: Decision; approval?: ApprovalRequest; result: ToolResult; receipt?: AuthorizationReceipt };

export interface RunDeps {
  gate: Gate;
  tools: ToolRegistry;
  trace: TraceLog;
  metrics?: Metrics;
}

export async function runToolCall(
  call: ToolCall,
  { gate, tools, trace, metrics }: RunDeps,
  hooks: { onApprovalRequested?: (request: ApprovalRequest) => void } = {},
): Promise<RunOutcome> {
  const checkStarted = performance.now();
  const decision = await gate.check(call);
  metrics?.observe("gate.check", performance.now() - checkStarted);
  if (decision.verdict === "deny") return { status: "denied", decision };

  let approval: ApprovalRequest | undefined;
  if (decision.verdict === "ask") {
    const answered = gate.requestApproval(call, decision);
    const pending = gate.pendingFor(call.id);
    if (pending) hooks.onApprovalRequested?.(pending);
    approval = await answered;
    if (approval.status !== "approved") return { status: "not_approved", decision, approval };
  }

  try {
    gate.authorize(call, decision, approval);
  } catch (err) {
    if (!(err instanceof GateError)) throw err;
    return { status: "blocked", decision, approval, error: err.message };
  }

  const adapter = tools.get(call.tool)!;
  let result: ToolResult;
  const runStarted = performance.now();
  try {
    result = await withBankExecution(call.tool, call.args, call.id, () => adapter.run(call.args));
  } catch (err) {
    result = { ok: false, data: null, systemValues: [], texts: [], error: err instanceof Error ? err.message : String(err) };
  }
  metrics?.observe(`tool.run:${call.tool}`, performance.now() - runStarted);
  gate.recordToolResult(call.turnId, call.tool, result);
  trace.append("tool_executed", { callId: call.id, tool: call.tool, ok: result.ok, data: result.data, error: result.error }, call.turnId);
  if (!result.ok) return { status: "failed", decision, approval, error: result.error ?? "The tool failed." };

  const receipt = adapter.spec.effect !== "read" ? gate.issueReceipt(call, decision, approval) : undefined;
  return { status: "executed", decision, approval, result, receipt };
}
