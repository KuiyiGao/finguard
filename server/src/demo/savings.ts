import type { SavingsRecommendation, SavingsReport } from "../types.ts";
import { nowIso } from "../util.ts";

const APY = 0.04;
const MONTHS = 60;

export function fiveYearValue(monthly: number, apy = APY, months = MONTHS): number {
  const r = apy / 12;
  return Math.round(monthly * ((Math.pow(1 + r, months) - 1) / r) * 100) / 100;
}

type Input = Omit<SavingsRecommendation, "annualSavings" | "fiveYearValue" | "assumptions">;

const INPUTS: Input[] = [
  {
    id: "rec-streamflix",
    kind: "subscription",
    title: "Cancel the Paramount+ trial before it renews: not watched once",
    monthlySavings: 15.49,
    evidence: [
      { label: "Trial renews in 2 days at $15.49/month", source: "stub.subscriptions#sub-streamflix" },
      { label: "No viewing activity since sign-up", source: "demo" },
    ],
    citations: [{ docId: "builtin:savings/subscription-audit", title: "Audit your subscriptions", excerpt: "List recurring charges and cancel the ones you no longer use.", score: 1 }],
    action: { label: "Cancel Paramount+", tool: "subscriptions.cancel", args: { subscription_id: "sub-streamflix" } },
  },
  {
    id: "rec-late-fee",
    kind: "late_fee",
    title: "Pay Duke Energy in the next 2 days to avoid a $25 late fee",
    monthlySavings: 4.17,
    evidence: [
      { label: "Duke Energy bill $84.20 due in 2 days", source: "stub.bills#bill-duke-oct" },
      { label: "Late fees in March and June", source: "demo" },
    ],
    citations: [{ docId: "builtin:savings/late-fees", title: "Avoid late fees", excerpt: "Paying a few days early or setting reminders avoids most late fees.", score: 1 }],
    action: { label: "Pay $84.20 now", tool: "bank.pay_bill", args: { bill_id: "bill-duke-oct", from_account: "acct-checking", amount: 84.2 } },
  },
  {
    id: "rec-idle-cash",
    kind: "idle_cash",
    title: "Move $500 of idle checking cash to savings",
    monthlySavings: 1.67,
    evidence: [{ label: "Checking has stayed above $3,500 for 90 days", source: "stub.accounts#acct-checking.balance" }],
    citations: [{ docId: "builtin:savings/high-yield-savings", title: "Put idle cash to work", excerpt: "Money you will not need soon can earn interest in savings.", score: 1 }],
    action: { label: "Move $500 to savings", tool: "bank.move_own", args: { from_account: "acct-checking", to_account: "acct-savings", amount: 500 } },
  },
  {
    id: "rec-internet",
    kind: "cheaper_plan",
    title: "Switch internet to a $45 plan with the same speed",
    monthlySavings: 25,
    evidence: [{ label: "Internet bill $70.00 each month", source: "demo" }],
    citations: [{ docId: "builtin:plans/internet", title: "Demo provider catalog: internet plans", excerpt: "Demo catalog entry: 300 Mbps for $45 a month.", score: 1 }],
  },
];

export function demoSavingsReport(): SavingsReport {
  const recommendations: SavingsRecommendation[] = INPUTS.map((r) => ({
    ...r,
    annualSavings: Math.round(r.monthlySavings * 12 * 100) / 100,
    fiveYearValue: fiveYearValue(r.monthlySavings),
    assumptions: `${(APY * 100).toFixed(1)}% APY, monthly compounding, saved every month for 5 years`,
  }));
  const totalMonthly = Math.round(recommendations.reduce((sum, r) => sum + r.monthlySavings, 0) * 100) / 100;
  return {
    generatedAt: nowIso(),
    recommendations,
    totalMonthly,
    disclaimers: ["Demo data until the savings engine is connected.", "Estimates, not financial advice."],
  };
}
