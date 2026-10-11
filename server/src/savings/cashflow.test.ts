import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { seedCashflowScenario } from '../../mock-nessie/seed.ts';
import { startReview } from './review.ts';
import { previewAction, toCents, type BankSnapshot } from './cashflow.ts';
import { BANK_TOOLS } from '../tools/specs.ts';
import { runToolCall } from '../policy/run.ts';
import type { ToolCall } from '../types.ts';

const now=new Date('2026-10-10T16:00:00Z'), horizon='2026-10-17';
function sample():BankSnapshot {const s=seedCashflowScenario(now);return {...s,readResults:[]};}
const action=(amount=150)=>({tool:'bank.move_own',args:{from_account:'acct-checking',to_account:'acct-savings',amount}});
async function withReview(fn:(r:Awaited<ReturnType<typeof startReview>>,base:string)=>Promise<void>) {
 const r=await startReview(0),a=r.server.address();assert.ok(a&&typeof a!=='string');
 try{await fn(r,`http://127.0.0.1:${a.port}`);}finally{await r.close();}
}
async function post(base:string,path:string,body:unknown){const res=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Role':'customer'},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};}

test('cash-flow arithmetic identifies the exact affordable boundary and shows a shortfall',()=>{
 const s=sample(),p=previewAction(s,action(500),{now,horizon,buffer:200});
 assert.equal(p.availableToMove,150);assert.equal(p.shortfallAfter,350);assert.equal(p.status,'blocked');
 assert.equal(previewAction(s,action(150),{now,horizon,buffer:200}).status,'ready');
 assert.equal(previewAction(s,action(150.01),{now,horizon,buffer:200}).shortfallAfter,.01);
 assert.ok(p.assumptions.some(a=>a.includes('No future income')));
});
test('overdue obligations remain reserved; malformed money and dates fail explicitly',()=>{
 const s=sample();s.bills[0]!.payment_date='2026-10-09';
 assert.equal(previewAction(s,action(),{now,horizon,buffer:200}).billsReserved,850);
 for(const n of [-1,NaN,Infinity,.001,'150'])assert.throws(()=>toCents(n));
 s.bills[0]!.payment_date='2026-02-31';assert.throws(()=>previewAction(s,action(),{now,horizon,buffer:200}),/date/);
});
test('stale and unknown bank observation times disable execution',()=>{
 for(const observedAt of ['2026-10-09T16:00:00Z','unknown','2026-10-11T16:00:00Z']){
 const s=sample();s.observedAt=observedAt;assert.equal(previewAction(s,action(),{now,horizon,buffer:200}).status,'needs_data');}
});
test('paying a bill reserves other bills without counting the paid bill twice',()=>{
 const p=previewAction(sample(),{tool:'bank.pay_bill',args:{from_account:'acct-checking',bill_id:'rent-next',amount:650}},{now,horizon,buffer:200});
 assert.equal(p.billsReserved,200);assert.equal(p.shortfallAfter,0);assert.equal(p.balanceAfter,550);
});
test('pending purchases reduce available funds and duplicate bank records are rejected',()=>{
 const s=sample();s.purchases[0]!.status='pending';s.purchases[0]!.amount=50;
 assert.equal(previewAction(s,action(100),{now,horizon,buffer:200}).availableToMove,100);
 s.bills.push(s.bills[0]!);assert.throws(()=>previewAction(s,action(),{now,horizon,buffer:200}),/Duplicate/);
});
test('tool contracts exactly match the shared specs; optional read arguments work',async()=>{
 await withReview(async r=>{const bank=r.getRuntime().bank;
 for(const spec of Object.values(BANK_TOOLS).filter(s => s.name.startsWith('bank.')))assert.deepEqual(bank[spec.name]!.spec,spec);
 assert.equal((await bank['bank.list_bills']!.run({})).ok,true);
 assert.equal((await bank['bank.list_purchases']!.run({limit:2})).data instanceof Array,true);
 assert.equal(((await bank['bank.list_purchases']!.run({limit:2})).data as unknown[]).length,2);
 assert.equal((await bank['bank.list_purchases']!.run({limit:0})).ok,false);
 });
});
test('cash-flow block rejects execution even when policy limit would allow it',async()=>{
 await withReview(async r=>{const runtime=r.getRuntime();runtime.services.policy.recordConsent('app');
 const p=await runtime.preview(action(500));await assert.rejects(()=>runtime.execute(p.id,p.actionHash),/cannot execute/);
 assert.equal(r.state.transfers.length,0);assert.equal(runtime.services.gate.receipts().length,0);
 });
});
test('no consent denies a ready preview without mutating bank state',async()=>{
 await withReview(async r=>{const rt=r.getRuntime(),p=await rt.preview(action());
 const result=await rt.execute(p.id,p.actionHash) as any;
 assert.equal(result.outcome.status,'denied');assert.equal(result.verification.status,'not_executed');assert.equal(r.state.accounts[0]!.balance,1200);
 });
});
test('an exact confirmed action runs through real SkillGate, gets a receipt and reconciles; retries do not duplicate',async()=>{
 await withReview(async r=>{const rt=r.getRuntime();rt.services.policy.recordConsent('app');const p=await rt.preview(action());
 await assert.rejects(()=>rt.execute(p.id,'wrong-hash'),/exact/);
 const result=await rt.execute(p.id,p.actionHash) as any;
 assert.equal(result.outcome.status,'executed');assert.equal(result.verification.status,'confirmed');assert.equal(result.verification.realizedSavings,null);
 assert.equal(result.outcome.receipt.actionHash,p.actionHash);assert.equal(result.outcome.receipt.authorizedBy.kind,'standing_instruction');
 assert.equal(r.state.accounts[0]!.balance,1050);assert.equal(r.state.accounts[1]!.balance,1150);
 assert.deepEqual(await rt.execute(p.id,p.actionHash),result);assert.equal(r.state.transfers.length,1);assert.equal(rt.services.trace.verify().ok,true);
 });
});
test('bank change between preview and confirmation requires another preview',async()=>{
 await withReview(async r=>{const rt=r.getRuntime();rt.services.policy.recordConsent('app');const p=await rt.preview(action());r.state.bills[0]!.payment_amount=700;
 await assert.rejects(()=>rt.execute(p.id,p.actionHash),/changed/);assert.equal(r.state.transfers.length,0);
 });
});
test('bill payment asks for exact-action approval; wrong code does not execute',async()=>{
 await withReview(async(r,base)=>{const rt=r.getRuntime();rt.services.policy.recordConsent('app');
 const p=await rt.preview({tool:'bank.pay_bill',args:{from_account:'acct-checking',bill_id:'duke-next',amount:200}});
 const started=await post(base,'/review/execute',{id:p.id,actionHash:p.actionHash});assert.equal(started.status,202);
 const approval=started.body.approval;const wrong=await post(base,'/api/approvals/'+approval.id,{approve:true,code:approval.code==='0000'?'1111':'0000'});
 assert.equal(wrong.status,400);assert.equal(r.state.transfers.length,0);
 assert.equal((await post(base,'/api/approvals/'+approval.id,{approve:true,code:approval.code})).status,200);
 for(let i=0;i<20&&!rt.outcomes.has(p.id);i++)await new Promise(resolve=>setTimeout(resolve,10));
 const result=rt.outcomes.get(p.id) as any;assert.equal(result.verification.status,'confirmed');assert.equal(result.outcome.receipt.authorizedBy.kind,'approval');
 assert.equal(r.state.bills.find(b=>b._id==='duke-next')!.status,'completed');
 });
});
test('bank changes during an approval wait stop the write even after a valid code',async()=>{
 await withReview(async r=>{const rt=r.getRuntime();rt.services.policy.recordConsent('app');const p=await rt.preview({tool:'bank.pay_bill',args:{from_account:'acct-checking',bill_id:'duke-next',amount:200}});
 const result=await rt.execute(p.id,p.actionHash,{onApprovalRequested:a=>{r.state.accounts[0]!.balance=900;rt.services.gate.answer(a.id,true,a.code);}}) as any;
 assert.equal(result.outcome.status,'failed');assert.equal(r.state.transfers.length,0);assert.equal(rt.services.gate.receipts().length,0);
 });
});
test('a poisoned memo cannot supply the destination or amount to SkillGate',async()=>{
 await withReview(async r=>{const rt=r.getRuntime();rt.services.policy.recordConsent('app');
 const turn='poison-test';rt.services.gate.recordToolResult(turn,'bank.list_purchases',await rt.bank['bank.list_purchases']!.run({}));
 const call:ToolCall={id:'poison-call',turnId:turn,tool:'bank.transfer',args:{from_account:'acct-checking',to_account:'9917',amount:120},skill:'core',activeSkills:[],requestedBy:'model'};
 const result=await runToolCall(call,rt.services);assert.equal(result.status,'denied');assert.ok(result.decision.provenance.some(p=>p.field==='to_account'&&p.status==='untrusted_only'));assert.equal(r.state.transfers.length,0);
 });
});
test('mock idempotency returns one transaction and rejects a changed action under the same key',async()=>{
 await withReview(async r=>{const a=r.mock.address();assert.ok(a&&typeof a!=='string');const url=`http://127.0.0.1:${a.port}/accounts/acct-checking/transfers`;
 const request=(amount:number)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'same-execution'},body:JSON.stringify({medium:'balance',payee_id:'acct-savings',amount})});
 assert.equal((await request(10)).status,201);assert.equal((await request(10)).status,200);assert.equal((await request(11)).status,409);assert.equal(r.state.transfers.length,1);assert.equal(r.state.accounts[0]!.balance,1190);
 });
});
test('a successful response with a missing transaction ledger remains unconfirmed',async()=>{
 await withReview(async r=>{const rt=r.getRuntime();rt.services.policy.recordConsent('app');const p=await rt.preview(action());
 const adapter=rt.bank['bank.move_own']!,old=adapter.run;
 adapter.run=async args=>{const result=await old(args);r.state.transfers.length=0;return result;};
 const result=await rt.execute(p.id,p.actionHash) as any;assert.equal(result.outcome.status,'executed');assert.equal(result.verification.status,'unconfirmed');assert.equal(result.verification.realizedSavings,null);
 });
});
test('review HTTP routes expose the shared savings report and deny cross-origin execution',async()=>{
 await withReview(async(r,base)=>{const res=await fetch(base);assert.match(await res.text(),/See the impact/);
 assert.equal((await post(base,'/review/reset',{scenario:'household'})).status,200);
 const report=await(await fetch(base+'/api/savings')).json();assert.equal(report.report.recommendations.length,5);
 assert.equal(report.report.recommendations.find((r:any)=>r.kind==='late_fee').action.args.from_account,'acct-checking');
 const forbidden=await fetch(base+'/review/execute',{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},body:'{}'});assert.equal(forbidden.status,403);
 });
});

test('cash-flow previews match independently generated Decimal reference cases',async()=>{
 const expected=JSON.parse(await readFile(new URL('../../fixtures/cashflow.expected.json',import.meta.url),'utf8'));
 for(const entry of expected.cases){const actual=previewAction(sample(),action(entry.amount),{now,horizon,buffer:200});
 for(const field of ['balanceAfter','availableToMove','shortfallAfter'] as const)assert.equal(actual[field],entry[field]);}
});

test('normalized Nessie rows feed the existing cash-flow guard and retain subscription tools',async()=>{
 await withReview(async r=>{const rt=r.getRuntime(),flow=await rt.services.cashFlow('acct-checking');
 assert.equal(flow?.balance,1200);assert.equal(flow?.safeToMove,150);assert.equal(flow?.upcoming.length,2);
 assert.ok(rt.services.tools.get('subscriptions.list'));assert.ok(rt.services.tools.get('subscriptions.cancel'));
 rt.services.policy.recordConsent('app');const p=await rt.preview(action());const result=await rt.execute(p.id,p.actionHash) as any;
 assert.ok(result.outcome.decision.reasons.some((reason:any)=>reason.rule==='cash_flow'&&reason.verdict==='allow'));
 });
});
