-- 094: accounts.tax_treatment — which accounts are taxable.
--
-- A sale inside a retirement account (Roth IRA, traditional IRA, any other
-- tax-advantaged wrapper) is not a taxable event and is never reported on
-- Form 8949, but the tax report and its CSV/TXF exports had no way to tell
-- one account from another: `accounts` was (id, name) only, so every sale in
-- the book landed in the "TAXABLE ST/LT" totals (QA finding
-- tax-lots--form-8949-export-and-taxable-totals-include-roth-ira-sales).
--
-- The treatment is a real column, never a name heuristic ("Admiral" contains
-- "ira"; a Roth can be named anything). Vocabulary is single-sourced in
-- lib/compute/tax-treatment.ts and pinned here by the CHECK constraint so a
-- hand-edit through sqlite3 cannot invent a fifth value.
--
-- Additive and deliberately data-free: every existing account defaults to
-- 'taxable', which preserves today's behaviour exactly. Stamping the actual
-- retirement account is a separate, user-run step:
--   npx tsx scripts/repair-account-tax-treatment.ts --account "<name>" --treatment roth_ira --apply
-- Until that runs, the tax report says so in its NOT-FOR-FILING banner.

ALTER TABLE accounts ADD COLUMN tax_treatment TEXT NOT NULL DEFAULT 'taxable'
  CHECK (tax_treatment IN ('taxable', 'roth_ira', 'traditional_ira', 'other_tax_advantaged'));
