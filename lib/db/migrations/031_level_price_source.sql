-- Migration 031: price_source column on security_levels.
-- Enables "moving-average-based" levels where the effective price is computed
-- from ohlcv_bars rather than stored statically. The `price` column becomes a
-- reference value (the MA price at creation time) used as a fallback when
-- insufficient bars exist for live computation.

ALTER TABLE security_levels ADD COLUMN price_source TEXT NOT NULL DEFAULT 'static';

-- price_source values:
--   'static'    — use the `price` column as-is (the current behavior)
--   'sma_9'     — 9-day simple moving average
--   'sma_21'    — 21-day simple moving average
--   'sma_50'    — 50-day simple moving average
--   'sma_200'   — 200-day simple moving average
--   'ema_9'     — 9-day exponential moving average
--   'ema_21'    — 21-day exponential moving average
