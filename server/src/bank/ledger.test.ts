import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TraceLog } from '../audit/trace.ts';
import type { ToolResult, TraceEvent } from '../types.ts';
import { createBankAdapters, withBankExecution } from './index.ts';
import { SIMULATED_SETTLEMENT, withSimulatedSettlement } from './ledger.ts';

type Row = Record<string, unknown>;
const DUKE = { _id: 'uuid-b', nickname: 'bill-duke-oct', payee: 'Duke Energy', payment_amount: 84.2, payment_date: '2026-10-13', status: 'pending' };

function liveBank({ history = [], checking = 500, pending = [DUKE] }: { history?: readonly TraceEvent[]; checking?: number; pending?: Row[] } = {}) {
  const methods: string[] = [];
  const accounts = [
    { _id: 'uuid-c', customer_id: 'cust', type: 'Checking', nickname: 'Checking', balance: checking },
    { _id: 'uuid-s', customer_id: 'cust', type: 'Savings', nickname: 'Savings', balance: 100 },
  ];
  const bills: Record<string, Row[]> = { 'uuid-c': pending, 'uuid-s': [] };
  const bank = createBankAdapters({ mode: 'live', apiKey: 'fixture', fetcher: async (input, init) => {
    methods.push(init?.method ?? 'GET');
    const path = new URL(String(input)).pathname;
    const body = path === '/accounts' ? accounts : path.endsWith('/bills') ? bills[path.split('/')[2]!] ?? [] : [];
    return new Response(JSON.stringify(body), { status: 200 });
  } });
  return { bank: withSimulatedSettlement(bank, { history }), methods };
}
const balances = async (bank: ReturnType<typeof liveBank>['bank']) => {
  const r = await bank['bank.get_accounts']!.run({});
  return Object.fromEntries((r.data as Row[]).map((a) => [a._id, a.balance]));
};
const run = (bank: ReturnType<typeof liveBank>['bank'], tool: string, args: Row) => withBankExecution(tool, args, 'call-1', () => bank[tool]!.run(args));

test('an authorized move settles on the ledger over live reads and never writes to Nessie', async () => {
  const { bank, methods } = liveBank();
  const args = { from_account: 'acct-checking', to_account: 'acct-savings', amount: 120.5 };
  const r = await run(bank, 'bank.move_own', args);
  assert.equal(r.ok, true, r.error);
  assert.equal((r.data as Row).settlement, SIMULATED_SETTLEMENT);
  assert.deepEqual(await balances(bank), { 'acct-checking': 379.5, 'acct-savings': 220.5 });
  const cited = (await bank['bank.get_accounts']!.run({})).systemValues.find((v) => v.source === 'nessie.accounts#acct-checking.balance');
  assert.equal(cited?.value, 379.5);
  assert.ok(methods.length > 0 && methods.every((m) => m === 'GET'), methods.join(', '));
});

test('a settlement needs the runner permit for exactly these arguments', async () => {
  const { bank } = liveBank();
  const args = { from_account: 'acct-checking', to_account: 'acct-savings', amount: 10 };
  assert.match((await bank['bank.move_own']!.run(args)).error!, /SkillGate execution context/);
  const other = await withBankExecution('bank.move_own', { ...args, amount: 1 }, 'call-1', () => bank['bank.move_own']!.run(args));
  assert.match(other.error!, /SkillGate execution context/);
  assert.deepEqual(await balances(bank), { 'acct-checking': 500, 'acct-savings': 100 });
});

test('a pending bill is paid once, and the read shows it paid', async () => {
  const { bank } = liveBank();
  const args = { from_account: 'acct-checking', bill_id: 'bill-duke-oct', amount: 84.2 };
  assert.equal((await run(bank, 'bank.pay_bill', args)).ok, true);
  const listed = (await bank['bank.list_bills']!.run({})).data as Row[];
  assert.equal(listed.find((b) => b._id === 'bill-duke-oct')?.status, 'paid');
  assert.equal((await balances(bank))['acct-checking'], 415.8);
  assert.match((await run(bank, 'bank.pay_bill', args)).error!, /does not match pending/);
});

test('settlements keep the bank adapter checks: ownership, balance and amount', async () => {
  const { bank } = liveBank();
  assert.match((await run(bank, 'bank.move_own', { from_account: 'acct-checking', to_account: 'acct-elsewhere', amount: 5 })).error!, /Destination must be owned/);
  assert.match((await run(bank, 'bank.move_own', { from_account: 'acct-checking', to_account: 'acct-savings', amount: 900 })).error!, /Insufficient balance/);
  assert.match((await run(bank, 'bank.pay_bill', { from_account: 'acct-checking', bill_id: 'bill-duke-oct', amount: 80 })).error!, /does not match pending/);
  assert.match((await run(bank, 'bank.transfer', { from_account: 'acct-savings', to_account: 'acct-savings', amount: 5 })).error!, /Invalid source account/);
  assert.deepEqual(await balances(bank), { 'acct-checking': 500, 'acct-savings': 100 });
});

const recorded = (trace: TraceLog, tool: string, r: ToolResult) =>
  trace.append('tool_executed', { callId: `call-${trace.size}`, tool, ok: r.ok, data: r.data, error: r.error }, 'turn-1');

test('a restart rebuilds the ledger from the trace: balances, paid bills and the next transfer id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finguard-ledger-'));
  try {
    const file = path.join(dir, 'trace.jsonl');
    const trace = new TraceLog(file);
    const before = liveBank();
    const pay = { from_account: 'acct-checking', bill_id: 'bill-duke-oct', amount: 84.2 };
    const own = { from_account: 'acct-checking', to_account: 'acct-savings', amount: 120.5 };
    const out = { from_account: 'acct-checking', to_account: 'payee-sam', amount: 20 };
    recorded(trace, 'bank.pay_bill', await run(before.bank, 'bank.pay_bill', pay));
    recorded(trace, 'bank.move_own', await run(before.bank, 'bank.move_own', own));
    recorded(trace, 'bank.transfer', await run(before.bank, 'bank.transfer', out));
    recorded(trace, 'bank.move_own', await run(before.bank, 'bank.move_own', { ...own, amount: 100_000 })); // refused: nothing to replay
    const settled = await balances(before.bank);
    assert.deepEqual(settled, { 'acct-checking': 275.3, 'acct-savings': 220.5 });

    const after = liveBank({ history: new TraceLog(file).list() });
    assert.deepEqual(await balances(after.bank), settled);
    const bill = ((await after.bank['bank.list_bills']!.run({})).data as Row[]).find((b) => b._id === 'bill-duke-oct');
    assert.equal(bill?.status, 'paid');
    assert.equal(bill?.settlement, SIMULATED_SETTLEMENT);
    assert.match((await run(after.bank, 'bank.pay_bill', pay)).error!, /does not match pending/);
    assert.match((await run(after.bank, 'bank.move_own', { ...own, amount: 300 })).error!, /Insufficient balance/);
    const next = await run(after.bank, 'bank.move_own', { ...own, amount: 5 });
    assert.equal((next.data as Row)._id, 'steward-sim-4');
    assert.equal((await balances(after.bank))['acct-checking'], 270.3);
    assert.ok(after.methods.every((m) => m === 'GET'), after.methods.join(', '));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a restart replays only successful settlements of the money tools', async () => {
  const done = (data: unknown): TraceEvent => ({ seq: 1, ts: '2026-10-11T00:00:00.000Z', type: 'tool_executed', data, prevHash: '', hash: '' });
  const settled = { _id: 'steward-sim-1', payer_id: 'acct-checking', payee_id: 'acct-savings', amount: 50, settlement: SIMULATED_SETTLEMENT };
  const paid = { ...DUKE, _id: 'bill-duke-oct', account_id: 'acct-checking', settlement: SIMULATED_SETTLEMENT };
  const history: TraceEvent[] = [
    done({ tool: 'bank.move_own', ok: false, data: settled }), // failed
    done({ tool: 'bank.move_own', ok: true, data: { ...settled, settlement: undefined } }), // not simulated: the mock bank's result
    done({ tool: 'bank.list_bills', ok: true, data: [paid] }), // a read that reports a paid bill is not a payment
    done({ tool: 'bank.get_accounts', ok: true, data: settled }),
    done({ tool: 'bank.move_own', ok: true, data: { ...settled, amount: -50 } }), // malformed
    done({ tool: 'bank.move_own', ok: true, data: { ...settled, payer_id: 'a b' } }),
    done({ tool: 'bank.move_own', ok: true, data: null }),
    done(null),
    { ...done({ tool: 'bank.move_own', ok: true, data: settled }), type: 'receipt_issued' },
  ];
  assert.deepEqual(await balances(liveBank({ history }).bank), { 'acct-checking': 500, 'acct-savings': 100 });
  history.push(done({ tool: 'bank.move_own', ok: true, data: settled }), done({ tool: 'bank.pay_bill', ok: true, data: paid }));
  const counted = liveBank({ history });
  assert.deepEqual(await balances(counted.bank), { 'acct-checking': 365.8, 'acct-savings': 150 });
  assert.equal(((await counted.bank['bank.list_bills']!.run({})).data as Row[])[0]?.status, 'paid');
});

test('two settlements at once cannot overdraw an account', async () => {
  const { bank } = liveBank({ checking: 500 });
  const move = (amount: number) => run(bank, 'bank.move_own', { from_account: 'acct-checking', to_account: 'acct-savings', amount });
  const results = await Promise.all([move(300), move(300), move(300)]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.ok(results.filter((r) => !r.ok).every((r) => /Insufficient balance/.test(r.error!)));
  assert.deepEqual(await balances(bank), { 'acct-checking': 200, 'acct-savings': 400 });
});

test('two payments at once cannot pay a bill twice or overdraw', async () => {
  const bills = [
    { _id: 'uuid-b1', nickname: 'bill-a', payee: 'Duke Energy', payment_amount: 70, payment_date: '2026-10-13', status: 'pending' },
    { _id: 'uuid-b2', nickname: 'bill-b', payee: 'Maple Court Apartments', payment_amount: 60, payment_date: '2026-10-17', status: 'pending' },
  ];
  const { bank } = liveBank({ checking: 100, pending: bills });
  const pay = (bill_id: string, amount: number) => run(bank, 'bank.pay_bill', { from_account: 'acct-checking', bill_id, amount });
  const results = await Promise.all([pay('bill-a', 70), pay('bill-a', 70), pay('bill-b', 60)]);
  assert.equal(results.filter((r) => r.ok).length, 1, results.map((r) => r.error ?? 'paid').join('; '));
  const left = (await balances(bank))['acct-checking'] as number;
  assert.ok(left === 30 || left === 40, `checking is ${left}`);
  assert.equal(((await bank['bank.list_bills']!.run({})).data as Row[]).filter((b) => b.status === 'paid').length, 1);
});

test('a refused settlement does not hold up the next one', async () => {
  const { bank } = liveBank();
  const move = (amount: number) => run(bank, 'bank.move_own', { from_account: 'acct-checking', to_account: 'acct-savings', amount });
  const [refused, fine] = await Promise.all([move(900), move(10)]);
  assert.match(refused.error!, /Insufficient balance/);
  assert.equal(fine.ok, true);
});
