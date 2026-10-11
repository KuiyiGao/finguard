export function money(value: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error('Amount must be finite and nonnegative');
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
export function monthlyRate(apy: number) {
  if (!Number.isFinite(apy) || apy < 0 || apy > 1) throw new Error('APY must be a decimal from 0 to 1');
  return Math.expm1(Math.log1p(apy) / 12);
}
export function futureValue(monthly: number, apy: number, months = 60) {
  if (!Number.isFinite(monthly) || monthly < 0 || !Number.isInteger(months) || months < 0 || months > 1200) throw new Error('Invalid projection inputs');
  const r = monthlyRate(apy);
  const value = r === 0 ? monthly * months : monthly * Math.expm1(months * Math.log1p(r)) / r;
  if (!Number.isFinite(value)) throw new Error('Projection overflow');
  return money(value);
}
