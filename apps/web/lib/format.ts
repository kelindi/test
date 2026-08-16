export function formatMoney(minor: bigint, currency: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(Number(minor) / 100);
}
