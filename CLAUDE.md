# Vanguard Skin v2

Local-first portfolio dashboard for tracking Vanguard + IBKR investments.

## Tech Stack

- **Framework:** Next.js 16, React 19, TypeScript 5
- **Database:** SQLite via better-sqlite3 (WAL mode, foreign keys ON)
- **Styling:** Tailwind CSS 4
- **Charts:** Recharts
- **CSV parsing:** papaparse
- **PDF parsing:** Claude API (@anthropic-ai/sdk)
- **Testing:** Vitest

## Architecture

- **App Router** — Server components for data loading, client components for interactivity
- **SQLite** — Single `data/vanguard.db` file, WAL mode, foreign keys enforced
- **Migrations** — Numbered `.sql` files in `lib/db/migrations/`, tracked in `schema_migrations` table
- **Tab-based UI** — Overview | Accounts | Tax Lots | Analysis | Import | Reconciliation | Notes | Chat

## Directory Structure

```
app/                    # Next.js app router pages + API routes
  dashboard/            # Main dashboard with tab navigation
  api/                  # API endpoints (import, compute, chat)
lib/
  db.ts                 # Database singleton (production)
  db/migrate.ts         # Migration runner
  db/migrations/        # Numbered .sql files
  queries/              # Read-only DB functions (all take db parameter)
  mutations/            # Write DB functions (all take db parameter)
  import/               # Import pipeline (detect, parse, commit)
    parsers/            # Per-format parsers
  compute/              # Computation engines (valuations, tax lots)
  types.ts              # Shared TypeScript types
tests/
  fixtures/             # Test data (anonymized samples)
  fixtures/real/        # Real PDFs/CSVs (gitignored, local only)
docs/plans/             # Design doc and implementation plan
data/                   # SQLite DB + imported files (gitignored)
scripts/                # One-time utility scripts (e.g. generate-pdf-fixture.ts)
```

## Data Flow

All imports follow: **Detect → Parse → Preview → Confirm → Commit**

1. User drops file(s) on import tab
2. `/api/import?mode=preview` detects format and parses
3. UI shows preview with counts and sample records
4. User clicks Import → `/api/import?mode=commit` writes to DB
5. Every import creates an `import_batches` record for undo

## Conventions

- All DB query functions live in `lib/queries/` — read-only
- All DB mutation functions live in `lib/mutations/` — writes
- Every DB function takes a `db: Database.Database` parameter (dependency injection for testing with `:memory:` DBs)
- All dates use `YYYY-MM-DD` format
- Monthly snapshots always use last-day-of-month dates
- Every imported record gets a deterministic `source_key` — re-import is a no-op
- Every import creates an `import_batches` record with undo capability
- Transaction types are UPPERCASE: BUY, SELL, DIVIDEND, REINVESTMENT, TAX_WITHHELD, BUY_TO_OPEN, SELL_TO_CLOSE, etc.
- `computeTaxLots` matches on uppercase BUY/SELL — parsers must output uppercase
- Market values use `adjustedMarketValueSQL()` from `lib/valuation.ts` — handles bonds (÷100) and options (×multiplier)
- Always use `COALESCE(s.multiplier, 1)` in queries — SQLite DEFAULT is bypassed by explicit INSERT NULL
- Bond unrealized gain: apply par-adjustment to BOTH current value AND cost basis
- Option symbols MUST use OCC format (e.g., `INTC  260320P00045000`), never bare tickers — `ensureOCCSymbol()` in vanguard-pdf.ts auto-converts. Bare tickers cause stock/option collisions in `upsertSecurity()` UNIQUE(symbol) constraint.
- `upsertSecurity()` has a type conflict guard — refuses to merge stock↔option on same symbol to prevent data corruption

## API Pattern

- `POST /api/import?mode=preview` — parse only, return preview JSON
- `POST /api/import?mode=commit` — parse and commit to database
- `POST /api/compute/valuations` — recompute daily valuations
- `POST /api/compute/tax-lots` — recompute tax lots (FIFO)
- `POST /api/chat` — streaming Claude Q&A with portfolio context (Opus 4.6, adaptive thinking, prompt caching)

## Safety Rules

- NEVER use `rm -rf` with relative paths — always absolute
- NEVER nest worktrees inside the repo
- See global ~/.claude/CLAUDE.md for git commit/push rules

## Shell Gotchas

- `gh pr create --body` with backticks causes shell errors — use `--body-file /tmp/file.md` instead

## Testing

- Run tests: `npx vitest run`
- All tests use in-memory SQLite (`:memory:`) for isolation
- Test fixtures in `tests/fixtures/` (anonymized)
- Real data fixtures in `tests/fixtures/real/` (gitignored)
- PDF parser tests use mock Claude API response JSON (`tests/fixtures/vanguard-pdf-claude-response.json`)
- To regenerate PDF fixture: `ANTHROPIC_API_KEY=sk-... npx tsx scripts/generate-pdf-fixture.ts <path-to-pdf>`
- Verify build compiles: `npx next build` (catches issues tests don't)

## Known Bugs (from 2026-03-11 feature audit)

- ~~**IBKR YTD TWR = 0%**~~ — **FIXED** (`7748f64`). Four bugs: (a) `twr = 0` default → `undefined`, (b) `"Deposits & Withdrawals"` field name variant, (c) negative TWR regex now `/(-?[\d.]+)%/`, (d) added external flow transaction parsing from D&W section.
- **Bond cost basis display 100x too high** — `TaxLotTables.tsx` line 88 computes `quantity × acquisition_price` without ÷100 par adjustment for bonds. The unrealized gain column IS correct (computed server-side via `adjustedMarketValueSQL()`). Fix: check `security_type` and divide by 100 for bonds.
- **Tax lot summary cards ignore account filter** — `getTaxLotSummary()` in `lib/queries/tax-lots.ts` has no `account_id` parameter. The lot table filters correctly but the 4 summary cards (Unrealized, Realized, Long-Term, Short-Term) always show all-accounts aggregate.
- **Tax lots not auto-computed after import** — Tax Lots tab shows "No tax lots computed" until user clicks Recompute. Consider auto-triggering after import commit.
- **Reconciliation feature is scaffolding only** — Tab exists with "+ Add Checkpoint" button and empty state but has never been used with real data.

## Reference

- Full design doc: `docs/plans/2026-03-04-v2-rebuild-design.md`
- Implementation plan: `docs/plans/2026-03-04-v2-implementation-plan.md`
- Product one-pager: `docs/vanguard-skin-overview.pdf` (generated by `scripts/generate-one-pager.py`)

## Decision Log

Record architectural and implementation decisions here so future sessions don't relitigate them.

- **PDF parsing via Claude API, not OCR** — Vanguard PDFs are image-heavy. We use the Anthropic SDK to send PDF pages to Claude for structured extraction. This is more accurate than tesseract/pdftotext and worth the API cost.
- **SQLite over Postgres** — Local-first, single-user app. No need for a database server. WAL mode handles concurrent reads during imports.
- **OCC format for option symbols** — Bare tickers like "INTC" collide with the underlying stock in the securities table UNIQUE constraint. Always use full OCC format (e.g., `INTC  260320P00045000`). This was a painful bug — do not revert.
- **Bond par adjustment in two places** — Both market value AND cost basis need ÷100 for bonds. This has been fixed wrong multiple times. The canonical logic is in `adjustedMarketValueSQL()` in `lib/valuation.ts`.
- **Deterministic source_key for idempotent imports** — Every record gets a hash-based key so re-importing the same file is a no-op. Do not change the hashing logic without understanding the dedup implications.
- **Thematic factor exposure — separate table, query-time inheritance** — `security_factors` is a standalone table (not bolted onto `securities`) because factors are opinionated macro assessments, not security identity. Options inherit factors at query time via `LEFT JOIN securities u ON u.symbol = s.underlying_symbol` + `COALESCE(sf.col, sf_u.col)` — no duplicate storage. Constants/labels/colors shared from `lib/factors.ts`. Auto-classify uses Sonnet 4 with training examples from the CSV.

## Bug Priority (work in this order)

1. Bond cost basis display 100x too high — `TaxLotTables.tsx` line 88, straightforward fix
2. Tax lot summary cards ignore account filter — `getTaxLotSummary()` needs account_id parameter
3. Tax lots not auto-computed after import — trigger recompute after commit
4. Reconciliation feature is scaffolding only — low priority, build out when core features are solid

## What NOT to Change

These areas are working correctly and should not be refactored or "improved" unless I specifically ask:
- The import pipeline (Detect → Parse → Preview → Confirm → Commit)
- The Claude API PDF parsing integration
- The migration system
- The chat endpoint streaming implementation
