-- Migration 022: Clean up duplicate securities
--
-- Problem: Re-imports and multi-format imports created duplicate securities:
--   1. Bond/SPAC re-imports (4000+ IDs duplicating earlier records)
--   2. Vanguard-format options ("AFRM 270115 C 115.00") duplicating
--      OCC-format counterparts ("AFRM  270115C00115000")
--
-- Strategy: Move holdings from duplicates to originals, then delete duplicates.

-- ═══════════════════════════════════════════════════════════════════
-- Part 1: Bond & SPAC duplicates (hardcoded from investigation)
-- ═══════════════════════════════════════════════════════════════════

-- Move holdings from bond/SPAC duplicates to originals
UPDATE holdings SET security_id = 1927 WHERE security_id = 4253;
UPDATE holdings SET security_id = 1851 WHERE security_id = 4175;
UPDATE holdings SET security_id = 2076 WHERE security_id = 4220;
UPDATE holdings SET security_id = 2077 WHERE security_id = 4156;
UPDATE holdings SET security_id = 2078 WHERE security_id = 4229;
UPDATE holdings SET security_id = 1863 WHERE security_id = 4187;
UPDATE holdings SET security_id = 1869 WHERE security_id = 4193;

DELETE FROM securities WHERE id IN (4253, 4175, 4220, 4156, 4229, 4187, 4193);

-- ═══════════════════════════════════════════════════════════════════
-- Part 2: Vanguard-format options → OCC-format counterparts
-- ═══════════════════════════════════════════════════════════════════
-- Vanguard format: "AFRM 270115 C 115.00" (has a period in the symbol)
-- OCC format:      "AFRM  270115C00115000" (ends in 8+ digits, no period)
--
-- Match by underlying_symbol + expiration_date + strike_price + option_type.
-- Detect format by presence of '.' (Vanguard) vs pure alphanumeric+space (OCC).

-- Step 1: Move holdings from Vanguard-format → OCC-format
UPDATE holdings
SET security_id = (
  SELECT occ.id
  FROM securities v
  JOIN securities occ ON (
    occ.underlying_symbol = v.underlying_symbol
    AND occ.expiration_date = v.expiration_date
    AND occ.strike_price = v.strike_price
    AND occ.option_type = v.option_type
    AND occ.id != v.id
    AND occ.symbol NOT LIKE '%.%'
  )
  WHERE v.id = holdings.security_id
  LIMIT 1
)
WHERE security_id IN (
  SELECT v.id
  FROM securities v
  JOIN securities occ ON (
    occ.underlying_symbol = v.underlying_symbol
    AND occ.expiration_date = v.expiration_date
    AND occ.strike_price = v.strike_price
    AND occ.option_type = v.option_type
    AND occ.id != v.id
    AND occ.symbol NOT LIKE '%.%'
  )
  WHERE v.symbol LIKE '%.%'
    AND LOWER(v.security_type) IN ('option')
);

-- Step 2: Move prices from Vanguard-format → OCC-format (avoid orphaned FK refs)
-- Delete prices for Vanguard-format options that would conflict (same security+date)
-- then move the remaining ones.
DELETE FROM prices
WHERE security_id IN (
  SELECT v.id FROM securities v
  JOIN securities occ ON (
    occ.underlying_symbol = v.underlying_symbol
    AND occ.expiration_date = v.expiration_date
    AND occ.strike_price = v.strike_price
    AND occ.option_type = v.option_type
    AND occ.id != v.id AND occ.symbol NOT LIKE '%.%'
  ) WHERE v.symbol LIKE '%.%' AND LOWER(v.security_type) IN ('option')
);

-- Step 3: Delete orphaned Vanguard-format options (those with OCC counterparts)
-- Safety: only delete securities with zero remaining holdings
DELETE FROM securities
WHERE id IN (
  SELECT v.id
  FROM securities v
  JOIN securities occ ON (
    occ.underlying_symbol = v.underlying_symbol
    AND occ.expiration_date = v.expiration_date
    AND occ.strike_price = v.strike_price
    AND occ.option_type = v.option_type
    AND occ.id != v.id
    AND occ.symbol NOT LIKE '%.%'
  )
  WHERE v.symbol LIKE '%.%'
    AND LOWER(v.security_type) IN ('option')
    AND NOT EXISTS (SELECT 1 FROM holdings h WHERE h.security_id = v.id)
);

-- ═══════════════════════════════════════════════════════════════════
-- Part 3: Normalize security_type casing
-- ═══════════════════════════════════════════════════════════════════
UPDATE securities SET security_type = 'Option' WHERE security_type = 'option';
UPDATE securities SET security_type = 'Stock' WHERE security_type = 'stock';
UPDATE securities SET security_type = 'Bond' WHERE security_type = 'bond';
UPDATE securities SET security_type = 'ETF' WHERE security_type = 'etf';
