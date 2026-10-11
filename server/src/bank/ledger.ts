import { BANK_TOOLS } from '../tools/specs.ts';
import type { ToolAdapter, ToolResult, ToolSpec, TraceEvent } from '../types.ts';
import { permitCovers, splitResult } from './index.ts';

type Row = Record<string, unknown>;
type Entry = { from: string; to?: string; amount: number; billId?: string };

export const SIMULATED_SETTLEMENT = "simulated: settled on FinGuard's ledger over live Nessie reads; nothing was written to Nessie";

const failure = (error: string): ToolResult => ({ ok: false, data: null, systemValues: [], texts: [], error });
const toCents = (n: number) => Math.round(n * 100);
const resourceId = (v: unknown) => (typeof v === 'string' && /^[\w-]{1,100}$/.test(v) ? v : undefined);
const validAmount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && Number.isSafeInteger(toCents(v)) && Math.abs(v * 100 - toCents(v)) <= 1e-7;

const SETTLING = new Set<string>([BANK_TOOLS.moveOwn.name, BANK_TOOLS.transfer.name, BANK_TOOLS.payBill.name]);

function replayed(history: readonly TraceEvent[]): Entry[] {
  const entries: Entry[] = [];
  for (const event of history) {
    const done = event.type === 'tool_executed' ? (event.data as Row | null) : undefined;
    if (!done || done.ok !== true || typeof done.tool !== 'string' || !SETTLING.has(done.tool)) continue;
    const row = done.data;
    if (!row || typeof row !== 'object' || Array.isArray(row) || (row as Row).settlement !== SIMULATED_SETTLEMENT) continue;
    const settled = row as Row, bill = done.tool === BANK_TOOLS.payBill.name;
    const from = resourceId(bill ? settled.account_id : settled.payer_id), amount = bill ? settled.payment_amount : settled.amount;
    if (!from || !validAmount(amount)) continue;
    if (bill) {
      const billId = resourceId(settled._id);
      if (billId) entries.push({ from, amount, billId });
    } else {
      const to = resourceId(settled.payee_id);
      if (to) entries.push({ from, to, amount });
    }
  }
  return entries;
}

export function withSimulatedSettlement(bank: Record<string, ToolAdapter>, { history = [] }: { history?: readonly TraceEvent[] } = {}): Record<string, ToolAdapter> {
  const ledger: Entry[] = replayed(history);
  let queue: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(job: () => Promise<T>): Promise<T> => {
    const turn = queue.then(job);
    queue = turn.catch(() => undefined);
    return turn;
  };
  const paid = (billId: unknown) => ledger.some((e) => e.billId === billId);
  const settle = (account: Row): Row => {
    const delta = ledger.reduce((d, e) => d - (e.from === account._id ? toCents(e.amount) : 0) + (e.to === account._id ? toCents(e.amount) : 0), 0);
    return delta && typeof account.balance === 'number' ? { ...account, balance: (toCents(account.balance) + delta) / 100 } : account;
  };
  const read = (spec: ToolSpec) => bank[spec.name]!;

  const accounts = async (input: Row = {}): Promise<ToolResult> => {
    const r = await read(BANK_TOOLS.getAccounts).run(input);
    if (!r.ok || !Array.isArray(r.data) || !ledger.length) return r;
    const rows = (r.data as Row[]).map(settle);
    const balances = new Map(rows.map((a) => [`nessie.accounts#${a._id}.balance`, a.balance]));
    return { ...r, data: rows, systemValues: r.systemValues.map((v) => (balances.has(v.source) ? { ...v, value: balances.get(v.source) as number } : v)) };
  };
  const bills = async (input: Row = {}): Promise<ToolResult> => {
    const r = await read(BANK_TOOLS.listBills).run(input);
    if (!r.ok || !Array.isArray(r.data)) return r;
    return { ...r, data: (r.data as Row[]).map((b) => (paid(b._id) ? { ...b, status: 'paid', nessie_status: 'pending', settlement: SIMULATED_SETTLEMENT } : b)) };
  };

  const money = (spec: ToolSpec, settleIt: (args: Row) => Promise<ToolResult>): ToolAdapter => ({
    spec,
    async run(input) {
      const required = (spec.inputSchema.required as string[] | undefined) ?? [];
      const props = spec.inputSchema.properties as Row;
      if (!input || typeof input !== 'object' || Array.isArray(input) || required.some((f) => !(f in input)) || Object.keys(input).some((f) => !(f in props))) return failure('Invalid tool arguments');
      const args = Object.freeze({ ...input });
      if (!validAmount(args.amount)) return failure('Invalid amount');
      if (!permitCovers(spec.name, args)) return failure('SkillGate execution context required for this exact action');
      return oneAtATime(() => settleIt(args));
    },
  });

  const transfer = (spec: ToolSpec) => money(spec, async (args) => {
    const from = resourceId(args.from_account), to = resourceId(args.to_account), amount = args.amount as number;
    if (!from || !to) return failure('Invalid resource id');
    const r = await accounts();
    if (!r.ok) return failure(r.error ?? 'Bank read failed; check connection and configuration');
    const own = r.data as Row[];
    const source = own.find((a) => a._id === from);
    if (!source || from === to) return failure('Invalid source account');
    const owned = own.some((a) => a._id === to);
    if (spec.name === BANK_TOOLS.moveOwn.name && !owned) return failure('Destination must be owned');
    for (const field of ['memo', 'payee_name']) if (args[field] !== undefined && (typeof args[field] !== 'string' || String(args[field]).length > 1000)) return failure('Invalid optional text');
    if (typeof source.balance !== 'number' || toCents(amount) > toCents(source.balance)) return failure('Insufficient balance');
    ledger.push({ from, to, amount });
    return splitResult('transfers', {
      _id: `steward-sim-${ledger.length}`, payer_id: from, payee_id: to, amount, medium: 'balance', status: 'completed',
      transaction_date: new Date().toISOString().slice(0, 10), description: args.memo ?? 'FinGuard authorized action', settlement: SIMULATED_SETTLEMENT,
    });
  });

  const payBill = money(BANK_TOOLS.payBill, async (args) => {
    const from = resourceId(args.from_account), billId = resourceId(args.bill_id), amount = args.amount as number;
    if (!from || !billId) return failure('Invalid resource id');
    const r = await accounts();
    if (!r.ok) return failure(r.error ?? 'Bank read failed; check connection and configuration');
    const source = (r.data as Row[]).find((a) => a._id === from);
    if (!source) return failure('Invalid source account');
    const list = await read(BANK_TOOLS.listBills).run({ account_id: from });
    if (!list.ok || !Array.isArray(list.data)) return failure(list.error ?? 'Bank read failed; check connection and configuration');
    const bill = (list.data as Row[]).find((b) => b._id === billId && b.status === 'pending' && !paid(b._id));
    if (!bill || bill.payment_amount !== amount) return failure('Bill or amount does not match pending bank record');
    if (typeof source.balance !== 'number' || toCents(amount) > toCents(source.balance)) return failure('Insufficient balance');
    ledger.push({ from, amount, billId });
    return splitResult('bills', { ...bill, status: 'completed', settlement: SIMULATED_SETTLEMENT });
  });

  return {
    ...bank,
    [BANK_TOOLS.getAccounts.name]: { spec: BANK_TOOLS.getAccounts, run: (input) => accounts(input as Row) },
    [BANK_TOOLS.listBills.name]: { spec: BANK_TOOLS.listBills, run: (input) => bills(input as Row) },
    [BANK_TOOLS.moveOwn.name]: transfer(BANK_TOOLS.moveOwn),
    [BANK_TOOLS.transfer.name]: transfer(BANK_TOOLS.transfer),
    [BANK_TOOLS.payBill.name]: payBill,
  };
}
