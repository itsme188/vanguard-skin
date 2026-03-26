# Vanguard Skin v2

Local-first portfolio dashboard for tracking Vanguard + IBKR investments.

## Tech Stack

- **Framework:** Next.js 16, React 19, TypeScript 5
- **Database:** SQLite via better-sqlite3 (WAL mode, foreign keys ON)
- **Styling:** Tailwind CSS 4
- **Charts:** Recharts
- **CSV parsing:** papaparse
- **PDF parsing:** Claude API (@anthropic-ai/sdk)
- **Chat:** AI SDK v6 (`ai`, `@ai-sdk/react`, `@ai-sdk/anthropic`)
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
6. Post-commit: auto-classifies securities + auto-computes tax lots (silent, non-blocking)

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
- PDF holdings extraction uses focused extraction (holdings-only, no transactions) with multi-attempt retry — asking Claude to extract both in one call causes attention dilution on 28-page PDFs, missing 50-70% of holdings. See `extractHoldingsFromPdf()` in `vanguard-pdf.ts`.
- `upsertSecurity()` has a type conflict guard — refuses to merge stock↔option on same symbol to prevent data corruption
- Dashboard "as of" dates: `getAccountSummaries()` prefers `daily_valuations` over `monthly_snapshots` when more recent

## Dev Server Gotchas

- After changing any server-side code (SQL queries, API routes, server components), restart the dev server before testing. Next.js dev server caches server-side code aggressively — page refreshes alone won't pick up changes. Stale server code can also make errors appear on the wrong page.

## API Pattern

- `POST /api/import?mode=preview` — parse only, return preview JSON
- `POST /api/import?mode=commit` — parse and commit to database
- `POST /api/compute/valuations` — recompute daily valuations
- `POST /api/compute/tax-lots` — recompute tax lots (FIFO)
- `POST /api/chat` — AI SDK v6 `streamText` with `@ai-sdk/anthropic` provider (Opus 4.6, adaptive thinking, ephemeral cache control, `stopWhen: stepCountIs(8)`). Client uses `useChat` from `@ai-sdk/react`.

## Safety Rules

- NEVER use `rm -rf` with relative paths — always absolute
- NEVER nest worktrees inside the repo
- NEVER run two `next dev` processes against the same project directory — Turbopack's persistent cache is single-writer; concurrent writes corrupt SST files
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

## Decision Log

See `docs/DECISIONS.md` — consult before making structural changes. Add new entries there after each session.

## Reference

- Full design doc: `docs/plans/2026-03-04-v2-rebuild-design.md`
- Implementation plan: `docs/plans/2026-03-04-v2-implementation-plan.md`
- Product one-pager: `docs/vanguard-skin-overview.pdf` (generated by `scripts/generate-one-pager.py`)
- Project roadmap: `docs/plans/TODO.md`

## What NOT to Change

These areas are working correctly and should not be refactored or "improved" unless I specifically ask:
- The import pipeline (Detect → Parse → Preview → Confirm → Commit)
- The Claude API PDF parsing integration
- The migration system
- The chat AI SDK integration (route.ts uses streamText, ChatInterface.tsx uses useChat)
