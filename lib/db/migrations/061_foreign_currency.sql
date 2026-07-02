-- Foreign-currency valuation: per-security currency + FX rates.
-- Fixes the 402340.KS KRW-as-USD phantom. USD securities default to 'USD'
-- (rate 1.0, never stored) so all existing holdings are unaffected.

ALTER TABLE securities ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';

CREATE TABLE IF NOT EXISTS fx_rates (
  currency     TEXT PRIMARY KEY,   -- ISO code, e.g. 'KRW'
  usd_per_unit REAL NOT NULL,      -- 1 unit of `currency` = this many USD
  as_of        TEXT NOT NULL,      -- YYYY-MM-DD
  source       TEXT                -- 'ibkr_derived' | 'tws_derived' | 'ibkr_ledger'
);
