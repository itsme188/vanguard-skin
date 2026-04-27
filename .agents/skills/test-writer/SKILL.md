---
name: test-writer
description: Generate Vitest tests for Vanguard Skin following project conventions — in-memory SQLite with dependency injection, parser tests with fixture files, compute tests with pure functions, integration tests for full pipelines. Use when adding tests for a new feature, fixing a bug that needs regression coverage, or backfilling tests for an existing module.
---

# Test Writer

You write Vitest tests for the Vanguard Skin portfolio dashboard.

## Conventions

Follow the established patterns in the codebase:

### DB query tests (`tests/queries/*.test.ts`)
- In-memory SQLite: `new Database(":memory:")` with `runMigrations(db)`
- All query functions take a `db: Database.Database` parameter (DI)
- Seed test data directly with INSERT statements
- Test real SQL execution, not mocks — catches constraint bugs
- See `tests/queries/accounts.test.ts`, `tests/queries/holdings.test.ts`

### DB mutation tests (`tests/mutations/*.test.ts`)
- Same in-memory pattern
- Test both success and constraint violation paths
- Verify `source_key` deduplication (re-import is a no-op)
- See `tests/mutations/securities.test.ts`

### Compute tests (`tests/compute/*.test.ts`)
- Pure function tests — no DB needed
- Edge cases: empty arrays, zero values, boundary conditions
- Tax lot tests: verify FIFO matching, short/long term classification
- See `tests/compute/tax-lots.test.ts`, `tests/compute/daily-valuation.test.ts`

### Import parser tests (`tests/import/parsers/*.test.ts`)
- Fixture files from `tests/fixtures/` (anonymized)
- Real PDFs/CSVs in `tests/fixtures/real/` (gitignored)
- Test detection, parsing, and edge cases per format
- See `tests/import/parsers/ibkr-activity.test.ts`, `tests/import/parsers/vanguard-pdf.test.ts`

### Integration tests (`tests/integration/*.test.ts`)
- Full pipeline: detect → parse → commit → verify DB state
- In-memory DB + real fixture files
- See `tests/integration/full-import-flow.test.ts`

### General rules
- Use `describe` blocks grouped by function name
- `beforeEach` for shared setup (create DB, run migrations, seed)
- Test both success and error paths
- All dates in `YYYY-MM-DD` format
- Transaction types are UPPERCASE: BUY, SELL, DIVIDEND, etc.
- Use `COALESCE(s.multiplier, 1)` awareness — test with and without multiplier
- Always exclude `.claude/**` and `.agents/**` when running: `npx vitest run --exclude '.claude/**' --exclude '.agents/**'`

## Test directory map

```
tests/
  apis/         — External API integration tests (EDGAR, etc.)
  chat/         — Chat validation and system prompt tests
  compute/      — Tax lots, valuations, XIRR, TWR, classification
  db/           — Migration runner tests
  fixtures/     — Anonymized test data + real/ (gitignored)
  import/       — Detection, engine, and per-format parser tests
  integration/  — Full pipeline tests
  lib/          — Utility library tests (bonds, valuation)
  mutations/    — DB write function tests
  queries/      — DB read function tests
  tws/          — IBKR TWS client tests (rate limiter, contracts, etc.)
```
