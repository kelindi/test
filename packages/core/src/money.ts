/**
 * Money uses bigint minor units so arithmetic cannot introduce binary-float
 * rounding errors.
 */
export type Money = {
  minor: bigint;
  currency: string;
};

export function money(minor: bigint | number, currency: string): Money {
  return { minor: BigInt(minor), currency };
}

export function parseMoney(value: string, currency: string): Money {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new Error('Money must contain at most two decimal places');
  }

  const [whole, fraction = ''] = value.split('.');
  return money(
    BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0'),
    currency,
  );
}

export function formatMoney(value: Money): string {
  return `${value.currency} ${(Number(value.minor) / 100).toFixed(2)}`;
}

export function addMoney(left: Money, right: Money): Money {
  if (left.currency !== right.currency) throw new Error('Currency mismatch');
  return money(left.minor + right.minor, left.currency);
}
