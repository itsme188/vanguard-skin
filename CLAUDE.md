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
- **Security Levels & Alerts** — Migrations 029-031. Per-security price levels (static OR moving-average-resolved: SMA/EMA 9/21/50/200) for both held + watchlist. `LevelsPanel` on Security Detail (add/edit/pause/reactivate/delete) with chart `priceLine` overlays. `findCrossedLevels` + `detectAndFireAlerts` run as Step 6 of auto-refresh; Sonnet 4.6 generates one-sentence recommendations per alert. Header `AlertsBell` shows pending count, `/dashboard/alerts` is the inbox. Newsletter extraction (`extractLevelsFromNewArticles`) auto-runs after research sync, scoped to held+watchlist symbols. Sunday briefing surfaces "Levels Hit This Week" + "Active Levels Within 5%". `/dashboard/levels/performance` (2026-04-24) scores each `source_author` by hit-rate + 30/60/90-day forward P&L with <3-sample null rule + empty-state tolerance — linked from alerts inbox header. Chat tool `query_release_reactions` queries the same surface for macro + earnings reactions.
- **Calendar Living Record** — Migration 041 (2026-04-24). Post-release enrichment pipeline. `calendar_events` gains `release_time` (HH:MM ET), `actual_value`, `consensus_value`, `reaction_snapshot` (JSON: SPY/QQQ/TLT + sector ETF), `enriched_at`. New `sector_etf_gaps` table logs earnings with unmappable sectors for later backfill. Files: `lib/calendar/release-times.ts::resolveReleaseTime` (priority cascade: event_time → `RELEASE_TIMES_ET` lookup → `raw_json.entry.hour` for earnings → null); `lib/calendar/enrich-actuals.ts` dispatches on `source_key` pattern (`fred:<releaseId>` → FRED series, `fomc:<date>` → DFEDTARU, `finnhub:<symbol>:<date>` → Finnhub, `nonfred:<name>:<date>` → Claude + `web_search_20250305`); `lib/calendar/reaction-snapshot.ts::captureReactionFromTws` fetches 1-min bars (TRADES, 9000s duration, `endDateTime = release+125min UTC`) with shared pure helpers `matchBarsToReaction` + `findNearestBar` reused by Worker cloud path; `composeReleaseInstant` does DST-aware ET→UTC so release timestamps + bar timestamps stay in one reference frame. `ReactionSnapshot.source` discriminator is `"tws" | "polygon" | "yahoo"`. Scheduler: launchd `com.vanguard-skin.calendar-enrich.plist` (StartInterval=900, self-gates to Mon-Fri 09:30–18:00 ET), mirrored by Workers cron `*/15 * * * *` via `workers/cron/src/calendar-enrich.ts::shouldRunCalendarEnrich`. **Phase 9b cloud-fallback (2026-04-25, flag-gated):** when Mac primary fails and `CLOUD_ENRICH_ENABLED=true`, Worker reads the R2 state snapshot (extended to `daysAgo(1)` trailing window), filters in-window candidates, fetches actual from FRED + Finnhub (Claude nonfred deferred to Mac), and reaction bars from **Yahoo Finance** (`query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1m&period1&period2`, free, no auth, real-time, ~10-day 1-min retention). Writes `cloud-enriched-{eventId}` KV payloads (7d TTL). Mac reconciles on every wake via `/api/calendar/reconcile-cloud-enrich` — piggy-backed on `POST /api/calendar/enrich` — reading payloads from Worker's `GET /internal/cloud-enriched` with **TWS-always-wins** precedence (`json_extract(reaction_snapshot, '$.source') = 'tws'` skips reaction overwrite; still upserts actual). After DB commit, Mac DELETEs the KV key. `POST /api/calendar/enrich { upgradeReactionToTws: true }` body flag re-captures TWS bars over a cloud-sourced row via `runTwsReactionUpgrade`. Why Yahoo over Polygon: Polygon Starter has 15-min delay which would tick events out of the 2h candidate window before bars become available; Polygon Advanced ($199/mo) overpriced; Finnhub /stock/candle is paid-only since 2024. Yahoo risk: unofficial endpoint, graceful null fallback on breakage. UI: `EnrichmentChips` on Calendar rows ("actual 3.2% · SPY -0.41%"), `TodayReleases` block on Today view, "Released Last Week" context in briefing via `formatReleasedEventForPrompt`. Plan: `docs/plans/2026-04-24-calendar-living-record.md`. **Why window filter in JS not SQL:** release_time is ET wall-clock; `datetime('now')` in SQLite is UTC; string-compare silently offsets by 4-5h under DST. `findCandidates` does SQL pre-filter by event_date range then JS final filter via `composeReleaseInstant`.
- **Mobile Today view** — `/dashboard/today` server component (mobile-first, single column). Server-rendered blocks: pending alerts (split triggered-today / older-pending), optional `TodayReleases` (macro + earnings with known release_time, enriched rows flip to "actual X · SPY ±X%"), `NearbyLevelsCard` (armed levels within 5%), full-width chat launcher (`OpenChatButton` → `toggle-mobile-chat` event), IBKR holdings sorted by `|today_gain|` desc (today's move: latest close − prior close, via ROW_NUMBER() CTE over `prices` picking rn=1 and rn=2) with `data_quality` chip. `MobileBottomNav` maps Today to the leftmost slot (sun icon). **Today is the default landing**: Electron `main.ts` loads `/dashboard/today`; desktop tab nav has Today as leftmost tab alongside Overview. Architectural decision doc: `docs/plans/2026-04-21-mobile-today-view-decision.md`.
- **Privacy toggle** — `lib/privacy/context.tsx` (`PrivacyProvider` + `usePrivacy()` hook + localStorage `vgs:privacyMode`). `lib/privacy/components.tsx` exports `<Money>` / `<Pct>` / `<Shares>` / `<Count>` / `<PrivateText>` and `usePrivateFormatter` (wraps Recharts tick/tooltip formatters). Header eye-icon `PrivacyToggle` flips between ink-faint and gold. When on, every user-facing dollar / percent / share-count masks to `•••`; symbols, dates, account names, and UI chrome stay visible. LightweightCharts security chart re-reads `localization.priceFormatter` + volume formatter + marker text on toggle via explicit `useEffect([isPrivate])`.
- **Mobile push** — `lib/alerts/notify-pushover.ts`: `sendPushover` + `sendLevelAlertPush`. Graceful no-op when `PUSHOVER_APP_TOKEN` or `PUSHOVER_USER_KEY` missing. `detectAndFireAlerts` fires fire-and-forget push per new alert with symbol, triggered price, author, held quantity, and a deep link to `/dashboard/security/[id]`. Env vars thread through `electron/settings-store.ts` + `electron/main.ts`; UI field in Settings → "Mobile Push (Pushover)".
- **AI model routing** — `lib/ai/provider.ts` is the translation layer between logical feature keys (`FeatureKey` in `lib/ai/feature-keys.ts`) and concrete AI SDK language models. `lib/ai/models.ts::FEATURE_MODELS` maps each feature to a `"<provider>/<model-id>"` string. All 11 Claude call sites use `getModelForFeature("<key>")` instead of instantiating `new Anthropic()` — the one exception is `vanguard-pdf.ts` which uses `getRawAnthropicClient("pdfParsing")` to keep its custom `messages.stream()` retry logic. Swapping Kimi K2 / Llama 3.3 / GPT-5 into any feature is a one-line change in `FEATURE_MODELS`. When `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` env vars are set, every call routes through Cloudflare AI Gateway with `cf-aig-metadata: {"feature":"<key>"}` for per-feature cost tracking. Missing env vars transparently fall back to direct provider URLs — no behavior change for dev without Cloudflare creds. **Live Phase 2 experiments:** `alertSuggestion` → Llama 3.3 70B on Workers AI (~2.4s/call), `newsletterLevelExtraction` → Kimi K2.6 on Workers AI (~21s with reasoning). Two Workers AI gotchas: (1) Kimi K2.x is a *reasoning* model whose `reasoning_content` shares the `max_tokens` budget — only use where `maxOutputTokens >= 1024`; (2) Llama on Cloudflare's compat endpoint auto-parses JSON-shaped output into an object instead of a string, breaking AI SDK's schema — don't use Llama for raw-JSON prompts. See `memory/project_ai_gateway.md`.
- **R2 statement archival** — `lib/storage/r2.ts` uploads source PDFs to Cloudflare R2 via `aws4fetch` (S3-compatible, Sigv4). Migration 033 adds `import_batches.raw_file_r2_key`. `/api/import?mode=commit` fires an async upload after DB commit (graceful no-op when `R2_*` env vars missing). Key format: `{sourceType}/{filename}`. 39 existing Vanguard PDFs backfilled via `scripts/backfill-r2-statements.ts` (idempotent via HEAD check). Env vars: `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` (falls back to `CLOUDFLARE_ACCOUNT_ID`). Pure disaster-recovery — parsed data still lives in SQLite; R2 is insurance against Mac loss.
- **Workers Cron hybrid (Phase 4)** — `workers/cron/` is a Cloudflare Worker that runs four cron triggers (summer+winter slots for Sun 3pm ET briefing + weekday 9am ET digest; `scheduled()` gates via `Intl.DateTimeFormat("America/New_York")` so only the right seasonal slot executes). Primary path: Worker calls the Mac at `MESH_HOSTNAME` → `/api/cron/{briefing,digest}` with `X-Cron-Secret`. On success, writes `mac-sent-{type}-{YYYY-MM-DD}` to KV (30h TTL). On primary failure: `src/fallback-{briefing,digest}.ts` generates the email from the latest R2 snapshot + live Gmail REST fetch + Claude via AI Gateway, sends via `users.messages.send`, writes `cloud-sent-*` marker. Launchd wrappers (`scripts/send-{daily-digest,weekly-briefing}.sh`) now also hit `/api/cron/*` with the secret so Mac-local triggers share the same dedup. Mac side: `lib/cron/marker-check.ts::checkCloudMarker` pre-flights the Worker's `/internal/marker` endpoint before regenerating; returns null gracefully when `WORKER_MARKER_URL` is unset. Env vars: Mac needs `CRON_SHARED_SECRET` + optional `WORKER_MARKER_URL`; Worker needs `CRON_SHARED_SECRET` + `MESH_HOSTNAME` + `ANTHROPIC_API_KEY` + `CLOUDFLARE_ACCOUNT_ID`/`GATEWAY_ID` + `BRIEFING_EMAIL_TO` + `FROM_EMAIL` + `WORKER_GMAIL_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN`. Worker reuses R2 bucket `vanguard-skin-statements`. State snapshot written nightly at 2am by `scripts/snapshot-state-to-r2.ts` (launchd `com.vanguard-skin.state-snapshot.plist`). Known fallback gaps (accepted): TWS-dependent sections (expiring options, live price-level triggers) are absent in cloud briefings — footer note discloses. IMAP-only sources like Vital Knowledge rely on snapshot deep-read entries rather than live IMAP.

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

On TWS connect (auto or manual), `lib/tws/auto-refresh.ts` orchestrates a 6-step pipeline:
1. `syncPortfolio()` — positions + account values + live prices (15s)
2. `enrichSecurities()` — TWS contract details for unenriched securities (rate-limited, skipped if none)
3. `fetchSnapshotPrices()` — current prices for ALL held securities (~2 min, NOT rate-limited)
4. `computeDailyValuations()` — recompute with fresh prices (instant)
5. `fetchBenchmarkPrices()` — benchmark ETFs, incremental (parallel with steps 3-4)
6. `detectAndFireAlerts()` + `generateSuggestionsForPendingAlerts()` — scan active `security_levels` against fresh prices, insert `level_alerts` + Claude one-sentence recommendations

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
- **Claude model IDs**: `lib/claude-models.ts` is the single source of truth — import `OPUS_MODEL` / `SONNET_MODEL`, never inline a model string. Anthropic's API requires specific IDs (no "latest" alias). A typo previously broke 4 features silently (calendar sync, trade reviews, briefings, Gmail processing) when `claude-sonnet-4-7` was used (Sonnet's latest is 4-6).
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
- **Security levels effective price**: For `price_source != 'static'`, the level's effective trigger price is computed from `ohlcv_bars` via `lib/alerts/resolve-level-price.ts::resolveLevelPrice()`. Returns `null` when bars are insufficient — **never** falls back to the creation-time snapshot (which drifts over days). Callers filter null levels out of scans and UI renders "insufficient history" chip. `findCrossedLevels` already does this.
- **Levels-and-alerts dedup**: Triggering a level flips `is_active=0` (primary dedup) and inserts an alert. `hasAlertToday` is the secondary safety net for re-activation paths. `triggerLevel` returns a discriminated union — `{ deduped: true, reason: "already_alerted_today" }` when the guard fires — so UI can surface it (LevelsPanel shows an "alerted today" chip + disables Reactivate). To re-arm, user clicks Reactivate: clears `triggered_at` + flips `is_active=1`.
- **Levels scan filter**: `findCrossedLevels` and sibling queries (`getActiveLevelCountsForSecurityIds`, `getLevelsNearPrice`) use `review_status = 'auto_approved'` as an **inclusive whitelist**, not `!= 'pending_review'`. The blacklist pattern lets `rejected` rows slip through. If you add a new scan query, mirror the whitelist.
- **Levels stale-price guard**: `findCrossedLevels` skips securities whose latest price row is older than 4 calendar days. 4 days tolerates Fri→Mon weekends and long-weekend Mondays; longer gaps mean TWS has been offline and prices are suspect.
- **Levels benchmark fallback**: `findCrossedLevels` CTEs both `prices` and `benchmark_prices` (joined via `securities.symbol`). Levels on DIA/VOO/other index ETFs the user tracks without holding now fire correctly.
- **Newsletter review gate**: `extractLevelsFromArticle` stages newsletter-extracted levels with `review_status='pending_review'`; user approves on `/dashboard/levels/review` before they arm. User-created levels default to `auto_approved`. `ReviewBell` in header polls pending count.
- **Dashboard pages are force-dynamic**: All 10 DB-loading pages in `app/dashboard/**/page.tsx` export `const dynamic = "force-dynamic"`. Prevents `next build` from opening `data/vanguard.db` during static collection — critical for worktree builds where the main repo's dev server already holds the WAL lock. Pages query DB on every request anyway (live portfolio data), so zero perf cost.
- **useCallback render-loop trap**: `DataConfidenceIndicator` had `confidence` in its `useCallback` deps, which recreated the function on every state update, retriggered the polling `useEffect`, and caused ~300k requests/session. **Pattern to follow:** if a callback needs to read state but shouldn't depend on it, mirror the state to a `useRef` and read `.current` inside the callback. Same trap likely exists elsewhere — check any `useCallback` whose body reads state that the callback also sets.
- **Privacy-aware formatters**: never inline `${value.toFixed(2)}` for a user-facing dollar/percent/share amount. Use `<Money>` / `<Pct>` / `<Shares>` / `<Count>` from `@/lib/privacy/components`. For Recharts `tickFormatter` / `formatter` props, use `usePrivateFormatter((v) => fn(v))` which returns `•••` under privacy mode. Pure formatters (`formatUSD` / `formatPercent` in `lib/format.ts`) are still fine for LLM prompts, CSV exports, aria-labels, and other non-visual uses. When rendering a split visual (faint `$` glyph + big amber number, as in the Terminal hero and KPI row), pass `<Money precise bare>` — the `bare` prop drops the leading `$` so it doesn't duplicate the separately-rendered glyph.
- **Colored chips use `<Chip>`, not inline classes**: `app/dashboard/components/Chip.tsx` is the single source of truth for colored pills/badges (status indicators, sentiment chips, transaction-type labels, grade letters, etc). Tones: `up` / `down` / `gold` / `info` / `neutral` / `warn`. Sizes: `xs` (11px) / `sm` (12px, default). Always `font-medium` minimum, `/20` tint minimum. **Never** inline `bg-{color}/10 text-{color}` or the `-tint` / `-glow` tokens for chip text — that's the low-contrast pattern flagged 2026-04-22. See `memory/feedback_design_readability.md` for the readability rules.
- **Sortable table headers use `<SortableHeader>` + `useSortParam`**: `app/dashboard/components/SortableHeader.tsx` + `lib/hooks/useSortParam.ts` are the canonical primitives. Sort state lives in the URL with a per-table scope (`?holdingsSort=gain_pct&holdingsDir=desc`), never in component state. Tri-state click cycle: asc → desc → cleared (defaults back to the table's natural order). For card-list UIs without column headers (Alerts, LevelsPanel), use `<SortPicker>` — same hook, pill row. `compareValues()` in the hook file handles null-last, case-insensitive strings, and numeric sort. Never handroll sort state. Inside `MarketDataPanel` (or any Terminal-aesthetic container), pass `variant="terminal"` to `SortableHeader` for uppercase mono header styling; default variant stays in the rest of the app.
- **Terminal-aesthetic sections use `<TerminalSection>` + primitives**: shipped 2026-04-23 (`b099ba7`) on the Security Detail page. `app/dashboard/components/TerminalSection.tsx` exports `<TerminalSection title subtitle action dense>` (section chrome), `<TerminalTH>` (column header), `<TerminalTD align mono color>` (cell with hex-color override for gain/loss), and `<TerminalTag color variant size>` (filled or outlined colored block — NOT rounded pills). Palette: `#0d0d0d` container, `#1f1f1f` border, `#0a0a0a` table headers, `#161616` row dividers, `#888` for labels/dim text, `#ddd` for body, uppercase mono 11px with 0.18em letter-spacing for micro-labels. Use these primitives for any new section on the Security Detail page — don't hand-roll `<section className="rounded-xl border border-edge bg-panel overflow-hidden">`. This is the foundation for the future "light but not white" app theme with dark data modules embedded. Topic file: `memory/project_market_data_panel.md`.
- **`MarketDataPanel` is the self-contained dark data module**: `app/dashboard/components/MarketDataPanel.tsx` wraps the Security Detail page's hero (big amber price), chart, and LevelsPanel inside a scoped dark container with its own CSS variables. Does NOT use global Tailwind tokens (`bg-panel`, `text-ink`) — that isolation is intentional so the module stays dark when the surrounding app flips to a light paper palette. Hero sizes use `clamp()` + `rem`, NOT `fontSize: "Npx"`, so blanket font-size sweeps don't accidentally resize the hero. Chart color solution: current price = solid amber `#ffb84d` 2px (the only amber element), active S/R = solid emerald/rose 2px, suggested S/R = dotted 1px at 50% opacity, axis pills styled via `axisLabelColor` + `axisLabelTextColor` (LightweightCharts v5) — titles dropped from `createPriceLine` calls because the LevelsPanel below carries semantic context.
- **LightweightCharts v5 re-apply formatters on state change**: `localization.priceFormatter` and series `priceFormat.formatter` are read at chart/series creation and only re-read on subsequent `applyOptions`. When reactive state (e.g., `isPrivate`) must influence axis labels or marker text, you need an explicit `useEffect([state])` that calls `chart.applyOptions({ localization: { ... } })` + `volumeSeries.applyOptions({ priceFormat: { ... } })` + re-renders markers. Precedent: `SecurityChart.tsx` privacy-toggle effect.
- **`SettingsModal` is Electron-only**: gated on `if (!isElectron) return null;`. Invisible in plain browser / `npm run dev` on :3000. Settings file is at `~/Library/Application Support/Vanguard Dashboard/settings.json` (Electron display name, not slug) and can be hand-edited as a fallback.
- **Electron env-var threading for new settings**: any new `FOO_API_KEY` that code reads via `process.env.FOO_API_KEY` needs four touches to surface in the packaged DMG: (1) `AppSettings` interface in `electron/settings-store.ts`; (2) `bootstrapFromEnvLocal()` mapping from `.env.local`; (3) redacted display in `getSanitizedSettings()`; (4) `env.FOO_API_KEY = settings.fooApiKey` pass-through in `electron/main.ts::startServer()`. Optionally: a field in `SECTIONS` in `SettingsModal.tsx` for UI editing. Precedent: `pushoverAppToken` / `pushoverUserKey`.
- **Canonical CSV examples live in THREE places** that must stay in sync: `app/dashboard/components/CanonicalCsvGuide.tsx` (the Import-tab prompt generator — copy-paste target for Claude Co-Work preprocessing of Vanguard PDFs), `docs/canonical-csv-guide.md` (reference), and `tests/import/canonical-csv.test.ts` (fixtures). Two historical failures that motivated this rule: (1) a stray comma in the TSX DIVIDEND example pushed dividend amounts into `fees` instead of `amount`, silently zeroing the income card; (2) the prompt failed to specify that VMFXX `TRANSFER` rows carry a signed amount ("Sweep Into" positive, "Sweep Out Of" negative), so every sweep-out across 11 months of PDFs imported positive, inflating running-total views (201 rows SQL-repaired 2026-04-23). Whenever you add or edit a transaction-type example, update all three at once.
- **Compare timestamps with SQLite `datetime()` on BOTH sides, never as raw strings**: `research_articles.received_at` and similar columns are written via `datetime('now')` in space-separator form ("2026-04-22 22:53:41"). Caller-supplied filters often arrive in ISO-Z form from `new Date().toISOString()` ("2026-04-22T13:44:44.806Z"). Under raw string compare, space (ASCII 32) < 'T' (ASCII 84), so space-format timestamps sort earlier than T-format ones even when the actual moment is later — silently returning zero rows. Always wrap both sides in `datetime()` when comparing timestamps that may mix formats. Shipped 2026-04-23 (`57d9c26`) after the "send digest since last email" bug.

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
- `POST /api/calendar/sync` — SSE streaming: three phases — (1) WSH company events from TWS, (2) macro events (FOMC, CPI, jobs) from FRED/Claude, (3) Finnhub per-held-stock earnings scan (requires `FINNHUB_API_KEY`). Stores in `calendar_events` table.
- `GET /api/calendar/events?start=&end=&weekOf=` — read calendar events from DB
- `POST /api/calendar/briefing` — SSE streaming: generates weekly research briefing via Claude for all events in a given week. Includes Vital Knowledge market context if Gmail env vars set. Stores in `calendar_briefings` table.
- `POST /api/calendar/email` — generates briefing (if needed), converts markdown→styled HTML, sends via Gmail. Body: `{ weekOf?, to? }`. Requires `GMAIL_ADDRESS`, `GMAIL_APP_PASSWORD`, `BRIEFING_EMAIL_TO` env vars. Thin wrapper over `lib/digest/send-briefing.ts::sendBriefingEmail`.
- `POST /api/calendar/enrich` — post-release enrichment trigger. Body: `{ eventId?: number, upgradeReactionToTws?: boolean }` (omit eventId for window-filter sweep: unenriched rows whose `release_time` falls in `[now-2h, now-5min]`; set `upgradeReactionToTws: true` with a specific eventId to overwrite a cloud-sourced `reaction_snapshot` with a fresh TWS capture via `runTwsReactionUpgrade`). Accepts `X-Cron-Secret` header for Worker/launchd calls; trusted local UI calls without. Fire-and-forgets a call to `/api/calendar/reconcile-cloud-enrich` at the top so cloud-enriched KV payloads drain before the local runner decides who needs work. Runs `lib/calendar/enrichment-runner.ts::runEnrichment` which orchestrates `fetchActualForEvent` + `captureReactionFromTws` per candidate.
- `POST /api/calendar/reconcile-cloud-enrich` — Phase 9b Mac-side reconcile. Polls Worker's `GET /internal/cloud-enriched` for KV payloads written during Mac-off windows, upserts into `calendar_events` with TWS-always-wins precedence (existing `reaction_snapshot.source === "tws"` → skip reaction overwrite, still upsert actual+consensus), then DELETEs the KV key per reconciled event. No-op when `WORKER_MARKER_URL` or `CRON_SHARED_SECRET` is unset. Optional `X-Cron-Secret` header.
- `POST /api/cron/briefing` — cron-authenticated briefing trigger (X-Cron-Secret required, matches `CRON_SHARED_SECRET` env). Pre-checks Worker's `cloud-sent-*` marker via `lib/cron/marker-check.ts`. Called by the Cloudflare Worker's primary path and by the updated launchd wrapper `scripts/send-weekly-briefing.sh`. Same body as `/api/calendar/email`.
- `POST /api/cron/digest` — cron-authenticated digest trigger. Mirrors `/api/cron/briefing` for the daily digest. Called by the Worker + `scripts/send-daily-digest.sh`. Same body as `/api/digest/email`.
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
- `GET /api/watchlist` — list active watchlist items (includes `group_name`)
- `POST /api/watchlist` — add security to watchlist (by securityId or symbol). Accepts `groupName` for behavioral groupings ("vanguard_buy", "ibkr_buy_next", etc.)
- `PATCH /api/watchlist` — update price targets, thesis, or group_name
- `DELETE /api/watchlist?id=` — remove from watchlist (soft delete)
- `GET /api/levels?securityId=&activeOnly=true` — list price levels (per-security or all). Returns `effective_price` resolved from `ohlcv_bars` for MA-based levels.
- `POST /api/levels` — create or update a level. Body matches `UpsertLevelInput` (security_id, level_type, price, price_source, direction, action_hint, source, source_author, thesis, timeframe, expires_at, group_id, notes).
- `PATCH /api/levels` — update OR pass `{ id, action: "deactivate" | "reactivate" }` for state flips.
- `DELETE /api/levels?id=` — hard delete a level.
- `POST /api/levels/extract` — Claude scans recent unscanned `research_articles` for ticker+level mentions against held+watchlist symbols. Body: `{ sinceDays?, batchSize? }`. Auto-runs after `/api/research/sync`. Extracted levels insert with `review_status='pending_review'` — they don't arm until the user approves on `/dashboard/levels/review`.
- `GET /api/levels/review?countOnly=true` — list pending_review levels (newsletter-extracted, awaiting user approval), or just the count. Used by `ReviewBell` in the header.
- `PATCH /api/levels/review` — flip `review_status` for a pending level. Body: `{ id, status: "auto_approved" | "rejected" }`. Approve arms the level; reject keeps the row for audit but excludes it from scans.
- `GET /api/alerts?response=&securityId=&limit=&countOnly=true` — list level_alerts with enriched security + level info (includes `level.price_source` for MA-chip rendering), OR just the pending count.
- `PATCH /api/alerts` — update alert response (acted/ignored/dismissed) with optional note, or set `suggestedAction`.
- `POST /api/alerts/detect` — manual run of `detectAndFireAlerts` (the auto-refresh pipeline runs this automatically as Step 6).
- `POST /api/alerts/suggest` — Claude generates a one-sentence recommendation for an alert. Body `{ alertId? }` for single, otherwise fills all pending alerts without a suggestion.
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

- 9 tabs: Today, Overview, Accounts, Holdings, Analysis, Charts, Calendar, Research, Import
- **Chat** is a slide-out drawer (ChatDrawer.tsx) in the layout, toggled via header button or Cmd+J
- **Reconciliation** merged into Accounts tab as collapsible section
- **Notes** renamed to **Research** (redirect from /dashboard/notes)
- **Research** tab has 4 views: Notes | Trade Reviews | Feeds | Documents (newsletter articles + uploaded PDFs)
- **Holdings** tab shows cross-account positions with P&L and allocation %
- Old routes (/dashboard/notes, /dashboard/reconciliation, /dashboard/chat) redirect to new locations
- **Tab-subview dropdowns (desktop)**: tabs with `subviews` in `nav-tabs.ts` (currently Research + Analysis) render a caret ▾ next to the label; clicking opens `TabDropdown.tsx` — a menu of subviews with keyboard nav (ArrowDown opens, Arrow keys/Home/End cycle, Enter selects, Escape/outside-click close). Menu uses `position:fixed` + `getBoundingClientRect()` to escape the parent `<nav>`'s `overflow-x-auto` clip (absolute positioning gets silently cut off). Mobile keeps the in-page pill toggle (`ResearchViewToggle`, `AnalysisView` mode toggle — both gated `md:hidden`). `TabDropdown` reads `useSearchParams()` so it's wrapped in `<Suspense>` inside `TabNav.tsx` with a plain-`<Link>` fallback — required to keep static pre-rendering working for dashboard pages without `force-dynamic`.

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
- Macro event dates from FRED `releases/dates` API (authoritative); FOMC + ISM Mfg/Svc + UMich Sentiment + Conf Board Consumer Confidence dates hardcoded (publishers are not federal agencies, so not in FRED)
- Claude Sonnet used for enrichment only (descriptions, consensus estimates, impact ratings — never dates from scratch)
- **FRED release ID drift guard**: every entry in `RELEASE_MAP` has `expectedNameKeywords`; `releaseNameMatches()` skips + warns if FRED's `release_name` doesn't match. Verified against FRED `/releases` on 2026-04-18 — do NOT edit IDs without re-verifying (memory: `feedback_verify_external_truth.md`).
- **Reschedule verification (non-FRED)**: `verifyNonFredReschedules()` calls Claude with `web_search_20250305` against publisher calendars; if rescheduled, applies new date + stores `reschedule_verified_at` + `source_url` in event `raw_json`. On Claude error, falls back to hardcoded date (never regresses).
- **Sync-route cleanup**: `app/api/calendar/sync/route.ts` calls `deleteEventsForWeek(db, weekOf, "claude_macro")` before macro upsert. `source_key` includes the date, so without this a reschedule leaves an orphan row.
- Dividends/ex-dividends are filtered OUT of the calendar (user preference — too noisy)
- `lib/tws/wsh.ts` — WSH fetch with Promise wrapper, `lib/calendar/parse-wsh.ts` — defensive parser
- `lib/calendar/macro-events.ts` — FRED dates + non-FRED hardcoded schedules + Claude verify + Claude enrichment
- `lib/calendar/finnhub.ts` — per-held-stock earnings scan (source `finnhub`). Two-phase: `/calendar/earnings` per symbol → surprise history (`/stock/earnings` — free tier returns empty array, estimates-only is enough). 550ms pacing → ~35s for ~60 stocks. `FINNHUB_API_KEY` in `.env.local`.
- `lib/queries/briefing-symbols.ts` — `getHeldStockSymbols()` filters to `security_type IN ('stock', 'common stock')` across all accounts, latest date per account.
- `lib/calendar/briefing.ts` — weekly briefing via **Opus 4.7** (not Sonnet — this is the one email read most carefully). Reads FULL raw_text from 4 preferred weekend sources (Vital Knowledge id=1, Eliant Capital 18, Purple Drink's Market Musings 19, Helene Meisler 28), summary-level from other sources, surfaces expiring options + Finnhub earnings + macro events. 30k chars/article + 200k total cap keeps input cost ~$0.65/run.
- `lib/queries/research.ts::getFullTextForSources()` — fetches processed articles' raw_text for a source-id list over a lookback window.
- `lib/vital-knowledge.ts` — IMAP-based Vital Knowledge newsletter fetching (ported from Stock Contest)
- `lib/email.ts` — nodemailer Gmail sending utility; `lib/calendar/briefing-html.ts` — markdown→HTML for email
- Weekly briefings stored in `calendar_briefings` table, one per week (UNIQUE on `week_of`)
- **Email-route caching quirk**: `POST /api/calendar/email` does NOT regenerate if a briefing row already exists for the week. If you run `/sync` after a briefing was saved (e.g., new Finnhub events land), you must POST `/api/calendar/briefing` first to regenerate, then POST `/api/calendar/email`. Sunday automation isn't affected because sync fires before email.
- **Apple Calendar dormant code**: `scripts/read-calendar.swift`, `bin/read-calendar`, `lib/calendar/apple-calendar.ts` exist but are not wired into any route. Kept in case IBKR ever exposes per-calendar routing. `CalendarEventSource` still lists `"apple_calendar"` for the same reason.
- Automated emails via launchd plists in `~/Library/LaunchAgents/`:
  - `com.vanguard-skin.weekly-email.plist` — **Sunday 3 PM** (shifted from 5 PM 2026-04-19), week-ahead calendar briefing
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
- Project roadmap: in-repo shortlist at `docs/plans/TODO.md`; v2 build log archived at `docs/plans/archive/TODO-v2-complete-2026-03-30.md`

## What NOT to Change

These areas are working correctly and should not be refactored or "improved" unless I specifically ask:
- The import pipeline (Detect → Parse → Preview → Confirm → Commit)
- The Claude API PDF parsing integration
- The migration system
- The chat AI SDK integration (route.ts uses streamText, ChatInterface.tsx uses useChat)
