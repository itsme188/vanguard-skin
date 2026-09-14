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
 * exchangerate, written by lib/ibkr/refresh.ts) is the authoritative
 * automated source; `manual` is the human-repair source
 * (scripts/repair-fx-rate.ts). The TWS sync no longer derives or writes a
 * rate at all (removed 2026-09-14): `Position.marketValue` there was
 * verified NATIVE currency, not USD-base, so deriving from it produced a
 * bogus ~1.0 for a JPY position and there was no ledger rate yet to fall
 * back on. A `*_derived` source is kept in the type only for legacy rows a
 * reader may still see (lib/queries/data-health.ts::DERIVED_FX_SOURCES) —
 * nothing writes one anymore, and the guard below refuses to write one that
 * looks like the native-currency bug even if something does.
 */
export function upsertFxRate(db: Database.Database, r: FxRateInput): void {
  const currency = r.currency.toUpperCase();
  if (currency === "USD") return;
  if (!Number.isFinite(r.usdPerUnit) || r.usdPerUnit <= 0) {
    throw new Error(`Refusing to write implausible FX rate for ${currency}: ${r.usdPerUnit}`);
  }
  // Defense in depth (2026-09-14): a *_derived source landing within 1% of
  // 1.0 for a non-USD currency is the native-currency-mistaken-for-USD-base
  // bug class that produced the JPY=1.0 corruption. Skip rather than throw —
  // this runs inside a sync, and a thrown error there would abort the whole
  // positions loop over one bad FX signal.
  // Epsilon above the 1% band absorbs float noise (e.g. 1 - 0.99 evaluates to
  // 0.010000000000000009 in IEEE 754, not exactly 0.01) so a rate exactly at
  // the boundary is still caught.
  if (r.source.endsWith("_derived") && Math.abs(r.usdPerUnit - 1) < 0.01 + 1e-9) {
    console.warn(
      `[fx-rates] Skipped ${r.source} write for ${currency} (${r.usdPerUnit}) — within 1% of 1.0 for a non-USD currency, looks like a native-currency-as-USD-base derive bug`,
    );
    return;
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
