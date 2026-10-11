import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { seedHousehold, type Household } from './seed.ts';

export function createMockBackend(state: Household = seedHousehold(new Date())) {
  const idempotency = new Map<string, { fingerprint: string; response: unknown }>();
  return (input: { url: string; method: string; body?: unknown; idempotencyKey?: string }) => {
    const send = (status: number, data: unknown) => ({ status, data });
    try {
      const url = new URL(input.url);
      const parts = url.pathname.split('/').filter(Boolean);
      const account = state.accounts.find(a => a._id === parts[1]);
      if (input.method === 'GET') {
        if (url.pathname === '/demo/meta') return send(200, { observedAt: state.observedAt, mock: true });
        if (url.pathname === '/accounts') return send(200, state.accounts);
        if (url.pathname === '/merchants') return send(200, state.merchants);
        if (url.pathname === '/demo/payees') return send(200, state.payees);
        if (parts[0] === 'accounts' && account) {
          if (parts.length === 2) return send(200, account);
          if (parts.length === 3 && parts[2] === 'bills') return send(200, state.bills.filter(b => b.account_id === account._id));
          if (parts.length === 3 && parts[2] === 'purchases') return send(200, state.purchases.filter(p => p.payer_id === account._id));
          if (parts.length === 3 && parts[2] === 'transfers') return send(200, state.transfers.filter(t => t.payer_id === account._id || t.payee_id === account._id));
        }
      }
      if (input.method === 'POST' && parts[0] === 'accounts' && account && ['transfers', 'bills'].includes(parts[2] ?? '')) {
        const body = input.body as Record<string, unknown>;
        if (!body || typeof body !== 'object' || parts.length !== 3) return send(400, { message: 'Invalid request' });
        const idem = input.idempotencyKey;
        const fingerprint = JSON.stringify({ path: url.pathname, body });
        if (typeof idem !== 'string' || !idem) return send(400, { message: 'Local mock writes require an idempotency key' });
        const prior = idempotency.get(idem);
        if (prior) return send(prior.fingerprint === fingerprint ? 200 : 409, prior.fingerprint === fingerprint ? prior.response : { message: 'Idempotency key reused for another action' });
        const amount = parts[2] === 'bills' ? body.payment_amount : body.amount;
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7)
          return send(400, { message: 'Positive cent-precision amount required' });
        if (amount > account.balance) return send(409, { message: 'Insufficient balance' });
        const target = parts[2] === 'transfers' ? state.accounts.find(a => a._id === body.payee_id) : undefined;
        if (parts[2] === 'transfers' && (typeof body.payee_id !== 'string' || !/^[\w-]{1,100}$/.test(body.payee_id))) return send(400, { message: 'Invalid destination' });
        if (target?._id === account._id) return send(400, { message: 'Source and destination must differ' });
        if (parts[2] === 'bills' && !state.payees.some(p => p.name === body.payee)) return send(400, { message: 'Unknown bill payee' });
        const bill = parts[2] === 'bills' ? state.bills.find(b => b._id === body.bill_id && b.account_id === account._id && b.status === 'pending') : undefined;
        if (parts[2] === 'bills' && (!bill || bill.payment_amount !== amount)) return send(409, { message: 'Pending bill or amount does not match' });
        account.balance = (Math.round(account.balance * 100) - Math.round(amount * 100)) / 100;
        if (target) target.balance = (Math.round(target.balance * 100) + Math.round(amount * 100)) / 100;
        if (bill) bill.status = 'completed';
        const record = { ...body, _id: `mock-${state.transfers.length + 1}`, payer_id: account._id, status: 'completed' };
        state.transfers.push(record);
        state.observedAt = new Date().toISOString();
        const response = { code: 201, message: 'Mock transaction created', objectCreated: record };
        idempotency.set(idem, { fingerprint, response });
        return send(201, response);
      }
      return send(404, { message: 'Resource not found' });
    } catch { return send(400, { message: 'Invalid request' }); }
  };
}
export function createMockFetcher(state: Household): typeof fetch {
  const dispatch = createMockBackend(state);
  return async (input, init) => {
    const result = dispatch({ url: String(input), method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      idempotencyKey: new Headers(init?.headers).get('Idempotency-Key') ?? undefined });
    return new Response(JSON.stringify(result.data), { status: result.status, headers: { 'Content-Type': 'application/json' } });
  };
}
export function createMockNessie(state: Household = seedHousehold(new Date())) {
  const dispatch = createMockBackend(state);
  return createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 16384) { res.writeHead(413); res.end(); return; } }
      const idem = req.headers['idempotency-key'];
      const result = dispatch({ url: new URL(req.url ?? '/', 'http://localhost').href, method: req.method ?? 'GET',
        body: raw ? JSON.parse(raw) : undefined, idempotencyKey: typeof idem === 'string' ? idem : undefined });
      res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result.data));
    } catch { res.writeHead(400); res.end(JSON.stringify({ message: 'Invalid request' })); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_NESSIE_PORT ?? 8788);
  createMockNessie().listen(port, '127.0.0.1', () => console.log(`Mock Nessie: http://127.0.0.1:${port}`));
}
