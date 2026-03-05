const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const currencyPreciseFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numberFormatter = new Intl.NumberFormat("en-US");

export function formatUSD(value: number): string {
  return currencyFormatter.format(value);
}

export function formatUSDPrecise(value: number): string {
  return currencyPreciseFormatter.format(value);
}

export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}
