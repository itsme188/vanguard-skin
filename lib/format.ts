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

/**
 * True when a formatted numeric string contains no significant digit — i.e.
 * the value rounded to zero at the rendered precision ("$0", "-$0.00",
 * "0.0%"). Used to drop the sign on tiny negatives AFTER rounding so no
 * surface ever renders a signed negative zero ("−$0").
 */
export function rendersAsZero(formatted: string): boolean {
  return !/[1-9]/.test(formatted);
}

export function formatUSD(value: number): string {
  const out = currencyFormatter.format(value);
  // Tiny negatives (e.g. -0.4) round to zero but keep their sign ("-$0").
  return rendersAsZero(out) ? currencyFormatter.format(0) : out;
}

/**
 * Parse a SQLite `datetime('now')` value into a Date at the correct instant.
 *
 * SQLite stores these as UTC, space-separated, with no timezone marker
 * (e.g. "2026-06-05 01:49:38"). A bare `new Date(thatString)` parses it as
 * LOCAL time, which rolls the displayed date past midnight in the evening —
 * an import done at 9:49 PM ET (01:49 UTC) renders as "tomorrow". This forces
 * UTC interpretation so callers can format in the viewer's local zone
 * correctly. Idempotent for values that already carry a T/Z/offset.
 */
export function parseStoredTimestamp(value: string): Date {
  const hasTz = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value);
  const iso = hasTz ? value : value.trim().replace(" ", "T") + "Z";
  return new Date(iso);
}

export function formatUSDPrecise(value: number): string {
  const out = currencyPreciseFormatter.format(value);
  return rendersAsZero(out) ? currencyPreciseFormatter.format(0) : out;
}

export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  const out = `${value.toFixed(digits)}%`;
  // (-0.04).toFixed(1) === "-0.0" — drop the sign once it rounds to zero.
  return rendersAsZero(out) ? `${(0).toFixed(digits)}%` : out;
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
  const abs = Math.abs(value);
  let body: string;
  if (abs >= 1_000_000_000) body = `$${(abs / 1_000_000_000).toFixed(2)}B`;
  else if (abs >= 1_000_000) body = `$${(abs / 1_000_000).toFixed(1)}M`;
  else if (abs >= 1_000) body = `$${numberFormatter.format(Math.round(abs))}`;
  // Sub-$1k: keep 2 decimals so EPS-scale values render naturally ($0.91)
  else body = `$${abs.toFixed(2)}`;
  // Sign applies only when the rounded output is nonzero — never "-$0.00".
  const sign = value < 0 && !rendersAsZero(body) ? "-" : "";
  return `${sign}${body}`;
}

// Same scaling as formatLargeUSD but without the "$" glyph. For unit counts
// (subscribers, contracts, etc.) and contexts that already supply currency.
export function formatLargeNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  let body: string;
  if (abs >= 1_000_000_000) body = `${(abs / 1_000_000_000).toFixed(2)}B`;
  else if (abs >= 1_000_000) body = `${(abs / 1_000_000).toFixed(1)}M`;
  else if (abs >= 1_000) body = numberFormatter.format(Math.round(abs));
  else body = abs.toFixed(2);
  const sign = value < 0 && !rendersAsZero(body) ? "-" : "";
  return `${sign}${body}`;
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
