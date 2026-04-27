---
name: db-query
description: "Query the Vanguard SQLite database with full schema context. Use for ad-hoc data exploration, debugging, and verification."
disable-model-invocation: true
---

# Database Query

Query `data/vanguard.db` using the sqlite MCP server (preferred) or `sqlite3 data/vanguard.db`.

## Schema Overview

### Core tables
- **accounts** — id, name, institution, account_type
- **securities** — id, symbol, name, security_type, asset_class, sector, industry, fund_category, multiplier, ib_con_id, classification_source
- **holdings** — id, account_id, security_id, quantity, cost_basis, market_value, as_of_date, source_key
- **transactions** — id, account_id, security_id, type (BUY/SELL/DIVIDEND/etc.), quantity, price, amount, date, source_key
- **prices** — security_id, date, close_price, source
- **tax_lots** — id, account_id, security_id, open_date, close_date, quantity, cost_basis, proceeds, gain_loss, term (short/long)

### Supporting tables
- **import_batches** — id, filename, imported_at, row_count, undo_sql
- **notes** — id, security_id, content, created_at
- **monthly_snapshots** — account_id, date, total_value, cash_value
- **daily_valuations** — account_id, date, total_value
- **schema_migrations** — version, applied_at

## Common Joins

- `holdings h JOIN securities s ON h.security_id = s.id`
- `transactions t JOIN securities s ON t.security_id = s.id`
- `prices p JOIN securities s ON p.security_id = s.id`
- `tax_lots tl JOIN securities s ON tl.security_id = s.id JOIN accounts a ON tl.account_id = a.id`

## Gotchas

- Bond market values: divide by 100 (par adjustment). Use `adjustedMarketValueSQL()` from `lib/valuation.ts`.
- Options: multiply by `COALESCE(s.multiplier, 1)`. SQLite DEFAULT is bypassed by explicit INSERT NULL.
- Transaction types are UPPERCASE: BUY, SELL, DIVIDEND, REINVESTMENT, TAX_WITHHELD, BUY_TO_OPEN, SELL_TO_CLOSE.
- Latest holdings: `WHERE as_of_date = (SELECT MAX(as_of_date) FROM holdings)`.
- Monthly snapshots use last-day-of-month dates.
