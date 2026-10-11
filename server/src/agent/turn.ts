import { buildFindings } from "../findings/index.ts";
import { runToolCall } from "../policy/run.ts";
import type { Services } from "../services.ts";
import type { ApprovalRequest, ToolCall } from "../types.ts";
import { newId } from "../util.ts";
import type { AgentContext } from "./agent.ts";
import { replyData, startTurn, type TurnSource } from "./core.ts";

export interface TurnRequest {
  turnId?: string;
  text: string;
  inbound?: { id?: string; text: string };
  source?: TurnSource;
}

export interface TurnResult {
  turnId: string;
  replies: string[];
}

export async function runTurn(s: Services, request: TurnRequest, hooks: { onApprovalRequested?: (a: ApprovalRequest) => void } = {}): Promise<TurnResult> {
  const turnId = request.turnId ?? newId("turn");
  const inbound = request.inbound && { id: request.inbound.id ?? newId("in"), text: request.inbound.text };
  startTurn(s, turnId, inbound ? "inbound" : "chat", request.source ?? "app", inbound ? `Customer forwarded a message: "${request.text.slice(0, 80)}"` : `Customer asked: "${request.text.slice(0, 100)}"`);
  if (inbound) s.gate.recordInbound(turnId, inbound.id, inbound.text);
  s.gate.recordUserMessage(turnId, newId("msg"), request.text);

  const replies: string[] = [];
  const ctx: AgentContext = {
    tool: (tool, args) => {
      const call: ToolCall = { id: newId("call"), turnId, tool, args, skill: "core", activeSkills: [], requestedBy: s.config.agentMode === "replay" ? "replay" : "model" };
      return runToolCall(call, s, {
        onApprovalRequested: (approval) => {
          ctx.say(`This needs your approval: ${s.gate.describe(call, [], false)}. Open the request in the app to approve it with its code, or decline.`);
          hooks.onApprovalRequested?.(approval);
        },
      });
    },
    say: (text) => {
      replies.push(text);
      s.trace.append("agent_reply", replyData(s, text), turnId);
    },
    checkMessage: async (text, ref) => {
      const assessment = await s.scam.assessMessage(text, ref);
      s.trace.append("scam_assessed", assessment, turnId);
      return assessment;
    },
    savings: async () => {
      const report = await s.savings();
      s.trace.append("savings_report", report, turnId);
      return report;
    },
    pause: () => void s.policy.update({ paused: true }, "paused from chat"),
    alertTrustedContact: (text) => {
      const contact = s.policy.current().trustedContact;
      s.trace.append("alert_sent", { to: contact?.name ?? null, handle: contact?.handle ?? null, text, delivered: false, channel: "app" }, turnId);
    },
    recentInbound: () => s.gate.contextTexts("inbound_message"),
    policy: () => s.policy.current(),
    search: (query, collection) => {
      const known = (["savings", "plans", "fees", "scams"] as const).find((c) => c === collection);
      return s.rag.search(query, { k: 3, ...(known ? { collection: known } : {}) });
    },
    findings: async (area) => (await buildFindings(s)).findings.filter((f) => !area || f.area === area),
  };

  try {
    const handle = () => s.agent.handle({ turnId, text: request.text, inbound }, ctx);
    await (s.metrics ? s.metrics.time("agent.turn", handle) : handle());
  } catch (err) {
    ctx.say("Something went wrong on my side, so I stopped. Nothing was sent.");
    s.log(`turn ${turnId} failed: ${err instanceof Error ? err.stack : String(err)}`);
  }
  return { turnId, replies };
}
