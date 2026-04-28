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

export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function formatShares(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return "—";
  if (digits === 0) return numberFormatter.format(Math.round(value));
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// Compact rendering of large USD figures: "$4.34B", "$245M", "$945",
// "$0.91" for EPS-scale values. Negatives keep their sign. Used in earnings
// scoreboard cells, AI prompts, and any UI that shows revenue / market-cap.
export function formatLargeUSD(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${numberFormatter.format(Math.round(abs))}`;
  // Sub-$1k: keep 2 decimals so EPS-scale values render naturally ($0.91)
  return `${sign}$${abs.toFixed(2)}`;
}

// Same scaling as formatLargeUSD but without the "$" glyph. For unit counts
// (subscribers, contracts, etc.) and contexts that already supply currency.
export function formatLargeNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${numberFormatter.format(Math.round(abs))}`;
  return `${sign}${abs.toFixed(2)}`;
}

// Parse a user-entered or AI-extracted large-USD string into a number.
// Accepts "$4.34B", "4.34B", "4,340M", "4340000000", "4,340,000,000",
// "$0.91". Returns null on unparseable input. Suffix is case-insensitive.
export function parseLargeUSD(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = /^(-?)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*([bmk])?\s*$/i.exec(trimmed);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const numeric = Number(match[2].replace(/,/g, ""));
  if (!Number.isFinite(numeric)) return null;
  const suffix = match[3]?.toLowerCase();
  const multiplier = suffix === "b" ? 1_000_000_000 : suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  return sign * numeric * multiplier;
}
