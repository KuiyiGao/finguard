import type { ToolAdapter, ToolCall, ToolResult } from '../types.ts';
import { canonicalJson, sha256 } from '../util.ts';
export type Row = Record<string, unknown>;
export type BankSnapshot = { accounts: Row[]; bills: Row[]; purchases: Row[]; observedAt: string; readResults: { tool: string; result: ToolResult }[] };
export type CashflowPreview = {
  action: Pick<ToolCall, 'tool' | 'args'>; actionHash: string; snapshotHash: string;
  generatedAt: string; expiresAt: string; horizon: string; observedAt: string;
  status: 'ready' | 'blocked' | 'needs_data'; reasons: string[];
  balanceBefore: number; balanceAfter: number; billsReserved: number; pendingReserved: number;
  buffer: number; availableToMove: number; shortfallAfter: number;
  obligations: { id: string; payee: string; amount: number; due: string; overdue: boolean }[];
  assumptions: string[];
};
export function toCents(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100)) || Math.abs(value * 100 - Math.round(value * 100)) > 1e-7) throw new Error('Expected a nonnegative USD amount at cent precision');
  return Math.round(value * 100);
}
export function validDay(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw new Error('Invalid calendar date');
  return value;
}
export async function readSnapshot(bank: Record<string, ToolAdapter>, observedAt: string): Promise<BankSnapshot> {
  const readResults: BankSnapshot['readResults'] = [];
  const read = async (tool: string) => {
    const result = await bank[tool]!.run({});
    if (!result.ok || !Array.isArray(result.data)) throw new Error('A complete bank snapshot is unavailable');
    readResults.push({ tool, result }); return result.data as Row[];
  };
  const accounts = await read('bank.get_accounts'), bills = await read('bank.list_bills'), purchases = await read('bank.list_purchases');
  return { accounts, bills, purchases, observedAt, readResults };
}
export function snapshotHash(snapshot: BankSnapshot): string {
  return sha256(canonicalJson({ accounts: snapshot.accounts, bills: snapshot.bills, purchases: snapshot.purchases, observedAt: snapshot.observedAt }));
}
export function previewAction(snapshot: BankSnapshot, action: Pick<ToolCall, 'tool' | 'args'>, options: { now: Date; horizon: string; buffer: number; maxAgeMs?: number }): CashflowPreview {
  const args = structuredClone(action.args), exact = { tool: action.tool, args };
  const horizon = validDay(options.horizon), today = options.now.toISOString().slice(0,10);
  if (horizon < today) throw new Error('Horizon cannot precede today');
  const source = snapshot.accounts.find(a => a._id === args.from_account);
  if (!source) throw new Error('Source account is not in bank records');
  const balance = toCents(source.balance), amount = toCents(args.amount), buffer = toCents(options.buffer);
  if (amount === 0) throw new Error('Action amount must be positive');
  if (!['bank.move_own','bank.transfer','bank.pay_bill'].includes(action.tool)) throw new Error('Unsupported money action');
  if (action.tool === 'bank.move_own' && !snapshot.accounts.some(a => a._id === args.to_account)) throw new Error('Destination must be an owned account');
  if (args.to_account === args.from_account) throw new Error('Accounts must differ');
  if (new Set(snapshot.bills.map(b => b._id)).size !== snapshot.bills.length || new Set(snapshot.purchases.map(p => p._id)).size !== snapshot.purchases.length) throw new Error('Duplicate bank records');
  const obligations = snapshot.bills.filter(b => b.account_id === args.from_account && b.status === 'pending')
    .map(b => ({ id: String(b._id), payee: String(b.payee), amount: toCents(b.payment_amount) / 100, due: validDay(b.payment_date), overdue: String(b.payment_date) < today }))
    .filter(b => b.due <= horizon).sort((a,b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id));
  const paying = action.tool === 'bank.pay_bill' ? obligations.find(b => b.id === args.bill_id) : undefined;
  if (action.tool === 'bank.pay_bill' && (!paying || toCents(paying.amount) !== amount)) throw new Error('Payment must match a pending bill within the preview horizon');
  const bills = obligations.filter(b => b.id !== paying?.id).reduce((s,b) => s + toCents(b.amount),0);
  const pending = snapshot.purchases.filter(p => p.payer_id === args.from_account && p.status === 'pending').reduce((s,p) => s + toCents(p.amount),0);
  const available = Math.max(0,balance-bills-pending-buffer), after = balance-amount;
  const shortfall = Math.max(0,bills+pending+buffer-after), reasons: string[] = [];
  const age = options.now.getTime()-Date.parse(snapshot.observedAt);
  const fresh = Number.isFinite(age) && age >= -1000 && age <= (options.maxAgeMs ?? 300000);
  if (!fresh) reasons.push('Bank data is stale or its observation time is unknown; refresh before authorizing');
  if (shortfall) reasons.push(`This action would leave a $${(shortfall/100).toFixed(2)} shortfall against recorded obligations and your buffer`);
  if (!reasons.length) reasons.push('Recorded obligations and your buffer remain covered under the stated assumptions');
  return { action: exact, actionHash: sha256(canonicalJson(exact)), snapshotHash: snapshotHash(snapshot),
    generatedAt: options.now.toISOString(), expiresAt: new Date(options.now.getTime()+120000).toISOString(), horizon, observedAt: snapshot.observedAt,
    status: !fresh ? 'needs_data' : shortfall ? 'blocked' : 'ready', reasons,
    balanceBefore: balance/100, balanceAfter: after/100, billsReserved: bills/100, pendingReserved: pending/100,
    buffer: buffer/100, availableToMove: available/100, shortfallAfter: shortfall/100, obligations,
    assumptions: ['USD; integer-cent cash-flow arithmetic', 'No future income is counted before it arrives',
      'Overdue pending bills remain reserved', 'Buffer covers unrecorded living costs; it is chosen by the user',
      'Pending purchases are conservatively reserved separately and may overlap with a bill',
      'Only recorded obligations are included; this is a conditional preview, not a guarantee',
      'This preview is not authorization; SkillGate applies the current policy separately'] };
}
