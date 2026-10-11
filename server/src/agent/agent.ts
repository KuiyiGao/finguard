import type { RunOutcome } from "../policy/run.ts";
import type { Area, DelegationPolicy, Finding, RagHit, ScamAssessment, SavingsReport } from "../types.ts";

export interface TurnInput {
  turnId: string;
  text: string;
  inbound?: { id: string; text: string };
}

export interface AgentContext {
  tool(name: string, args: Record<string, unknown>): Promise<RunOutcome>;
  say(text: string): void;
  checkMessage(text: string, ref: string): Promise<ScamAssessment>;
  savings(): Promise<SavingsReport>;
  pause(): void;
  alertTrustedContact(text: string): void;
  recentInbound(): string[];
  policy(): DelegationPolicy;
  search?(query: string, collection?: string): Promise<RagHit[]>;
  findings?(area?: Area): Promise<Finding[]>;
}

export interface Agent {
  name: string;
  handle(input: TurnInput, ctx: AgentContext): Promise<void>;
}
