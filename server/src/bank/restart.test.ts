import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.ts';
import { personaSetup } from '../demo/personas.ts';
import { runToolCall } from '../policy/run.ts';
import { buildServices, resetServices, type Services } from '../services.ts';
import type { ToolCall } from '../types.ts';

type Row = Record<string, any>;

function liveSandbox() {
  const uuid = (id: string) => `u-${id}-0000`;
  const { household } = personaSetup('maya', new Date());
  const accounts = household.accounts.map((a) => ({ _id: uuid(a._id), customer_id: 'cust-maya', type: a.type, nickname: a.nickname, balance: a.balance }));
  const bills: Record<string, Row[]> = {};
  for (const a of household.accounts) bills[uuid(a._id)] = [];
  for (const b of household.bills) bills[uuid(b.account_id)]!.push({ _id: uuid(b._id), nickname: b._id, payee: b.payee, payment_date: b.payment_date, payment_amount: b.payment_amount, status: 'pending' });
  const seen: string[] = [];
  const fetcher = (async (input: unknown, init?: { method?: string }) => {
    const url = new URL(String(input));
    if (url.hostname !== 'prod-api.nessieisreal.com') throw new Error(`blocked network: ${url.hostname}`);
    const method = init?.method ?? 'GET';
    seen.push(`${method} ${url.pathname}`);
    if (method !== 'GET') throw new Error('write attempted');
    const parts = url.pathname.split('/').filter(Boolean);
    const body = parts[0] === 'accounts' ? (parts.length === 1 ? accounts : parts[2] === 'bills' ? bills[parts[1]!] ?? [] : []) : [];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fetcher, seen };
}

const call = (tool: string, args: Row): ToolCall => ({ id: crypto.randomUUID(), turnId: crypto.randomUUID(), tool, args, skill: 'core', activeSkills: [], requestedBy: 'app' });

async function view(s: Services) {
  const accounts = (await s.tools.get('bank.get_accounts')!.run({})).data as Row[];
  const bills = (await s.tools.get('bank.list_bills')!.run({})).data as Row[];
  return { checking: accounts.find((a) => a._id === 'acct-checking')?.balance, duke: bills.find((b) => b._id === 'bill-duke-oct')?.status };
}

async function payDuke(s: Services) {
  const pay = call('bank.pay_bill', { from_account: 'acct-checking', bill_id: 'bill-duke-oct', amount: 84.2 });
  s.gate.recordToolResult(pay.turnId, 'bank.list_bills', await s.tools.get('bank.list_bills')!.run({}));
  s.gate.recordUserMessage(pay.turnId, 'msg-pay', 'Pay my Duke Energy bill');
  return runToolCall(pay, s, { onApprovalRequested: (a) => void s.gate.answer(a.id, true, a.code) });
}

test('a restarted server keeps the settled balances and paid bills; a demo reset starts clean', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finguard-restart-'));
  const sandbox = liveSandbox();
  const realFetch = globalThis.fetch, env = { key: process.env.NESSIE_API_KEY, customer: process.env.NESSIE_CUSTOMER_ID };
  globalThis.fetch = sandbox.fetcher;
  process.env.NESSIE_API_KEY = 'fixture';
  delete process.env.NESSIE_CUSTOMER_ID;
  const open: Services[] = [], lines: string[] = [];
  const build = (config: ReturnType<typeof loadConfig>) => { const s = buildServices(config, { persist: true, log: (line) => lines.push(line) }); open.push(s); return s; };
  try {
    const config = loadConfig({ NESSIE_MODE: 'live', DATA_DIR: dir, APPROVAL_TTL_SECONDS: '5' });
    const first = build(config);
    first.policy.recordConsent('app');
    assert.ok(first.stubs.some((line) => /^subscriptions: simulated merchant/.test(line)) && first.stubs.every((line) => !/mock|fictional/i.test(line)), first.stubs.join('; '));
    assert.deepEqual(await view(first), { checking: 4210.55, duke: 'pending' });
    assert.equal(lines.filter((line) => /NESSIE_CUSTOMER_ID/.test(line)).length, 1, 'the sandbox has no Demo Household customer: one warning reaches the server log');
    assert.equal((await payDuke(first)).status, 'executed');
    assert.deepEqual(await view(first), { checking: 4126.35, duke: 'paid' });
    first.db?.close();

    const second = build(config);
    assert.deepEqual(await view(second), { checking: 4126.35, duke: 'paid' });
    assert.equal(second.gate.receipts().length, 1, 'the receipt persisted, and so does the ledger');
    const again = await payDuke(second);
    assert.equal(again.status, 'failed');
    assert.match((again as { error: string }).error, /does not match pending/);
    assert.deepEqual(await view(second), { checking: 4126.35, duke: 'paid' });

    resetServices(second);
    assert.deepEqual(await view(second), { checking: 4210.55, duke: 'pending' });
    assert.ok(sandbox.seen.length > 0 && sandbox.seen.every((r) => r.startsWith('GET ')), 'nothing was written to the sandbox');
  } finally {
    for (const s of open) s.db?.close();
    globalThis.fetch = realFetch;
    for (const [name, value] of [['NESSIE_API_KEY', env.key], ['NESSIE_CUSTOMER_ID', env.customer]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
