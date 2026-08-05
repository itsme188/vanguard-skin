import { parseOCCSymbol } from "@/lib/import/occ-symbol";

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

// Compact K/M/B money for allocation/coverage-style UI ("$48K of $1.9M").
// Sign is hoisted OUTSIDE the "$" ("-$14K", never "$-14K") and dropped when
// the rounded output is zero, mirroring formatLargeUSD. Differs from
// formatLargeUSD in the $1k–$1M band: that one comma-groups the full figure
// (scoreboard cells); this one abbreviates to K (dense analysis tables).
export function formatCompactUSD(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  let body: string;
  if (abs >= 1_000_000_000) body = `$${(abs / 1_000_000_000).toFixed(2)}B`;
  else if (abs >= 1_000_000) body = `$${(abs / 1_000_000).toFixed(1)}M`;
  else if (abs >= 1_000) body = `$${(abs / 1_000).toFixed(0)}K`;
  else body = `$${abs.toFixed(0)}`;
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

// Trade-review profit factor (gross wins ÷ gross losses).
// computeTradeRoundtrips clamps at 99.9 when a period has no gross losses —
// that's a sentinel for "no losing trades", not a measured ratio, so it
// renders as ∞ instead of "99.9x". Moved here from TradeReviewView 2026-07-28
// (number-rendering single source).
export function formatProfitFactor(profitFactor: number): string {
  return profitFactor >= 99.9 ? "∞" : `${profitFactor.toFixed(1)}x`;
}

// Compact display form for OCC option symbols in narrow UI columns:
// "KRE   270115C00070000" → "KRE $70C 1/15/27". Non-OCC symbols pass
// through unchanged. Raw OCC stays the canonical stored form everywhere —
// this is display-only (QA 2026-07-12: 21-char OCC symbols wrapped inside
// fixed-width scenario rows and collided with the adjacent β label).
export function formatCompactOptionSymbol(symbol: string): string {
  const parsed = parseOCCSymbol(symbol);
  if (!parsed) return symbol;
  const [y, m, d] = parsed.expirationDate.split("-");
  const strike = Number.isInteger(parsed.strike)
    ? String(parsed.strike)
    : parsed.strike.toFixed(2).replace(/\.?0+$/, "");
  return `${parsed.underlying} $${strike}${parsed.optionType === "CALL" ? "C" : "P"} ${Number(m)}/${Number(d)}/${y.slice(-2)}`;
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

/**
 * Unrealized gain as a fraction of the position's basis MAGNITUDE.
 * Short positions carry a negative cost basis (short proceeds) — dividing by
 * the signed basis flips the percent against its own dollar gain, so the
 * denominator is |costBasis| and the sign always follows the gain.
 * Returns null when either side is missing or the basis is zero.
 */
export function unrealizedGainRatio(
  gain: number | null | undefined,
  costBasis: number | null | undefined
): number | null {
  if (gain == null || costBasis == null || costBasis === 0) return null;
  return gain / Math.abs(costBasis);
}

/**
 * Percent coercer for expected-move fields: tolerates "6", "6%", "±6.0%",
 * "+/-6%". Absolute value (a move is directionless); zero/negative/garbage →
 * null. Distinct from parseLargeUSD — $-scale suffixes make no sense for a
 * percent. Single source (feedback #5): PDF/newsletter bogey extraction and
 * the BogeysEditModal manual input all parse through this.
 */
export function coercePercent(v: unknown): number | null {
  let n: number | null = null;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") {
    const cleaned = v.replace(/[±%\s]|\+\/-/g, "");
    if (cleaned !== "" && /^[-+]?\d*\.?\d+$/.test(cleaned)) n = Number(cleaned);
  }
  if (n == null || !Number.isFinite(n) || n === 0) return null;
  return Math.abs(n);
}
