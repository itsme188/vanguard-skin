# Database Layer — Domain Rules

Rules specific to SQLite database access. See root CLAUDE.md for project-wide conventions.

## Schema

- WAL mode, foreign keys ON
- Migrations: numbered `.sql` files in `migrations/`, tracked in `schema_migrations` table
- `import.meta.url` in migrate.ts (not `__dirname`) — ESM compat with Vitest
- `serverExternalPackages` in next.config — better-sqlite3 is a native addon, excluded from bundling

## Query Patterns

- All DB functions take `db: Database.Database` parameter (dependency injection for `:memory:` tests)
- Queries live in `lib/queries/` (read-only), mutations in `lib/mutations/` (writes)
- **Holdings queries: key "latest" per (account, security) via `latestHoldingsPredicate`** (`lib/queries/latest-holdings.ts`) — never a hand-rolled per-account or global `MAX(as_of_date)` (those drop statement-only positions; the closed-position reconciler's quantity-0 tombstones make per-pair safe). A static guard test (`tests/repo/no-handrolled-latest-holdings.test.ts`) enforces this. (This line previously mandated the opposite — inverted 2026-08-30, holdings-latest sweep.)
- Bond maturity filter: `quantity > 0 AND (maturity_date IS NULL OR maturity_date >= date('now'))`
- Always use `COALESCE(s.multiplier, 1)` — SQLite DEFAULT is bypassed by explicit INSERT NULL
- Market values: use `adjustedMarketValueSQL()` from `lib/valuation.ts` — handles bonds (/100) and options (*multiplier)
- **Column naming trap**: `prices` table uses `date` and `close_price`. `ohlcv_bars` table uses `bar_date` and `close`. Never use `price_date` or bare `close` on `prices` — this mismatch has caused bugs twice (commits f080a2d, next fix).
