-- Speed up "latest snapshot on or before date" lookups (computeDailyValuations
-- hot loop) — the UNIQUE(account_id, security_id, as_of_date) autoindex cannot
-- serve account_id + as_of_date range/equality scans.
CREATE INDEX IF NOT EXISTS idx_holdings_account_asof ON holdings(account_id, as_of_date);
