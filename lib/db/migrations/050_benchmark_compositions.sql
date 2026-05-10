-- Benchmark sector compositions — hand-curated, approximate sector weights
-- for the four scope-aware default benchmarks (VTI/QQQ/SPY/DIA). Sourced
-- from publisher fact sheets dated approximately 2026-04-30; refresh via
-- scripts/seed-benchmark-compositions.ts when fact sheets update.
--
-- Used by Cash-Deploy (lib/compute/cash-deploy.ts) to compute sector gaps:
-- (current scope weight) - (benchmark weight) = gap. Positive gap = scope
-- overweight that sector; negative gap = scope underweight (deploy target).
--
-- market_cap_bucket is reserved for future market-cap-stratified targets
-- (e.g., Large Cap Tech vs Small Cap Tech). v1 leaves it as empty string.
--
-- Weights are decimals summing to ~1.0 per benchmark; small rounding gaps
-- are acceptable since the solver works on gap magnitude not absolutes.

CREATE TABLE IF NOT EXISTS benchmark_compositions (
  benchmark_symbol TEXT NOT NULL,
  sector TEXT NOT NULL,
  weight REAL NOT NULL,
  market_cap_bucket TEXT NOT NULL DEFAULT '',
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (benchmark_symbol, sector, market_cap_bucket)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_compositions_symbol
  ON benchmark_compositions(benchmark_symbol);

-- VTI (Vanguard Total Stock Market) — broad-market, similar to SPY but with
-- mid+small cap tilt. Approximate weights from Vanguard fact sheet.
INSERT OR REPLACE INTO benchmark_compositions (benchmark_symbol, sector, weight, market_cap_bucket, refreshed_at) VALUES
  ('VTI', 'Technology',              0.310, '', '2026-04-30'),
  ('VTI', 'Financials',              0.130, '', '2026-04-30'),
  ('VTI', 'Healthcare',              0.115, '', '2026-04-30'),
  ('VTI', 'Consumer Discretionary',  0.105, '', '2026-04-30'),
  ('VTI', 'Communication Services',  0.080, '', '2026-04-30'),
  ('VTI', 'Industrials',             0.090, '', '2026-04-30'),
  ('VTI', 'Consumer Staples',        0.055, '', '2026-04-30'),
  ('VTI', 'Energy',                  0.035, '', '2026-04-30'),
  ('VTI', 'Real Estate',             0.030, '', '2026-04-30'),
  ('VTI', 'Utilities',               0.025, '', '2026-04-30'),
  ('VTI', 'Materials',               0.025, '', '2026-04-30');

-- QQQ (Invesco Nasdaq 100) — concentrated in Tech + Comm Services, NO
-- Financials, NO Real Estate, NO Energy (by index rule).
INSERT OR REPLACE INTO benchmark_compositions (benchmark_symbol, sector, weight, market_cap_bucket, refreshed_at) VALUES
  ('QQQ', 'Technology',              0.560, '', '2026-04-30'),
  ('QQQ', 'Communication Services',  0.155, '', '2026-04-30'),
  ('QQQ', 'Consumer Discretionary',  0.135, '', '2026-04-30'),
  ('QQQ', 'Healthcare',              0.060, '', '2026-04-30'),
  ('QQQ', 'Consumer Staples',        0.045, '', '2026-04-30'),
  ('QQQ', 'Industrials',             0.035, '', '2026-04-30'),
  ('QQQ', 'Utilities',               0.010, '', '2026-04-30');

-- SPY (S&P 500) — large-cap balanced, the most reference-able benchmark.
INSERT OR REPLACE INTO benchmark_compositions (benchmark_symbol, sector, weight, market_cap_bucket, refreshed_at) VALUES
  ('SPY', 'Technology',              0.305, '', '2026-04-30'),
  ('SPY', 'Financials',              0.135, '', '2026-04-30'),
  ('SPY', 'Healthcare',              0.115, '', '2026-04-30'),
  ('SPY', 'Consumer Discretionary',  0.105, '', '2026-04-30'),
  ('SPY', 'Communication Services',  0.090, '', '2026-04-30'),
  ('SPY', 'Industrials',             0.085, '', '2026-04-30'),
  ('SPY', 'Consumer Staples',        0.060, '', '2026-04-30'),
  ('SPY', 'Energy',                  0.035, '', '2026-04-30'),
  ('SPY', 'Utilities',               0.025, '', '2026-04-30'),
  ('SPY', 'Real Estate',             0.025, '', '2026-04-30'),
  ('SPY', 'Materials',               0.020, '', '2026-04-30');

-- DIA (Dow Jones Industrial Average) — price-weighted 30-name basket,
-- heavier in Industrials and Financials, lighter in Tech vs SPY.
INSERT OR REPLACE INTO benchmark_compositions (benchmark_symbol, sector, weight, market_cap_bucket, refreshed_at) VALUES
  ('DIA', 'Financials',              0.215, '', '2026-04-30'),
  ('DIA', 'Healthcare',              0.165, '', '2026-04-30'),
  ('DIA', 'Industrials',             0.150, '', '2026-04-30'),
  ('DIA', 'Technology',              0.165, '', '2026-04-30'),
  ('DIA', 'Consumer Discretionary',  0.115, '', '2026-04-30'),
  ('DIA', 'Consumer Staples',        0.060, '', '2026-04-30'),
  ('DIA', 'Communication Services',  0.040, '', '2026-04-30'),
  ('DIA', 'Energy',                  0.030, '', '2026-04-30'),
  ('DIA', 'Materials',               0.025, '', '2026-04-30'),
  ('DIA', 'Utilities',               0.020, '', '2026-04-30'),
  ('DIA', 'Real Estate',             0.015, '', '2026-04-30');
