# Vanguard Skin v2

Local-first portfolio dashboard for tracking Vanguard + IBKR investments.

This is primarily a TypeScript project with some Python utilities. Use TypeScript conventions, proper type safety, and avoid type assertion workarounds unless necessary.

## Tech Stack

- **Framework:** Next.js 16, React 19, TypeScript 5
- **Database:** SQLite via better-sqlite3 (WAL mode, foreign keys ON)
- **Styling:** Tailwind CSS 4
- **Charts:** Recharts (portfolio-level), LightweightCharts v5 (per-security candlestick)
- **CSV parsing:** papaparse
- **PDF parsing:** Claude API (@anthropic-ai/sdk)
- **Chat:** AI SDK v6 (`ai`, `@ai-sdk/react`, `@ai-sdk/anthropic`)
- **Gmail:** googleapis (OAuth 2.0 for newsletter ingestion)
- **Testing:** Vitest
- **Desktop:** Electron (standalone Next.js + system Node.js for native modules)

## Architecture

- **App Router** — Server components for data loading, client components for interactivity
- **SQLite** — Single `data/vanguard.db` file, WAL mode, foreign keys enforced
- **Migrations** — Numbered `.sql` files in `lib/db/migrations/`, tracked in `schema_migrations` table
- **Tab-based UI** — Overview | Accounts | Holdings | Analysis | Charts | Calendar | Research | Import
- **Chat drawer** — Slide-out right panel (Cmd+J), accessible from any tab, persists conversation
- **Security Detail** — `/dashboard/security/[id]` hub page per security (chart, positions, lots, notes, events, factors, trade grades)
- **Watchlist** — Track securities not yet owned, with price targets and thesis
- **Trade Reviews** — Monthly AI trade analysis in Research tab (Notes | Trade Reviews toggle). Migration 016 + 021. Two-phase: Sonnet Q&A → Opus review. Account-specific profiles (IBKR/Vanguard/Roth). GroupedTrade abstraction (lots → trades). Auto model selection (>20 trades → Sonnet).
- **Auto-Refresh** — TWS connect triggers full sync pipeline automatically. Background refresh every 30 min. Data confidence scoring in header.

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
  chart/                # Technical indicators (SMA, EMA) — client-side
  types.ts              # Shared TypeScript types
tests/
  fixtures/             # Test data (anonymized samples)
  fixtures/real/        # Real PDFs/CSVs (gitignored, local only)
docs/plans/             # Design doc and implementation plan
data/                   # SQLite DB + imported files (gitignored)
scripts/                # Utility scripts (import-real-data.ts, seed-demo.ts, etc.)
```

## Data Flow

All imports follow: **Detect → Parse → Preview → Confirm → Commit**

1. User drops file(s) on import tab
2. `/api/import?mode=preview` detects format and parses
3. UI shows preview with counts and sample records
4. User clicks Import → `/api/import?mode=commit` writes to DB
5. Every import creates an `import_batches` record for undo
6. Post-commit: auto-classifies securities + auto-computes tax lots + recomputes daily valuations (silent, non-blocking)

## Auto-Refresh & Data Confidence

On TWS connect (auto or manual), `lib/tws/auto-refresh.ts` orchestrates a 5-step pipeline:
1. `syncPortfolio()` — positions + account values + live prices (15s)
2. `enrichSecurities()` — TWS contract details for unenriched securities (rate-limited, skipped if none)
3. `fetchSnapshotPrices()` — current prices for ALL held securities (~2 min, NOT rate-limited)
4. `computeDailyValuations()` — recompute with fresh prices (instant)
5. `fetchBenchmarkPrices()` — benchmark ETFs, incremental (parallel with steps 3-4)

- **Sync state**: `lib/tws/sync-state.ts` — globalThis singleton tracking status, phase, progress. UI polls `GET /api/tws/sync-status` (3s during sync, 30s when idle).
- **Mutex**: `isSyncing()` prevents concurrent runs. Second call returns immediately.
- **Background refresh**: `lib/hooks/useAutoRefresh.ts` triggers quick refresh (snapshot + valuations only) every 30 min while connected. Configurable via `refreshIntervalMinutes` in Electron settings (0 = disabled).
- **Data confidence**: `lib/queries/data-confidence.ts` scores 5 dimensions (price freshness 40%, holdings recency 25%, cash accuracy 15%, enrichment 10%, valuation coverage 10%). `DataConfidenceIndicator.tsx` replaces `DataFreshness.tsx` in header — shows score, colored dot, popover with dimension bars and actionable fix buttons. Polls `GET /api/data-confidence` every 60s.
- **Data quality labeling**: Migration 026 adds `data_quality` column to `daily_valuations` (`live`/`recent`/`estimated`/`computed`). Set by `computeDailyValuations()` based on price staleness. Account cards show "(est.)" for stale data; portfolio total shows "~" prefix when estimated.

## Conventions

- All DB query functions live in `lib/queries/` — read-only
- All DB mutation functions live in `lib/mutations/` — writes
- Every DB function takes a `db: Database.Database` parameter (dependency injection for testing with `:memory:` DBs)
- All dates use `YYYY-MM-DD` format
- Monthly snapshots use last-day-of-month dates (or today's date for TWS live snapshots with `source='tws'`)
- Every imported record gets a deterministic `source_key` — re-import is a no-op
- Every import creates an `import_batches` record with undo capability
- Transaction types are UPPERCASE: BUY, SELL, DIVIDEND, REINVESTMENT, TAX_WITHHELD, BUY_TO_OPEN, SELL_TO_CLOSE, etc.
- `computeTaxLots` matches on uppercase BUY/SELL — parsers must output uppercase
- Market values use `adjustedMarketValueSQL()` from `lib/valuation.ts` — handles bonds (÷100) and options (×multiplier). Uses `LOWER()` for case-insensitive type matching.
- **Security type casing**: DB stores capitalized types (`Bond`, `Stock`, `ETF`, `Option`, `Mutual Fund`). Always use case-insensitive comparisons (`.toLowerCase()` in TS, `LOWER()` in SQL). `mapSecurityType()` is centralized in `lib/tws/security-type-map.ts` — import from there, never duplicate. A PostToolUse lint hook in `.claude/settings.json` rejects new case-sensitive comparisons.
- **Import validation**: `lib/import/validate.ts` runs before commit — validates dates, quantities, prices, transaction types, AND financial sanity (`isGarbageSymbol()` rejects timestamps, commas, >30 chars, purely numeric). Bad rows excluded with warnings.
- **API contract tests**: `tests/contracts/api-component-contracts.test.ts` verifies compute function return shapes match component expectations. Add a test here whenever a new client component fetches from an API.
- **Account scoping rule**: If a page has an account scope selector (e.g., Analysis), EVERY query on that page must accept and respect `accountIds`. No global queries on scoped pages. Client components pass `scope` prop; API routes resolve via `resolveScopeToSingleId()` or `resolveScope()` from `lib/queries/accounts.ts`.
- **Calendar date utilities**: `lib/calendar/date-utils.ts` is the single source of truth for Monday calculations (`getCurrentMonday()`), date arithmetic (`addDays()`), week range formatting (`formatWeekRange()`), and weekOf validation (`validateWeekOf()`). Never create local date functions — import from here.
- **Price source priority**: Higher-priority sources overwrite lower: tws(1) > ibkr(2) > vanguard(3) > manual(4). See conditional upsert in `engine.ts`.
- **Data Health**: `/dashboard/data-health` — coverage, freshness, gaps, reconciliation. `DataConfidenceIndicator` header popover links there. Old `DataFreshness.tsx` is unused (replaced by `DataConfidenceIndicator.tsx`).
- Always use `COALESCE(s.multiplier, 1)` in queries — SQLite DEFAULT is bypassed by explicit INSERT NULL
- Bond unrealized gain: apply par-adjustment to BOTH current value AND cost basis
- Option symbols MUST use OCC format (e.g., `INTC  260320P00045000`), never bare tickers — `ensureOCCSymbol()` in vanguard-pdf.ts auto-converts. Bare tickers cause stock/option collisions in `upsertSecurity()` UNIQUE(symbol) constraint.
- PDF holdings extraction uses focused extraction (holdings-only, no transactions) with multi-attempt retry — asking Claude to extract both in one call causes attention dilution on 28-page PDFs, missing 50-70% of holdings. See `extractHoldingsFromPdf()` in `vanguard-pdf.ts`.
- `upsertSecurity()` has a type conflict guard — refuses to merge stock↔option on same symbol to prevent data corruption
- Dashboard "as of" dates: `getAccountSummaries()` prefers `daily_valuations` over `monthly_snapshots` when more recent
- Daily valuations infer cash from monthly snapshot anchors: `cash = snapshot_total - holdings_value`. Cash carries forward between snapshots.
- TWS portfolio sync filters to the personal account set via `IBKR_ACCOUNT_CODE` env var (managed advisor account excluded). `getAccountUpdates()` includes `marketPrice` in the position data. On TWS connect, auto-refresh pipeline runs automatically (positions → enrich → snapshot prices → valuations → benchmarks).
- **ALL portfolio queries exclude TWS snapshots** (`source != 'tws'`). TWS rows are live-sync data for daily valuations, not month-end statements — including them breaks Modified Dietz, corrupts change calculations (shifts global MAX date), and adds irregular chart points. This applies to: TWR, XIRR, portfolio totals, account summaries, chart data. TWR format is source-aware: `ibkr-activity` stores as percentage, `canonical` stores as decimal fraction.
- **December annual snapshots**: Vanguard year-end statements produce December rows with annual `starting_value` and cumulative `deposits_withdrawals`. TWR/XIRR detect these (starting_value mismatch >10% from prior month) and compute December-only values.

## Bug Fixes

When fixing bugs, verify the fix against the actual data/edge cases before declaring it done. Do not assume a calculation is correct — test with real values (e.g., holding periods, XIRR, bond pricing, portfolio valuations).

## Data Integrity

When working with financial data (prices, valuations, dates, events), NEVER use hardcoded or guessed values. Always use authoritative data sources (APIs like FRED, Hebcal, IBKR) instead of generating dates, prices, or financial figures from training data.

When data appears missing or wrong, investigate the root cause (check the API response, query the DB directly) before building UI workarounds. The import engine now derives prices from holdings `market_value` — every holding with a market value produces a price automatically on import.

## External APIs

When working with external APIs (TWS/IBKR, Gmail, FRED), check the correct API contract (parameter names, types, rate limits) before writing code. Do not guess field names like `symbol` vs `conId`.

## Dev Server Gotchas

- After changing any server-side code (SQL queries, API routes, server components), restart the dev server before testing. Next.js dev server caches server-side code aggressively — page refreshes alone won't pick up changes. Stale server code can also make errors appear on the wrong page.
- **Turbopack lock file**: If dev server crashes or terminal closes without Ctrl+C, a stale lock file prevents restart ("Unable to acquire lock"). Fix: `rm -rf .next` then `npm run dev`.
- **TWS stale connection after restart**: The old TCP socket to TWS lingers after dev server restart. New server gets `getCurrentTime timeout (5s)` because TWS is still holding the old client ID 1 session. Fix: in TWS, toggle Edit → Global Config → API → "Enable ActiveX and Socket Clients" off then on to drop stale connections.

## API Pattern

- `POST /api/import?mode=preview` — parse only, return preview JSON
- `POST /api/import?mode=commit` — parse and commit to database
- `POST /api/compute/valuations` — recompute daily valuations
- `POST /api/compute/tax-lots` — recompute tax lots (FIFO)
- `POST /api/chat` — AI SDK v6 `streamText` with `@ai-sdk/anthropic` provider (Opus 4.7, adaptive thinking, ephemeral cache control, `stopWhen: stepCountIs(8)`). Client uses `useChat` from `@ai-sdk/react`.
- `POST /api/tws/positions` — SSE streaming: sync live IBKR positions + account summary from TWS
- `POST /api/tws/chart` — OHLCV bars for per-security charting. Supports daily (cached in `ohlcv_bars`) and intraday 1m/5m (live from TWS, not cached). Returns transactions for BUY/SELL markers.
- `POST /api/calendar/sync` — SSE streaming: pulls WSH company events (earnings, analyst meetings) from TWS + macro events (FOMC, CPI, jobs) from Claude API. Stores in `calendar_events` table.
- `GET /api/calendar/events?start=&end=&weekOf=` — read calendar events from DB
- `POST /api/calendar/briefing` — SSE streaming: generates weekly research briefing via Claude for all events in a given week. Includes Vital Knowledge market context if Gmail env vars set. Stores in `calendar_briefings` table.
- `POST /api/calendar/email` — generates briefing (if needed), converts markdown→styled HTML, sends via Gmail. Body: `{ weekOf?, to? }`. Requires `GMAIL_ADDRESS`, `GMAIL_APP_PASSWORD`, `BRIEFING_EMAIL_TO` env vars.
- `GET /api/compute/xirr?startDate=&endDate=&accountId=` — compute XIRR for arbitrary date ranges
- `GET /api/compute/risk?startDate=&endDate=&accountId=` — portfolio risk metrics (drawdown, volatility, Sharpe, Herfindahl)
- `GET /api/compute/position-risk?accountId=&topN=10` — per-position volatility, risk contribution, correlation matrix
- `GET /api/compute/factors?accountId=&benchmark=SPY` — market beta regression + portfolio tilts (size, style, sector, geography)
- `GET /api/compute/scenarios?accountId=&scenario=` — scenario modeling (9 presets: crash, rate shocks, rally, sector rotation)
- `POST /api/compute/scenarios` — custom what-if scenario. Body: `{ marketMove, rateMove?, sectorMoves?, name? }`
- `GET /api/compute/fixed-income` — bond exposure: weighted avg duration, credit quality breakdown, bond positions
- `GET /api/compute/options-greeks?accountId=` — portfolio + per-position Greeks (delta, gamma, theta, vega, IV)
- `GET /api/compute/options-strategies?accountId=` — detected option strategies (covered calls, spreads, etc.)
- `GET /api/compute/reconciliation?accountId=` — cost basis reconciliation: broker-reported vs computed
- `GET /api/tws/option-chain?symbol=` — option chain expirations + strikes from TWS
- `GET /api/tax-report?year=&format=json|csv|txf` — Form 8949 tax report with wash sale detection (CSV for filing, TXF for TurboTax)
- `GET /api/search?q=` — global search across securities, notes, transactions
- `POST /api/benchmark/sync` — SSE streaming: fetch benchmark prices from TWS (falls back to cached ohlcv_bars/prices on timeout)
- `GET /api/benchmark/prices?mode=prices|chart|stats|available&symbol=SPY` — benchmark data and analytics
- `GET /api/tws/stream` — SSE: streaming live quotes for current holdings
- `POST /api/tws/stream` — control streaming: `{ action: "stop" | "snapshot" }`
- `GET /api/tws/sync-status` — current auto-refresh pipeline state (status, phase, progress, last sync result)
- `POST /api/tws/auto-refresh` — trigger sync pipeline. Body: `{ level?: "full" | "quick" }`. Default: full. Quick = snapshot prices + valuations only.
- `GET /api/data-confidence` — 5-dimension data confidence score with actionable fix list
- `GET /api/summary` — lightweight portfolio summary (total value, data freshness, TWS state, confidence score) for Electron tray
- `GET /api/watchlist` — list active watchlist items
- `POST /api/watchlist` — add security to watchlist (by securityId or symbol)
- `PATCH /api/watchlist` — update price targets/thesis
- `DELETE /api/watchlist?id=` — remove from watchlist (soft delete)
- `POST /api/trade-review` — SSE streaming, two-phase: Phase 1 (no answers) prepares data + Sonnet Q&A; Phase 2 (with answers) generates Opus/Sonnet review. Body: `{ accountId, periodStart, periodEnd, answers?: [{tradeNumber, answer}] }`. Auto-selects Sonnet for >20 trades.
- `GET /api/trade-review?accountId=&year=` — list trade reviews for account
- `GET /api/trade-review?id=` — single review with grouped trades (lots grouped by sale_transaction_id)
- `GET /api/trade-review?periods=true&accountId=` — available review periods (COUNT DISTINCT sale_transaction_id)
- `POST /api/research/sync` — SSE streaming: fetch Gmail newsletters + AI-process with Claude Sonnet + backfill HTML + backfill source URLs for old articles
- `GET /api/research/articles?sourceId=&securityId=&startDate=&endDate=&search=&limit=` — query research articles (includes symbolMap)
- `GET /api/research/articles/[id]` — single article with raw_text + raw_html for expanded view
- `GET /api/research/sources` — list newsletter sources with article counts
- `POST /api/research/sources` — create newsletter source
- `PATCH /api/research/sources` — update newsletter source (sender_email, is_active, processing_prompt, etc.)
- `DELETE /api/research/sources` — delete newsletter source. Body: `{ id }`
- `POST /api/research/discover` — scan Gmail for newsletter senders (90-day window, 1+ emails)
- `GET /api/gmail/status` — check Gmail OAuth connection
- `POST /api/digest/email` — sync feeds + compile daily digest + send email. Body: `{ to?, mode?: "today" | "since_last" | "since_date", sinceDate? }`. Default (no mode) = last 24h. Records `last_digest_sent_at` in settings table.
- `GET /api/digest/status` — last-sent timestamps (`lastDigestSentAt`, `lastBriefingSentAt`) and `defaultRecipient` from env

## Security Detail Page

- Route: `/dashboard/security/[id]` — hub page for a single security
- Shows: chart (SecurityChart), positions (cross-account), tax lots (open + closed), transactions, notes, events, factor exposure, transcripts
- Every symbol in the app links here via `SymbolLink` component
- Watchlist button toggles add/remove with star icon
- `lib/queries/security-detail.ts` — consolidated queries calling existing sub-queries

## Tab Structure

- 8 tabs: Overview, Accounts, Holdings, Analysis, Charts, Calendar, Research, Import
- **Chat** is a slide-out drawer (ChatDrawer.tsx) in the layout, toggled via header button or Cmd+J
- **Reconciliation** merged into Accounts tab as collapsible section
- **Notes** renamed to **Research** (redirect from /dashboard/notes)
- **Research** tab has 3 views: Notes | Trade Reviews | Feeds (newsletter articles from Gmail)
- **Holdings** tab shows cross-account positions with P&L and allocation %
- Old routes (/dashboard/notes, /dashboard/reconciliation, /dashboard/chat) redirect to new locations

## Mobile Responsive

- **Bottom nav** (`MobileBottomNav.tsx`): 5 icons — Home, Research, Chat (gold center), Calendar, Analysis. `md:hidden electron:hidden`.
- **Desktop tabs** hidden on mobile (`hidden md:flex` on TabNav `<nav>`). Maintenance tabs (Accounts, Holdings, Charts, Import) only in desktop nav.
- **Chat**: full-screen overlay on mobile (`fixed inset-0`, slide-up via `translate-y`), 480px side drawer on desktop. Uses `useIsMobile` hook + `toggle-mobile-chat` DOM event.
- **Header**: simplified on mobile — only Title + Search + Settings. DataConfidenceIndicator, TwsStatus, ChatDrawer toggle, AppVersion hidden via `hidden md:flex`.
- **ChatDrawer rendered at layout root** (not inside header) so mobile full-screen overlay works. Do NOT wrap in `hidden md:flex`.
- **Breakpoint**: `md:` (768px) separates phone from tablet/desktop. Mobile-first defaults.
- **Safe area**: `pb-safe` utility in globals.css, `viewport-fit=cover` meta tag for iPhone notch/home indicator.
- **Remote access**: Cloudflare Mesh — iPhone accesses Electron app at `100.96.0.1:3099` via Cloudflare One Client. Server binds to `0.0.0.0` (not localhost). Team: `isafier`. MDM config at `/Library/Managed Preferences/com.cloudflare.warp.plist`. Device profile: "Mesh Network Profile" (Include mode, `100.96.0.0/12`).

## Benchmark & Risk

- Benchmark prices stored in `benchmark_prices` table (migration 014), separate from portfolio `prices`
- Benchmark sync requires TWS connection; falls back to `ohlcv_bars` then `prices` table for cached data
- TWS `getHistoricalData` requires `conId` in contract for reliability — symbol-only contracts time out
- `lib/tws/benchmark.ts` auto-resolves conId via `getContractDetails` for unknown benchmark symbols
- Risk metrics computed from `daily_valuations` — no external data needed
- Sharpe ratio uses 4.5% risk-free rate (configurable via `riskFreeRate` option)
- Recharts `formatter` on Tooltip needs untyped params: `(value) => [formatFn(Number(value)), label]`
- Recharts `minTickGap={40}` on XAxis prevents duplicate labels with dense daily data

## Calendar

- WSH (Wall Street Horizon) provides company events via `reqWshEventData()` on raw `IBApi` — IBApiNext has NO WSH wrapper, so we access `(ibApiNext as any).api`
- WSH JSON format is undocumented — `raw_json` column stores the full response for debugging/iteration
- Macro event dates from FRED `releases/dates` API (authoritative); FOMC dates hardcoded from federalreserve.gov
- Claude Sonnet used for enrichment only (descriptions, consensus estimates, impact ratings — never dates)
- Dividends/ex-dividends are filtered OUT of the calendar (user preference — too noisy)
- `lib/tws/wsh.ts` — WSH fetch with Promise wrapper, `lib/calendar/parse-wsh.ts` — defensive parser
- `lib/calendar/macro-events.ts` — FRED dates + FOMC schedule + Claude enrichment
- `lib/calendar/briefing.ts` — weekly briefing generation (includes VK market context if available)
- `lib/vital-knowledge.ts` — IMAP-based Vital Knowledge newsletter fetching (ported from Stock Contest)
- `lib/email.ts` — nodemailer Gmail sending utility; `lib/calendar/briefing-html.ts` — markdown→HTML for email
- Weekly briefings stored in `calendar_briefings` table, one per week (UNIQUE on `week_of`)
- Automated emails via launchd plists in `~/Library/LaunchAgents/`:
  - `com.vanguard-skin.weekly-email.plist` — Sunday 5 PM, week-ahead calendar briefing
  - `com.vanguard-skin.daily-digest.plist` — Weekdays 9 AM, research feed digest

## Electron Build

- **DMG build**: `npm run electron:pack` (chains: `rm -rf dist` → `next build` → `tsc` → copy static → deref symlinks → `electron-builder --mac`)
- **`npmRebuild: false`** in `electron-builder.yml` — prevents electron-builder from trying to recompile better-sqlite3 for Electron's V8 (it fails and deletes the working `.node` binary). If it ever runs without this flag, rebuild with `npx node-gyp rebuild --directory=node_modules/better-sqlite3`
- **Symlink dereferencing**: `scripts/deref-standalone-symlinks.js` replaces symlinks in `.next/standalone/.next/node_modules/` with real copies (electron-builder breaks on symlinks post-copy)
- **Explicit `node_modules`** in `extraResources` — electron-builder silently excludes `node_modules` directories even from `extraResources`; the standalone server needs them
- **App icon**: `build/icon.icns` (tracked in git despite `/build/*` in gitignore via `!/build/icon.icns`)
- **Tray icons**: `public/tray-iconTemplate.png` + `@2x.png` — macOS template images (black on transparent, auto-adapt to dark/light)
- **Settings**: `autoConnectTws` (default: true), `refreshIntervalMinutes` (default: 30), and `firstRunComplete` (default: false) in AppSettings
- **WelcomeOverlay ↔ SettingsModal**: communicate via custom DOM event `open-settings` (siblings in server component layout, can't share state via props)
- **Code signing**: Developer ID Application certificate (team 8D2724Y4G2), hardened runtime, notarization via App Store Connect API key
- **Notarization env vars**: `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (set in `~/.zshrc`, not `.env.local`)
- **Entitlements**: `build/entitlements.mac.plist` — JIT, unsigned memory, disable library validation (V8 JIT needs these), network, file access
- **Build gotcha**: `dist/` must be cleaned before `next build` — Next.js standalone tracer copies it, causing recursive `.app` nesting during signing

## Safety Rules

- NEVER use `rm -rf` with relative paths — always absolute
- NEVER nest worktrees inside the repo
- NEVER run two `next dev` processes against the same project directory — Turbopack's persistent cache is single-writer; concurrent writes corrupt SST files
- Never use broad kill commands (e.g., `pkill node`, `killall`). Only kill processes by specific PID or exact process name to avoid disrupting unrelated running projects.
- See global ~/.claude/CLAUDE.md for git commit/push rules

## Shell Gotchas

- `gh pr create --body` with backticks causes shell errors — use `--body-file /tmp/file.md` instead

## Workflow Rules

After implementing a fix or feature, always run the full test suite (`npx vitest run`) and report the result before committing. This project has 1600+ tests — use them. Report the test count and pass/fail status. Do not commit if tests are failing.

## Debugging

When debugging data issues, investigate root causes rather than applying smoothing or workarounds. If the user says to fix the underlying data, do not paper over gaps.

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
