---
name: data-auditor
description: Audit Vanguard Skin database integrity — verify holdings consistency, check for orphaned records, validate tax lot computations, cross-reference import batches, detect stale prices, verify bond/option adjustments. Use when the user asks to "audit the DB", "check data health", "find orphans", "verify tax lots", or before a major data migration.
---

# Data Auditor

You audit the Vanguard Skin SQLite database (`data/vanguard.db`) for data integrity issues.

## What to check

### 1. Holdings consistency
- Latest holdings: `SELECT * FROM holdings WHERE as_of_date = (SELECT MAX(as_of_date) FROM holdings)`
- Every holding has a valid `security_id` (exists in `securities`)
- Every holding has a valid `account_id` (exists in `accounts`)
- No duplicate `source_key` values (should be unique per import)
- No negative quantities

### 2. Orphaned records
- Securities with no holdings, no transactions, and no prices (dead references)
- Holdings referencing non-existent securities or accounts
- Transactions referencing non-existent securities or accounts
- Tax lots referencing non-existent securities or accounts
- Prices for securities that no longer exist

### 3. Tax lot validation
- For each security with BUY/SELL transactions:
  - Total sold quantity ≤ total bought quantity
  - Tax lots cover all closed positions
  - Gain/loss = proceeds − cost_basis per lot
  - Term classification: short (< 1 year), long (≥ 1 year) based on `open_date` → `close_date`
- Compare computed tax lots against the `tax_lots` table

### 4. Price staleness
- Most recent price date per security
- Flag securities with prices older than 7 days (excluding bonds / money markets)
- Flag open holdings with NO prices at all
- Verify price values are reasonable (not 0, not negative, not NaN)

### 5. Import batch integrity
- Each `import_batches` record has valid `undo_sql`
- No overlapping imports (same filename imported twice)
- Records-per-batch matches `row_count`

### 6. Bond and option adjustments
- Bonds: market values stored at par (divide by 100 for display)
- Options: `multiplier` is set (typically 100); use `COALESCE(s.multiplier, 1)`
- Option symbols use OCC format (e.g., `INTC  260320P00045000`)

## How to report

Output a clear summary:
- Total records audited per table
- Issues found (with specific IDs and details)
- Per-account holdings count and value
- Price staleness overview
- Overall data health: **PASS** or **FAIL** with reasons

Prefer querying via the `db-query` skill (which has the schema gotchas baked in) or `sqlite3 data/vanguard.db`.
