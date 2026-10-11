import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig, SERVER_ROOT } from '../config.ts';
import { buildServices, resetServices } from '../services.ts';
import { createApp } from '../gateway/app.ts';
import { runToolCall } from '../policy/run.ts';
import { BM25Retriever, loadKnowledgeBaseSync } from '../rag/index.ts';
import type { ToolCall } from '../types.ts';
import path from 'node:path';

const call = (tool: string, args: Record<string,unknown>): ToolCall => ({ id: crypto.randomUUID(), turnId: crypto.randomUUID(), tool, args, skill: 'core', activeSkills: [], requestedBy: 'app' });
test('production KB has all collections and scam scenarios; safe-account remains first', async () => {
  const docs = loadKnowledgeBaseSync(path.join(SERVER_ROOT, 'kb'));
  assert.deepEqual([...new Set(docs.map(d => d.collection))].sort(), ['fees','plans','savings','scams']);
  for (const id of ['safe-account','family-emergency','invoice-payee-swap','government-impersonation','gift-card-crypto','tech-support']) assert.ok(docs.some(d => d.id === `kb:scams/${id}`));
  assert.ok(docs.every(d => d.source_url?.startsWith('https://')));
  assert.equal((await new BM25Retriever(docs).search('move money to a safe account'))[0]?.docId, 'kb:scams/safe-account');
});
test('standard services use evidence engine; cancellation requires approval and removes only its opportunity', async () => {
  const s = buildServices(loadConfig({}), { persist: false });
  s.policy.recordConsent('app');
  const before = await s.savings();
  assert.ok(before.recommendations.every(r => r.citations.length && r.evidence.length));
  assert.ok(before.recommendations.some(r => r.kind === 'late_fee' && r.monthlySavings === 0));
  assert.ok(!before.recommendations.some(r => r.id === 'subscription-stream'), 'the Paramount+ trial is a nudge about a coming charge, not a charge marked unused');
  const recommendation = before.recommendations.find(r => r.id === 'subscription-gym')!;
  assert.equal(recommendation.monthlySavings, 29.99);
  assert.equal(recommendation.action?.tool, 'subscriptions.cancel');
  assert.deepEqual(recommendation.action?.args, { subscription_id: 'sub-gym' });
  const listed = await s.tools.get('subscriptions.list')!.run({});
  const action = call(recommendation.action!.tool, recommendation.action!.args);
  s.gate.recordToolResult(action.turnId, 'subscriptions.list', listed);
  s.gate.recordUserMessage(action.turnId, 'tap', s.gate.describe(action));
  const result = await runToolCall(action,s,{ onApprovalRequested: a => {
    assert.equal(s.gate.answer(a.id,true,a.code === '0000' ? '1111' : '0000').ok,false);
    assert.equal(s.gate.answer(a.id,true,a.code).ok,true);
  }});
  assert.equal(result.status,'executed');
  assert.ok(result.status === 'executed' && result.receipt?.authorizedBy.kind === 'approval');
  assert.ok(!(await s.savings()).recommendations.some(r => r.id === recommendation.id));
  resetServices(s);
  assert.equal(s.policy.consent(),undefined);
  assert.ok((await s.savings()).recommendations.some(r => r.id === recommendation.id));
});
test('the stand-ins and the disclaimers use one word: simulated', async () => {
  const s = buildServices(loadConfig({}), { persist: false });
  assert.deepEqual(s.stubs, ['bank: offline Nessie household', 'subscriptions: simulated merchant', 'plans: simulated internet offer']);
  const { disclaimers } = await s.savings();
  assert.equal(disclaimers[0], 'Simulated household and offers. Rates are explicit scenario assumptions.');
  assert.ok(disclaimers.every(d => !/fictional|demo mode|mock/i.test(d)));
});
test('formal gateway report actions move and pay through Gate with bank balances and receipts', async () => {
  const s = buildServices(loadConfig({}),{ persist: false });
  const server = http.createServer(createApp(s));
  await new Promise<void>(r => server.listen(0,'127.0.0.1',r));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const api = async (endpoint: string, body?: unknown) => {
    const response = await fetch(base+endpoint,{ method: body ? 'POST' : 'GET', headers: {'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {}) });
    return {status:response.status,body:await response.json() as any};
  };
  try {
    assert.equal((await api('/api/consent',{policyVersion:1})).status,200);
    const report = (await api('/api/savings')).body.report;
    assert.equal(report.recommendations.length,5);
    const moved = await api('/api/actions',{tool:'bank.move_own',args:{from_account:'acct-checking',to_account:'acct-savings',amount:100}});
    assert.equal(moved.body.status,'executed'); assert.ok(moved.body.receipt);
    assert.equal((await api('/api/accounts')).body.accounts[0].balance,4110.55);
    const bill = report.recommendations.find((r: any) => r.kind === 'late_fee');
    const asked = await api('/api/actions',{tool:bill.action.tool,args:bill.action.args});
    assert.equal(asked.status,202);
    await api(`/api/approvals/${asked.body.approval.id}`,{approve:true,code:asked.body.approval.code});
    for (let i=0;i<100 && !s.gate.receipts().some(r=>r.callId===asked.body.callId);i++) await new Promise(r=>setTimeout(r,10));
    assert.ok(s.gate.receipts().some(r=>r.callId===asked.body.callId));
    assert.equal((await api('/api/accounts')).body.accounts[0].balance,4026.35);
    assert.ok(!(await api('/api/savings')).body.report.recommendations.some((r: any)=>r.id===bill.id));
    assert.equal(s.trace.verify().ok,true);
  } finally {server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r()));}
});
