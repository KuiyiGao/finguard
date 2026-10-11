import { performance } from "node:perf_hooks";
import type { TraceLog } from "../audit/trace.ts";
import type { Metrics } from "../metrics.ts";
import type { RunOutcome } from "../policy/run.ts";
import type { Area, ToolSpec } from "../types.ts";
import type { Agent, AgentContext, TurnInput } from "./agent.ts";
import { deterministicReply, emptyEvidence, evaluateReply, withoutCode, type Review, type TurnEvidence } from "./evaluator.ts";
import { LlmError, runModelSpecialist, type ChatMessage, type Provider, type RunState, type SpecialistDef } from "./llm.ts";
import { classifyIntent, RuleAgent, type RuleIntent } from "./rules.ts";
import { RESEARCH_TOOL_NAMES } from "../research/tools.ts";

export type SpecialistId = "guardian" | "payments" | "savings" | "advisor";
export interface AgentStep {
  agent: "orchestrator" | SpecialistId | "evaluator";
  step: "route" | "scope" | "evaluate" | "repair" | "fallback";
  detail: string;
  tools?: string[];
  ok?: boolean;
  problems?: string[];
}

const BANK_READS = ["bank.get_accounts", "bank.list_bills", "bank.list_payees"];

export const SPECIALISTS: Record<SpecialistId, SpecialistDef & { summary: string }> = {
  guardian: {
    id: "guardian",
    summary: "scams, forwarded messages, pausing money movement",
    prompt:
      "You are FinGuard's guardian. You check messages the customer forwards for scams and explain the warning signs. Use check_message for the rating and knowledge_search for the matching scam pattern; cite its doc id. You cannot move money. If the customer wants to stop all money movement, use pause_all.",
    manifest: { tools: [], extras: ["check_message", "knowledge_search", "list_findings", "pause_all"], areas: ["protection"], seesForwarded: true, alert: false },
  },
  payments: {
    id: "payments",
    summary: "balances, moving money, paying bills, sending money",
    prompt:
      "You are FinGuard's payments specialist. You read balances, bills and saved payees, and propose moves between the customer's own accounts, bill payments and transfers. Use the account ids, bill ids and payee accounts from tool results or the customer's words. If the customer refers to a forwarded message, you cannot read it: ask them to say the amount and the payee themselves, or use check_message for its risk rating.",
    manifest: { tools: [...BANK_READS, "bank.move_own", "bank.pay_bill", "bank.transfer"], extras: ["check_message"], areas: [], seesForwarded: false, alert: true },
  },
  savings: {
    id: "savings",
    summary: "subscriptions, cancelling, ways to save, cash flow",
    prompt:
      "You are FinGuard's savings specialist. Use savings_report and list_findings for savings with amounts computed in code, and subscriptions tools to list or cancel a subscription (cancelling needs the customer's approval through SkillGate). Quote the amounts as given.",
    manifest: { tools: ["subscriptions.list", "subscriptions.cancel"], extras: ["savings_report", "list_findings"], areas: ["subscriptions", "everyday", "bills"], seesForwarded: false, alert: false },
  },
  advisor: {
    id: "advisor",
    summary: "loans, contracts, investments (education only), public-company and bank research, anything else",
    prompt:
      "You are FinGuard's advisor for loans, contracts and investment fees. Explain the customer's evidence cards (list_findings) and general facts (knowledge_search) in plain words. Education only: never recommend buying, selling or investing in anything; suggest a licensed professional for personal advice. You cannot move money. " +
      "For a public company or a bank, use the research tools (public data only: SEC filings and reported financials, Treasury average rates, FDIC BankFind, CFPB complaints). Give 2-3 facts, writing each number exactly as the tool's display text or value shows it, and one source URL from the results; say \"cached sample, not live\" when a result's status says so.",
    manifest: { tools: [...RESEARCH_TOOL_NAMES], extras: ["list_findings", "knowledge_search"], areas: ["loans", "contracts", "investments"], seesForwarded: false, alert: false },
  },
};

const IDS = Object.keys(SPECIALISTS) as SpecialistId[];

export function routeIntent(intent: RuleIntent): SpecialistId {
  switch (intent.kind) {
    case "forwarded":
      return intent.act ? "payments" : "guardian"; // checking a message vs. asking to pay it (SkillGate judges the payment)
    case "pause":
      return "guardian";
    case "cancel":
    case "savings":
      return "savings";
    case "move_own":
    case "pay_bill":
    case "send":
    case "balances":
      return "payments";
    case "area":
    case "research":
    case "help":
      return "advisor";
  }
}

const RULE_WHY: Record<RuleIntent["kind"], string> = {
  forwarded: "about a forwarded message",
  pause: "asks to pause money movement",
  cancel: "asks to cancel a subscription",
  area: "asks about loans, contracts or investments",
  move_own: "asks to move money between own accounts",
  savings: "asks how to save",
  pay_bill: "asks to pay a bill",
  send: "asks to send money",
  balances: "asks about balances",
  research: "asks to research a company or check a bank (public data)",
  help: "no specific request",
};

export const ROUTER_PROMPT = `You route one message from a household to exactly one FinGuard specialist:
- guardian: scams, suspicious or forwarded messages ("is this real?"), pausing or freezing money movement
- payments: balances, moving money between their own accounts, paying bills, sending money to someone
- savings: subscriptions and trials, cancelling them, ways to save, spending and cash flow
- advisor: loans, contracts, investments and fees (education only), researching a public company or checking whether a bank is real (public data), and anything else
Reply with JSON only: {"specialist": "guardian" | "payments" | "savings" | "advisor", "why": "<a few words>"}`;

const ROUTER_SCHEMA = {
  type: "object",
  properties: { specialist: { type: "string", enum: IDS }, why: { type: "string" } },
  required: ["specialist", "why"],
  additionalProperties: false,
};

export function parseRoute(text: string): { id: SpecialistId; why: string } {
  try {
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "") as { specialist?: unknown; why?: unknown };
    if (IDS.includes(parsed.specialist as SpecialistId)) return { id: parsed.specialist as SpecialistId, why: String(parsed.why ?? "").slice(0, 120) };
  } catch {
  }
  throw new LlmError("router_parse", "The router did not return a valid specialist.");
}

class ScopeError extends Error {}

class Recorder {
  readonly evidence: TurnEvidence;
  constructor(input: TurnInput, ctx: AgentContext) {
    this.evidence = emptyEvidence(input.text, ctx.policy());
  }
  outcome(o: RunOutcome): void {
    this.evidence.outcomes.push(withoutCode(o));
    if (o.status === "executed" && o.receipt) this.evidence.receipts.push(o.receipt);
  }
  record(x: unknown): void {
    this.evidence.records.push(x);
  }
}

export interface SupervisorOptions {
  trace: TraceLog;
  kbIds: ReadonlySet<string>;
  tools: () => ToolSpec[];
  provider?: Provider;
  metrics?: Metrics;
  log?: (line: string) => void;
  historyTurns?: number;
  name?: string;
}

export class SupervisedAgent implements Agent {
  readonly name: string;
  private readonly rules = new RuleAgent();
  private readonly history: ChatMessage[] = [];
  private readonly fallbacks: { at: string; turnId: string; reason: string }[] = [];

  constructor(private readonly o: SupervisorOptions) {
    this.name = o.name ?? (o.provider ? this.brand : "rules");
  }

  private get brand(): "claude" | "gemini" {
    return this.o.provider?.name === "gemini" ? "gemini" : "claude";
  }

  recentFallbacks(): { at: string; turnId: string; reason: string }[] {
    return [...this.fallbacks];
  }

  private step(turnId: string, s: AgentStep): void {
    this.o.trace.append("agent_step", s, turnId);
  }

  private time<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    return this.o.metrics ? this.o.metrics.time(`agent.stage.${stage}`, fn) : fn();
  }

  async handle(input: TurnInput, ctx: AgentContext): Promise<void> {
    const rec = new Recorder(input, ctx);
    const said: string[] = [];
    const emit = (text: string) => {
      said.push(text);
      ctx.say(text);
    };
    const brain = this.o.provider;
    if (brain && !brain.configured()) this.noteFallback(input.turnId, "no_key", "no API key is set; the rules brain answers");
    const useModel = !!brain?.configured();

    const route = await this.time("route", () => this.route(input, ctx, useModel));
    this.o.metrics?.inc(`agent.route.${route.id}`);
    this.o.metrics?.inc(`agent.route.source.${route.source}`);
    this.step(input.turnId, { agent: "orchestrator", step: "route", detail: `${route.id} (${route.source}): ${route.why}`, ok: true });

    try {
      if (useModel) await this.time("specialist", () => this.runModel(route.id, input, ctx, rec, emit));
      else await this.time("specialist", () => this.runRules(route.id, route.intent, input, ctx, rec, emit));
    } catch (err) {
      if (!(err instanceof ScopeError)) throw err;
      emit(deterministicReply(rec.evidence));
    }
    this.remember(input, said.join(" "));
  }

  private async route(input: TurnInput, ctx: AgentContext, useModel: boolean): Promise<{ id: SpecialistId; why: string; source: "claude" | "gemini" | "rules"; intent: RuleIntent }> {
    const intent = classifyIntent(input, ctx.recentInbound());
    const byRules = { id: routeIntent(intent), why: RULE_WHY[intent.kind], source: "rules" as const, intent };
    if (!useModel) return byRules;
    const forwarded = input.inbound ? "yes, in this message" : ctx.recentInbound().length ? "yes, earlier" : "no";
    try {
      const step = await this.o.provider!.start({
        system: ROUTER_PROMPT,
        tools: [],
        messages: [{ role: "user", text: `Customer: ${input.text}\nForwarded a message: ${forwarded}` }], // never the forwarded text itself
        json: ROUTER_SCHEMA,
        maxTokens: 200,
      }).next();
      return { ...parseRoute(step.text), source: this.brand, intent };
    } catch (err) {
      const reason = err instanceof LlmError ? err.reason : "error";
      this.o.metrics?.inc(`agent.route.fallback.${reason.split(":")[0]}`);
      this.step(input.turnId, { agent: "orchestrator", step: "fallback", detail: `model router unavailable (${reason}); routed by rules`, ok: false });
      return byRules;
    }
  }

  private scoped(id: SpecialistId, input: TurnInput, ctx: AgentContext, rec: Recorder, say: (text: string) => void): AgentContext {
    const m = SPECIALISTS[id].manifest;
    const deny = (what: string): never => {
      this.reject(input.turnId, id, what);
      throw new ScopeError(`${what} is outside the ${id} specialist's scope.`);
    };
    return {
      tool: async (name, args) => {
        if (!m.tools.includes(name)) deny(name);
        const outcome = await ctx.tool(name, args);
        rec.outcome(outcome);
        return outcome;
      },
      say,
      checkMessage: async (text, ref) => {
        if (!m.extras.includes("check_message")) deny("check_message");
        const a = await ctx.checkMessage(text, ref);
        rec.record(a);
        return a;
      },
      savings: async () => {
        if (!m.extras.includes("savings_report")) deny("savings_report");
        const report = await ctx.savings();
        rec.record(report);
        return report;
      },
      pause: () => (m.extras.includes("pause_all") ? ctx.pause() : deny("pause_all")),
      alertTrustedContact: (text) => (m.alert ? ctx.alertTrustedContact(text) : deny("alert_trusted_contact")),
      recentInbound: () => ctx.recentInbound(),
      policy: () => ctx.policy(),
      ...(m.extras.includes("knowledge_search") && ctx.search
        ? {
            search: async (query: string, collection?: string) => {
              const hits = await ctx.search!(query, collection);
              rec.record(hits);
              return hits;
            },
          }
        : {}),
      ...(m.extras.includes("list_findings") && ctx.findings
        ? {
            findings: async (area?: Area) => {
              const cards = (await ctx.findings!(area && m.areas.includes(area) ? area : undefined)).filter((f) => m.areas.includes(f.area));
              rec.record(cards);
              return cards;
            },
          }
        : {}),
    };
  }

  private reject(turnId: string, id: SpecialistId, tool: string): void {
    this.o.metrics?.inc("agent.scope.rejected");
    this.step(turnId, { agent: id, step: "scope", detail: `rejected ${tool}: not in the ${id} manifest, so it never ran`, tools: [tool], ok: false });
  }

  private announceScope(turnId: string, id: SpecialistId): void {
    const m = SPECIALISTS[id].manifest;
    const tools = [...m.tools, ...m.extras.map((x) => (x === "list_findings" ? `list_findings(${m.areas.join("|")})` : x)), ...(m.alert ? ["alert_trusted_contact"] : [])];
    this.step(turnId, { agent: id, step: "scope", detail: `${SPECIALISTS[id].summary}; nothing else is offered or executable`, tools, ok: true });
  }

  private review(turnId: string, draft: string, rec: Recorder): Review {
    const started = performance.now();
    const review = evaluateReply(draft, rec.evidence, this.o.kbIds);
    this.o.metrics?.observe("agent.stage.evaluate", performance.now() - started);
    this.o.metrics?.inc(review.ok ? "agent.evaluator.pass" : "agent.evaluator.fail");
    this.step(turnId, {
      agent: "evaluator",
      step: "evaluate",
      detail: review.ok ? "grounded, honest, cited and in scope" : `${review.problems.length} problem(s) in the draft`,
      ok: review.ok,
      ...(review.ok ? {} : { problems: review.problems }),
    });
    return review;
  }

  private floor(turnId: string, rec: Recorder, emit: (text: string) => void, already: Set<string>, why: string): void {
    const reply = deterministicReply(rec.evidence);
    this.o.metrics?.inc("agent.evaluator.deterministic");
    this.step(turnId, { agent: "evaluator", step: "repair", detail: `${why}; answered from this turn's outcomes only`, ok: true });
    if (!already.has(reply)) emit(reply);
  }

  private async runRules(id: SpecialistId, intent: RuleIntent, input: TurnInput, ctx: AgentContext, rec: Recorder, emit: (text: string) => void): Promise<void> {
    this.announceScope(input.turnId, id);
    const spoken = new Set<string>();
    const say = (draft: string) => {
      if (this.review(input.turnId, draft, rec).ok) {
        spoken.add(draft);
        return emit(draft);
      }
      this.floor(input.turnId, rec, (t) => (spoken.add(t), emit(t)), spoken, "the rules draft failed review");
    };
    await this.rules.run(intent, input, this.scoped(id, input, ctx, rec, say));
  }

  private async runModel(id: SpecialistId, input: TurnInput, ctx: AgentContext, rec: Recorder, emit: (text: string) => void): Promise<void> {
    this.announceScope(input.turnId, id);
    const state: RunState = { sideEffects: 0 };
    const scoped = this.scoped(id, input, ctx, rec, emit);
    try {
      const { reply } = await runModelSpecialist(SPECIALISTS[id], input, scoped, {
        provider: this.o.provider!,
        specs: this.o.tools(),
        history: [...this.history],
        metrics: this.o.metrics,
        review: (draft) => this.review(input.turnId, draft, rec),
        onReview: (review, stage) => {
          if (stage === "draft" && !review.ok) {
            this.o.metrics?.inc("agent.evaluator.repair");
            this.step(input.turnId, { agent: "evaluator", step: "repair", detail: "sent the problems back to the model once", ok: true });
          }
          if (stage === "repair" && review.ok) this.o.metrics?.inc("agent.evaluator.repaired");
        },
        onReject: (tool) => this.reject(input.turnId, id, tool),
      }, state);
      if (reply) emit(reply);
      else this.floor(input.turnId, rec, emit, new Set(), "the model's reply failed review twice or ran out of steps");
    } catch (err) {
      const reason = err instanceof LlmError ? err.reason : "error";
      const detail = this.o.provider!.redact(err instanceof Error ? err.message : String(err));
      if (state.sideEffects > 0) {
        this.o.metrics?.inc("llm.aborted");
        this.o.log?.(`agent ${this.name}: stopped turn ${input.turnId} after an action was proposed (${reason}): ${detail}`);
        this.step(input.turnId, { agent: id, step: "fallback", detail: `model stopped (${reason}) after an action was proposed; no retry`, ok: false });
        return this.floor(input.turnId, rec, emit, new Set(), "the model stopped partway");
      }
      this.noteFallback(input.turnId, reason, detail);
      this.step(input.turnId, { agent: id, step: "fallback", detail: `model unavailable (${reason}); the rules brain answers this turn`, ok: false });
      const intent = classifyIntent(input, ctx.recentInbound());
      const ruleId = routeIntent(intent);
      this.step(input.turnId, { agent: "orchestrator", step: "route", detail: `${ruleId} (rules): ${RULE_WHY[intent.kind]}`, ok: true });
      await this.runRules(ruleId, intent, input, ctx, rec, emit);
    }
  }

  private noteFallback(turnId: string, reason: string, detail: string): void {
    this.o.metrics?.inc("llm.fallback");
    this.o.metrics?.inc(`llm.fallback.${reason.split(":")[0]}`);
    this.fallbacks.push({ at: new Date().toISOString(), turnId, reason });
    if (this.fallbacks.length > 20) this.fallbacks.shift();
    this.o.log?.(`agent ${this.name}: fell back to rules for turn ${turnId} (${reason}): ${detail}`);
  }

  private remember(input: TurnInput, reply: string): void {
    const max = (this.o.historyTurns ?? 3) * 2;
    if (!reply.trim()) return;
    this.history.push({ role: "user", text: input.inbound ? `${input.text}\n(The customer also forwarded a message.)` : input.text }, { role: "assistant", text: reply });
    while (this.history.length > max) this.history.shift();
  }
}
