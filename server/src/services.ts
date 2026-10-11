import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { Agent } from "./agent/agent.ts";
import { AnthropicProvider } from "./agent/llm.ts";
import { GeminiProvider } from "./agent/gemini.ts";
import { GeminiSecondOpinion } from "./fraud/second-opinion.ts";
import { SupervisedAgent } from "./agent/supervisor.ts";
import { TraceLog } from "./audit/trace.ts";
import type { Config } from "./config.ts";
import { createMockFetcher } from '../mock-nessie/server.ts';
import { createBankAdapters } from './bank/index.ts';
import { withSimulatedSettlement } from './bank/ledger.ts';
import { loadKnowledgeBaseSync } from './rag/index.ts';
import { HybridRetriever, timedRetriever } from './rag/hybrid.ts';
import { GeminiEmbedder } from './rag/gemini.ts';
import { Metrics } from './metrics.ts';
import { dbFile, StewardDb } from './store/db.ts';
import { EvidenceSavingsEngine } from './savings/index.ts';
import { assertPersona, DEFAULT_PERSONA, personaSetup } from './demo/personas.ts';
import { SERVER_ROOT } from './config.ts';
import { RuleScamShield } from "./fraud/scamshield.ts";
import { bankCashFlow, type CashFlowSource } from "./policy/cashflow.ts";
import { Gate } from "./policy/gate.ts";
import { loadPolicyFile, PolicyStore } from "./policy/store.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { stubBankAdapters } from "./tools/stub-bank.ts";
import { createResearchAdapters, researchExtensions } from "./research/index.ts";
import type { Retriever, SavingsReport, ScamShield } from "./types.ts";
import { nowIso } from "./util.ts";

export interface Services {
  phones?: { list(): { id: number; label: string; active: boolean; connected: boolean }[]; use(key: string | number): Promise<boolean> };
  config: Config;
  trace: TraceLog;
  policy: PolicyStore;
  tools: ToolRegistry;
  gate: Gate;
  scam: ScamShield;
  agent: Agent;
  savings: () => Promise<SavingsReport>;
  cashFlow: CashFlowSource;
  rag: Retriever;
  sources?: ReadonlyMap<string, { title: string; url?: string }>;
  db?: StewardDb;
  metrics?: Metrics;
  persona?: string;
  startedAt: string;
  stubs: string[];
  persist: boolean;
  events: EventEmitter;
  log: (line: string) => void;
}

function traceFile(config: Config): string {
  return path.join(config.dataDir, "trace.jsonl");
}

export function buildServices(config: Config, { persist = true, log = (_: string) => {}, metrics = new Metrics(), persona = DEFAULT_PERSONA } = {}): Services {
  const trace = new TraceLog(persist ? traceFile(config) : undefined);
  const db = new StewardDb(dbFile(config.dataDir, persist), log).attach(trace);
  const setup = personaSetup(config.nessieMode === 'live' ? DEFAULT_PERSONA : persona, new Date());
  const policy = new PolicyStore(trace, setup.policy(loadPolicyFile(config.policyFile)));
  const household = setup.household;
  const subscriptions = stubBankAdapters({ subscriptions: setup.subscriptions }).filter(a => a.spec.name.startsWith('subscriptions.'));
  const nessie = createBankAdapters({ mode: config.nessieMode,
    baseUrl: config.nessieMode === 'live' ? config.nessieBaseUrl : 'http://127.0.0.1:8788',
    ...(config.nessieMode === 'mock' ? { fetcher: createMockFetcher(household) } : {}),
    savedPayees: policy.current().savedPayees, log });
  const bank = config.nessieMode === 'live' ? withSimulatedSettlement(nessie, { history: trace.list() }) : nessie;
  const geminiKey = config.ragMode === 'live' ? config.secret('GEMINI_API_KEY') : undefined;
  const kbDocs = loadKnowledgeBaseSync(path.join(SERVER_ROOT, 'kb'));
  const rag = timedRetriever(new HybridRetriever(kbDocs, {
    store: db, metrics, log, ...(geminiKey ? { remote: new GeminiEmbedder({ apiKey: geminiKey, metrics }) } : {}),
  }), metrics);
  const research = createResearchAdapters({ secUserAgent: config.secret('SEC_USER_AGENT') });
  const tools = new ToolRegistry().register(...Object.values(bank), ...subscriptions, ...research);
  const scamKey = config.scamLlm === 'gemini' ? config.secret('GEMINI_API_KEY') : undefined;
  const scam = new RuleScamShield({ policy: () => policy.current(), retriever: rag, metrics,
    ...(scamKey ? { secondOpinion: new GeminiSecondOpinion({ apiKey: scamKey, model: config.scamLlmModel, metrics, log }) } : {}) });
  const adapters = Object.fromEntries([...Object.values(bank), ...subscriptions].map(a => [a.spec.name, a]));
  const engine = new EvidenceSavingsEngine(adapters, rag, { ...setup.savings, simulatedFacts: true });
  const cashFlow = bankCashFlow(tools, () => policy.current());
  const gate = new Gate({ policy, trace, tools, scam, cashFlow, approvalTtlSeconds: config.approvalTtlSeconds, extensions: researchExtensions() });
  return {
    config,
    trace,
    policy,
    tools,
    gate,
    scam,
    agent: new SupervisedAgent({
      trace, kbIds: new Set(kbDocs.map((d) => d.id)), tools: () => tools.specs(), metrics, log,
      ...(config.agentMode === 'claude'
        ? { provider: new AnthropicProvider({ apiKey: config.secret('ANTHROPIC_API_KEY'), model: config.llmModel, timeoutMs: config.llmTimeoutMs, serverFallback: config.llmServerFallback, metrics }) }
        : config.agentMode === 'gemini'
          ? { provider: new GeminiProvider({ apiKey: config.secret('GEMINI_API_KEY'), model: config.geminiModel, fallbackModel: process.env.GEMINI_FALLBACK_MODEL ?? (config.geminiModel === 'gemini-3.5-flash' ? 'gemini-3.5-flash-lite' : 'gemini-3.5-flash'), timeoutMs: config.llmTimeoutMs, metrics }) }
          : {}),
    }),
    savings: () => engine.report(),
    cashFlow,
    rag,
    sources: new Map(kbDocs.map((d) => [d.id, { title: d.title, ...(d.source_url ? { url: d.source_url } : {}) }])),
    db,
    metrics,
    persona: setup.id,
    startedAt: nowIso(),
    stubs: config.nessieMode === 'mock'
      ? ['bank: offline Nessie household', 'subscriptions: simulated merchant', 'plans: simulated internet offer']
      : ['money actions: settled on a simulated ledger over live Nessie reads; nothing is written to the sandbox', 'subscriptions: simulated merchant; not connected to Nessie', 'plans: simulated internet offer'],
    persist,
    events: new EventEmitter(),
    log,
  };
}

export function resetServices(s: Services, { persona = DEFAULT_PERSONA }: { persona?: string } = {}): void {
  assertPersona(persona);
  if (s.persist && fs.existsSync(traceFile(s.config))) {
    const stamp = nowIso().replace(/[:.]/g, "-");
    fs.renameSync(traceFile(s.config), path.join(s.config.dataDir, `trace-${stamp}.jsonl`));
  }
  const { events, log, metrics } = s;
  s.db?.close();
  Object.assign(s, buildServices(s.config, { persist: s.persist, log, metrics, persona }), { events, log });
  events.emit("reset");
}
