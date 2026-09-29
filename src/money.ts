// Plain-text amounts for notifications, for example 120000 PKR -> "Rs 1,200". Minor units as stored.
const DIGITS: Record<string, number> = { BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3, JPY: 0, KRW: 0 };
const SYMBOL: Record<string, string> = { PKR: 'Rs' };

export function money(minor: number, currency: string) {
  const digits = DIGITS[currency] ?? 2;
  const amount = minor / 10 ** digits;
  const text = amount.toLocaleString('en-GB', {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : digits,
    maximumFractionDigits: digits,
  });
  return `${SYMBOL[currency] ?? currency} ${text}`;
}
