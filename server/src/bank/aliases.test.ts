import test from 'node:test';
import assert from 'node:assert/strict';
import { seedHousehold } from '../../mock-nessie/seed.ts';
import { createNessieAliases, seedCustomers, type RawRequest } from './aliases.ts';
import { createBankAdapters, withBankExecution } from './index.ts';
import { withSimulatedSettlement } from './ledger.ts';

type Row = Record<string, any>;
const NOW = new Date('2026-10-10T16:00:00Z');

function household(customer: string, tag: string, checkingBalance?: number) {
  const seed = seedHousehold(NOW);
  const id = (x: string) => `${tag}-${x}`;
  const checking = id('acct-checking');
  return {
    accounts: seed.accounts.map((a) => ({ _id: id(a._id), customer_id: customer, type: a.type, nickname: a.nickname, balance: a.type === 'Checking' && checkingBalance !== undefined ? checkingBalance : a.balance })),
    bills: {
      [checking]: [
        { _id: id('duke'), nickname: 'bill-duke-oct', payee: 'Duke Energy', payment_date: '2026-10-12', payment_amount: 84.2, status: 'pending' },
        { _id: id('inet'), nickname: 'internet-bill', payee: 'Spectrum Internet', payment_date: '2026-11-19', payment_amount: 90, status: 'pending' },
      ],
      [id('acct-savings')]: [] as Row[],
    } as Record<string, Row[]>,
    purchases: { [checking]: seed.purchases.map((p) => ({ ...p, _id: id(p._id), merchant_id: id(`m-${p.merchant_id}`), payer_id: checking })) } as Record<string, Row[]>,
    merchants: Object.fromEntries(seed.merchants.map((m) => [id(`m-${m._id}`), { _id: id(`m-${m._id}`), name: m.name }])) as Record<string, Row>,
  };
}

function sandbox(homes: ReturnType<typeof household>[] = [household('c-1', 'u')], customers: Row[] = []) {
  const requests: string[] = [];
  const failures = new Map<string, number>();
  const fail = (path: string, times = 1) => failures.set(path, times);
  const raw: RawRequest = async (path, method = 'GET') => {
    requests.push(`${method} ${path}`);
    if (method !== 'GET') throw new Error('write attempted');
    const left = failures.get(path) ?? 0;
    if (left > 0) {
      failures.set(path, left - 1);
      throw Object.assign(new Error('Bank HTTP 503'), { status: 503 });
    }
    const parts = path.split('/').filter(Boolean);
    if (path === '/customers') return customers;
    if (path === '/accounts') return homes.flatMap((h) => h.accounts);
    if (parts[0] === 'accounts' && parts[2] === 'bills') return homes.flatMap((h) => h.bills[parts[1]!] ?? []);
    if (parts[0] === 'accounts' && parts[2] === 'purchases') return homes.flatMap((h) => h.purchases[parts[1]!] ?? []);
    if (parts[0] === 'merchants') {
      const found = homes.map((h) => h.merchants[parts[1]!]).find(Boolean);
      if (found) return found;
    }
    throw Object.assign(new Error('Bank HTTP 404'), { status: 404 });
  };
  const count = (prefix: string) => requests.filter((r) => r.startsWith(prefix)).length;
  const fetcher = (async (input: unknown, init?: { method?: string }) => {
    try {
      return new Response(JSON.stringify(await raw(new URL(String(input)).pathname, init?.method ?? 'GET')), { status: 200 });
    } catch (error) {
      return new Response('{}', { status: (error as { status?: number }).status ?? 500 });
    }
  }) as typeof fetch;
  return { raw, requests, fail, count, fetcher };
}

test('a purchases read looks up each merchant once, not once per row', async () => {
  const { raw, count } = sandbox();
  const aliases = createNessieAliases(raw);
  const rows = (await aliases.request('/accounts/acct-checking/purchases')) as Row[];
  assert.equal(rows.length, 32);
  assert.equal(count('GET /merchants/'), 6);
  assert.deepEqual([...new Set(rows.map((r) => r.merchant_id))].sort(), ['fee', 'groceries', 'gym', 'internet', 'music', 'stream']);
  assert.ok(rows.some((r) => r._id === 'p-fee'), 'the past late fee is found by its demo purchase id');
  await aliases.request('/accounts/acct-checking/purchases');
  assert.equal(count('GET /merchants/'), 6, 'answers are kept for the next read');
});

test('a failed merchant lookup is not remembered: the late fee is found on the next read', async () => {
  const { raw, fail, count } = sandbox();
  fail('/merchants/u-m-fee');
  const aliases = createNessieAliases(raw);
  const first = (await aliases.request('/accounts/acct-checking/purchases')) as Row[];
  assert.ok(first.every((r) => r._id !== 'p-fee'), 'while the merchant cannot be read its purchase is left as it is');
  assert.equal(first.length, 32, 'the read itself still succeeds');
  assert.equal(count('GET /merchants/u-m-fee'), 1, 'rows read together share the one failed lookup');
  const second = (await aliases.request('/accounts/acct-checking/purchases')) as Row[];
  assert.ok(second.some((r) => r._id === 'p-fee' && r.merchant_id === 'fee'));
  assert.equal(count('GET /merchants/u-m-fee'), 2);
  await aliases.request('/accounts/acct-checking/purchases');
  assert.equal(count('GET /merchants/u-m-fee'), 2, 'a lookup that worked is kept');
});

test('a failed bills read keeps the account aliases and is tried again on the next call', async () => {
  const { raw, fail, requests } = sandbox();
  fail('/accounts/u-acct-checking/bills');
  const aliases = createNessieAliases(raw);
  const purchases = (await aliases.request('/accounts/acct-checking/purchases')) as Row[];
  assert.ok(requests.includes('GET /accounts/u-acct-checking/purchases'), 'the account id was still translated');
  assert.ok(purchases.every((p) => p.payer_id === 'acct-checking'));
  const bills = (await aliases.request('/accounts/acct-checking/bills')) as Row[];
  assert.deepEqual(bills.map((b) => b._id), ['bill-duke-oct', 'internet-bill'], 'the bills are read again and aliased');
});

const HOME = { _id: 'c-home', first_name: 'Demo', last_name: 'Household' };
const OTHER = { _id: 'c-other', first_name: 'Someone', last_name: 'Else' };
const key = { mode: 'live', apiKey: 'fixture' } as const;
const twoHouseholds = (customers: Row[] = [OTHER, HOME]) => sandbox([household('c-other', 'o', 99), household('c-home', 'h')], customers);
const ids = (rows: unknown) => (rows as Row[]).map((r) => r._id);

test('the seed customer is found by name, and the lowest id wins when several carry it', () => {
  const customers = [
    { _id: 'c-9', first_name: 'Demo', last_name: 'Household' }, { _id: 'c-1', first_name: 'Demo', last_name: 'Household' },
    { _id: 'c-0', first_name: 'Demo', last_name: 'Household Two' }, { _id: 'c-2', first_name: 'demo', last_name: 'household' }, { first_name: 'Demo', last_name: 'Household' },
  ];
  assert.deepEqual(seedCustomers(customers).map((c) => c._id), ['c-1', 'c-9']);
  assert.deepEqual(seedCustomers(null), []);
});

test('without NESSIE_CUSTOMER_ID the demo ids map to the Demo Household customer, not the first account listed', async () => {
  const lines: string[] = [];
  const { raw, requests } = twoHouseholds();
  const aliases = createNessieAliases(raw, { log: (line) => lines.push(line) });
  const listed = (await aliases.request('/accounts')) as Row[];
  assert.deepEqual(ids(listed), ['o-acct-checking', 'o-acct-savings', 'acct-checking', 'acct-savings']);
  assert.equal(listed.find((a) => a._id === 'acct-checking')?.nessie_id, 'h-acct-checking');
  const bills = (await aliases.request('/accounts/acct-checking/bills')) as Row[];
  assert.ok(requests.includes('GET /accounts/h-acct-checking/bills'));
  assert.deepEqual(ids(bills), ['bill-duke-oct', 'internet-bill']);
  assert.deepEqual(lines, [], 'one household matches by name: nothing to warn about');
});

test('the bank adapters read only the Demo Household customer, and do not let another household be read by id', async () => {
  const { fetcher, count } = twoHouseholds();
  const bank = createBankAdapters({ ...key, fetcher });
  const accounts = (await bank['bank.get_accounts']!.run({})).data as Row[];
  assert.deepEqual(ids(accounts), ['acct-checking', 'acct-savings']);
  assert.ok(accounts.every((a) => a.customer_id === 'c-home'));
  assert.deepEqual(accounts.map((a) => a.balance), [5400, 1000], 'the balances are the Demo Household customer\'s, not the other customer\'s');
  for (const tool of ['bank.list_bills', 'bank.list_purchases']) {
    const refused = await bank[tool]!.run({ account_id: 'o-acct-checking' });
    assert.equal(refused.ok, false);
    assert.match(refused.error!, /selected household/);
  }
  assert.equal(count('GET /customers'), 1, 'the customer list is read once');
});

test('the ledger owns only the Demo Household customer accounts', async () => {
  const { fetcher, requests } = twoHouseholds();
  const bank = withSimulatedSettlement(createBankAdapters({ ...key, fetcher }));
  const run = (tool: string, args: Row) => withBankExecution(tool, args, 'call-1', () => bank[tool]!.run(args));
  const foreign = { from_account: 'acct-checking', to_account: 'o-acct-savings', amount: 25 };
  assert.match((await run('bank.move_own', foreign)).error!, /Destination must be owned/);
  assert.equal((await run('bank.transfer', foreign)).ok, true, 'sending to someone else is still an external transfer');
  const own = await run('bank.move_own', { from_account: 'acct-checking', to_account: 'acct-savings', amount: 100 });
  assert.equal(own.ok, true, own.error);
  const accounts = (await bank['bank.get_accounts']!.run({})).data as Row[];
  assert.deepEqual(accounts.map((a) => [a._id, a.balance]), [['acct-checking', 5275], ['acct-savings', 1100]]);
  assert.ok(requests.every((r) => r.startsWith('GET ')));
});

test('several customers named Demo Household: the lowest id is used and one warning names NESSIE_CUSTOMER_ID', async () => {
  const lines: string[] = [];
  const { fetcher } = sandbox([household('c-9', 'z'), household('c-1', 'a')], [{ ...HOME, _id: 'c-9' }, { ...HOME, _id: 'c-1' }, OTHER]);
  const bank = createBankAdapters({ ...key, fetcher, log: (line) => lines.push(line) });
  for (let i = 0; i < 3; i++) {
    const accounts = (await bank['bank.get_accounts']!.run({})).data as Row[];
    assert.deepEqual(accounts.map((a) => a.nessie_id), ['a-acct-checking', 'a-acct-savings']);
    await bank['bank.list_bills']!.run({});
  }
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0]!, /NESSIE_CUSTOMER_ID/);
  assert.match(lines[0]!, /c-1/);
});

test('no customer named Demo Household: every account is read as before, with one warning', async () => {
  const lines: string[] = [];
  const { fetcher } = twoHouseholds([OTHER]);
  const bank = createBankAdapters({ ...key, fetcher, log: (line) => lines.push(line) });
  const first = (await bank['bank.get_accounts']!.run({})).data as Row[];
  assert.equal(first.length, 4);
  await bank['bank.get_accounts']!.run({});
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /NESSIE_CUSTOMER_ID/);
});

test('NESSIE_CUSTOMER_ID wins: the customer list is not read and nothing is warned', async () => {
  const lines: string[] = [];
  const { fetcher, count } = twoHouseholds();
  const bank = createBankAdapters({ ...key, customerId: 'c-other', fetcher, log: (line) => lines.push(line) });
  const accounts = (await bank['bank.get_accounts']!.run({})).data as Row[];
  assert.deepEqual(accounts.map((a) => a.nessie_id), ['o-acct-checking', 'o-acct-savings']);
  assert.equal(count('GET /customers'), 0);
  assert.deepEqual(lines, []);
});

test('a failed customer lookup fails the read instead of reading the wrong household, and is tried again', async () => {
  const lines: string[] = [];
  const { fetcher, fail } = twoHouseholds();
  fail('/customers');
  const bank = createBankAdapters({ ...key, fetcher, log: (line) => lines.push(line) });
  const failed = await bank['bank.get_accounts']!.run({});
  assert.equal(failed.ok, false);
  assert.match(failed.error!, /HTTP 503/);
  const retried = await bank['bank.get_accounts']!.run({});
  assert.equal(retried.ok, true);
  assert.deepEqual(ids(retried.data), ['acct-checking', 'acct-savings']);
  assert.deepEqual(lines, [], 'a lookup that failed is not a customer that is missing');
});

test('a bill seeded as Demo Internet reads as Spectrum Internet, and nothing is written back', async () => {
  const home = household('c-home', 'h');
  home.bills['h-acct-checking']![1]!.payee = 'Demo Internet';
  const { raw, requests, fetcher } = sandbox([home], [HOME]);
  const bills = (await createNessieAliases(raw).request('/accounts/acct-checking/bills')) as Row[];
  assert.deepEqual(bills.map((b) => [b._id, b.payee]), [['bill-duke-oct', 'Duke Energy'], ['internet-bill', 'Spectrum Internet']]);
  const listed = await createBankAdapters({ ...key, fetcher })['bank.list_bills']!.run({});
  assert.deepEqual((listed.data as Row[]).map((b) => b.payee), ['Duke Energy', 'Spectrum Internet']);
  assert.ok(listed.texts.some((t) => t.source === 'nessie.bills#internet-bill.payee' && t.text === 'Spectrum Internet'));
  assert.ok(requests.every((r) => r.startsWith('GET ')), requests.join(', '));
  assert.equal(home.bills['h-acct-checking']![1]!.payee, 'Demo Internet', 'the sandbox record itself is untouched');
});

test('payee names that were never renamed, or that only look like a rename, are left as they are', async () => {
  const home = household('c-home', 'h');
  home.bills['h-acct-checking']![0]!.payee = 'constructor';
  home.bills['h-acct-checking']![1]!.payee = 'Demo Internet Co';
  const bills = (await createNessieAliases(sandbox([home], [HOME]).raw).request('/accounts/acct-checking/bills')) as Row[];
  assert.deepEqual(bills.map((b) => b.payee), ['constructor', 'Demo Internet Co']);
});
