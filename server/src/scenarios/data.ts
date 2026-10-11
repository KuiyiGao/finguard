
export const SIMULATED_NOTE = "Simulated demo household: not a real account, offer or message.";

export interface SimHolding {
  id: string;
  name: string;
  value: number;
  expenseRatio: number;
}

export interface SimInvestmentAccount {
  id: string;
  name: string;
  holdings: SimHolding[];
}

export const INVESTMENT_ACCOUNTS: SimInvestmentAccount[] = [
  {
    id: "brokerage",
    name: "Brokerage account (simulated)",
    holdings: [{ id: "active-large-cap", name: "Active Large-Cap Fund (simulated)", value: 12480, expenseRatio: 0.0062 }],
  },
  {
    id: "retirement",
    name: "Retirement account (simulated)",
    holdings: [
      { id: "target-date-2055", name: "Target Date 2055 Index (simulated)", value: 18900, expenseRatio: 0.0008 },
      { id: "stable-value", name: "Stable Value Fund (simulated)", value: 2600, expenseRatio: 0.0035 },
    ],
  },
];

export const INDEX_FUND = { id: "total-market-index", name: "Total Market Index (simulated)", expenseRatio: 0.0004 };

export const FEE_DRAG = { holdingId: "active-large-cap", years: 20, grossReturn: 0.06 };

export const INVESTMENT_PITCH = {
  id: "sim-investment-pitch",
  claimedDailyReturn: 0.02,
  get text(): string {
    return `Hi, this is Mia from Apex Crypto Club. Our AI trading desk pays guaranteed ${Math.round(this.claimedDailyReturn * 10000) / 100}% daily returns. Only 3 spots left, act within 24 hours: send USDT to the wallet below to lock in your place.`;
  },
};

export interface SimLoan {
  id: string;
  name: string;
  balance: number;
  apr: number;
  monthsLeft: number;
}

export const LOANS: SimLoan[] = [
  { id: "auto", name: "Auto loan (simulated)", balance: 18400, apr: 0.099, monthsLeft: 48 },
  { id: "student", name: "Student loan (simulated)", balance: 22000, apr: 0.055, monthsLeft: 120 },
];

export const REFINANCE_OFFER = { id: "auto-refi", loanId: "auto", lender: "Example Credit Union (simulated)", apr: 0.064, months: 48, fee: 150 };

export const LOAN_RELIEF_MESSAGE = {
  id: "sim-loan-relief",
  fee: 499,
  get text(): string {
    return `Student Loan Forgiveness Center: good news, you qualify to have your federal student loans forgiven. Pay the $${this.fee} processing fee today to enroll. Do not call your loan servicer, they will only slow this down.`;
  },
};

export const CONTRACT = {
  id: "doc:cloudgym-membership",
  merchant: "CloudGym",
  subscriptionId: "sub-gym",
  monthlyDues: 29.99,
  termMonths: 12,
  annualFee: 49,
  earlyTerminationFee: 199,
  noticeDays: 30,
  priceNoticeDays: 30,
  daysUntilNextCharge: 12,
};

export function contractText(c = CONTRACT): string {
  return [
    `${c.merchant} Membership Agreement (simulated sample)`,
    "",
    `1. Term. Your membership begins on the day you sign and lasts ${c.termMonths} months. This agreement renews automatically for additional ${c.termMonths}-month terms unless you cancel as described below.`,
    "",
    `2. Dues and fees. Monthly dues of $${c.monthlyDues.toFixed(2)} are charged to your card on file. An annual maintenance fee of $${c.annualFee} is charged at the start of each term.`,
    "",
    `3. Ending early. If you end your membership before the current term is over, an early termination fee of $${c.earlyTerminationFee} applies.`,
    "",
    `4. Cancellation. To cancel, you must send written notice by certified mail to ${c.merchant} Member Services at least ${c.noticeDays} days before your renewal date. Requests by phone, email or at the front desk will not be accepted.`,
    "",
    `5. Changes. ${c.merchant} may change your monthly dues or any fee with ${c.priceNoticeDays} days notice.`,
    "",
    "6. Disputes. Any dispute will be resolved by binding arbitration on an individual basis, and you give up the right to a jury trial or class action.",
    "",
    "7. Guest passes. Members may bring one guest per month at no charge when the guest signs a waiver at the front desk.",
  ].join("\n");
}
