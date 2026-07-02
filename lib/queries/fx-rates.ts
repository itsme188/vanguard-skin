import type Database from "better-sqlite3";

/**
 * USD per 1 unit of `currency`. 'USD' (or nullish) → 1. Unknown currency or a
 * DB without the fx_rates table → 1 (fail-safe: leave the native value
 * unconverted rather than fabricate a rate — never guess FX).
 */
export function getUsdPerUnit(db: Database.Database, currency: string | null | undefined): number {
  if (!currency || currency.toUpperCase() === "USD") return 1;
  let row: { usd_per_unit: number } | undefined;
  try {
    row = db
      .prepare("SELECT usd_per_unit FROM fx_rates WHERE currency = ?")
      .get(currency.toUpperCase()) as { usd_per_unit: number } | undefined;
  } catch {
    return 1;
  }
  if (!row || !Number.isFinite(row.usd_per_unit) || row.usd_per_unit <= 0) return 1;
  return row.usd_per_unit;
}
