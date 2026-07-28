-- 071: sector verification stamps (2026-07-28).
-- Provenance for securities.sector ('tws_bloomberg' | 'ai_classify' |
-- 'csv_import' | 'gics_verified') + the web-search-verified sweep timestamp.
-- Data Health flags sector<->fund_category disagreements ONLY where
-- sector_verified_at IS NULL, so verified-legit divergences (GOOG/META)
-- stay suppressed. Spec: docs/superpowers/specs/2026-07-28-sector-tag-verification-design.md
ALTER TABLE securities ADD COLUMN sector_source TEXT;
ALTER TABLE securities ADD COLUMN sector_verified_at TEXT;
