-- Adds the residual standard deviation (idiosyncratic daily volatility) of each
-- security's beta regression vs SPY. Stored in PERCENT units (decimal std x 100)
-- so the anomaly engine can compare it directly against simple-percent daily moves.
--
-- This is the standard deviation of the regression residuals — the part of a
-- daily move NOT explained by beta x SPY — and is the basis for the z-score
-- "out-of-the-ordinary" test in lib/digest/anomalies.ts. Nullable so existing
-- rows survive until the next nightly refresh-vanguard-betas run backfills them.

ALTER TABLE security_betas ADD COLUMN residual_std REAL;
