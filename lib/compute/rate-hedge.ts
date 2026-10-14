/**
 * Interest-rate hedge funds in rate scenarios (owner ruling 2026-10-12,
 * option 1).
 *
 * A fund built to GAIN when long rates rise carries a "High" rate-sensitivity
 * bucket, so the rate preset used to bucket it as a casualty of the very
 * shock it hedges. Its move is not a linear rate leg (it is usually an option
 * or swap overlay), so neither the loss nor a sign-inverted figure is right.
 * In any scenario that moves rates it takes no figure and is named and
 * counted instead. Under a scenario with no rate component it is treated like
 * any other fund.
 *
 * `isInterestRateHedgeFund` is the ONE reader of the category/name rule.
 * Import-free on purpose (pure helpers, shared by both scenario engines).
 */

/** The fund family: the same lowercased-type idiom the bond-duration rule uses. */
function isFundFamilyType(securityType: string | null | undefined): boolean {
  const type = (securityType ?? "").trim().toLowerCase();
  return type === "etf" || type === "mutual fund" || type === "mutual_fund";
}

const RATE_HEDGE_CATEGORY = "interest rate hedge";
/** The whole phrase "rate hedge": "Rate Hedged" and "Exchange Rate Hedged" do not match. */
const RATE_HEDGE_NAME = /\brate\s+hedge\b/i;

/**
 * True for an ETF or mutual fund whose fund category is "Interest Rate Hedge"
 * (case-insensitive) or whose name carries the whole phrase "rate hedge".
 * A non-fund (a stock, a bond, an option) never matches.
 */
export function isInterestRateHedgeFund(sec: {
  security_type: string | null;
  fund_category: string | null;
  name: string | null;
}): boolean {
  if (!isFundFamilyType(sec.security_type)) return false;
  if ((sec.fund_category ?? "").trim().toLowerCase() === RATE_HEDGE_CATEGORY) return true;
  return RATE_HEDGE_NAME.test(sec.name ?? "");
}

/**
 * Whether a scenario moves rates: a nonzero finite `rateMove` (basis points),
 * or a preset whose primary factor is rate sensitivity.
 */
export function scenarioMovesRates(scenario: { rateMove?: number | null; primaryFactor?: string | null }): boolean {
  const { rateMove, primaryFactor } = scenario;
  if (typeof rateMove === "number" && Number.isFinite(rateMove) && rateMove !== 0) return true;
  return primaryFactor === "interest_rate_sensitive";
}

/**
 * The disclosure on a scenario result: how many rate hedge funds were left
 * out, their share of the book's gross value, and their symbols (sorted).
 * Reporting only; no figure reads it.
 */
export function summarizeUnmodelledRateHedges(
  rows: Array<{ symbol: string; currentValue: number; rateHedgeUnmodelled?: boolean }>,
): { count: number; valueShare: number; symbols: string[] } {
  let total = 0;
  let hedged = 0;
  const symbols: string[] = [];
  for (const row of rows) {
    const value = Math.abs(row.currentValue);
    total += value;
    if (row.rateHedgeUnmodelled) {
      hedged += value;
      symbols.push(row.symbol);
    }
  }
  symbols.sort();
  return { count: symbols.length, valueShare: total > 0 ? hedged / total : 0, symbols };
}
