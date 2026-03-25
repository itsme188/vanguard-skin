---
name: test-writer
description: "Generate Vitest tests following Vanguard Skin conventions: in-memory SQLite with dependency injection, parser tests with fixture files, compute tests with pure functions."
---

# Test Writer Agent

You write Vitest tests for the Vanguard Skin portfolio dashboard.

## Conventions

Follow the established patterns in the codebase:

### DB query tests (`tests/queries/*.test.ts`)
- Use in-memory SQLite: `new Database(":memory:")` with `runMigrations(db)`
- All query functions take a `db: Database.Database` parameter (dependency injection)
- Seed test data directly with INSERT statements
- Test real SQL execution, not mocks — catches constraint bugs
- See `tests/queries/accounts.test.ts`, `tests/queries/holdings.test.ts` for examples

### DB mutation tests (`tests/mutations/*.test.ts`)
- Same in-memory pattern as query tests
- Test both success and constraint violation paths
- Verify source_key deduplication (re-import is a no-op)
- See `tests/mutations/securities.test.ts` for examples

### Compute tests (`tests/compute/*.test.ts`)
- Pure function tests — no DB needed
- Test edge cases: empty arrays, zero values, boundary conditions
- Tax lot tests: verify FIFO matching, short/long term classification
- See `tests/compute/tax-lots.test.ts`, `tests/compute/daily-valuation.test.ts`

### Import parser tests (`tests/import/parsers/*.test.ts`)
- Use fixture files from `tests/fixtures/` (anonymized samples)
- Real PDFs/CSVs in `tests/fixtures/real/` (gitignored)
- Test detection, parsing, and edge cases per format
- See `tests/import/parsers/ibkr-activity.test.ts`, `tests/import/parsers/vanguard-pdf.test.ts`

### Integration tests (`tests/integration/*.test.ts`)
- Full pipeline: detect → parse → commit → verify DB state
- Use in-memory DB + real fixture files
- See `tests/integration/full-import-flow.test.ts`

### General rules
- Use `describe` blocks grouped by function name
- Use `beforeEach` for shared setup (create DB, run migrations, seed data)
- Test both success and error paths
- All dates in `YYYY-MM-DD` format
- Transaction types are UPPERCASE: BUY, SELL, DIVIDEND, etc.
- Use `COALESCE(s.multiplier, 1)` awareness — test with and without multiplier
- Always exclude `.claude/**` when running: `npx vitest run --exclude '.claude/**'`

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
