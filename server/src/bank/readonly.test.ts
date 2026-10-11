import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankAdapters, withBankExecution } from './index.ts';
test('live money tools cannot write even with an exact permit and approving callback', async () => {
 let calls = 0;
 const bank = createBankAdapters({ mode: 'live', apiKey: 'fixture', authorize: async () => true, fetcher: async () => { calls++; throw new Error('must not call provider'); } });
 for (const [tool,args] of [['bank.move_own',{from_account:'a',to_account:'b',amount:1}],['bank.transfer',{from_account:'a',to_account:'b',amount:1}],['bank.pay_bill',{from_account:'a',bill_id:'bill',amount:1}]] as const) {
  const result = await withBankExecution(tool,args,'fixture',()=>bank[tool]!.run(args));
  assert.equal(result.ok,false); assert.match(result.error!,/read-only/);
 }
 assert.equal(calls,0);
});

test('live household filter keeps only selected customer accounts',async()=>{
 const bank=createBankAdapters({mode:'live',apiKey:'fixture',customerId:'owned',fetcher:async()=>new Response(JSON.stringify([{_id:'a',customer_id:'owned',balance:10},{_id:'b',customer_id:'other',balance:100}]),{status:200})});
 const r=await bank['bank.get_accounts']!.run({});assert.deepEqual((r.data as { _id:string }[]).map(a=>a._id),['a']);
});

test('explicit account reads cannot escape the selected live household', async () => {
 const paths:string[]=[];
 const bank=createBankAdapters({mode:'live',apiKey:'fixture',customerId:'owned',fetcher:async(input)=>{
  paths.push(new URL(String(input)).pathname);
  return new Response(JSON.stringify([{_id:'a',customer_id:'owned'}]),{status:200});
 }});
 for(const name of ['bank.list_bills','bank.list_purchases']) {
  const result=await bank[name]!.run({account_id:'other'});
  assert.equal(result.ok,false); assert.match(result.error!,/selected household/);
 }
 assert.deepEqual(paths,['/accounts','/accounts']);
});

test('provider read errors retain status but never leak credentials or response text',async()=>{
 const bank=createBankAdapters({mode:'live',apiKey:'fixture-secret',fetcher:async()=>new Response('private provider detail',{status:400})});
 const r=await bank['bank.list_bills']!.run({account_id:'a'});
 assert.equal(r.ok,false); assert.match(r.error!,/HTTP 400/);
 assert.doesNotMatch(r.error!,/fixture-secret|private provider detail/);
});
