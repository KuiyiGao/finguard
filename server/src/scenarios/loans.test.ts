import assert from "node:assert/strict";
import { test } from "node:test";
import { LOANS, REFINANCE_OFFER } from "./data.ts";
import { balanceSchedule, compareRefinance, loanTotals, monthlyPayment, sample } from "./loans.ts";

const cents = (n: number) => Math.round(n * 100) / 100;
const auto = LOANS.find((l) => l.id === REFINANCE_OFFER.loanId)!;

test("the payment formula matches published reference values", () => {
  assert.equal(cents(monthlyPayment(200_000, 0.06, 360)), 1199.1);
  assert.equal(cents(monthlyPayment(10_000, 0.05, 36)), 299.71);
  assert.equal(monthlyPayment(1200, 0, 12), 100);
  assert.throws(() => monthlyPayment(-1, 0.05, 12));
  assert.throws(() => monthlyPayment(1000, 0.05, 0));
});

test("the auto loan payment pays the balance off exactly (independent bisection check)", () => {
  const { balance, apr, monthsLeft } = auto;
  const endBalance = (payment: number) => {
    let b = balance;
    for (let m = 0; m < monthsLeft; m++) b = b * (1 + apr / 12) - payment;
    return b;
  };
  let lo = 0;
  let hi = balance;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (endBalance(mid) > 0) lo = mid;
    else hi = mid;
  }
  assert.ok(Math.abs(monthlyPayment(balance, apr, monthsLeft) - lo) < 1e-6);
  const schedule = balanceSchedule(balance, apr, monthsLeft);
  assert.equal(schedule.length, monthsLeft + 1);
  assert.equal(schedule[0], balance);
  assert.equal(schedule.at(-1), 0);
  assert.ok(schedule.every((b, i) => i === 0 || b < schedule[i - 1]!), "the balance falls every month");
});

test("refinancing counts the fee: monthly saving, total saving and break-even month", () => {
  const c = compareRefinance(auto, REFINANCE_OFFER);
  assert.equal(c.currentPayment, cents(monthlyPayment(18_400, 0.099, 48)));
  assert.equal(c.newPayment, cents(monthlyPayment(18_400, 0.064, 48)));
  assert.equal(c.monthlySaving, cents(c.currentPayment - c.newPayment));
  assert.deepEqual([c.currentPayment, c.newPayment, c.monthlySaving], [465.79, 435.51, 30.28]);
  assert.equal(c.netSaving, cents(c.monthlySaving * 48 - REFINANCE_OFFER.fee));
  assert.equal(c.netSaving, 1303.44);
  assert.equal(c.currentInterest, cents(c.currentPayment * 48 - 18_400));
  assert.equal(c.breakEvenMonth, 5);
  assert.ok(4 * c.monthlySaving < REFINANCE_OFFER.fee && 5 * c.monthlySaving >= REFINANCE_OFFER.fee, "month 5 is the first to cover the fee");
  assert.equal(compareRefinance(auto, { ...REFINANCE_OFFER, fee: 5000 }).breakEvenMonth, null, "a fee the savings never cover");
  assert.equal(compareRefinance(auto, { ...REFINANCE_OFFER, fee: 0 }).breakEvenMonth, 0);
  assert.equal(compareRefinance(auto, { ...REFINANCE_OFFER, apr: 0.12 }).monthlySaving < 0, true, "a worse rate costs more");
});

test("curves keep at most 49 points, with the first and last", () => {
  const long = balanceSchedule(22_000, 0.055, 120);
  const s = sample(long);
  assert.equal(s.length, 49);
  assert.equal(s[0], long[0]);
  assert.equal(s.at(-1), long.at(-1));
  assert.deepEqual(sample([1, 2, 3]), [1, 2, 3]);
});

test("loan totals add up the simulated loans", () => {
  const t = loanTotals();
  assert.equal(t.balance, 40_400);
  assert.equal(t.monthlyPayments, cents(cents(monthlyPayment(18_400, 0.099, 48)) + cents(monthlyPayment(22_000, 0.055, 120))));
  assert.equal(t.refinanceMonthlySaving, 30.28);
});
