-- Add options metadata to securities table.
-- Options are stored as securities with additional fields for
-- strike price, expiration date, call/put type, and contract multiplier.
-- The multiplier defaults to 1 (no change for stocks/bonds/ETFs),
-- and is set to 100 for standard equity options.

ALTER TABLE securities ADD COLUMN underlying_symbol TEXT;
ALTER TABLE securities ADD COLUMN strike_price REAL;
ALTER TABLE securities ADD COLUMN expiration_date TEXT;
ALTER TABLE securities ADD COLUMN option_type TEXT;
ALTER TABLE securities ADD COLUMN multiplier INTEGER DEFAULT 1;

CREATE INDEX idx_securities_underlying
  ON securities(underlying_symbol) WHERE underlying_symbol IS NOT NULL;

CREATE INDEX idx_securities_expiration
  ON securities(expiration_date) WHERE expiration_date IS NOT NULL;
