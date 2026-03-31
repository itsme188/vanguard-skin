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
- **Holdings queries: use per-account MAX date** (`WHERE h2.account_id = h.account_id`), NOT per-security MAX. Per-security returns stale/matured positions. Fixed in 7 locations.
- Bond maturity filter: `quantity > 0 AND (maturity_date IS NULL OR maturity_date >= date('now'))`
- Always use `COALESCE(s.multiplier, 1)` — SQLite DEFAULT is bypassed by explicit INSERT NULL
- Market values: use `adjustedMarketValueSQL()` from `lib/valuation.ts` — handles bonds (/100) and options (*multiplier)
- **Column naming trap**: `prices` table uses `date` and `close_price`. `ohlcv_bars` table uses `bar_date` and `close`. Never use `price_date` or bare `close` on `prices` — this mismatch has caused bugs twice (commits f080a2d, next fix).
