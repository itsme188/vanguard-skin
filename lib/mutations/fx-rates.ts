import type Database from "better-sqlite3";

export interface FxRateInput {
  currency: string;
  usdPerUnit: number;
  asOf: string; // YYYY-MM-DD
  source: string;
}

/**
 * Upsert an FX rate. No-op for USD; rejects non-finite / non-positive rates.
 *
 * Source precedence: `ibkr_ledger` (the broker's own per-currency
 * exchangerate) is authoritative. Derived sources (`tws_derived` /
 * `ibkr_derived`) compute a rate from position mktValue÷notional, but that
 * field's currency-base is path-dependent — the Web API's mktValue is NATIVE
 * currency (live-verified 2026-07-03, derive yields a bogus ~1.0) and the TWS
 * base is unverified. A derived write therefore only replaces a ledger rate
 * once it has gone stale (>7 days old relative to the incoming asOf).
 */
export function upsertFxRate(db: Database.Database, r: FxRateInput): void {
  const currency = r.currency.toUpperCase();
  if (currency === "USD") return;
  if (!Number.isFinite(r.usdPerUnit) || r.usdPerUnit <= 0) {
    throw new Error(`Refusing to write implausible FX rate for ${currency}: ${r.usdPerUnit}`);
  }
  const info = db
    .prepare(
      `INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES (?, ?, ?, ?)
       ON CONFLICT(currency) DO UPDATE SET usd_per_unit = excluded.usd_per_unit,
         as_of = excluded.as_of, source = excluded.source
       WHERE excluded.source = 'ibkr_ledger'
          OR fx_rates.source != 'ibkr_ledger'
          OR fx_rates.as_of < date(excluded.as_of, '-7 days')`,
    )
    .run(currency, r.usdPerUnit, r.asOf, r.source);
  if (info.changes === 0) {
    console.log(
      `[fx-rates] Skipped ${r.source} write for ${currency} (${r.usdPerUnit}) — fresh ibkr_ledger rate takes precedence`,
    );
  }
}
