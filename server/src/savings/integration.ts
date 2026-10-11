import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { Services } from '../services.ts';
import type { Config } from '../config.ts';
import type { ToolCall } from '../types.ts';
import { TraceLog } from '../audit/trace.ts';
import { PolicyStore, loadPolicyFile } from '../policy/store.ts';
import { Gate, actionHash } from '../policy/gate.ts';
import { runToolCall, type RunOutcome } from '../policy/run.ts';
import { RuleScamShield } from '../fraud/scamshield.ts';
import { bankCashFlow } from '../policy/cashflow.ts';
import { stubBankAdapters } from '../tools/stub-bank.ts';
import { RuleAgent } from '../agent/rules.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { createBankAdapters, withBankExecution } from '../bank/index.ts';
import { createRetriever } from '../rag/index.ts';
import { EvidenceSavingsEngine } from './index.ts';
import { demoOptions } from './demo.ts';
import { readSnapshot, previewAction, snapshotHash, toCents, type CashflowPreview, type BankSnapshot } from './cashflow.ts';

export async function buildTianjiaServices(config: Config, baseUrl: string, observedAt: () => string) {
  if (config.nessieMode !== 'mock') throw new Error('The review harness only executes local mock transactions');
  const trace = new TraceLog(), policy = new PolicyStore(trace, { ...loadPolicyFile(config.policyFile), cashFlowBuffer: 200 });
  let beforeWrite: ((tool: string, args: Record<string,unknown>) => Promise<boolean>) | undefined;
  const bank = createBankAdapters({ mode: 'mock', baseUrl, authorize: async (tool,args) => beforeWrite ? beforeWrite(tool,args) : false });
  const rag = await createRetriever(fileURLToPath(new URL('../rag/fixtures/kb/', import.meta.url)), 'mock');
  const tools = new ToolRegistry().register(...stubBankAdapters().filter(a => a.spec.name.startsWith('subscriptions.')), ...Object.values(bank));
  const scam = new RuleScamShield({ policy: () => policy.current(), retriever: rag });
  const cashFlow = bankCashFlow(tools, () => policy.current());
  const gate = new Gate({ policy, trace, tools, scam, cashFlow, approvalTtlSeconds: config.approvalTtlSeconds });
  const engine = new EvidenceSavingsEngine(bank, rag, demoOptions);
  const services: Services = { config, trace, policy, tools, gate, scam, agent: new RuleAgent(),
    savings: () => engine.report(), cashFlow, rag, startedAt: new Date().toISOString(), stubs: ['local mock bank; no real money','seven T8 test KB documents; full T7 corpus pending'],
    persist: false, events: new EventEmitter(), log: () => {} };
  const previews = new Map<string,CashflowPreview>(), outcomes = new Map<string,unknown>();
  let busy = false;
  const snapshot = () => readSnapshot(bank, observedAt());
  async function preview(action: Pick<ToolCall,'tool'|'args'>, buffer = 200, horizon = new Date(Date.now()+7*86400000).toISOString().slice(0,10)) {
    const p = previewAction(await snapshot(), action, { now: new Date(), buffer, horizon });
    const id = crypto.randomUUID(); previews.set(id, structuredClone(p)); return { id, ...p };
  }
  async function verify(before: BankSnapshot, action: CashflowPreview['action'], outcome: RunOutcome) {
    if (outcome.status !== 'executed') return { status: outcome.status === 'failed' ? 'unconfirmed' : 'not_executed', realizedSavings: null };
    try {
      const after = await snapshot();
      const row = outcome.result.data as Record<string,unknown>;
      const response = await fetch(`${baseUrl}/accounts/${encodeURIComponent(String(action.args.from_account))}/transfers`);
      if (!response.ok) throw new Error('Ledger read failed');
      const ledger = await response.json() as Record<string,unknown>[];
      const transaction = ledger.find(r => r._id === row._id && r.status === 'completed' && r.payer_id === action.args.from_account && (r.amount ?? r.payment_amount) === action.args.amount &&
        (action.tool === 'bank.pay_bill' ? r.bill_id === action.args.bill_id : r.payee_id === action.args.to_account));
      const oldFrom = before.accounts.find(a => a._id === action.args.from_account)!, newFrom = after.accounts.find(a => a._id === action.args.from_account)!;
      const expected = toCents(oldFrom.balance)-toCents(action.args.amount);
      let balancesMatch = toCents(newFrom.balance) === expected;
      if (action.tool === 'bank.move_own') {
        const oldTo = before.accounts.find(a => a._id === action.args.to_account)!, newTo = after.accounts.find(a => a._id === action.args.to_account)!;
        balancesMatch &&= toCents(newTo.balance) === toCents(oldTo.balance)+toCents(action.args.amount);
      }
      const billMatches = action.tool !== 'bank.pay_bill' || after.bills.some(b => b._id === action.args.bill_id && ['completed','paid'].includes(String(b.status)));
      return { status: transaction && balancesMatch && billMatches ? 'confirmed' : 'unconfirmed', transactionId: row._id,
        balanceAfter: newFrom.balance, expectedBalanceAfter: expected/100, ledgerMatched: Boolean(transaction), balancesMatch, billMatches,
        realizedSavings: null, explanation: 'A transfer changes where money is held; it is not realized interest or subscription savings' };
    } catch { return { status: 'unconfirmed', realizedSavings: null, explanation: 'Execution responded, but independent bank reads did not confirm the outcome; do not retry automatically' }; }
  }
  async function execute(id: string, suppliedActionHash: string, hooks: Parameters<typeof runToolCall>[2] = {}) {
    if (busy) throw new Error('Another review is pending; finish it first');
    if (outcomes.has(id)) return outcomes.get(id);
    const p = previews.get(id);
    if (!p || p.actionHash !== suppliedActionHash) throw new Error('The exact preview action must be confirmed');
    if (p.status !== 'ready') throw new Error('This preview cannot execute');
    if (Date.now() >= Date.parse(p.expiresAt)) throw new Error('Preview expired; review a new preview');
    busy = true;
    try {
      const before = await snapshot();
      if (snapshotHash(before) !== p.snapshotHash) throw new Error('Bank records changed; review a new preview');
      const call: ToolCall = { id: `preview-${id}`, turnId: `turn-${id}`, ...structuredClone(p.action), skill: 'core', activeSkills: [], requestedBy: 'app' };
      for (const read of before.readResults) gate.recordToolResult(call.turnId, read.tool, read.result);
      gate.recordUserMessage(call.turnId, `confirmation-${id}`, gate.describe(call));
      beforeWrite = async (tool,args) => {
        if (actionHash({tool,args}) !== p.actionHash) return false;
        if (Date.now() >= Date.parse(p.expiresAt)) return false;
        const current = await snapshot();
        return snapshotHash(current) === p.snapshotHash && previewAction(current,p.action,{ now:new Date(), buffer:p.buffer,horizon:p.horizon }).status === 'ready';
      };
      const outcome = await withBankExecution(call.tool,call.args,call.id, () => runToolCall(call,services,hooks));
      const verification = await verify(before,p.action,outcome);
      const result = { previewId:id, actionHash:p.actionHash, outcome, verification, traceVerified:trace.verify() };
      outcomes.set(id,result); return result;
    } finally { beforeWrite = undefined; busy = false; }
  }
  return { services, bank, rag, engine, snapshot, preview, execute, outcomes };
}
