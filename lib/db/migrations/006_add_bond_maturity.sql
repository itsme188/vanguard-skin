-- Add maturity_date to securities for bonds and other dated instruments.
-- Enables filtering out matured positions from holdings queries.

ALTER TABLE securities ADD COLUMN maturity_date TEXT;

-- Backfill from 2-digit year bond names: "T-Bill (due 10/23/25)"
-- Extracts MM/DD/YY → YYYY-MM-DD
UPDATE securities
SET maturity_date =
  '20' || SUBSTR(name, INSTR(name, '(due ') + 11, 2) || '-' ||
  SUBSTR(name, INSTR(name, '(due ') + 5, 2) || '-' ||
  SUBSTR(name, INSTR(name, '(due ') + 8, 2)
WHERE security_type = 'bond'
  AND name LIKE '%(due __/__/__)%'
  AND maturity_date IS NULL;

-- Backfill from 4-digit year bond names: "T-Note 4.375% (due 05/15/2034)"
-- Extracts MM/DD/YYYY → YYYY-MM-DD
UPDATE securities
SET maturity_date =
  SUBSTR(name, INSTR(name, '(due ') + 11, 4) || '-' ||
  SUBSTR(name, INSTR(name, '(due ') + 5, 2) || '-' ||
  SUBSTR(name, INSTR(name, '(due ') + 8, 2)
WHERE security_type = 'bond'
  AND name LIKE '%(due __/__/____)%'
  AND maturity_date IS NULL;

CREATE INDEX idx_securities_maturity
  ON securities(maturity_date) WHERE maturity_date IS NOT NULL;
