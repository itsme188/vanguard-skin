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

- **Digest editorial contract (2026-09-17):** mirrored `lib/digest/synthesis-editorial.ts` and `workers/cron/src/synthesis-editorial.ts` own the takeaway-first policy, supplied-link whitelist and `splitDigestOpening`. Lead with a market-specific headline and substantive subhead; group shared sector stories, use company sections only for substantive commentary, and put citations at paragraph ends. No newsletter inventory, mandatory held-ticker filler, or production-process notes. Morning copy describes overnight developments without inventing a closing session. Both composers promote the opening ahead of metadata. Keep Mac/Worker parity.
- **Rules from the 2026-10-05/06 backlog run** (detail: `docs/DECISIONS.md` 2026-10-05 and 2026-10-06 entries):
  - **Mutating handlers** read the response through `readMutationResult` / `networkFailureMessage` (`lib/ui/mutation-result.ts`) — never a bare `res.ok` gate or raw `err.message`.
  - **Earnings time shown vs stored:** `displayEarningsTime` (`lib/calendar/display-earnings-time.ts`) is DISPLAY ONLY (estimate or "time unknown" for a slot-less vendor row). `tests/repo/display-earnings-time-consumers.test.ts` limits its importers to `app/**` and the Today releases query; no gate, sweep, email composer or Worker file may read it. A history-derived time is never STORED for a slot-less row (the accept floor, enrichment window and recap floor fall back to the stored time). **The pre-release chip may use the usual side (2026-10-08):** `preReleaseFloorET` (`lib/calendar/pre-release-actual.ts`) reads the row's own slot first, then the display-only usual side the page attached (`display_time.slot`), then a stored clock time; the chip and its timer (`app/dashboard/today/pre-release-clear.ts`) share it. Nothing is stored, and the save floor never reads the usual side (pinned as "THE CARVE-OUT" in `tests/calendar/pre-release-actual.test.ts`; do not widen it).
  - **Manual earnings add** has two guards with SEPARATE acknowledgements: `forceSlot` (slot contradicts the known time) and `force` (would supersede a vendor date). Never let one flag answer both. Since 2026-10-08 an edit (PATCH) runs the slot guard too, with its own `forceSlot`, when it changes the slot or the symbol and leaves the clock time to the server. An add onto a hand-entered row answers 409 before either guard, and no flag skips it: `manual_row_exists` (the row is showing) or `manual_row_hidden` (it is hidden; the message names the entry showing in its place, and the hidden row is not revived). `lib/calendar/manual-add-collision.ts` is the one reader. Guard: `tests/api/calendar-events-manual-add-gaps.test.ts`.
  - **Event actuals by id** go through the healed `getEventById` (`lib/queries/calendar.ts`); `tests/repo/calendar-event-actuals-healed-reader.test.ts` guards it. A cloud actual fills a missing local actual and never replaces one.
  - **Live options:** `liveOptionExpirationSql` / `isOptionLive` (`lib/compute/option-expiry.ts`) normalize legacy `YYYYMMDD` expirations — never compare an expiration string by hand.
  - **As-of computations bound every read by the as-of date** (`computePositionRisk`): holdings as of a past date with prices to today is look-ahead.
  - **Privacy:** unit nouns via `<QuantityUnit>`, editable figures via `<PrivateNumberInput>` (both `lib/privacy/components.tsx`).
  - **Tax convention pending:** `isTaxConventionPending` (`lib/compute/tax-convention.ts`) is the one fail-closed reader.
  - **Reconciliation roll-up** (`scripts/reconcile-tax-report-vs-broker.ts --rollup`) bridges row granularity only; equal row counts must match row-for-row.
  - **Recap modal** (`lib/earnings/recap-modal-generate.ts`): SSE phases, cancel reaches the AI request, at most two AI attempts, the SDK's own retries off on that path, a refusal or top-rung truncation is never retried.
  - **Source-pin tests** locate anchors with `anchorIndex` (`tests/helpers/source-anchor.ts`) so a vanished anchor fails loudly.
  - **Deploy order:** `npm run deploy` builds and gates first, quits the live app only before install, and relaunches the installed app if a later step fails.
  - **History rewritten 2026-10-06:** commit ids recorded in docs before that date are old ids; the old-to-new map is in gitignored `docs/private/`.
- **Unchecked integrity scan (2026-09-17):** `lotDriftChecked` distinguishes an unperformed scan from a clean result. Fresh prices do not imply reconciled tax lots; stale tax markers display Unchecked while critical/stale states retain precedence.

- **Trade-lot direction and review validity (2026-09-06):** preserve IBKR O/C and timestamps in transaction notes; replay lots chronologically with explicit long/short predicates. Never infer a short from an unmatched legacy sale. v3 tax convention requires fresh recompute and broker acceptance; deploying code does not authorize historical metadata backfill or repair. Saved-review pairing mismatches warn instead of silently rewriting AI prose. Runbook: `docs/reference/conventions-detail.md`. **Runbook order (2026-09-15):** the IBKR direction backfill (`scripts/backfill-ibkr-trade-direction.ts`, manifest of every `ibkr-activity` batch) runs BEFORE any tax-lot recompute — without direction evidence every historical short round-trip goes unmatched and the orphan pass mints synthetic closes with phantom gains; `recompute-tax-lots-v2.ts --verify-idempotent` keys sales by the synthetic close's autoincrement id and false-alarms NOT IDENTICAL on an idempotent book (prove with a `source_key`-keyed digest). A cash merger is transcribed as a SELL (only sells close lots); in-kind carryover lots are rewritten with `scripts/repair-inkind-transfer-lots.ts`.

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
- **FX rates have two writers only (2026-09-14):** the IBKR Web API ledger (`ibkr_ledger`, `lib/ibkr/refresh.ts`, authoritative, runs while TWS is disconnected) and `scripts/repair-fx-rate.ts` (`--from-ibkr` or `--usd-per-unit`, dry-run default). The TWS sync NEVER derives a rate — `Position.marketValue` is native currency (a yen position derived exactly 1.0), and `upsertFxRate` refuses any `*_derived` rate within 1% of parity for a non-USD currency. A missing rate reads as 1.0 everywhere (`COALESCE(fx.usd_per_unit,1)`), so never "fix" a placeholder by deleting the row.
- Risk metrics are flow-adjusted (`lib/compute/flow-adjusted.ts`), never raw `daily_valuations` — a metric must be invariant to depositing $1M and buying nothing.
- Risk metrics are also SEAM-BRIDGED (2026-08-13): a day whose `monthly_snapshots` anchor source differs from the previous anchor's (statement↔plaid↔tws handoffs, go-lives) is a measurement-basis splice, not a market move — `fetchAnchorSourceSeamDates` + `buildFlowAdjustedIndex(…, seamDates)` carry the index flat and emit no return observation (`PortfolioRiskMetrics.seamDaysBridged` counts them). Cash-residual audits classify these days `source-seam`; never synthesize a flow row to "explain" a seam day (the repair script refuses to).
- Cash-equivalent identity is single-sourced: `isCashEquivalentSecurity` (`lib/compute/cash-equivalents.ts`, fund_category-driven) — never hand-roll `money_market` string lists. The last five hand-rolled lists moved onto it (or its SQL twin) on 2026-10-07; the one type list left is the option-underlying filter in `lib/tws/option-underlyings.ts`, which also excludes cash and option types. `daily_valuations` counts sweep funds as CASH, not holdings; statement-sourced bonds are carried into Plaid-snapshot days (2026-08-12).
- Holdings `source_key` prefix classes (statement-authority vs live) are single-sourced in `lib/db/holding-sources.ts` — never inline a `LIKE 'canonical:%'`-style match for source classification.
- **Per-pair "latest" holdings depend on the closed-position reconciler (2026-08-30):** `latestHoldingsPredicate` keeps a sold position's last non-zero row alive forever unless a `quantity = 0` tombstone supersedes it. `reconcileClosedEquityHoldings` (name is historical) runs THREE passes — statement book is complete (any type absent from the latest statement-sourced snapshot is closed, EXCEPT cash equivalents via `isCashEquivalentSecurity`, shrink-guarded statement-vs-statement); equities vs the latest live snapshot; options vs the latest live snapshot only when it carries ≥1 option row. Never narrow it back to stock/ETF, never let a live (Plaid/TWS) snapshot reconcile bonds/funds (those sources omit them), never widen a `MAX(as_of_date)` call site to per-pair without this reconciler in front of it. Tombstones (2026-08-31 hardening) are origin-suffixed (`:stmt`/`:live`), batch-owned when minted by an import for its own accounts, and orphan-cleaned (never wholesale-rebuilt) by `undoImport`/`restoreImportBatch` — see `docs/superpowers/specs/2026-08-30-reconciler-hardening-design.md`.

**Scoping**
- Scope-selector pages: every query respects `accountIds`; scopes are disjoint (`all = vanguard + roth + ibkr`). Never collapse a multi-account scope to `accountIds[0]`.
- Multi-account summed series doing return math must pass `fullCoverageOnly: true`.
- **The Performance view reads the whole scope (2026-10-08):** the money-weighted return (`computeXirr` takes `accountIds`, `lib/compute/xirr.ts`; `GET /api/compute/xirr?scope=` passes the whole list), the risk tiles and the equity curve all read every account in the selected scope, never the first one. The curve starts at the first statement (`lib/compute/equity-curve-floor.ts`: for several accounts, the latest of their first statements; a live-only account sets no floor). No time-weighted return computation changed. OPEN owner question: a single account with stored monthly returns opens its chain on the first day of the month, every other case on the prior month-end, so the two branches differ by one day; the caption prints the date the return really uses (`lib/compute/performance-window-caption.ts`). Do not align the branches without a ruling: it moves a published figure. Guards: `tests/compute/xirr-scope-u13.test.ts`, `tests/compute/equity-curve-floor-u13.test.ts`, `tests/dashboard/performance-caption-u13.test.ts`.
- **Earnings coverage is EVENT-scoped (live print v2 slice A, 2026-09-03):** `coveredForEvents(db, rows)` (`lib/queries/briefing-symbols.ts`) = held/watchlist family-aware OR the event (or an unsuperseded same-symbol, same-date twin) carries an `earnings_worksheet_flags` row. Never hand-roll a `held || watchlist` selection gate — `tests/repo/symbol-status-consumers.test.ts` classifies every call site of the six coverage/status helpers and fails on an unclassified one. `SymbolStatus` `"armed"` is DISPLAY-ONLY (never `=== "armed"` in a selection file); the three push gates stay held/watchlist/read-through by user ruling.
- **Prepare steps (`registerPrepareStep`, `lib/earnings/prepare-armed-event.ts`):** `pending` = precondition not met (NOT an attempt; e.g. TWS down), `failed` = attempt, side effects must be idempotent upserts, long steps check `ctx.signal.aborted` between units of work; the runner caps at 5 attempts (takeovers included), races each step against a 4-minute deadline inside the 5-minute claim-stale window, budgets a pass at 5 minutes, and revives capped rows when their input fingerprint drifts. Run order is alphabetical by step name. The registries self-bootstrap through `lib/earnings/registry-bootstrap.ts` — never register at module top level (TDZ on the import cycle).

**Symbols & classification**
- Options use OCC symbols; `upsertSecurity` refuses stock↔option merges — AND refuses bond-like identity (incoming Bond/Mutual Fund type, name, derived maturity) onto a Stock/ETF row that has equity fills (2026-08-23 guard; the "U" Treasury-transcription corruption class). The weak-evidence rule is now two-directional: incoming 'Stock' never downgrades a fund-family type, incoming bond/fund identity never lands on an equity-fill security.
- Security-type repairs: `scripts/repair-security-type-corruption.ts` (config-driven from gitignored `data/repair-configs/`, dry-run default, all-or-nothing apply). ALWAYS rehearse `--apply` on a DB copy first via `REPAIR_DB_PATH`/`REPAIR_CONFIG_PATH` env overrides, running FROM THE REPO ROOT — running tsx scripts from another cwd breaks `@/` alias resolution for dynamic imports (transitively; caught live 2026-08-23).
- IBKR labels every STK contract 'Stock' (ETFs included) — an incoming 'Stock' is WEAK evidence: `upsertSecurity` never downgrades a fund-family type, and enrich promotes 'Stock'→'ETF' from contract-details `stockType`. Repair: `scripts/repair-etf-types.ts`.
- Compare security types case-insensitively; `mapSecurityType()` is the single source.
- Share classes roll up via `issuerSiblings()` — never symbol-string-equal.
- Sectors via `normalizeSector` (GICS-11: `"Technology"`, not `"Information Technology"`); fund categories via `normalizeFundCategory`. Never bucket a raw vendor string.
- **Transcript kind is single-sourced (2026-09-06):** `lib/transcripts/presentation.ts` — `transcriptKind`/`isFilingRow` (`edgar_8k` → filing), `hasDeskNote` (the summary carries a real AI desk note; pinned to agree with the store-time `isValidDeskNote` shape), `kindLabel`/`sourceLabel`/`transcriptCountLabel`. Never render the raw `source` token, never call an 8-K a "call"/"transcript", and never ship a filing WITHOUT a desk note in an outbound email (digest omits it; debrief skips it). Note identity lists are likewise single-sourced: `NOTE_TYPES`/`NOTE_SENTIMENTS` in `lib/types.ts` + `lib/notes/coerce.ts` — never an inline `["journal", …]` copy or an `as NoteType` cast on a query param.

**AI / LLM**
- Never inline a model id — `lib/claude-models.ts` / `resolveFeatureModel(key)`.
- Guard `generateObject` array fields with `Array.isArray` before `.slice/.map/.join`; sanitize model prose + array fields at storage AND render.
- **Frontier structured output rejects array count keywords (2026-09-22):** `generateObjectForFeature` requests native Anthropic structured output (the frontier family 400s on forced `tool_choice`). Native mode rejects `minItems` other than 0/1 and `maxItems` entirely (also numeric/string constraints, recursion). Schemas describe SHAPE; enforce counts in code after the call. `tests/ai/structured-output-schemas.test.ts` pins the two frontier schemas. The provider defaults an unknown (5-generation) id to 4,096 output tokens and thinking counts against it — every `generateObjectForFeature` caller passes an explicit `maxOutputTokens`.
- Parse LLM JSON via `extractJsonArray` + the C0-control-char retry. Join `web_search` text blocks with `""`, never `"\n"`.
- Cached AI narratives (`analysis_narratives`) carry an `input_fingerprint`; GET is read-only and reports drift (NULL = drifted) — regeneration only via explicit POST, never on a cache read.

**Privacy**
- Portfolio-derived numbers use `<Money>`/`<Pct>`/`<Shares>`/`<Count>`; public market data uses plain `formatUSD`/`formatPercent`. Wrap AI prose in `<PrivateText>`.
- Outbound email is DIRECTION-ONLY: no counts, no return %, no `cost_basis`/`quantity` in prompts.

**UI**
- Mutating handlers check `res.ok` AND `data.success`, explain no-ops in domain language, revert optimistic state, no empty `catch {}`.
- Use `<Chip>`, `<ScrollFade>`, `<SortableHeader>`+`useSortParam` (sort state in URL). `<dialog>` needs `m-auto`; headings need `whitespace-nowrap!`; text ≤17px needs 4.5:1; hover-only affordances are touch tap-traps.
- All DB-loading `app/dashboard/**/page.tsx` export `const dynamic = "force-dynamic"`.
- **A server page never imports a function from a `"use client"` file (2026-10-08):** the Data Health page crashed that way with the type-check and the whole suite green. Shared helpers live in a plain module (`lib/ui/data-confidence-level.ts`; `tests/dashboard/data-health-confidence-top.test.ts` pins that one boundary). Any new server-page import from a component file needs a look in a browser.
- **A question goes through the app dialog (2026-10-08):** `useConfirmPrompt` (`app/dashboard/components/useConfirmPrompt.tsx`): `if (!(await prompt.ask({...}))) return;`. Never add a native `confirm()` or `alert()`. The conflict marker, the bogeys modal and the live print row were moved over and are pinned (`tests/dashboard/today-week-tidy-u16.test.ts`); any component still on a native prompt moves when it is next touched.
- **A chip is one line unless `wrap` is passed (2026-10-08):** the `<Chip>` base carries `whitespace-nowrap`; a caller with a long label in a narrow parent passes `wrap` (the earnings conflict chip does). Chip tones are pinned for 4.5:1 contrast in both themes, computed from the theme tokens and the classes in `Chip.tsx` (`tests/dashboard/chip-contrast-nowrap.test.tsx`); the three tones that failed were corrected in the chip, and no theme token changed. **A base-class change needs a search for callers that override it:** the one-line change removed a deliberate exception elsewhere and only a test in another file caught it.

**Invariants**
- **Two hand-entered earnings rows for one company (2026-10-07):** the reconciler keeps both; for EMAIL the earlier date counts (`lib/earnings/manual-twin-email.ts`, mirrored byte-for-byte in the Worker and parity-pinned; change both and deploy both). Never add an email finder that skips this rule.
- **Scenario inputs are never defaulted (2026-10-07):** options reprice through `lib/compute/option-reprice.ts`, bonds take their duration from `lib/compute/bond-duration.ts`; a position that cannot be modelled is listed and counted, never given a fixed figure. Only bond FUNDS take a stated 5-year default, and only when `fundDefaultRefusal` (`lib/compute/bond-duration.ts`, the one reader, 2026-10-08) returns null: no equity evidence in the sector or name AND a bond-family fund category; a refused fund with equity evidence still takes the market move. Guard: `tests/compute/bond-fund-default-corroboration-d6.test.ts`. **A name that says the coupon floats, steps or follows an index is never given a derived duration (2026-10-08):** `isNotFixedCouponName` (`lib/bonds.ts`, the one reader of that word list) runs in `estimateBondRateLeg` BEFORE any coupon is read, stored or from the name, and the bond is listed with the reason `not-fixed-coupon`. A stored duration is still used as stored. A Treasury inflation-indexed note keeps its fixed real coupon; an issuer named with the whole word CMS is treated as not modelled (the safe side). The Fixed Income card reads the same rule through `lib/compute/fixed-income-exposure.ts` (`computeFixedIncomeExposure`), so the card and a scenario never show two durations for one bond; never read `securities.duration_years` alone for a display. Guards: `tests/compute/bond-duration-not-fixed-coupon.test.ts`, `tests/compute/fixed-income-exposure.test.ts`, `tests/api/compute-fixed-income.test.ts`. `lib/tws/bond-coupon.ts` is intentionally unwired (a repo test guards it). Detail: `docs/reference/conventions-detail.md`, `docs/reference/auto-refresh.md`.
- **Donation writes need an acknowledgement (2026-10-07):** every handler under `app/api/donations/[id]/` answers 409 `ledger_recompute_unacknowledged` without `acknowledgeLedgerRecompute: true` (`applyOrRehearse` / `ledgerRecomputeRefusal`, `lib/compute/donation-recompute.ts`); never add a path that recomputes silently. An implausible donated-lot basis has one predicate, `isDonatedLotBasisImplausible` (`lib/queries/giving-view.ts`), read by the row and the year total.
- **Basis-verified marker (2026-10-07):** `donatedLotBasisState` (`lib/queries/giving-view.ts`) is the one reader that decides whether a flagged donated lot counts; the marker in `lot_basis_verifications` snapshots the lot's cost basis and quantity acquired and goes stale when either changes. Marking never changes a tax input or triggers a recompute.
- **Enrichment account-level failures (2026-10-07):** classified in `lib/gmail/enrichment-failure.ts` and judged by the four rules on `processUnprocessedArticles` (`lib/gmail/process.ts`). An account-level failure alone in a pass is never counted toward `MAX_ENRICH_ATTEMPTS`; an unknown error is always counted.
- **An option's sector is a maintained copy of its underlying's (2026-10-07):** `lib/securities/classify-option-sectors.ts` fills and resyncs it on every classify run (`sector_source = 'underlying_inherited'`), never AI-first. Protected provenance (`csv_import`, `gics_verified`, `tws_bloomberg`, any verified or unstamped row) is never overwritten. **The trust strip's "Sectors classified" time means LAST CHECKED (2026-10-08):** the `settings` key `sector_classify_last_run_at` is written by a run that finished with no error (a run with nothing to do counts) and by `markOptionSectorsChecked` when a caller's free pre-check found no work (the full sync and `POST /api/compute/classify`). A run that hit an AI error does not move it, and no import writes it. Data Health lists held, live options whose underlying has no usable sector (`getOptionsWithUnsectoredUnderlying`, `lib/queries/data-health.ts`, read-only; the underlying is resolved by `lib/securities/underlying-sector.ts`, the same way the run resolves it). Guards: `tests/securities/classify-option-sectors-last-run.test.ts`, `tests/api/compute-classify-sector-check-time.test.ts`, `tests/queries/data-health-option-underlying-sector.test.ts`.
- **Arming and sending re-check at the write (2026-10-07):** every earnings send re-checks `superseded` inside `claimEarningsEmailSlot` through `emailRowRefusal` (`lib/digest/send-earnings-email.ts`) and again after compose; level approval and re-arm share one guard, `evaluateArmGuard` (`lib/alerts/arm-guard.ts`). Never fork either check. The row check has three answers (`EMAIL_ROW_REFUSALS`): `superseded_event`, `ignored_manual_twin`, and since 2026-10-08 `event_not_found` (no calendar row with that id; checked first, so a caller gets a plain refusal, status 404 from the send service, not a raw foreign-key error). Callers branch on `isEmailRowRefusal`, never on a list of reasons. The sweep books each under its own skip name (`entry-replaced`, `later-manual-entry`, `entry-not-found`, `lib/calendar/email-sweep.ts`); only a refusal with no code is `not-ready`. A debrief member deleted while the email is composed stops that run. Guard: `tests/earnings/event-not-found-send-path.test.ts`.
- **A hand-entered earnings row locks by its source; a sync never confirms it (2026-10-07):** the reconciler (`lockedStatusFor`, `lib/calendar/reconcile-earnings-dates.ts`) keeps an existing `user_confirmed` and writes none; only `lib/mutations/confirm-earnings-date.ts` writes it, and a hidden hand-entered row keeps a real one. Never key a lock or an edit entry point on `user_confirmed` alone. Guard: `tests/calendar/reconcile-manual-rows-a14.test.ts`.
- **Cash-equivalent identity has a SQL twin (2026-10-07):** `cashEquivalentSecuritySql` sits beside `isCashEquivalentSecurity` (`lib/compute/cash-equivalents.ts`) and `tests/compute/cash-equivalents-sql-u12.test.ts` pins parity; change both together. Live-sync sites use the type-only `cashEquivalentSecurityTypeSql`, so a fund labelled by category still gets a contract id and prices.
- **A level price is native currency: labelled, never converted (2026-10-07):** level rows carry `currency` (`lib/queries/briefing-levels.ts`); label with `formatLevelPrice` (`lib/chart/price-formatter.ts`), never a hardcoded dollar sign or an FX multiply. Guard: `tests/queries/briefing-levels-currency-u20.test.ts`. OUTBOUND text (briefing prompt, digest, pushes) goes through `formatOutboundLevelPrice` (`lib/alerts/outbound-level-price.ts`, 2026-10-08): locale pinned to `en-US`, import-free, hand-mirrored at `workers/cron/src/level-price.ts` and parity-pinned over `tests/fixtures/level-price-parity.json`; change both files together.
- **Recompute rehearses first (2026-10-07):** `rehearseTaxLotRecompute` (`lib/compute/tax-lot-recompute-summary.ts`) writes nothing and groups every figure by the year of the SALE, with open lots under no year; only an explicit confirm runs `applyTaxLotRecompute`. Guard: `tests/api/tax-lots-recompute-summary.test.ts`.
- **Linking a zero-amount gift leg stamps it (2026-10-07):** `linkDonationLegs` (`lib/mutations/donation-links.ts`) writes the gift's recorded fair value onto a still-zero in-kind OUT leg, under the repair script's guards and inside the acknowledged transaction; add no other path that stamps a leg. Guard: `tests/api/donation-links-u6.test.ts`.
- **The kept earnings row is not always Finnhub's (2026-10-08):** in the duplicate check, rows on ONE date go through `pickSameDateWinner` (`lib/calendar/reconcile-earnings-dates.ts`): a row with a real before-open or after-close slot beats one with only a vendor default time, before and after the print, and a hand-entered row wins a same-date tie. A kept Nasdaq or hand-entered row borrows vendor data from its hidden Finnhub twin through `createFinnhubDataCarrier` (never the slot, never actuals); a sync wipes that copy until the reconcile pass at its end, so a reader that cannot wait reads the twin itself with `findHiddenFinnhubDonor` (the consensus prepare step does). The weekly briefing lists the kept row whatever its source (`lib/calendar/briefing-partition.ts`, mirrored block in `workers/cron/src/fallback-briefing.ts`). Never assume the canonical row is Finnhub-sourced. Guards: `tests/calendar/reconcile-slot-beats-default.test.ts`, `tests/calendar/reconcile-carry-finnhub-data.test.ts`, `tests/earnings/consensus-row-donor.test.ts`, `workers/cron/test/fallback-briefing-partition.test.ts`.
- **The email finder's sibling check only removes (2026-10-08):** `phaseHandledOnSibling` (`lib/calendar/enrichment-runner.ts`) drops a preview or recap candidate when any same-company earnings row on that date already has that email or a recorded skip. It reads no state value and must never add a candidate. The Worker asks the same question of sibling rows (`siblingEventIndex`, `workers/cron/src/fallback-earnings.ts`); it cannot see a skip, because the snapshot ships none. Guards: `tests/calendar/findEmailCandidates-sibling-handled.test.ts`, `workers/cron/test/fallback-earnings-sibling-handled.test.ts`.
- **A feed earnings row behind a hand-entered row is stored hidden (2026-10-08):** `upsertCalendarEvents` (`createFeedRowHider`, `lib/mutations/calendar.ts`) hides it on insert and on update when exactly one showing hand-entered row holds that exact symbol and date; `restoreFeedRowOutsideWindow` brings one back when the hand-entered row is deleted or moved. A feed row on another date is left to the reconciler. Since the second half of the sprint the other direction is covered too: a hand-entered add (`insertCalendarEvent`) or an edit that moves a row onto a date (`updateCalendarEvent`) hides a showing feed row on that symbol and date in the same transaction, and writes the cloud outbox row. Guard: `tests/calendar/feed-row-hidden-behind-manual.test.ts`.
- **A feed row on a date the user removed never wins the duplicate check (2026-10-08):** the reconciler reads the removed-date list through `lib/calendar/event-suppressions.ts` (`getSuppressedEventTuples` / `suppressionKey`, the ONE reader of `calendar_event_suppressions`, shared with the feed upsert and the delete paths). Such a row cannot win its cluster (`resolveClusterHonouringRemovals`), so a refresh no longer brings it back. It still loses to the winner like any other row of its print, so its records follow the print; the one exception (`holdsBackRemovedPrint`) hides it without folding when that would copy a reported result onto a feed row for a print still ahead. Exact symbol and exact date; a hand-entered row is exempt by its source. Guard: `tests/calendar/reconcile-honours-suppressions.test.ts`.
- **Saving over a web-verified release time asks first (2026-10-08):** `POST /api/earnings/release-time` answers 409 `would_replace_web_verified` and stores nothing until the body carries `replaceWebVerified: true` (`checkUserSaveWouldReplaceWebVerified`, `lib/earnings/wire-times.ts`). The slot check runs first and has no bypass; the acknowledgement never answers it. A web-verified after-close time at or after 17:00 is a suspect call time and is replaced without a question. Guards: `tests/api/earnings-release-time.test.ts`, `tests/earnings/wire-times.test.ts`.
- **Confirming a different earnings date leaves one hand-entered row (2026-10-08):** `confirmEarningsDate` (`lib/mutations/confirm-earnings-date.ts`) moves the one other same-print row (same id) or, when the confirmed date already has a hand-entered row, folds it and deletes it only after `remainingEventDependents` finds nothing in ANY table that points at the event (the foreign keys cascade, so a delete never fails); otherwise the row stays hidden and the user is told. Guard: `tests/mutations/confirm-earnings-date.test.ts`.
- **One day-move rule (2026-10-08):** `computePositionDayMove` (`lib/compute/day-move.ts`) decides how quantity opened or added since the prior close is measured (from its cost; left out and counted when the cost is unknown). Today's IBKR line (`lib/queries/today-holdings.ts`) and the chat snapshot (`lib/queries/market-snapshot.ts`) both call it; never re-derive current quantity times close-to-close. Guard: `tests/compute/day-move.test.ts`.
- **One window rule for fixed performance periods (2026-10-08):** `resolvePerformanceWindow` (`lib/compute/performance-window.ts`) ends 1Y / 3Y / 5Y at the latest statement month-end every account in the scope has and covers the full span; the Performance view and the chat return tool read it. Pass `chainStartDate`, not `startDate`, to the return chain. Guard: `tests/dashboard/performance-window-b4.test.ts`.
- **No reaction before release plus two hours (2026-10-08):** the Mac runner and the Worker both gate capture on `REACTION_READY_MS` for every row, earnings and macro, and stamp `captured_at`. `lib/calendar/reaction-validity.ts` is the one place that says whether a stored leg is a measurement: the capture gate, the cloud reconcile and the on-screen chips read it, and every reader that turns a snapshot into text goes through `readReactionLegs`. Outbound text and prompts OMIT a pending leg; only in-app surfaces say "pending". Never print a leg's percent straight from `reaction_snapshot`. The push composer is import-free and carries its own copy of the snapshot-only part (Mac and Worker files; change both). The Worker's recap has its own copy of the leg rule, `workerReactionLegState` (`workers/cron/src/fallback-earnings.ts`): its scoreboard, its expected-move row and its recap gate (`evaluateRecapContent`: a pending leg is not a data point) read it, and a 900-case table in `workers/cron/test/fallback-earnings.test.ts` pins it against the Mac's `reactionLegState`; change both together and deploy the Worker. On the Mac, when no leg is measured the recap takes its "not captured yet" wording. Guards: `tests/calendar/reaction-validity.test.ts`, `tests/calendar/reaction-pending-text-readers.test.ts`, `tests/calendar/enrichment-runner-reaction-window.test.ts`, `workers/cron/test/calendar-enrich.test.ts`.
- **The Worker's fired-level marker is the Mac's audit record (2026-10-08):** `workers/cron/src/level-scan.ts` keeps `cloud-fired-level-{id}` seven days, carries earlier unreconciled fires in `earlier`, and puts the marker back when the push fails. The once-a-day guard is the Eastern day of the push (`firedAt`, plus the snapshot row's `triggered_at`), never the marker's lifetime. Needs snapshot schema version 12 (`currency`, `triggered_at` on level rows): deploy the Worker BEFORE the first v12 snapshot. Guards: `workers/cron/test/level-scan.test.ts`, `tests/alerts/reconcile-cloud-fired.test.ts`.
- **Digest window and theme week are single-sourced (2026-10-08):** `resolveDigestSince` / `defaultDigestSince` (`lib/digest/digest-window.ts`) are read by both senders and the Preview (guards: `tests/digest/digest-window.test.ts`, `tests/digest/send-evening-window.test.ts`); the macro-theme cache key is `currentThemeWeek`, and readers use `getCachedMacroThemesForNow` (`lib/compute/theme-week.ts`; guard: `tests/repo/no-utc-theme-week.test.ts`). Both are Eastern-anchored; never slice a UTC date for either. The Preview and the Send panel also share ONE window choice (`app/dashboard/components/digest-window-choice.ts`, client-safe, default "Today's articles"), so the preview shows the window a send would cover; a date mode with no date picked acts on neither. Guard: `tests/dashboard/digest-preview-window-mirrors-send.test.ts`.
- **A scheduled digest that found nothing new says so (2026-10-08):** the skip branch of `sendDigestEmail` records the reason in `settings` (`last_digest_skip`, `lib/digest/digest-skip.ts`, scheduled since-last-email window only; a later send does not clear it). `GET /api/digest/status` returns it as `lastDigestSkip`, and `decideDigestBanner` (`lib/digest/catchup-banner.ts`, pure) is the one rule for the catch-up banner: a skip recorded today at or after the scheduled time reads "nothing new to send" with no Send button; an earlier skip says nothing about the schedule. Guards: `tests/digest/catchup-banner.test.ts`, `tests/api/digest-status.test.ts`.
- **A recap scoreboard prints dashes; every other page keeps its fill-in boxes (2026-10-08):** the shared renderer (`lib/calendar/briefing-html.ts`, mirrored in `workers/cron/src/html.ts`) decides by the scoreboard HEADING: a page with a "scoreboard — post-print" heading and no "scoreboard — into the print" heading is a recap (`usesFillInBoxes`). The headings are written by the two composers (Mac `renderHeadlineTable`, Worker `renderScoreboard`). Rewording either heading means changing both composers and both renderers together, then deploying the Worker first. Guards: `tests/calendar/briefing-html-tables.test.ts`, `tests/digest/earnings-intel-render.test.ts`, `workers/cron/test/html.test.ts`.
- **One sign and one basis for an open lot (2026-10-08):** `lotSideSignSql` and `remainingLotBasisSql` (`lib/queries/tax-lots.ts`) are the only copies. The Tax Lots page, the chat summary (`lib/queries/portfolio-summary.ts`) and the chat tax-lot tool (`lib/queries/chat-tools.ts`) all compute an unrealized figure as sign times (current value minus the fee-inclusive basis of the quantity still open). Never rebuild the basis from quantity times acquisition price (that drops capitalized fees), and never sign a short lot by hand. A short lot is never long-term and never "approaching long-term": the engine books every short close as short-term. Guards: `tests/queries/chat-tools-short-lots.test.ts`, `tests/queries/portfolio-summary-short-lots.test.ts`, `tests/queries/chat-lot-basis-parity.test.ts`.
- **The lot integrity scan compares lots with the statement (2026-10-08):** `scanLotDriftHits` (`lib/queries/integrity-checks.ts`) compares open lots with the pair's newest statement-grade holdings row (`statementGradeHoldingSql`), or zero when the pair has none. When the ledger is newer than the statement, the lots are first rolled back to the statement date (`rollLotsBackToStatement`: later ledger rows and import-sourced splits undone, newest first); a mismatch there is critical. A difference seen only in live data is a `statement-lag` WARNING ("pending statement") and never caps the score; so is a pair the roll-back cannot do exactly, and its reason says so. An account with no statement book keeps the old any-source comparison. Currency-conversion lots are skipped. KNOWN LIMIT (pinned): duplicate rows dated after the last statement cannot be told from a real purchase whose sale is not yet imported. The file is classified `exclude` in `tests/repo/synthetic-close-consumers.test.ts` (it names the engine close type only to undo one). Guards: `tests/queries/integrity-checks-statement-positions.test.ts`, `tests/queries/integrity-checks-lot-rollback.test.ts`.
- **A bogey row counts for a composer only when that composer prints something from it (2026-10-08):** on the Mac the prompt block and its context go through `bogeysPrintedInPrompt` (`lib/earnings/bogey-prompt-entries.ts`), and the sheet table through `sheetBogeysWithCells`, both over `getBogeysWithContentForEvent`; in the cloud `resolveBogeysForEvent`, `hasBogeys` and `renderBogeysBlock` go through `snapshotBogeysPrinted` (`workers/cron/src/bogey-content.ts`). "Claims bogeys are included" and "prints them" must come from one list. The vendor EPS consensus is printed and labelled as the vendor's. `getBogeysForEvent` stays UNFILTERED on purpose: the edit modal must list an empty row so it can be deleted. One documented difference: the snapshot does not carry `extra_metrics_json`, so an extras-only row is an entry on the Mac and not in the cloud. Guard: `tests/earnings/bogey-content-worker-parity.test.ts`.
- **A level expires at the end of its Eastern day on the Mac (2026-10-08):** every Mac reader of `expires_at` binds `todayET()` as a parameter (`lib/queries/security-levels.ts` via `armedTodayParam()`, `lib/queries/briefing-levels.ts`, the nightly snapshot script), as the Worker already did. Never compare an expiry with SQLite `date('now')` (the UTC day). Global search labels a level price in the security's own currency with `formatLevelPrice` and never converts it. Guards: `tests/queries/level-expiry-eastern-day-q12.test.ts`, `tests/api/search-level-currency-q12.test.ts`.
- Mac↔Worker mirrors (plausibility, presence-position, editions, print-push, anomalies, sector maps) are parity-pinned — change both files together.
- **Armed-event cloud parity (2026-09-03):** the Mac never writes KV. Every mutation that changes the armed projection writes one `cloud_outbox` row inside its transaction (D10: no-op when unchanged; the sweep tick also reconciles); the drain POSTs generations in order to `/internal/armed-events` and the Worker applies only strictly-greater generations over snapshot v11 (`armedEvents` + `armedGeneration`, 14-day live lookback, D7 tombstones). The payload also carries top-level `supersededEventIds` for replaced earnings rows in that 14-day lookback so cloud preview / recap / wrap / today's-reporters paths stay quiet after the Mac outbox drains. A restored DB with lower generations is refused until the `armed-events` KV key is deleted — the drain surfaces that as `send_error` "worker holds generation X > local Y". Deploy the Worker BEFORE the first v11 snapshot. Projection keys and the `armed` chip are parity-pinned (`workers/cron/test/armed-events-parity.test.ts`).
- `earnings_emails.error` is a FIVE-value state column single-sourced in `lib/earnings/email-states.ts` (`NULL` / `in_progress` / `sending` / `sent-by-cloud` / `delivery_unknown`); every new reader goes through `isLiveClaim` / `notLiveClaimSql` / `deliveredSql`, never a literal — `tests/repo/no-handrolled-email-states.test.ts` fails on one. Every earnings email is sent by `lib/earnings/send-service.ts::sendEarningsCandidate`; only `debrief-send.ts` may claim a slot itself (the stapled-wrap sender was retired and deleted 2026-10-08).
- Never edit a sync-owned calendar row's date/slot in place — the conflict clause re-clobbers it.
- `RECONCILE_CLOSE` is engine-owned: never parse, emit, or treat it as user activity.
- **Synthetic closes need statement evidence (2026-10-02):** the broker-close pass anchors on the newest statement-grade holdings row (`statementGradeHoldingSql`); a live-only flat is "pending statement" (`getPendingStatementPairs`), never a saved close. Live-only writes must not bump `tax_input_generation`. Never classify holdings origin with an inline LIKE.
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
- **IBKR statement sections are per-currency blocks — never read an Amount column as dollars (2026-09-03).** Each block is the native rows, a native `Total`, then IBKR's own `Total in USD`. `parseIbkrActivity`'s Interest loop converts through that line and keeps the native figure in the note AND the source key (so re-importing an older statement dedupes); a non-USD block with no conversion line is SKIPPED with a warning, never stored at native magnitude. The Dividends / Fees / Deposits & Withdrawals loops convert the same way since 2026-10-05 (`emitCurrencyBlocks`); a non-USD block with rows of BOTH signs is skipped with a warning (the net-over-net ratio is not a rate), and Withholding Tax rows are not imported at all. The non-USD layout of those three sections was assumed from the Interest layout — confirm against a real statement the first time one appears.
- **A monthly statement's "Unsettled activity" is imported in its OWN month (2026-09-04).** The next statement does NOT re-list those trades in Completed — verified against the August statement. Skipping them leaves the sales out of the ledger entirely and `computeTaxLots` masks the hole with a synthesized `RECONCILE_CLOSE`. Detail + the corrected gate order: `.claude/skills/import-monthly-statements/SKILL.md` Phase 5.
- Earnings recap requires `actual_value IS NOT NULL`; `enriched_at` is not sufficient. Better no email than a wrong one.
- **Tax exports are marker-gated NOT-FOR-FILING (2026-08-23 durable fixes — engine defect FIXED):** the bond ÷100 / short-column defects are fixed — `tax_lots.cost_basis`/`tax_lot_sales.proceeds`/`cost_basis_allocated` now store true economic dollars (`lib/compute/tax-lots.ts`). The `-NOT-FOR-FILING` banner clears per accepted (account, tax-year) via `getTaxConventionState`/`filingReady` (`lib/compute/tax-convention.ts`) — only by running `scripts/recompute-tax-lots-v2.ts --apply` then `scripts/reconcile-tax-report-vs-broker.ts --stamp` against real transcribed broker figures; never bypass the gate. Wash-sale W codes stay advisory permanently, pending 1099-B reconciliation. Detail: `docs/reference/data-integrity.md` §17.
- **TWR now has an independent cross-check lane (Modified Dietz, 2026-08-23 durable fixes):** `reconcileTwrAgainstStatements` compares the statement TWR against `computeMonthlyDietz` (ledger-derived, never `computeTwr`'s passthrough) — bands `consistent`/`investigate`/`not_comparable`/`insufficient`. Never re-add a blanket "reconciled ✓ / 0 bp" claim; UI copy must gate on `band === "consistent"`. Detail: `docs/reference/data-integrity.md` §18, `docs/reference/conventions-detail.md`.
- **Plaid/TWS-day cash is a timing residual, not literal cash** — `computeCashFlowResiduals` classifies those points `live-anchor-residual` (precedence: `source-seam` first); they are labeled, never score-capped, and NEVER proposal candidates for flow synthesis.
- **Real-figure docs go to `docs/private/` (gitignored) — the repo is PUBLIC.** Committed docs stay direction-only; repair constants (DB ids, amounts, source keys) live in gitignored `data/repair-configs/*.json` with synthetic fixtures in committed tests. Never undo import batches 56/58 (their undo deletes the 2026-08-23 repaired coupon rows).
- Guard any Finnhub `actual_value` surface with `isPlausibleEarnings`.
- **Finnhub `Rev 0` is a placeholder, resolved at the PARSE layer (2026-09-06):** `parseFinnhubFigure` returns `revenue: null` for an exact 0 (EPS 0 stays real); `formatFinnhubFigure` falls back to the raw string ONLY for free text with no `EPS`/`Rev` token, so a token never leaks to a surface. The Worker mirrors (`workers/cron/src/todays-reporters.ts::formatCompactConsensus`, `fallback-earnings.ts`) are parity-pinned to the same fixture set — change both sides.
- **OHLCV bars are guarded on write (2026-09-06):** `upsertOhlcvBars` skips any bar with a non-finite / non-positive open-high-low-close or `high < low` (zero volume is fine), warns once per call, and returns `{inserted, rejected}`; `get52WeekRange` aggregates and dates over priced bars only. Readers go through `PRICED_BAR_SQL` (`lib/queries/ohlcv.ts`); `tests/repo/no-raw-ohlcv-bars-read.test.ts` fails on a new raw read of `ohlcv_bars` (2026-10-05 audit). `lib/tws/benchmark.ts` reads its bar fallback through the same filter (2026-10-07); no hand-rolled positive-close filter remains there. The stored zero bars themselves are not repaired.
- **Test fixtures never carry a real figure (2026-09-06):** the nightly fixer copied an account balance out of the gitignored ledger into a committed test; every landing review scans test diffs for 7+ digit / comma-grouped numbers, and a PR whose commit carries one is cherry-picked with a synthetic fixture, never merged.
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
- **`next build` in a worktree with no `data/vanguard.db` fails spuriously** ("database is locked", then "UNIQUE constraint failed: schema_migrations.filename" on retry): page-data workers race to migrate the fresh throwaway DB. Seat an already-migrated copy (e.g. the coord sandbox's `vanguard.db`) in the worktree's gitignored `data/` first. Not reproducible in the main checkout.
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
- **Manual earnings dates that would supersede a vendor date on another week are refused with 409 `would_supersede_vendor`** (POST and PATCH on `/api/calendar/events`, `checkManualAddWouldSupersedeVendor` — a read-only dry run of the reconciler, `excludeEventId` for edits) unless the body carries `force: true`; `force` never bypasses the sync-owned 403. `POST /api/earnings/correct-date` is deliberately not gated (it names the wrong date explicitly). The same route's other 409s (2026-10-08): `manual_row_exists` / `manual_row_hidden` (no flag skips them), `slot_contradicts_known_time` on POST and PATCH (`forceSlot` only). `POST /api/earnings/release-time` answers `slot_mismatch` (no bypass) and `would_replace_web_verified` (`replaceWebVerified: true`). Each acknowledgement answers one question only. Full list: `docs/reference/api-patterns.md`.
- **Cached AI routes.** GET = cache read (bypasses rate limit on hit); POST = forced regen behind a per-scope rate limit.

## UI Structure

- 6 desktop tabs: Today | Accounts | Analysis | Research | Charts | Import. **Today is six blocks: header · Portfolio strip · Releases · Earnings Hub · chat button · a one-line IBKR snapshot** (alerts, nearby levels, the cockpit and the print panel were removed by live print v2 slice F; Significant Moves + Momentum Pulse live on Analysis · Diagnostics). An armed Hub row expands in place into `LivePrintRow`. Chat is a persistent right rail ≥1280px (Cmd+J); Cmd+K is global ticker-jump; NotesAmbient overlay on Cmd+;. Old routes redirect.
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
- **`npx wrangler deploy` leaves an empty `workers/cron/.wrangler/` folder (2026-10-08):** the Mac deploy's pre-flight refuses to build while it exists. When deploying the Worker first and the Mac second, remove that folder in between.
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

- **Coordination (2026-09-08):** two agents, one Mac — `docs/reference/coordination.md` is the shared workflow. `npm run inbox` first (who is waiting on whom: open `decision` records, `USER:`/`CODEX:`/`CLAUDE:`-labeled `next_action`, open PRs, stale ownership); a question only the user can answer becomes a `decision` record so it outlives the task. Register every task in the shared register before editing (`npm run coord -- task register …`), checkpoint at milestones with a labeled `--next`, land only under the `integration` lock, deploy only through `npm run deploy` (locked wrapper; never an improvised script), browser-verify through `npm run sandbox` + `npm run smoke` (own DB copy, own port, `browser` lock). State lives in the register (`$(git rev-parse --git-common-dir)/portfolio-desk-coord`, shared by all worktrees); reasoning lives in the Markdown handoffs.
- **Session-end ownership (2026-09-06):** explicit session-end invocation authorizes the receiving agent to verify, commit, push, integrate its work, and deploy the reviewed result. Preserve concurrent work; discussions and summaries do not invoke shipping. Shared workflow: `.claude/session-end.md`; global approval rules have the same exception.

After implementing a fix or feature, always run the full test suite (`npx vitest run`) and report the result before committing. This project has 1600+ tests — use them. Report the test count and pass/fail status. Do not commit if tests are failing.

Before the full suite, run `npm run verify:changed` to execute the smallest relevant checks for your diff, and `npm run verify:smoke` for UI-visible changes. The loop + evidence template: `docs/reference/verification-loop.md`.

## Debugging

When debugging data issues, investigate root causes rather than applying smoothing or workarounds. If the user says to fix the underlying data, do not paper over gaps.

## Testing

- Shared verification: `bash scripts/verify.sh changed --base <integration-base>` covers committed branch changes plus staged, unstaged and untracked files; omit `--base` for working-diff mode. Run `full --base <integration-base>` once at completion and `typecheck` separately. Evidence binds HEAD and dirty contents; a commit or edit makes older evidence stale. See `docs/reference/verification-loop.md`.
- Claude Code hooks read stdin JSON (there is no `CLAUDE_FILE_PATHS`). Stop checks `scripts/verify.sh status --base main` even for clean branches; a missing runner or missing/stale evidence blocks once, then reports unresolved status without looping. Recovery is `bash scripts/verify.sh full --base main`. Logs are isolated by worktree and session. Post-edit checks are read-only, edited-file-only, with no per-edit `tsc`.
- Run tests: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run` — the project runs on the node@24 LTS keg (pinned by versioned path everywhere since 2026-08-11; the bare `/opt/homebrew/bin/node` moves on every `brew upgrade` and must never be relied on). better-sqlite3 ≥13 is N-API (one binary works across Node ≥22 and Electron), but keep the pin: Next/tooling behavior should not drift with Homebrew's default node. Same prefix for `npx tsx scripts/*.ts`. Still never `npm rebuild` casually — rebuilds are deliberate, full-suite-verified events.
- All tests use in-memory SQLite (`:memory:`) for isolation
- **A hand-built test schema must carry the real columns (2026-10-08):** a test that creates its own cut-down table fails only in the full suite, when a query starts reading a column it lacks. Prefer the migrated schema; run the full suite before a merge even when every unit's own tests pass.
- **launchd / cron scripts run `npx tsx` FROM THE REPO ROOT** — `cd` first (or wrap in `(cd "$PROJECT_DIR" && …)`): tsx resolves the `@/` alias off the tsconfig it finds from cwd, so an absolute script path launched from launchd's cwd dies with `Cannot find module '@/lib/…'`. Bit twice: the repair-script rehearsal (2026-08-23) and the 2 AM smoke, which ran zero authenticated checks 08-31 → 09-03 because its mint failed this way.
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
