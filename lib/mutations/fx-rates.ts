import type Database from "better-sqlite3";

export interface FxRateInput {
  currency: string;
  usdPerUnit: number;
  asOf: string; // YYYY-MM-DD
  source: string;
}

/** Upsert an FX rate. No-op for USD; rejects non-finite / non-positive rates. */
export function upsertFxRate(db: Database.Database, r: FxRateInput): void {
  const currency = r.currency.toUpperCase();
  if (currency === "USD") return;
  if (!Number.isFinite(r.usdPerUnit) || r.usdPerUnit <= 0) {
    throw new Error(`Refusing to write implausible FX rate for ${currency}: ${r.usdPerUnit}`);
  }
  db.prepare(
    `INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES (?, ?, ?, ?)
     ON CONFLICT(currency) DO UPDATE SET usd_per_unit = excluded.usd_per_unit,
       as_of = excluded.as_of, source = excluded.source`,
  ).run(currency, r.usdPerUnit, r.asOf, r.source);
}
