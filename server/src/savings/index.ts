import type { SavingsEngine, SavingsReport, SavingsRecommendation, ToolAdapter, Retriever } from '../types.ts';
import { formatUsd } from '../util.ts';
import { money, futureValue } from './math.ts';
type Row = Record<string, unknown>;
const cents = (n: number) => Math.round(n * 100);
export type SavingsOptions = {
  now?: () => Date; reserve: number; apy: number; currentApy: number;
  unusedMerchantIds: string[];
  internetOffer?: { billId: string; monthlyPrice: number; label: string; mock: boolean };
  pastLateFeePurchaseIds: string[];
  subscriptionIds?: Record<string, string>;
  simulatedFacts?: boolean;
};
export class EvidenceSavingsEngine implements SavingsEngine {
  private bank: Record<string, ToolAdapter>;
  private rag: Retriever;
  private options: SavingsOptions;
  constructor(bank: Record<string, ToolAdapter>, rag: Retriever, options: SavingsOptions) {
    this.bank = bank; this.rag = rag; this.options = options;
    money(options.reserve); money(options.internetOffer?.monthlyPrice ?? 0);
    futureValue(0, options.apy); futureValue(0, options.currentApy);
  }
  private async rows(tool: string, args: Row = {}): Promise<Row[]> {
    const result = await this.bank[tool]!.run(args);
    if (!result.ok || !Array.isArray(result.data)) throw new Error(`Cannot generate a complete report: ${tool} failed`);
    return result.data as Row[];
  }
  async report(): Promise<SavingsReport> {
    const now = (this.options.now ?? (() => new Date()))();
    const accounts = await this.rows('bank.get_accounts');
    const checking = accounts.find(a => a.type === 'Checking'), savings = accounts.find(a => a.type === 'Savings');
    if (!checking) throw new Error('A checking account is required');
    const accountId = String(checking._id);
    const [bills, purchases] = await Promise.all([this.rows('bank.list_bills', { account_id: accountId }), this.rows('bank.list_purchases', { account_id: accountId })]);
    if (typeof checking.balance !== 'number') throw new Error('Invalid checking balance');
    money(checking.balance);
    for (const bill of bills) {
      if (typeof bill.payment_amount !== 'number' || typeof bill.payment_date !== 'string' || !Number.isFinite(new Date(bill.payment_date).getTime())) throw new Error('Invalid bill data');
      money(bill.payment_amount);
      if (new Date(bill.payment_date).toISOString().slice(0,10) !== bill.payment_date) throw new Error('Invalid bill date');
    }
    for (const row of purchases) {
      if (typeof row.amount !== 'number' || !Number.isFinite(row.amount) || row.amount < 0 || typeof row.purchase_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.purchase_date) || !Number.isFinite(new Date(row.purchase_date).getTime()) || new Date(row.purchase_date).toISOString().slice(0, 10) !== row.purchase_date) throw new Error('Invalid purchase data');
    }
    if (new Set(purchases.map(p => p._id)).size !== purchases.length) throw new Error('Duplicate purchase ids');
    const recommendations: SavingsRecommendation[] = [];
    const subscriptions = this.bank['subscriptions.list'] ? await this.rows('subscriptions.list') : [];
    async function cite(rag: Retriever, query: string, collection: 'savings' | 'plans') {
      const hits = await rag.search(query, { collection, k: 1 });
      if (!hits.length) throw new Error(`Missing knowledge evidence: ${query}`);
      return hits;
    }
    const simulated = this.options.simulatedFacts ? { simulated: true } : {};
    const recurringAssumption = `Conditional on taking the action and saving the amount every month. Constant ${(this.options.apy * 100).toFixed(2)}% effective APY; 60 end-of-month deposits; no taxes, fees or rate changes. Illustrative, not guaranteed.`;
    for (const merchantId of new Set(this.options.unusedMerchantIds)) {
      const subscriptionId = this.options.subscriptionIds?.[merchantId];
      const subscription = subscriptions.find(s => s.id === subscriptionId);
      if (subscription?.status === 'cancelled') continue;
      const charges = purchases.filter(p => p.merchant_id === merchantId && p.status === 'completed' && String(p.purchase_date) <= now.toISOString().slice(0, 10)).sort((a, b) => String(a.purchase_date).localeCompare(String(b.purchase_date)));
      const recent = charges.filter(p => new Date(String(p.purchase_date)).getTime() >= now.getTime() - 190 * 86400000);
      const months = [...new Set(recent.map(p => String(p.purchase_date).slice(0, 7)))];
      if (months.length < 3 || recent.length !== months.length || new Set(recent.map(p => p.amount)).size !== 1) continue;
      const monthIndices = months.map(m => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)));
      if (monthIndices.some((m, i) => i > 0 && m - monthIndices[i - 1]! !== 1)) continue;
      const charged = Number(recent.at(-1)!.amount);
      const price = subscription?.status === 'active' && typeof subscription.price === 'number' ? subscription.price : undefined;
      const plan = price !== undefined && Math.abs(cents(price) - cents(charged)) < 100 ? price : undefined;
      const monthly = plan ?? charged;
      recommendations.push({ id: `subscription-${merchantId}`, kind: 'subscription', title: `Review ${subscription?.merchant ?? merchantId}: you marked it unused`,
        monthlySavings: money(monthly), annualSavings: money(monthly * 12), fiveYearValue: futureValue(monthly, this.options.apy),
        assumptions: `Repeated charges are candidates, not proof of non-use. User confirmed ${merchantId} unused. ${recurringAssumption}`,
        evidence: recent.map(p => ({ label: `${p.purchase_date}: ${formatUsd(Number(p.amount))}`, source: `nessie.purchases#${p._id}` })),
        citations: await cite(this.rag, 'subscription audit cancel recurring charges', 'savings'), ...simulated,
        ...(subscription && plan !== undefined ? { action: { label: `Cancel ${subscription.merchant}`, tool: 'subscriptions.cancel', args: { subscription_id: subscription.id } } } : {}) });
    }
    const pending = bills.filter(b => b.status === 'pending');
    const upcoming = pending.filter(b => {
      const due = new Date(String(b.payment_date)).getTime();
      return Number.isFinite(due) && due <= now.getTime() + 30 * 86400000;
    });
    for (const bill of upcoming.filter(b => new Date(String(b.payment_date)).getTime() <= now.getTime() + 3 * 86400000)) {
      const pastFees = purchases.filter(p => this.options.pastLateFeePurchaseIds.includes(String(p._id)));
      const fee = pastFees.reduce((s, p) => s + Number(p.amount), 0);
      recommendations.push({ id: `late-${bill._id}`, kind: 'late_fee', title: `${bill.payee} due ${bill.payment_date}: possible ${formatUsd(money(fee))} fee to avoid`,
        monthlySavings: 0, annualSavings: 0, fiveYearValue: 0,
        assumptions: 'Historical fee is evidence of a past cost, not proof this bill has the same fee. One-off possible avoidance is excluded from recurring totals and projections.',
        evidence: [{ label: `Pending bill ${formatUsd(Number(bill.payment_amount))}`, source: `nessie.bills#${bill._id}` }, ...pastFees.map(p => ({ label: `Historical fee ${formatUsd(Number(p.amount))}`, source: `nessie.purchases#${p._id}` }))],
        citations: await cite(this.rag, 'late fees bill due payment reminder', 'savings'),
        action: { label: `Pay ${formatUsd(Number(bill.payment_amount))} to ${bill.payee}`, tool: 'bank.pay_bill', args: { from_account: accountId, bill_id: bill._id, amount: bill.payment_amount } } });
    }
    const offer = this.options.internetOffer;
    if (offer) {
      const bill = bills.find(b => b._id === offer.billId);
      if (bill && typeof bill.payment_amount === 'number' && bill.payment_amount > offer.monthlyPrice) {
        const monthly = money(bill.payment_amount - offer.monthlyPrice);
        recommendations.push({ id: 'internet-plan', kind: 'cheaper_plan', title: `Compare ${offer.label}${offer.mock ? ' (illustrative price)' : ''}`,
          monthlySavings: monthly, annualSavings: money(monthly * 12), fiveYearValue: futureValue(monthly, this.options.apy),
          assumptions: `Assumes equal service, no installation/cancellation fees and unchanged prices. Verify availability and contract before switching. ${recurringAssumption}`,
          evidence: [{ label: `Current ${formatUsd(bill.payment_amount)} a month vs configured ${formatUsd(offer.monthlyPrice)} a month offer`, source: `nessie.bills#${bill._id}; configured-offer:${offer.label}` }],
          citations: await cite(this.rag, 'internet cheaper plan compare monthly price', 'plans'), ...simulated });
      }
    }
    const obligations = upcoming.reduce((s, b) => s + Math.round(Number(b.payment_amount) * 100), 0) / 100;
    const idle = money(Math.max(0, Number(checking.balance) - this.options.reserve - obligations));
    if (idle > 0 && savings && this.options.apy > this.options.currentApy) {
      const rawAnnual = idle * (this.options.apy - this.options.currentApy);
      const annual = money(rawAnnual), monthly = money(rawAnnual / 12);
      recommendations.push({ id: 'idle-cash', kind: 'idle_cash', title: `Idle cash: ${formatUsd(idle)} is above your ${formatUsd(this.options.reserve)} reserve and ${formatUsd(obligations)} of bills due in 30 days`,
        monthlySavings: monthly, annualSavings: annual, fiveYearValue: futureValue(rawAnnual / 12, this.options.apy),
        assumptions: `${formatUsd(this.options.reserve)} reserve plus ${formatUsd(obligations)} of pending bills due within 30 days retained. Safe to move today holds back only your cash-flow buffer and the bills due soonest, so it can be larger than this amount. Annual incremental interest = principal × APY difference; monthly is annual/12 equivalent. Projection reinvests that equivalent monthly benefit, excludes principal and is not a bank balance forecast. ${recurringAssumption}`,
        evidence: [{ label: `Checking balance ${formatUsd(Number(checking.balance))}`, source: `nessie.accounts#${checking._id}` }, { label: `Reserve kept ${formatUsd(this.options.reserve)}`, source: 'configured-reserve' },
          ...upcoming.map(b => ({ label: `Reserved bill ${formatUsd(Number(b.payment_amount))}`, source: `nessie.bills#${b._id}` }))],
        citations: await cite(this.rag, 'idle cash savings yield reserve', 'savings'), ...simulated,
        action: { label: `Move ${formatUsd(idle)} to savings`, tool: 'bank.move_own', args: { from_account: accountId, to_account: savings._id, amount: idle } } });
    }
    return { generatedAt: now.toISOString(), recommendations,
      totalMonthly: money(recommendations.reduce((s, r) => s + Math.round(r.monthlySavings * 100), 0) / 100),
      disclaimers: ['Simulated household and offers. Rates are explicit scenario assumptions.',
        'Potential savings require action and user verification. Historical fees are not recurring savings.',
        'Recommendations do not execute money actions. Preview and confirm the exact action through SkillGate; outcome verification is separate.'] };
  }
}
