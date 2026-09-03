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
- **Email:** Resend SMTP for outbound (briefing/digest/earnings from `myportfoliodesk.com`); Gmail googleapis OAuth 2.0 + IMAP for inbound newsletter ingestion only
- **Testing:** Vitest
- **Desktop:** Electron (standalone Next.js + system Node.js for native modules)


## Architecture

**Stack** — Next.js App Router (server components load data, client components handle interactivity), SQLite at `data/vanguard.db` (WAL, foreign keys enforced), Electron desktop shell. Migrations are numbered `.sql` files in `lib/db/migrations/`, tracked in `schema_migrations`.

**Components**
- `app/` — routes. Desktop tabs: Today | Accounts | Analysis | Research | Charts | Import. `/dashboard/today` is the default landing (Electron `main.ts` loads it); `/dashboard/security/[id]` is the per-security hub; chat drawer (Cmd+J) and notes overlay (Cmd+;) are global.
- `lib/` — all logic: `db/`, `queries/`, `mutations/`, `compute/`, `ai/`, `calendar/`, `gmail/`, `research/`, `digest/`, `alerts/`, `earnings/`, `trade-review/`, `cron/`, `privacy/`, `storage/`.
- `workers/cron/` — Cloudflare Worker on a single `*/15 * * * *` trigger. Calls the Mac first; on failure it composes the email/alert itself from the nightly R2 state snapshot, coordinating via KV markers. See `docs/reference/cron-and-workers.md`.
- `electron/` — desktop shell. `settings-store.ts` + `main.ts` are touchpoints every new env var must thread through.

**Flow** — Live print-watch (2026-08-21): armed earnings worksheets also arm an in-process leased watcher that acquires the press release at print time (DJ wire / EDGAR / NVDA RSS / drop zone), dual-parses against bogeys, and fills a verify-then-promote sheet on Today — detail in `docs/reference/earnings-pipeline.md` §Print-watch. TWS connect triggers the full sync pipeline (also every 30 min); its Step 6 fires price-level alerts + Pushover. Gmail → research articles → digest / briefing / earnings emails. Calendar events are enriched post-release with actuals + reaction snapshots.

**Invariants**
- The Mac is source of truth; the Worker is fallback-only and reconciles back through KV. Worker mirrors (model tiers, prompt caps, enrich dispatch, push composer) are parity-pinned — change both sides.
- Never hardcode a model id. Features map to tier tokens in `lib/ai/models.ts`; resolve with `resolveFeatureModel(key).modelId`.
- Never import the db singleton into `lib/ai` — use the injection seams.
- ET wall-clock vs UTC: filter release windows in JS, never by SQL string compare.
- Every user-facing dollar / percent / share count renders through `lib/privacy/components.tsx`.
- Deep detail: `docs/reference/architecture-detail.md`.

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

On TWS connect, `lib/tws/auto-refresh.ts` runs a 6-step pipeline: sync portfolio (plus purge expired/closed/matured holdings and reconcile closed equities — snapshot-diff with a 50% shrink guard), enrich securities (plus sector/factor classification), snapshot prices, recompute valuations, benchmark prices (parallel), fire level alerts. Mutex via `isSyncing()`; UI polls `GET /api/tws/sync-status`. Background refresh every 30 min while connected; when disconnected the same timer fires the IBKR Web API fallback (ET market-hours gated; broker-only pricing — never introduce a third-party price source for held securities on this path). Data confidence scored across 5 dimensions (`lib/queries/data-confidence.ts`); `data_quality` on `daily_valuations` labels staleness.

Detail: `docs/reference/auto-refresh.md`

## Conventions

Detail: `docs/reference/conventions-detail.md`, `docs/reference/earnings-pipeline.md`.

**Data layer**
- Reads in `lib/queries/`, writes in `lib/mutations/`; every DB fn takes `db: Database.Database` (DI for tests).
- Deterministic `source_key` per imported record (re-import = no-op); every import writes an `import_batches` row (undo). CAVEAT (2026-08-19): the within-file `:#N` ordinal suffix defeats cross-source dedupe — a file containing a row twice (or a generated row duplicating a file row) imports the second copy as NEW under `:#2` even when the base key exists. Before appending generated rows to a canonical file, tuple-diff by (symbol, date, type, cents); after any bulk import, twin-audit new rows.
- Transaction types are UPPERCASE (BUY/SELL/DIVIDEND/…); `computeTaxLots` matches uppercase.
- Always `COALESCE(s.multiplier, 1)` — SQLite DEFAULT is bypassed by explicit `INSERT NULL`.
- Compare timestamps with `datetime()` on BOTH sides (`datetime('now')` is space-separated, `toISOString()` uses `T`).
- Latest holdings: `latestHoldingsPredicate` (`lib/queries/latest-holdings.ts`), per-(account, security) + `quantity != 0`. Never a global `MAX(as_of_date)`. Sweep completed 2026-08-30 (merge `893f8c0`) — a per-occurrence static guard (`tests/repo/no-handrolled-latest-holdings.test.ts`) now fails the suite on any new hand-rolled holdings MAX; add allowlist entries only with a justification.
- Statement wins over TWS/live rows in snapshot + holdings upserts; history reads exclude live sources via `excludeLiveSnapshotsSql()`.

**Dates & time**
- All dates `YYYY-MM-DD`. Monthly snapshots use last-day-of-month (TWS live snapshots use today).
- ET-anchor every user-facing "today"/week/outbound-email date: `todayET()`, `timeZone:"America/New_York"`. Never `new Date().toISOString().slice(0,10)`.

**Valuation & money**
- Market values via `adjustedMarketValueSQL()` (bonds ÷100, options ×multiplier, `LOWER()` matching).
- Prices/cost_basis store NATIVE currency; convert at read time (`getUsdPerUnit` / `COALESCE(fx.usd_per_unit,1)`). Any new $-rendering surface must thread the FX factor. Don't convert % returns, betas, Sharpe/vol/drawdown, benchmarks.
- Risk metrics are flow-adjusted (`lib/compute/flow-adjusted.ts`), never raw `daily_valuations` — a metric must be invariant to depositing $1M and buying nothing.
- Risk metrics are also SEAM-BRIDGED (2026-08-13): a day whose `monthly_snapshots` anchor source differs from the previous anchor's (statement↔plaid↔tws handoffs, go-lives) is a measurement-basis splice, not a market move — `fetchAnchorSourceSeamDates` + `buildFlowAdjustedIndex(…, seamDates)` carry the index flat and emit no return observation (`PortfolioRiskMetrics.seamDaysBridged` counts them). Cash-residual audits classify these days `source-seam`; never synthesize a flow row to "explain" a seam day (the repair script refuses to).
- Cash-equivalent identity is single-sourced: `isCashEquivalentSecurity` (`lib/compute/cash-equivalents.ts`, fund_category-driven) — never hand-roll `money_market` string lists (nine legacy copies disagree; see TODO). `daily_valuations` counts sweep funds as CASH, not holdings; statement-sourced bonds are carried into Plaid-snapshot days (2026-08-12).
- Holdings `source_key` prefix classes (statement-authority vs live) are single-sourced in `lib/db/holding-sources.ts` — never inline a `LIKE 'canonical:%'`-style match for source classification.
- **Per-pair "latest" holdings depend on the closed-position reconciler (2026-08-30):** `latestHoldingsPredicate` keeps a sold position's last non-zero row alive forever unless a `quantity = 0` tombstone supersedes it. `reconcileClosedEquityHoldings` (name is historical) runs THREE passes — statement book is complete (any type absent from the latest statement-sourced snapshot is closed, EXCEPT cash equivalents via `isCashEquivalentSecurity`, shrink-guarded statement-vs-statement); equities vs the latest live snapshot; options vs the latest live snapshot only when it carries ≥1 option row. Never narrow it back to stock/ETF, never let a live (Plaid/TWS) snapshot reconcile bonds/funds (those sources omit them), never widen a `MAX(as_of_date)` call site to per-pair without this reconciler in front of it. Tombstones (2026-08-31 hardening) are origin-suffixed (`:stmt`/`:live`), batch-owned when minted by an import for its own accounts, and orphan-cleaned (never wholesale-rebuilt) by `undoImport`/`restoreImportBatch` — see `docs/superpowers/specs/2026-08-30-reconciler-hardening-design.md`.

**Scoping**
- Scope-selector pages: every query respects `accountIds`; scopes are disjoint (`all = vanguard + roth + ibkr`). Never collapse a multi-account scope to `accountIds[0]`.
- Multi-account summed series doing return math must pass `fullCoverageOnly: true`.
- **Earnings coverage is EVENT-scoped (live print v2 slice A, 2026-09-03):** `coveredForEvents(db, rows)` (`lib/queries/briefing-symbols.ts`) = held/watchlist family-aware OR the event (or an unsuperseded same-symbol, same-date twin) carries an `earnings_worksheet_flags` row. Never hand-roll a `held || watchlist` selection gate — `tests/repo/symbol-status-consumers.test.ts` classifies every call site of the six coverage/status helpers and fails on an unclassified one. `SymbolStatus` `"armed"` is DISPLAY-ONLY (never `=== "armed"` in a selection file); the three push gates stay held/watchlist/read-through by user ruling.
- **Prepare steps (`registerPrepareStep`, `lib/earnings/prepare-armed-event.ts`):** `pending` = precondition not met (NOT an attempt; e.g. TWS down), `failed` = attempt, side effects must be idempotent upserts, long steps check `ctx.signal.aborted` between units of work; the runner caps at 5 attempts (takeovers included), races each step against a 4-minute deadline inside the 5-minute claim-stale window, budgets a pass at 5 minutes, and revives capped rows when their input fingerprint drifts. Run order is alphabetical by step name. The registries self-bootstrap through `lib/earnings/registry-bootstrap.ts` — never register at module top level (TDZ on the import cycle).

**Symbols & classification**
- Options use OCC symbols; `upsertSecurity` refuses stock↔option merges — AND refuses bond-like identity (incoming Bond/Mutual Fund type, name, derived maturity) onto a Stock/ETF row that has equity fills (2026-08-23 guard; the "U" Treasury-transcription corruption class). The weak-evidence rule is now two-directional: incoming 'Stock' never downgrades a fund-family type, incoming bond/fund identity never lands on an equity-fill security.
- Security-type repairs: `scripts/repair-security-type-corruption.ts` (config-driven from gitignored `data/repair-configs/`, dry-run default, all-or-nothing apply). ALWAYS rehearse `--apply` on a DB copy first via `REPAIR_DB_PATH`/`REPAIR_CONFIG_PATH` env overrides, running FROM THE REPO ROOT — running tsx scripts from another cwd breaks `@/` alias resolution for dynamic imports (transitively; caught live 2026-08-23).
- IBKR labels every STK contract 'Stock' (ETFs included) — an incoming 'Stock' is WEAK evidence: `upsertSecurity` never downgrades a fund-family type, and enrich promotes 'Stock'→'ETF' from contract-details `stockType`. Repair: `scripts/repair-etf-types.ts`.
- Compare security types case-insensitively; `mapSecurityType()` is the single source.
- Share classes roll up via `issuerSiblings()` — never symbol-string-equal.
- Sectors via `normalizeSector` (GICS-11: `"Technology"`, not `"Information Technology"`); fund categories via `normalizeFundCategory`. Never bucket a raw vendor string.

**AI / LLM**
- Never inline a model id — `lib/claude-models.ts` / `resolveFeatureModel(key)`.
- Guard `generateObject` array fields with `Array.isArray` before `.slice/.map/.join`; sanitize model prose + array fields at storage AND render.
- Parse LLM JSON via `extractJsonArray` + the C0-control-char retry. Join `web_search` text blocks with `""`, never `"\n"`.
- Cached AI narratives (`analysis_narratives`) carry an `input_fingerprint`; GET is read-only and reports drift (NULL = drifted) — regeneration only via explicit POST, never on a cache read.

**Privacy**
- Portfolio-derived numbers use `<Money>`/`<Pct>`/`<Shares>`/`<Count>`; public market data uses plain `formatUSD`/`formatPercent`. Wrap AI prose in `<PrivateText>`.
- Outbound email is DIRECTION-ONLY: no counts, no return %, no `cost_basis`/`quantity` in prompts.

**UI**
- Mutating handlers check `res.ok` AND `data.success`, explain no-ops in domain language, revert optimistic state, no empty `catch {}`.
- Use `<Chip>`, `<ScrollFade>`, `<SortableHeader>`+`useSortParam` (sort state in URL). `<dialog>` needs `m-auto`; headings need `whitespace-nowrap!`; text ≤17px needs 4.5:1; hover-only affordances are touch tap-traps.
- All DB-loading `app/dashboard/**/page.tsx` export `const dynamic = "force-dynamic"`.

**Invariants**
- Mac↔Worker mirrors (plausibility, presence-position, editions, print-push, anomalies, sector maps) are parity-pinned — change both files together.
- **Armed-event cloud parity (2026-09-03):** the Mac never writes KV. Every mutation that changes the armed projection writes one `cloud_outbox` row inside its transaction (D10: no-op when unchanged; the sweep tick also reconciles); the drain POSTs generations in order to `/internal/armed-events` and the Worker applies only strictly-greater generations over snapshot v11 (`armedEvents` + `armedGeneration`, 14-day live lookback, D7 tombstones). A restored DB with lower generations is refused until the `armed-events` KV key is deleted — the drain surfaces that as `send_error` "worker holds generation X > local Y". Deploy the Worker BEFORE the first v11 snapshot. Projection keys and the `armed` chip are parity-pinned (`workers/cron/test/armed-events-parity.test.ts`).
- `earnings_emails.error` is a tri-state; every new reader must exclude `'in_progress'`.
- Never edit a sync-owned calendar row's date/slot in place — the conflict clause re-clobbers it.
- `RECONCILE_CLOSE` is engine-owned: never parse, emit, or treat it as user activity.
- In-kind TRANSFER legs carry transfer-date FMV in `amount` (positive; type carries direction); routing-artifact legs are demoted via `donation_leg_links`, never deleted; cash stepping excludes in-kind legs (`excludeInKind`).
- Corporate actions have TWO modes keyed on `corporate_actions.source` (2026-08-12, #37): `'import'` rows are REPLAY-mode — `computeTaxLots` applies them chronologically (end-of-day: split-date sells process first), history is never rewritten, rows leave only via import-batch undo (manual DELETE 403s); `'manual'` rows are legacy REWRITE-mode and are EXCLUDED from the replay (replaying them would double-apply). Never convert one mode to the other in place. CA-only imports must not trigger the holdings-snapshot sweeps (`parsed.holdings.length > 0` gate). The delta cross-check persists to `reconcile_delta` (NULL = clean, refreshed every recompute) and renders via `<Shares>`.
- Preview-phase `earnings_emails`/`earnings_email_skips` rows only repoint to an event their send date could cover (`date(sent_at) >= date(event_date,'-1 day')`) — a preview is a promise about a specific print; dragging a stale one blocks `findEmailCandidates` forever. Recaps/bogeys repoint unconditionally.
- Level approval routes through `approveLevelGuarded` (409 `would_fire_immediately` + `force`); the guard and the scanner share `checkLevelTriggerState` — never fork the trigger-condition logic.
- Earnings accept-gate floors on the BMO/AMC slot (`deriveEarningsSlot`, AMC 16:00 ET / BMO 07:00 ET), never the stored `release_time` — an AMC name's release_time is often the CALL time. A `web_verified` AMC time ≥17:00 is a suspect call time and is never stored or trusted.

## Bug Fixes

When fixing bugs, verify the fix against the actual data/edge cases before declaring it done. Do not assume a calculation is correct — test with real values (e.g., holding periods, XIRR, bond pricing, portfolio valuations).

## Data Integrity

- NEVER hardcode or guess financial data (prices, dates, figures). Use authoritative sources (FRED, Hebcal, IBKR, Finnhub).
- Data missing/wrong → find the root cause (API response, DB query) before any UI workaround.
- User-facing numbers: `lib/format.ts::formatLargeUSD`/`parseLargeUSD`; Finnhub-shaped strings via `lib/format/finnhub-figure.ts` — never render raw.
- Risk-free rate: always `getRiskFreeRate(db)` — never hardcode 0.045.
- Never symbol-string-equal on user-visible surfaces — use `issuerSiblings()`.
- Finnhub: the symbol we QUERIED is canonical, never `entry.symbol`.
- Earnings recap requires `actual_value IS NOT NULL`; `enriched_at` is not sufficient. Better no email than a wrong one.
- **Tax exports are marker-gated NOT-FOR-FILING (2026-08-23 durable fixes — engine defect FIXED):** the bond ÷100 / short-column defects are fixed — `tax_lots.cost_basis`/`tax_lot_sales.proceeds`/`cost_basis_allocated` now store true economic dollars (`lib/compute/tax-lots.ts`). The `-NOT-FOR-FILING` banner clears per accepted (account, tax-year) via `getTaxConventionState`/`filingReady` (`lib/compute/tax-convention.ts`) — only by running `scripts/recompute-tax-lots-v2.ts --apply` then `scripts/reconcile-tax-report-vs-broker.ts --stamp` against real transcribed broker figures; never bypass the gate. Wash-sale W codes stay advisory permanently, pending 1099-B reconciliation. Detail: `docs/reference/data-integrity.md` §17.
- **TWR now has an independent cross-check lane (Modified Dietz, 2026-08-23 durable fixes):** `reconcileTwrAgainstStatements` compares the statement TWR against `computeMonthlyDietz` (ledger-derived, never `computeTwr`'s passthrough) — bands `consistent`/`investigate`/`not_comparable`/`insufficient`. Never re-add a blanket "reconciled ✓ / 0 bp" claim; UI copy must gate on `band === "consistent"`. Detail: `docs/reference/data-integrity.md` §18, `docs/reference/conventions-detail.md`.
- **Plaid/TWS-day cash is a timing residual, not literal cash** — `computeCashFlowResiduals` classifies those points `live-anchor-residual` (precedence: `source-seam` first); they are labeled, never score-capped, and NEVER proposal candidates for flow synthesis.
- **Real-figure docs go to `docs/private/` (gitignored) — the repo is PUBLIC.** Committed docs stay direction-only; repair constants (DB ids, amounts, source keys) live in gitignored `data/repair-configs/*.json` with synthetic fixtures in committed tests. Never undo import batches 56/58 (their undo deletes the 2026-08-23 repaired coupon rows).
- Guard any Finnhub `actual_value` surface with `isPlausibleEarnings`.
- **Table-rebuild migrations are rehearsed on a VACUUM copy of the live DB before deploy (088 precedent, 2026-09-03):** per-row ALL-column digest of the pre-migration columns before/after, `sqlite_sequence.seq` unchanged (carry it explicitly across a create-copy-drop-rename), every index recreated, `PRAGMA foreign_key_check` empty, `integrity_check` ok, plus an orphan pre-check on every FK the rebuilt table carries. A PRAGMA inside a migration is a no-op (runner transaction).
- **EDGAR acceptance times (2026-09-02):** the SEC submissions JSON `acceptanceDateTime` is Eastern wall-clock with a bogus `Z` while a filing is FRESH and true UTC after a later rebuild — never window-filter on it alone. `pollEdgar` prefilters on both readings and decides on the filing header's `<ACCEPTANCE-DATETIME>` (always ET). Detail: `docs/reference/earnings-pipeline.md` §Print-watch.
- Cached OLS betas (`security_betas`) publish only past a confidence gate — r² ≥ 0.10 and ≥30 return pairs (`betaConfidenceVerdict`); failing either DELETES the row rather than storing a marker (beta is NOT NULL; a missing row already means "no beta" to every consumer).
- TWS historical bars are SPLIT-ADJUSTED to today's share basis; statement-sourced prices/quantities are statement-date basis. Never mix bases: any bars→prices backfill must compare statement rows against same-date bar closes (integer ratio = a split) and normalize product-preserving (`scripts/repair-split-basis-2024-year-end.ts` precedent; generalized guarded form: `scripts/repair-split-basis-audit.ts`).
- Underlying splits RE-SYMBOL the listed options (strike re-struck: IBKR 4:1 140P→35P, XLU 2:1 100C→50C) — the activity report prints split legs under the ORIGINAL symbols, the statements under the new ones. Never leave a pre-split option row on the old symbol: move + normalize via `OPTION_RESYMBOL_TARGETS` in `scripts/repair-mistyped-option-legs.ts`.
- REDEMPTION rows (bond/bill maturity) carry NO per-share price — principal lives in `amount`; `computeTaxLots` derives the close price as `|amount|/qty×100` on the per-100-face bond basis (a bill redeeming at cost realizes $0 — the discount is INTEREST, not gain). Statement transcriptions must keep that shape (qty + amount, price empty).
- No-data sections render `<EmptySection>`, never a silent `return null`.
- Outbound email = Resend; inbound = Gmail IMAP/OAuth. Keep split forever.

Detail: `docs/reference/data-integrity.md`

## External APIs

When working with external APIs (TWS/IBKR, Gmail, FRED), check the correct API contract (parameter names, types, rate limits) before writing code. Do not guess field names like `symbol` vs `conId`.

## Dev Server Gotchas

- After changing any server-side code (SQL queries, API routes, server components), restart the dev server before testing. Next.js dev server caches server-side code aggressively — page refreshes alone won't pick up changes. Stale server code can also make errors appear on the wrong page.
- **Turbopack lock file**: If dev server crashes or terminal closes without Ctrl+C, a stale lock file prevents restart ("Unable to acquire lock"). Fix: `rm -rf .next` then `npm run dev`.
- **TWS stale connection after restart**: The old TCP socket to TWS lingers after dev server restart. New server gets `getCurrentTime timeout (5s)` because TWS is still holding the old client ID 1 session. Fix: in TWS, toggle Edit → Global Config → API → "Enable ActiveX and Socket Clients" off then on to drop stale connections.

## API Pattern

Full route catalog: `docs/reference/api-patterns.md`. Every new/edited route:

- **Thin wrapper.** Logic lives in `lib/…`; the lib fn is the single source of truth so in-process callers (email composers, crons) share it. Route = auth + parse + call.
- **Envelope.** `{success:true,data}` / `{success:false,error}`.
- **Auth.** `/api/cron/*` + enrich/reconcile routes: `X-Cron-Secret` mandatory — missing `CRON_SHARED_SECRET` env → 500, mismatch → 403. Never trust "local UI" or the inbound `Host` header. In-app routes take no cron auth. **Trust boundary (#35, 2026-08-14):** the app sits behind `proxy.ts`, the single choke point that default-denies every non-static route and classifies each `(method, pathname)` as public/human/service/dual — human routes require a DB-backed session + double-submit CSRF cookie, service routes require the cron secret or the Electron-main service credential. The Next server binds loopback-only (`127.0.0.1`); remote (phone) access is a named Cloudflare Tunnel + Cloudflare Access in front of that same login, never a second unauthenticated path. Full design: `docs/superpowers/specs/2026-08-14-packaged-app-trust-boundary-design.md`.
- **Streaming.** Long/multi-phase in-app work → SSE; cron/background twins → plain JSON.
- **Scope.** Multi-account: `resolveScope`, never `resolveScopeToSingleId`/first-id.
- **Counts.** `?countOnly=true` must use the identical predicate + window as the list response — badge and surface can never disagree.
- **Settings.** User prefs → `settings` key-value table (next cron tick picks them up; no restart, no Electron env threading).
- **Sync-owned rows.** Read-first-guard `source='manual'`; 403 edits to sync-owned rows so the next sync stays idempotent; earnings deletes suppress-then-delete.
- **Cached AI routes.** GET = cache read (bypasses rate limit on hit); POST = forced regen behind a per-scope rate limit.

## UI Structure

- 6 desktop tabs: Today | Accounts | Analysis | Research | Charts | Import. Chat is a persistent right rail ≥1280px (Cmd+J); Cmd+K is global ticker-jump; NotesAmbient overlay on Cmd+;. Old routes redirect.
- Mobile: bottom nav (5 icons), `md:` (768px) separates phone from desktop, `pb-safe` + `viewport-fit=cover` for iPhone. ChatDrawer renders at layout root — do NOT wrap in `hidden md:flex`.
- Security detail hub: `/dashboard/security/[id]` — every symbol links there via `SymbolLink`.
- Benchmark prices live in `benchmark_prices` (not `prices`); TWS `getHistoricalData` needs `conId`; risk metrics compute from `daily_valuations`; Sharpe uses `getRiskFreeRate`.

Detail: `docs/reference/ui-structure.md`

## Electron Build

- DMG build: `npm run electron:pack`. `dist/` must be cleaned first (the chain does it) — stale `dist/` causes recursive `.app` nesting during signing.
- ~~Stale `dist/` ALSO breaks `npx next build`~~ FIXED PERMANENTLY 2026-08-21: `"dist"` is in tsconfig excludes (the sweep bit twice in one day first).
- **Bundle integrity is gated (2026-08-21):** `electron:deploy` runs `scripts/verify-bundle.js` between pack and install — fails on repo-internal leaks (data/.git/qa/tests/docs — the REAL DB had shipped inside Resources/standalone since ≥8/19) or missing runtime pieces (next-server app-route runtime, @stoqey/ib/dist). NEVER add `outputFileTracingExcludes` to next.config.ts — its globs strip every NESTED dist/tests dir (gutted @stoqey/ib/dist → packaged black screen; next/dist runtimes → every API route 500). The bundle gate is the electron-builder.yml extraResources filter + the verify script; `electron:copy-static` also force-copies `next/dist/compiled/next-server/`.
- `npmRebuild: false` in `electron-builder.yml` must stay — it protects the working better-sqlite3 binary.
- Packaged-app server logs: `~/Library/Logs/Vanguard Dashboard/server.log` — first place to look for packaged-app issues.
- **Never run `wrangler dev` in the main checkout before a deploy (2026-09-03):** Next's output tracer copies `workers/cron/.wrangler/state/**` (local KV blobs) into `.next/standalone` when that directory exists; run the local Worker only from a sibling worktree and add the path to the bundle gate's leak list when next touched.
- **Never run git branch/worktree cleanup while `electron:deploy` is building (2026-09-02):** Next's output tracer copies `.git/**` refs for a few routes; deleting a branch mid-build logs `Failed to copy traced files … ENOENT` for each vanished ref. Harmless behind the bundle gate, but it muddies the deploy log — finish the deploy, then clean up.

Detail (signing, notarization, entitlements, tray icons, settings): `docs/reference/electron-build.md`

## Calendar

Week-ahead events + auto emails. Sources: WSH via raw `IBApi` (`reqWshEventData()`; IBApiNext has no wrapper), FRED `releases/dates`, hardcoded non-FRED (FOMC/ISM/UMich/ConfBoard), Finnhub earnings. Claude enriches only — never invents dates. Dividends excluded.

Tables: `calendar_events`, `calendar_briefings` (1/week), `calendar_event_suppressions`.
Files: `lib/calendar/{sync,macro-events,finnhub,briefing,briefing-html}.ts`, `lib/tws/wsh.ts`, `lib/email.ts`.

Rules:
- `syncCalendarForWeek` is the single ingest path; sync may only ADD — never wipe enriched rows.
- Never edit FRED release IDs without re-verifying against `/releases`.
- launchd: `StartInterval` + `scripts/lib/et-gate.sh` (ET wall-clock). NEVER `StartCalendarInterval`. A Worker dispatch minute must never equal the Mac's.
- Newsletter HTML: sandboxed iframe only, never `dangerouslySetInnerHTML`.
- `briefing-html.ts` + mirror `workers/cron/src/html.ts` change together.

Detail: `docs/reference/calendar.md`

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

Before the full suite, run `npm run verify:changed` to execute the smallest relevant checks for your diff, and `npm run verify:smoke` for UI-visible changes. The loop + evidence template: `docs/reference/verification-loop.md`.

## Debugging

When debugging data issues, investigate root causes rather than applying smoothing or workarounds. If the user says to fix the underlying data, do not paper over gaps.

## Testing

- Run tests: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run` — the project runs on the node@24 LTS keg (pinned by versioned path everywhere since 2026-08-11; the bare `/opt/homebrew/bin/node` moves on every `brew upgrade` and must never be relied on). better-sqlite3 ≥13 is N-API (one binary works across Node ≥22 and Electron), but keep the pin: Next/tooling behavior should not drift with Homebrew's default node. Same prefix for `npx tsx scripts/*.ts`. Still never `npm rebuild` casually — rebuilds are deliberate, full-suite-verified events.
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

## Reference Docs

Deep knowledge lives in `docs/reference/` — read the relevant file BEFORE working in that area:

- `docs/reference/conventions-detail.md` — full conventions: data layer, dates, ledger/tax lots, valuation/FX, scoping, sectors/factors, AI output handling, emails, connectors, levels/alerts, imports, UI, Electron
- `docs/reference/earnings-pipeline.md` — earnings enrichment, email sweep + claim mutex, print-sheet pipeline, recaps
- `docs/reference/calendar.md` — calendar sources, enrichment, briefing, launchd plists, newsletter ingestion
- `docs/reference/cron-and-workers.md` — Cloudflare Worker cron, Mac-first fallback, KV markers, R2 snapshot, worker mirrors
- `docs/reference/architecture-detail.md` — subsystem deep dives: UI shell, trade reviews, Calendar Living Record, research ingestion, AI model routing, cockpit
- `docs/reference/api-patterns.md` — full API route catalog (18 domains)
- `docs/reference/data-integrity.md` — integrity rules with full context and history
- `docs/reference/auto-refresh.md` — the full 6-step sync pipeline detail
- `docs/reference/ui-structure.md` — tab structure, mobile responsive, benchmark & risk detail
- `docs/reference/electron-build.md` — build, signing, notarization, tray, settings

## What NOT to Change

These areas are working correctly and should not be refactored or "improved" unless I specifically ask:
- The import pipeline (Detect → Parse → Preview → Confirm → Commit)
- The Claude API PDF parsing integration
- The migration system
- The chat AI SDK integration (route.ts uses streamText, ChatInterface.tsx uses useChat)
