-- Migration 010: Thematic factor exposure table
-- Stores per-security factor classifications for portfolio risk analysis.
-- Factors are categorical (Low/Moderate/High/Very High) and cover macro themes
-- like tariff exposure, AI exposure, interest rate sensitivity, etc.
-- Options inherit factors from their underlying at query time (not stored here).

CREATE TABLE IF NOT EXISTS security_factors (
  security_id INTEGER PRIMARY KEY REFERENCES securities(id),
  interest_rate_sensitive TEXT,
  growth_vs_value TEXT,
  cyclical TEXT,
  international_exposure TEXT,
  geopolitical_onshoring TEXT,
  tariff_exposure TEXT,
  ai_exposure TEXT,
  crypto_adjacent TEXT,
  regulatory_risk TEXT,
  factor_source TEXT DEFAULT 'csv_import',
  updated_at TEXT DEFAULT (datetime('now'))
);
