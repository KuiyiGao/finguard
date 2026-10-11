import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ToolAdapter, ToolResult, ToolSpec } from '../types.ts';
import { BANK_TOOLS } from '../tools/specs.ts';
import { canonicalJson, sha256 } from '../util.ts';
import { createNessieAliases } from './aliases.ts';

type Row = Record<string, unknown>;
export type BankOptions = {
  mode?: 'live' | 'mock'; baseUrl?: string; apiKey?: string;
  customerId?: string;
  log?: (line: string) => void;
  savedPayees?: { id: string; name: string; account: string; addedAt: string }[];
  authorize?: (tool: string, args: Row) => Promise<boolean>;
  fetcher?: typeof fetch;
};
const permits = new AsyncLocalStorage<{ actionHash: string; executionId: string }>();
export function withBankExecution<T>(tool: string, args: Row, executionId: string, run: () => Promise<T>): Promise<T> {
  return permits.run({ actionHash: sha256(canonicalJson({ tool, args })), executionId }, run);
}
export function permitCovers(tool: string, args: Row): boolean {
  return permits.getStore()?.actionHash === sha256(canonicalJson({ tool, args }));
}
class BankHttpError extends Error { constructor(readonly status: number) { super(`Bank HTTP ${status}`); } }
const failure = (error: string): ToolResult => ({ ok: false, data: null, systemValues: [], texts: [], error });
const resourceId = (v: unknown) => { if (typeof v !== 'string' || !/^[\w-]{1,100}$/.test(v)) throw new Error('Invalid resource id'); return v; };
const cents = (v: unknown) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || !Number.isSafeInteger(Math.round(v * 100)) || Math.abs(v * 100 - Math.round(v * 100)) > 1e-7) throw new Error('Invalid amount');
  return v;
};
function rowsToNormalize(data: unknown): Row[] {
  return (Array.isArray(data) ? data : [data]).filter((r): r is Row => Boolean(r) && typeof r === 'object');
}
export function splitResult(resource: string, data: unknown): ToolResult {
  const fields: Record<string, string[]> = {
    accounts: ['_id', 'customer_id', 'balance'], bills: ['_id', 'account_id', 'payment_amount'],
    purchases: ['_id', 'merchant_id', 'payer_id', 'amount'], payees: ['id', 'account'],
    transfers: ['_id', 'payer_id', 'payee_id', 'amount'],
  };
  const systemValues: ToolResult['systemValues'] = [], texts: ToolResult['texts'] = [];
  for (const [i, item] of (Array.isArray(data) ? data : [data]).entries()) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Row, source = `nessie.${resource}#${row._id ?? row.id ?? i}`;
    for (const field of fields[resource] ?? []) {
      const value = row[field];
      if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) systemValues.push({ source: `${source}.${field}`, value });
    }
    for (const field of ['description', 'memo', 'nickname', 'name', 'payee']) if (typeof row[field] === 'string') texts.push({ source: `${source}.${field}`, text: row[field] as string });
  }
  const normalized = rowsToNormalize(data).map(row => ({ ...row,
    ...(resource === 'accounts' ? { id: row._id } : {}),
    ...(resource === 'bills' ? { id: row._id, amount: row.payment_amount, due: row.payment_date,
      nessie_status: row.status, status: row.status === 'completed' ? 'paid' : row.status } : {}),
    ...(resource === 'purchases' ? { id: row._id, date: row.purchase_date, memo: row.memo ?? row.description, merchant: row.merchant_id } : {}) }));
  return { ok: true, data: Array.isArray(data) ? normalized : normalized[0] ?? data, systemValues, texts };
}
export function createBankAdapters(options: BankOptions = {}): Record<string, ToolAdapter> {
  const mode = options.mode ?? process.env.NESSIE_MODE ?? 'mock';
  if (!['live', 'mock'].includes(mode)) throw new Error('NESSIE_MODE must be live or mock');
  const base = new URL(options.baseUrl ?? (mode === 'live' ? 'https://prod-api.nessieisreal.com' : process.env.MOCK_NESSIE_URL ?? 'http://127.0.0.1:8788'));
  if (base.username || base.password || base.search || base.hash) throw new Error('Invalid bank base URL');
  if (mode === 'live' && (base.protocol !== 'https:' || !['prod-api.nessieisreal.com', 'api.nessieisreal.com'].includes(base.hostname))) throw new Error('Live Nessie requires official HTTPS');
  if (mode === 'mock' && (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) throw new Error('Mock endpoint must be local HTTP');
  const apiKey = options.apiKey ?? process.env.NESSIE_API_KEY;
  if (mode === 'live' && !apiKey) throw new Error('NESSIE_API_KEY required');
  async function rawRequest(path: string, method = 'GET', body?: unknown, executionId?: string) {
    const url = new URL(path, base); if (mode === 'live') url.searchParams.set('key', apiKey!);
    const response = await (options.fetcher ?? fetch)(url, { method, redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', ...(mode === 'mock' && body ? { 'Idempotency-Key': executionId ?? randomUUID() } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new BankHttpError(response.status);
    return response.json();
  }
  const aliases = mode === 'live' ? createNessieAliases(rawRequest, { customerId: options.customerId || process.env.NESSIE_CUSTOMER_ID || undefined, log: options.log }) : undefined;
  const request = aliases ? aliases.request : rawRequest;
  const household = async () => aliases?.selectedCustomer();
  const adapters: Record<string, ToolAdapter> = {};
  function register(spec: ToolSpec, run: (args: Row) => Promise<ToolResult>) {
    adapters[spec.name] = { spec, async run(input) {
      try {
        const required = spec.inputSchema.required as string[] | undefined ?? [];
        const props = spec.inputSchema.properties as Row;
        if (!input || typeof input !== 'object' || Array.isArray(input) || required.some(f => !(f in input)) || Object.keys(input).some(f => !(f in props))) return failure('Invalid tool arguments');
        const args = Object.freeze({ ...input });
        if (spec.effect === 'move_money') {
          if (mode === 'live') return failure('Live Nessie is read-only; use the offline household for money actions until settlement semantics are verified');
          cents(args.amount);
          const permit = permits.getStore();
          const matching = permit?.actionHash === sha256(canonicalJson({ tool: spec.name, args }));
          if ((!matching && !options.authorize) || (options.authorize && !(await options.authorize(spec.name, args)))) return failure('SkillGate execution context required for this exact action');
        }
        return await run(args);
      } catch (error) {
        if (error instanceof BankHttpError && [401,403].includes(error.status)) return failure(`Nessie rejected authentication (HTTP ${error.status}); check NESSIE_API_KEY and the configured official API host`);
        if (error instanceof BankHttpError && spec.effect !== 'move_money') return failure(`Bank read failed (HTTP ${error.status}); check the selected household and provider endpoint`);
        return failure(spec.effect === 'move_money' ? 'Bank write not confirmed; reconcile before retrying' : 'Bank read failed; check connection and configuration');
      }
    } };
  }
  async function accounts(): Promise<Row[]> {
    const customer = await household();
    const data = await request('/accounts'); if (!Array.isArray(data)) throw new Error('Invalid accounts');
    return customer ? data.filter(a => a.customer_id === resourceId(customer)) : data;
  }
  register(BANK_TOOLS.getAccounts, async () => splitResult('accounts', await accounts()));
  for (const [resource, spec] of [['bills', BANK_TOOLS.listBills], ['purchases', BANK_TOOLS.listPurchases]] as const) register(spec, async args => {
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 10000)) return failure('limit must be an integer from 1 to 10000');
    const selected = await household();
    const owned = args.account_id === undefined || selected ? await accounts() : undefined;
    const accountId = args.account_id === undefined ? undefined : resourceId(args.account_id);
    if (accountId && selected && !owned!.some(a => a._id === accountId)) return failure('Account does not belong to the selected household');
    const ids = accountId ? [accountId] : owned!.map(a => resourceId(a._id));
    const rows: Row[] = [];
    for (const account of ids) {
      const data = await request(`/accounts/${account}/${resource}`); if (!Array.isArray(data)) throw new Error('Invalid bank rows');
      rows.push(...data.map(row => ({ ...row, ...(resource === 'bills' ? { account_id: account } : { payer_id: account }) })));
    }
    rows.sort((a,b) => (resource === 'bills' ? String(a.payment_date).localeCompare(String(b.payment_date)) : String(b.purchase_date).localeCompare(String(a.purchase_date))) || String(a._id).localeCompare(String(b._id)));
    const result = splitResult(resource, args.limit === undefined ? rows : rows.slice(0, Number(args.limit)));
    if (resource === 'bills') for (const row of result.data as Row[]) {
      if (options.savedPayees?.some(p => p.name === row.payee)) result.systemValues.push({ source: `nessie.bills#${row._id}.payee`, value: String(row.payee) });
    }
    return result;
  });
  register(BANK_TOOLS.listPayees, async () => splitResult('payees', mode === 'mock' ? await request('/demo/payees') : options.savedPayees ?? []));
  for (const spec of [BANK_TOOLS.moveOwn, BANK_TOOLS.transfer]) register(spec, async args => {
    const from = resourceId(args.from_account), to = resourceId(args.to_account), amount = cents(args.amount);
    const own = await accounts();
    if (!own.some(a => a._id === from) || from === to) return failure('Invalid source account');
    if (spec.name === BANK_TOOLS.moveOwn.name && !own.some(a => a._id === to)) return failure('Destination must be owned');
    for (const field of ['memo','payee_name']) if (args[field] !== undefined && (typeof args[field] !== 'string' || String(args[field]).length > 1000)) return failure('Invalid optional text');
    const response = await request(`/accounts/${from}/transfers`, 'POST', { medium: 'balance', payee_id: to, amount,
      transaction_date: new Date().toISOString().slice(0,10), description: args.memo ?? 'FinGuard authorized action' }, permits.getStore()?.executionId) as Row;
    return splitResult('transfers', response.objectCreated ?? response);
  });
  register(BANK_TOOLS.payBill, async args => {
    const from = resourceId(args.from_account), billId = resourceId(args.bill_id), amount = cents(args.amount);
    const bills = await request(`/accounts/${from}/bills`) as Row[];
    const bill = bills.find(b => b._id === billId && b.status === 'pending');
    if (!bill || bill.payment_amount !== amount) return failure('Bill or amount does not match pending bank record');
    if (mode === 'live') return failure('Live bill-payment mutation is not verified; disabled');
    const response = await request(`/accounts/${from}/bills`, 'POST', { payee: bill.payee, payment_amount: amount,
      payment_date: new Date().toISOString().slice(0,10), status: 'pending', bill_id: billId }, permits.getStore()?.executionId) as Row;
    return splitResult('bills', response.objectCreated ?? response);
  });
  return adapters;
}
