# Vanguard Skin v2 — Rebuild Design

**Date:** 2026-03-04
**Status:** Approved

## Context

The original Next.js portfolio dashboard was lost due to a git worktree cleanup failure during an Electron packaging session. All source code is gone; financial data (PDFs, CSVs) survives on disk. Session transcripts preserve the full architecture and file contents of v1.

This is a ground-up rebuild that preserves v1's functionality while fixing its architectural weaknesses.

## Goals

1. **Reliability** — Rock-solid data handling. Idempotent imports. No data corruption.
2. **Usability** — No terminal needed. Clean tab-based UI. Drag-and-drop import.
3. **Completeness** — Full coverage of Vanguard + IBKR accounts, all import types, tax lots, AI chat.
4. **Maintainability** — Clean architecture, proper migrations, tests, GitHub from day 1.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16, React 19, TypeScript 5 |
| Database | SQLite via better-sqlite3 (WAL mode, foreign keys) |
| Styling | Tailwind CSS 4 |
| Charts | Recharts |
| CSV parsing | papaparse |
| PDF parsing | Claude API (@anthropic-ai/sdk) |
| AI chat | Claude API |
| Testing | Vitest |

### Dependencies Eliminated from v1

- puppeteer (~150MB) — replaced by Claude API for PDF extraction
- canvas (~30MB) — no longer needed
- tesseract.js (~20MB) — no longer needed
- pdf2json, pdf-parse — replaced by Claude API

## Database Schema

### Migration System

- `lib/db/migrations/` directory with numbered `.sql` files (001_initial.sql, 002_xxx.sql, ...)
- `schema_migrations` table tracks applied migrations by filename + timestamp
- On startup: apply any unapplied migrations in order, each within a transaction
- Migrations are forward-only (no rollback files; if needed, create a new forward migration)

### Tables (13 total)

| Table | Purpose | Key Changes from v1 |
|-------|---------|-------------------|
| `accounts` | Investment accounts (Vanguard Taxable, Vanguard Roth IRA, IBKR) | — |
| `securities` | Stock/bond/ETF symbols + metadata | Add `source_key` for cross-source dedup |
| `transactions` | Buys, sells, dividends, deposits, withdrawals | Add `source_key UNIQUE` for idempotent imports, add `import_batch_id` |
| `holdings` | Point-in-time holdings snapshots | — |
| `settings` | Key-value config (start_date, opening_snapshot_asof) | — |
| `prices` | Daily close prices per security | Add `import_batch_id` |
| `daily_valuations` | Computed daily portfolio values | — |
| `reconciliation_checkpoints` | Statement value vs. computed value comparisons | — |
| `tax_lots` | Individual acquisition lots for cost basis tracking | — |
| `tax_lot_sales` | Records of lot dispositions with realized gain/loss | — |
| `monthly_snapshots` | Month-end account totals with optional IBKR P&L breakdown | — |
| `import_batches` | **NEW** — tracks each import operation (file, source, counts, status) | New table |
| `raw_imports` | Replaces `raw_transactions` — stores original file content for all import types | Renamed + expanded |

### Source Key Pattern

Every imported record gets a deterministic key derived from its source data:
- Transactions: `{source}:{date}:{symbol}:{type}:{quantity}:{amount}`
- Prices: `{source}:{symbol}:{date}`
- Holdings: `{source}:{account}:{symbol}:{as_of_date}`

`INSERT OR IGNORE` on source_key makes re-importing the same file a safe no-op.

## Import Architecture

### Unified Import Flow

One import page with a single drag-and-drop zone:

1. **Detect** — identify file type (PDF/CSV) and source (Vanguard/IBKR/generic)
2. **Parse** — route to appropriate parser, extract structured data
3. **Preview** — show summary of what will be imported (counts, sample records)
4. **Confirm** — user approves, data written in one atomic batch
5. **Track** — import recorded in `import_batches` with full metadata

### Parsers

| Parser | Input | Extracts |
|--------|-------|----------|
| `ibkr-activity-csv` | IBKR monthly/annual activity CSV | Transactions, holdings, prices, monthly P&L |
| `ibkr-holdings-csv` | IBKR current holdings CSV | Securities, positions |
| `vanguard-statement-pdf` | Vanguard monthly brokerage PDF | Holdings, transactions, monthly total |
| `vanguard-cost-basis-csv` | Vanguard cost basis CSV | Tax lots |
| `vanguard-holdings-csv` | Vanguard holdings CSV | Securities, positions |
| `generic-monthly-values` | Simple date/value CSV | Monthly snapshots |

Each parser: `(content: string | Buffer, metadata: ImportMetadata) => ParsedImportResult`

### Claude PDF Parsing

For Vanguard PDFs:
1. Read PDF as base64
2. Send to Claude API with structured extraction prompt
3. Claude returns JSON with: account_name, statement_period, holdings[], transactions[], monthly_total, cash_balance
4. Validate response against expected schema
5. Transform to `ParsedImportResult`

Benefits over v1's OCR approach:
- Claude understands document structure, not just pixel text
- Handles variable formatting, background-on/off, table layouts
- Returns structured data directly (no regex post-processing)
- ~2s per statement vs. ~30s for OCR pipeline

## Dashboard UI

### Tab-Based Navigation

| Tab | Contents |
|-----|----------|
| **Overview** | Combined portfolio chart (all accounts), account summary cards (total value, change, TWR), overall performance metrics |
| **Accounts** | Per-account detail: equity curve, holdings breakdown, transaction history |
| **Import** | Drag-and-drop zone, import history (all past batches with undo) |
| **Tax Lots** | Cost basis tracking, realized/unrealized gains, long/short-term breakdown |
| **Reconciliation** | Statement checkpoints, computed vs. statement value diffs |
| **Chat** | Claude-powered portfolio Q&A |

### Component Architecture

- Server components for data fetching (Next.js app router)
- Client components for interactivity (charts, forms, drag-and-drop)
- Shared `lib/queries/` for all database reads (no inline SQL in routes)
- `lib/mutations/` for all database writes (import, compute, reconcile)

## Testing Strategy

- **Unit tests** (vitest): parsers, tax lot computation, valuation math, migrations
- **Integration tests**: full import cycle (file → parse → preview → import → verify DB state)
- **PDF parsing fixtures**: Claude API responses saved as JSON fixtures (mock the API in tests)
- **Real PDF fixtures**: gitignored, local-only, for manual integration testing
- **Pre-commit hook**: lint + test

## Project Safety

- **GitHub from commit #1** — private repo, push at every milestone
- **No nested worktrees** — if worktrees are used, sibling directory only
- **Never `rm -rf` from a `cd`'d directory** — always use absolute paths
- **Commit early and often** — every working milestone gets a commit + push

## Build Order (Milestones)

Each milestone = commit + push to GitHub.

1. Project scaffold + GitHub repo + database schema + migrations
2. Core data layer (accounts, securities, settings queries)
3. CSV importers (IBKR activity, IBKR holdings, Vanguard cost basis, monthly values)
4. Claude PDF importer (Vanguard statements)
5. Dashboard — Overview tab (combined chart, account cards, performance)
6. Dashboard — Accounts tab (per-account detail)
7. Dashboard — Import tab (drag-and-drop, import history)
8. Compute engines (daily valuations, tax lots)
9. Dashboard — Tax Lots + Reconciliation tabs
10. Portfolio Chat (Claude-powered Q&A)
11. Desktop packaging (decide approach then)

## Data Sources

Financial data lives at `~/Desktop/Portfolio - Dashboard/data/`:
- 48 Vanguard PDFs (monthly statements, Jan-Dec 2025)
- 18 IBKR CSVs (monthly activity, annual summary, holdings)
- Various processed CSVs (cost basis, holdings, transactions)
