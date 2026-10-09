> Archived from CLAUDE.md on 2026-08-10. All facts preserved; read when working in this area.
> Cross-reference map for former CLAUDE.md pointers: *Earnings print-sheet pipeline* and *notes-are-sacred* → `earnings-pipeline.md`; *calendar-event-suppressions* → `calendar.md`; *deferred-minors TODO* → `conventions-detail.md`.

# API Pattern

Full route catalog for the vanguard-skin Next.js API. Grouped by domain; every route,
parameter, env var, table, helper, date, and rationale from the original CLAUDE.md
`## API Pattern` section is preserved below.

> Note on cross-references: several entries say "see the ... convention above" or
> "see notes-are-sacred above". Those pointed at sibling sections of the original
> CLAUDE.md (Earnings print-sheet pipeline, notes-are-sacred, calendar-event-suppressions,
> deferred-minors TODO) and are kept verbatim.

---

## Table of contents

- [Expected guard refusals (409)](#expected-guard-refusals-409)
- [Import & compute](#import--compute)
- [Chat](#chat)
- [TWS / IBKR](#tws--ibkr)
- [Calendar, briefing & enrichment](#calendar-briefing--enrichment)
- [Cron-authenticated triggers](#cron-authenticated-triggers)
- [Settings](#settings)
- [Compute & analytics](#compute--analytics)
- [Analysis](#analysis)
- [Reports, search & benchmarks](#reports-search--benchmarks)
- [Status & summary](#status--summary)
- [Watchlist](#watchlist)
- [Price levels](#price-levels)
- [Alerts](#alerts)
- [Trade review](#trade-review)
- [Research](#research)
- [Digest & email](#digest--email)
- [Earnings](#earnings)
- [Plaid](#plaid)

---
- Print watch (live print v2)

## Expected guard refusals (409)

A guard that refuses an action the user can still choose answers **409 with nothing written** and
an inline message beside the control. These are designed outcomes, not failures:
`POST /api/earnings/release-time` `slot_mismatch` (no bypass) and `would_replace_web_verified`
(until `replaceWebVerified: true`); `POST /api/earnings/actuals`
`pre_print` (the caller offers `force`); `POST /api/earnings/correct-date` refusals;
`POST /api/reconciliation` `checkpoint_exists`; `POST /api/research/documents` on a duplicate
upload; `POST` / `PATCH /api/calendar/events` `would_supersede_vendor` (`force`) and
`slot_contradicts_known_time` (`forceSlot`); `POST /api/calendar/events` `manual_row_exists` and
`manual_row_hidden` (no flag skips them); `PATCH /api/levels`
`{ action: "deactivate" }` on a level that is not armed; `POST /api/earnings/confirm-date` on a
past or too-distant date; `POST /api/earnings/email` on the later of two hand-entered entries for
one company (2026-10-08, no flag skips it). The browser logs
"Failed to load resource" for any non-2xx response, so each of these leaves a console line; the QA
sweep should not file them as console errors.

---

## Import & compute

- `POST /api/import?mode=preview` — parse only, return preview JSON.
- `POST /api/import?mode=commit` — parse and commit to database.
- `POST /api/compute/valuations` — recompute daily valuations.
- `POST /api/compute/tax-lots` — recompute tax lots (FIFO).

---

## Chat

- `POST /api/chat` — AI SDK v6 `streamText` with the `@ai-sdk/anthropic` provider.
  - Model/config: Opus 4.7, adaptive thinking, ephemeral cache control, `stopWhen: stepCountIs(8)`.
  - Client uses `useChat` from `@ai-sdk/react`.

---

## TWS / IBKR

- `POST /api/tws/connect` — connect to TWS, then start the sync pipeline. Body (all optional):
  `{ host?, port?, clientId? }`. An empty or unparseable body means "connect with the stored
  settings".
  - **400s (2026-10-08), nothing connected, `{ success: false, error }`:**
    - `body must be a JSON object`: the body parsed to null, text, a number or an array.
    - `clientId must be a whole number`: anything other than a whole number from 0 to 999. Zero is
      allowed (the TWS master client id).
    - the allowed-target check's own message, when the host or port (as sent, or the stored one)
      is not an allowed TWS target. A host that is not text or a port that is not a number is
      refused here too.
  - An omitted or null `host`, `port` or `clientId` keeps the stored value. The key is not passed
    on, so an omitted client id never blanks the stored one.
  - Test: `tests/api/tws-connect-body-shape.test.ts`.
- `POST /api/tws/positions` — SSE streaming: sync live IBKR positions + account summary from TWS.
- `POST /api/tws/chart` — OHLCV bars for per-security charting.
  - Supports daily (cached in `ohlcv_bars`) and intraday 1m/5m (live from TWS, **not** cached).
  - Returns transactions for BUY/SELL markers.
- `GET /api/tws/option-chain?symbol=` — option chain expirations + strikes from TWS.
- `GET /api/tws/stream` — SSE: streaming live quotes for current holdings.
- `POST /api/tws/stream` — control streaming: `{ action: "stop" | "snapshot" }`.
- `GET /api/tws/sync-status` — current auto-refresh pipeline state (status, phase, progress, last sync result).
- `POST /api/tws/auto-refresh` — trigger sync pipeline.
  - Body: `{ level?: "full" | "quick" }`. Default: full.
  - Quick = snapshot prices + valuations only.

---

## Calendar, briefing & enrichment

### `POST /api/calendar/sync`

SSE streaming wrapper around `lib/calendar/sync.ts::syncCalendarForWeek(db, weekOf, opts)`, the
three-phase ingest:

1. WSH company events from TWS.
2. Macro events (FOMC, CPI, jobs, GDP, PCE) from FRED + hardcoded non-FRED schedules + Claude.
3. Finnhub per-held-stock earnings scan (requires `FINNHUB_API_KEY`).

The library function is the single source of truth — it is also called in-process by
`sendBriefingEmail` so Sunday's briefing always has fresh week-ahead data (extracted 2026-04-27
after the 4/26 briefing missed PCE + Q1 GDP because the briefing path only ran TWS sync).
Stores in the `calendar_events` table.

### `GET /api/calendar/events?start=&end=&weekOf=`

Read calendar events from DB.

### `POST /api/calendar/briefing`

SSE streaming: generates weekly research briefing via Claude for all events in a given week.
Includes Vital Knowledge market context if Gmail env vars set. Stores in the `calendar_briefings` table.

### `POST /api/calendar/email`

- Generates briefing (if needed), converts markdown → styled HTML, sends via Resend
  (`From: briefing@myportfoliodesk.com`).
- Body: `{ weekOf?, to? }`.
- Requires `RESEND_API_KEY`, `RESEND_FROM_DOMAIN`, `BRIEFING_EMAIL_TO` env vars.
- Thin wrapper over `lib/digest/send-briefing.ts::sendBriefingEmail`.
- **`sendBriefingEmail` runs `runAutoRefresh(db, "quick")` after the positions sync** (as of
  2026-05-12, commit `e4ad876`) — snapshot prices + valuations recompute (~2-3 min). Best-effort:
  failures log but do not block the briefing.
- Also logs `[send-briefing] Latest price as_of_date: YYYY-MM-DD (Nd old)` to launchd logs as a
  freshness probe — staleness investigations now have a breadcrumb instead of starting from scratch.

### `POST /api/calendar/enrich` (service) / `POST /api/calendar/enrich-manual` (human)

Post-release enrichment trigger. Split into two routes 2026-08-14 (packaged-app trust boundary #35,
task 4) — both are thin wrappers around the shared
`lib/calendar/enrich-request.ts::runCalendarEnrichRequest(db, opts)` entrypoint, so behavior is
identical; only the auth wrapper differs.

- Body (both routes): `{ eventId?: number, upgradeReactionToTws?: boolean }`.
  - Omit `eventId` for a window-filter sweep: unenriched rows whose `release_time` falls in
    `[now-2h, now-5min]`.
  - Set `upgradeReactionToTws: true` with a specific `eventId` to overwrite a cloud-sourced
    `reaction_snapshot` with a fresh TWS capture via `runTwsReactionUpgrade`.
- **`POST /api/calendar/enrich` — service path.** Wrapped in `lib/cron/wrappers.ts::withCronAuth`:
  missing `CRON_SHARED_SECRET` env → 500; `X-Cron-Secret` mismatch → 401 (constant-time compare).
  Used by the launchd wrapper and the Workers Cron primary path.
- **`POST /api/calendar/enrich-manual` — human path.** No cron secret required. For a manual
  "re-enrich this row" UI action — a human browser session will never carry the service secret. Not
  yet session-gated (the session proxy lands in a later task of #35); until then it is open like any
  other pre-boundary route.
- Both routes read `CRON_SHARED_SECRET` from server-side env (never from the request) to call
  `reconcileCloudEnrichment(db, secret)` first, draining cloud-enriched KV payloads — hardened
  2026-04-27 (Codex critical-bug-pass) so the reconcile fetch's target URL is never built from the
  inbound `Host` header, which would leak the secret to a caller-controlled origin. Then runs
  `lib/calendar/enrichment-runner.ts::runEnrichment`, which orchestrates `fetchActualForEvent` +
  `captureReactionFromTws` per candidate.

### `POST /api/calendar/reconcile-cloud-enrich`

Phase 9b Mac-side reconcile.

- Polls the Worker's `GET /internal/cloud-enriched` for KV payloads written during Mac-off windows,
  upserts into `calendar_events` with TWS-always-wins precedence (existing
  `reaction_snapshot.source === "tws"` → skip reaction overwrite, still upsert actual+consensus),
  then DELETEs the KV key per reconciled event.
- **Auth: `withCronAuth`** — missing `CRON_SHARED_SECRET` → 500; mismatch → 401.
- No-op when `WORKER_MARKER_URL` is unset.

### `POST /api/calendar/events` (PATCH, DELETE also)

CRUD for manually-curated calendar events.

- POST body:
  `{ symbol, event_date, event_type='earnings', event_time?='AMC', release_time?, expected_impact?, consensus_estimate?, description? }`
  — inserts row with `source='manual'`,
  `source_key='manual:SYMBOL:DATE:TYPE'`, `week_of` derived from `event_date`, `release_time`
  auto-derived 08:00/16:15 from BMO/AMC.
- **POST refusals, in order (each writes nothing).** Typed-input checks first: 400
  `invalid_symbol`, 400 `invalid_date`. Then:
  1. 409 `manual_row_exists` (with `existingEventId`): a hand-entered row already shows on that
     symbol, date and type. Edit it instead.
  2. 409 `manual_row_hidden` (with `hiddenEventId`, `replacedByEventId`, `replacedByDate`): the
     hand-entered row on that tuple is hidden. The message names the entry showing in its place.
     The hidden row is not revived. (2026-10-08; `lib/calendar/manual-add-collision.ts`.)
  3. 409 `slot_contradicts_known_time`: the chosen slot contradicts the symbol's known release
     time. `forceSlot: true` inserts and stores the slot default time.
  4. 409 `would_supersede_vendor`: the add would take a live vendor date in another week off the
     calendar. `force: true` inserts.
  No flag skips 1 or 2. `forceSlot` answers only 3 and `force` only 4, so one add can be refused
  twice in sequence, each time with its own reason.
- **POST success** returns `{ success, id, securityMatched, hiddenFeedRows }`. `hiddenFeedRows`
  (2026-10-08) is the number of showing feed rows on that symbol and date that the add hid in its
  own transaction.
- PATCH read-first-guards on `source='manual'` and 403s sync-owned rows so a stray edit can't
  corrupt the next sync's idempotency. That 403 runs first; no flag bypasses it.
- **PATCH runs both guards too.** `would_supersede_vendor` runs when `event_date` changes
  (`force`). `slot_contradicts_known_time` (2026-10-08) runs when the body names a different slot,
  or a new symbol while the row keeps a before-open or after-close slot, and leaves the clock time
  to the server (`forceSlot`; `force` never answers it). When that check runs the release time
  follows the slot. A PATCH that keeps the slot and the symbol is never checked. A row moved onto
  a date where a feed row shows hides that feed row in the same transaction. Test:
  `tests/api/calendar-events-manual-add-gaps.test.ts`.
- DELETE (2026-07-26 `9cade35`): manual rows delete directly; sync-owned EARNINGS rows
  suppress-then-delete via `deleteAndSuppressCalendarEvent` (see the calendar-event-suppressions
  convention); symbol-less macro rows stay 403.
- Used by the Earnings Hub `+ Add ticker` form + per-row ✕ on `/dashboard/today`.

---

## Cron-authenticated triggers

All routes below (plus the 4 enrich/reconcile routes above) are wrapped in
`lib/cron/wrappers.ts::withCronAuth` (consolidated 2026-08-14, packaged-app trust boundary #35 task
4) — missing `CRON_SHARED_SECRET` → 500; `X-Cron-Secret` mismatch → 401 (constant-time compare). This
is the full 10-route "service" set per `lib/auth/route-policy.ts`'s `CRON_ROUTES`.

- `POST /api/cron/briefing` — cron-authenticated briefing trigger. Pre-checks the Worker's `cloud-sent-*` marker via
  `lib/cron/marker-check.ts`. Called by the Cloudflare Worker's primary path and by the updated
  launchd wrapper `scripts/send-weekly-briefing.sh`. Same body as `/api/calendar/email`.
- `POST /api/cron/digest` — cron-authenticated digest trigger. Mirrors `/api/cron/briefing` for the
  daily digest. Called by the Worker + `scripts/send-daily-digest.sh`. Same body as
  `/api/digest/email`.
- `POST /api/cron/evening` — cron-authenticated evening-email trigger.
  - Body: `{recipient?, footerNote?}`.
  - Pre-checks Worker `cloud-sent-evening-{date}` marker; sets/clears `mac-running-evening-*` marker.
  - Calls `sendEveningEmail(db)`, which composes via `generateDigestSinceAdaptive` with
    `includeAnomalies: true`.
  - Called by `scripts/send-evening-email.sh` launchd wrapper.
  - **2026-05-14**: also calls `confirmMacSent("evening")` after successful send to write
    `mac-sent-evening-{date}` on the Worker (skips Worker catch-up retry sweep). Sibling routes
    briefing + digest do the same.
- `POST /api/cron/research-sync` — see [Research](#research).
- `POST /api/cron/earnings-sweep` — see [Earnings](#earnings).
- `POST /api/cron/plaid-sync` — see [Plaid](#plaid).

---

## Settings

- `GET /api/settings/email-recipients` + `PATCH /api/settings/email-recipients` — per-email
  recipient overrides stored in `settings` (keys: `briefing_email_recipients`,
  `digest_email_recipients`, `evening_email_recipients`).
  - Helpers in `lib/queries/email-recipients.ts::getRecipientsFor(db, type)`.
  - Composer precedence: `opts.recipient` > settings override > `BRIEFING_EMAIL_TO` env.
  - Settings UI in `EmailRecipientsSection.tsx` slotted into `SettingsModal`.
- `GET /api/settings/earnings` + `PATCH /api/settings/earnings` — earnings-emails user prefs.
  - Stored in the existing `settings` key-value table (`earnings_emails_enabled` +
    `earnings_emails_muted_symbols`) so changes apply to the next 15-min cron sweep without an app
    restart — no Electron env-var threading.
  - Helpers in `lib/queries/earnings-settings.ts` (`getEarningsSettings`, `setEarningsEmailsEnabled`,
    `setMutedEarningsSymbols`, `shouldSendEarningsEmail`).
  - Settings UI section in `EarningsEmailsSection.tsx` slotted into `SettingsModal`.
- `GET /api/settings/plaid` + `PATCH /api/settings/plaid` — see [Plaid](#plaid).

---

## Compute & analytics

- `GET /api/compute/xirr?startDate=&endDate=&accountId=|scope=` — compute XIRR for arbitrary date
  ranges. An explicit `accountId` is one account. A named `scope` is its WHOLE account list: one
  money-weighted return over every account in it, never the first account alone (2026-10-08).
  `all` or no scope is every account. Test: `tests/compute/xirr-scope-u13.test.ts`.
- `GET /api/compute/risk?startDate=&endDate=&accountId=|scope=` — portfolio risk metrics (drawdown,
  volatility, Sharpe, Herfindahl). The week-ago comparison point is counted from the Eastern day
  (2026-10-09); it was a day late between 20:00 and midnight Eastern.
- `GET /api/compute/position-risk?accountId=|scope=&topN=10` — per-position volatility, risk
  contribution, correlation matrix.
- `GET /api/compute/factors?accountId=|scope=&benchmark=SPY` — market beta regression + portfolio
  tilts (size, style, sector, geography). An explicit `accountId` is one account; a named `scope`
  is its WHOLE account list, never the first account alone (2026-10-08). The week-ago comparison
  is counted from the Eastern day. Test: `tests/api/compute-factors.test.ts`.
- **One rule for `accountId` and `scope` on these routes.** `accountId` is one account. `scope`
  goes through `resolveScope`: `all` or no scope is every account, a named scope is every account
  in it. The single-id helper that took the first account of a scope was deleted on 2026-10-08.
  Known gap, an open owner question: a named scope that matches no account also resolves to
  "every account" (see `conventions-detail.md` §E).
- `GET /api/compute/scenarios?accountId=&scenario=` — scenario modeling (9 presets: crash, rate
  shocks, rally, sector rotation).
- `POST /api/compute/scenarios` — custom what-if scenario.
  Body: `{ marketMove, rateMove?, sectorMoves?, volMove?, name? }`.
  - **Inputs are bounded on the server (2026-10-08).** A market move, a rate move or a sector move
    outside its bound, or one that is not a finite number, answers **400** with a sentence naming
    the field and its range; nothing is clamped. The bounds live in
    `lib/compute/scenario-input-bounds.ts` (`SCENARIO_INPUT_BOUNDS`, `customScenarioBodyProblem`)
    and the custom form reads the same file for its input limits. `marketMove` and each sector
    move are decimal fractions; `rateMove` is basis points. Test:
    `tests/api/scenarios-route-validation.test.ts`.
- `GET /api/compute/fixed-income?scope=` — bond exposure: weighted avg duration, credit quality
  breakdown, bond positions. Thin wrapper over `computeFixedIncomeExposure`
  (`lib/compute/fixed-income-exposure.ts`); the whole scope, individual bonds only.
  - **Durations come from the scenario rule (2026-10-08)**, `estimateBondRateLeg`, not from the
    stored column alone. New fields per bond: `durationSource` (where the duration came from; null
    when not modelled), `unmodelledReason` (why there is none; null when there is one),
    `couponSource` (`broker` or `name`, set only when a coupon decided the outcome). `couponRate`
    is still the stored coupon.
  - **New top-level fields:** `asOfDate` (the Eastern date every duration and the maturity filter
    were judged on), `measuredBondValue`, `unmeasuredBondValue`, `unmeasuredBondCount`,
    `derivedBondCount` (durations worked out, not read from a stored figure).
  - `weightedAvgDuration` covers only the bonds that have a duration and is null when none has.
    A bond that cannot be modelled is still listed, with no figure.
  - Test: `tests/api/compute-fixed-income.test.ts`.
- `GET /api/compute/options-greeks?accountId=` — portfolio + per-position Greeks (delta, gamma,
  theta, vega, IV).
  - **Returns `diagnostics: GreeksDiagnostic[]`** alongside positions — entries explain why specific
    positions couldn't compute Greeks
    (`no_underlying_price | expired | missing_iv | missing_option_price`);
    rendered as a collapsible block in `OptionsGreeksCard`.
  - Query uses a per-(account, security) latest `as_of_date` CTE + `quantity != 0` (short positions
    surface) — see Slice A of Analysis Deep Dive P1 (commit `b4483a4`).
- `GET /api/compute/options-expirations?scope=&days=90` — positions expiring within `daysWindow`
  (default 90); DOES NOT require a Greeks compute.
  - Backed by `lib/compute/options-expirations.ts`.
  - Replaces the prior pattern where `ExpirationCalendar` chained off
    `/api/compute/options-greeks` and inherited its bugs.
  - Multi-account scope resolution via `resolveScope` — Expirations renders across all accounts
    in a scope, not just the first.
  - A live contract whose expiry is stored in the compact `YYYYMMDD` form is listed too
    (2026-10-09); before, it was missing. The rows return the dashed date.
- `GET /api/compute/options-strategies?accountId=|scope=` — detected option strategies (covered
  calls, spreads, etc.). A named `scope` reads every account in it (2026-10-08; it used to read
  the first one). Strategies are still detected account by account and then joined
  (`detectStrategiesPerAccount`, `lib/queries/options.ts`): shares in one account never cover a
  call written in another. Test: `tests/api/options-strategies-scope.test.ts`.
- `GET /api/compute/reconciliation?accountId=|scope=` — cost basis reconciliation: broker-reported
  vs computed. It checks one account at a time: a scope of two or more accounts answers **400**
  with a sentence saying so, and never picks one.

---

## Analysis

### `GET /api/analysis/trust-state?scope=`

Data-quality state for the Analysis page Trust Strip (factor coverage / last classify / independent
TWR cross-check / stale prices / bond duration). Single-shot query in
`lib/queries/analysis-trust-state.ts::getAnalysisTrustState`.

- **`crossCheckedThru`** (renamed from `performanceReconciledThru`, number-trust durable fixes,
  2026-08-23) — the latest month such that EVERY account has an unbroken chain of
  `consistent`/`not_comparable` Modified-Dietz bands from its own second statement month through that
  month; `investigate`, `insufficient`, or a missing calendar month breaks the chain (any account that
  fails or can't be evaluated forces the rollup null — same strict "all accounts agree at least
  through this month" semantic as before, now backed by the independent cross-check instead of a
  statement-self-reference).
- **`perAccountReconciliation[].bandHistory`** — the full walked per-account chain, one entry per
  calendar month (`{monthEndDate, band, divergenceBp}`, or `band: "missing"` for a month with no
  statement row) — backs the trust-drawer's month-by-month chip row. Band definitions:
  `docs/reference/conventions-detail.md`'s TWR cross-check contract; engine:
  `lib/compute/twr-reconcile.ts` + `lib/compute/dietz.ts`.

### `GET /api/analysis/defense?scope=`

Defense/Hedging analysis: Tier-1 same-name hedge pairs + Tier-2 proxy attribution (sector weights →
geography → beta cascade) + per-hedge efficiency scoring.

- Returns the `{success: true, data}` / `{success: false, error}` envelope (cash-deploy pattern,
  since 2026-07-06).
- Engine at `lib/compute/hedging.ts::computeDefenseAnalysis` (multi-account `resolveScope`, never
  first-id); UI is the Analysis `?view=defense` sub-view (`DefenseView` server component computes
  directly — the route serves external/mobile consumers).
- **`HedgeScore.monthlyBleedPct` is SIGNED** (negative = short-option hedge collecting
  premium/income, not a cost — never `Math.abs` it back; the `expensive` badge + `efficiency` guards
  and the narrative prompt already handle the sign).
- Spec: `docs/superpowers/specs/2026-07-05-defense-hedging-tab-design.md`.

### `GET /api/analysis/macro-themes?scope=&week=` + `POST /api/analysis/macro-themes`

Cached Sonnet-generated weekly macro themes (3-5 per week per scope).

- GET reads from the `analysis_macro_themes` cache (route-level lookup bypasses the rate-limit on hit).
- POST `{ scope }` forces a regen, rate-limited 1/day/scope via an in-process Map
  (`MACRO_REGEN_WINDOW_MS = 24h`).
- Generated by `lib/compute/macro-themes.ts::generateMacroThemes`:
  1. Cache-first → if missing, builds a 7d signal blob from `research_articles` + enriched
     `calendar_events` + `level_alerts`.
  2. If under `MIN_SIGNAL_THRESHOLD` (2 articles + 0 events), writes an empty cache to suppress
     repeated Sonnet calls.
  3. Otherwise calls Sonnet via AI Gateway (feature key `analysisMacroThemes`, ~$0.85/mo).
  4. Code-fence-trims output → `MacroThemesSchema.parse()` validates 1-5 themes with bounded
     `name`/`summary` lengths.
  5. Post-processes per-scope `exposure_bucket` + `top_contributors` from
     `computeFactorAnalysis().tilts[]` — populated 2026-05-11 by `computeMacroFactorTilts` in
     `lib/compute/factors.ts`, which aggregates `getFactorHeatmap` rows through
     `exposureMultiplier(value)` mapping No=0 / Low=.25 / Mod=.5 / High=.75 / VeryHigh=1.0 /
     categorical Growth/Value/Yes/International=1.0, and returns per-`FACTOR_COLUMNS`
     `{factor, exposurePct, topContributors}`.
  6. UPSERTs and returns.
- Pre-generated for all 4 scopes by the Sunday briefing pipeline at
  `lib/digest/send-briefing.ts:114-135`.
- **One cache, four consumers:**
  - Workspace `<MacroOverlayCard>`.
  - Briefing email Opus prompt (`lib/calendar/briefing.ts:198-211`).
  - Cash-Deploy gap re-ranking (`applyThemeAwareBoost` 1.15× boost for defensive sectors during
    risk-off net, aggressive during risk-on).
  - Scenario picker "live now" pill (`matchScenariosToThemes` decorates
    `ScenarioRecipe.liveNowReason`).
  - All four read with `mondayOf(weekOf)` cache-key normalization.

### `GET /api/analysis/narrative?scope=&surface=` + `POST /api/analysis/narrative`

Sonnet narrative prose per (scope, surface, week) cached in `analysis_narratives`.

- GET path has a 60s cache-miss rate-limit (separate `lastCacheMissAt` Map) to prevent a thundering
  herd on cold cache; cache HITS skip the limiter entirely.
- POST forces regen with a 24h per (scope+surface) rate-limit.
- `lib/compute/analysis-narratives.ts::generateNarrative` is the composer.

---

## Reports, search & benchmarks

- `GET /api/tax-report?year=&format=json|csv|txf` — Form 8949 tax report with wash sale detection
  (CSV for filing, TXF for TurboTax). `filingReady` is marker-gated per accepted (account, tax-year) —
  see `docs/reference/data-integrity.md` §17; CSV/TXF filenames carry `-NOT-FOR-FILING` until then.
- `GET /api/transcripts?ticker=&year=&quarter=` (also `?ticker=` alone for summaries, and
  `?ticker=&list=quarters`) / `POST /api/transcripts` `{ ticker, year?, quarter? }` — read or fetch
  and cache an earnings call transcript or 8-K. In-app, `{ success, data }` envelope; POST also
  returns `fromCache`.
  - **POST with no year and quarter means "the latest"** (`fetchLatestTranscript`): the issuer's
    most recent earnings print, requested by its FISCAL quarter.
  - **`latestConfirmed` and `latestNote` (2026-10-08)** ride on the POST reply. Both are null when
    a quarter was named. `latestConfirmed: false` plus a plain-words `latestNote` means the
    document could not be tied to the issuer's newest print: no earnings date is on file, or a
    newer print is on file with no results recorded yet (the note names both dates). The fetch
    button shows the note. Rules: `docs/reference/data-integrity.md` §13b. Test:
    `tests/api/transcripts-route.test.ts`.
- `GET /api/search?q=` — global search across securities, notes, transactions. A level result's
  title labels the price in the security's own currency (`formatLevelPrice`) and never converts it
  (2026-10-08; `tests/api/search-level-currency-q12.test.ts`).
- `POST /api/benchmark/sync` — SSE streaming: fetch benchmark prices from TWS (falls back to cached
  `ohlcv_bars`/`prices` on timeout).
- `GET /api/benchmark/prices?mode=prices|chart|stats|available&symbol=SPY` — benchmark data and
  analytics.

---

## Status & summary

- `GET /api/data-confidence` — 5-dimension data confidence score with actionable fix list, plus the
  cross-cutting integrity gate (`integrity: {critical, warnings}`, `capReason`) — see
  `docs/reference/auto-refresh.md`.
- `GET /api/summary` — lightweight portfolio summary (total value, data freshness, TWS state,
  confidence score) for the Electron tray.
- `GET /api/gmail/status` — check Gmail OAuth connection.

---

## Watchlist

- `GET /api/watchlist` — list active watchlist items (includes `group_name`).
- `POST /api/watchlist` — add security to watchlist (by `securityId` or `symbol`). Accepts
  `groupName` for behavioral groupings ("vanguard_buy", "ibkr_buy_next", etc.).
- `PATCH /api/watchlist` — update price targets, thesis, or `group_name`.
- `DELETE /api/watchlist?id=` — remove from watchlist (soft delete).

---

## Price levels

- `GET /api/levels?securityId=&activeOnly=true` — list price levels (per-security or all). Returns
  `effective_price` resolved from `ohlcv_bars` for MA-based levels.
- `GET /api/levels/armed` — every currently-armed level (`is_active=1`, auto_approved, unexpired)
  enriched with symbol + effective threshold (static or live MA) + current price (prices w/
  benchmark fallback) + signed distance-to-trigger, sorted nearest-first.
  - Backs the **"Armed" tab** in the alerts inbox (`/dashboard/alerts?view=armed`, U3 2026-06-15).
  - Query: `lib/queries/security-levels.ts::getArmedLevels`.
- `POST /api/levels` — create or update a level. Body matches `UpsertLevelInput` (`security_id`,
  `level_type`, `price`, `price_source`, `direction`, `action_hint`, `source`, `source_author`,
  `thesis`, `timeframe`, `expires_at`, `group_id`, `notes`).
- `PATCH /api/levels` — update OR pass `{ id, action: "deactivate" | "reactivate" }` for state flips.
  - A missing level answers 404 on every branch.
  - **Pause refusal (2026-10-08):** `deactivate` on a level whose review status is not
    `auto_approved` (a pending or rejected level) answers **409** with a plain sentence and writes
    nothing: a level that is not armed has nothing to pause. One rule, `levelPauseRefusal`
    (`lib/levels/action-visibility.ts`), read by the route and the panel. Test:
    `tests/api/levels-route-pause-refusal.test.ts`.
- `DELETE /api/levels?id=` — hard delete a level.
- `POST /api/levels/extract` — Claude scans recent unscanned `research_articles` for ticker+level
  mentions against held+watchlist symbols.
  - Body: `{ sinceDays?, batchSize? }`.
  - Auto-runs after `/api/research/sync`.
  - Extracted levels insert with `review_status='pending_review'` — they don't arm until the user
    approves on `/dashboard/levels/review`.
- `GET /api/levels/review?countOnly=true` — list pending_review levels (newsletter-extracted,
  awaiting user approval), or just the count. Used by `ReviewBell` in the header.
- `PATCH /api/levels/review` — flip `review_status` for a pending level. Body:
  `{ id, status: "auto_approved" | "rejected" }`. Approve arms the level; reject keeps the row for
  audit but excludes it from scans.

---

## Alerts

- `GET /api/alerts?response=&securityId=&limit=&countOnly=true` — list `level_alerts` with enriched
  security + level info (includes `level.price_source` for MA-chip rendering), OR just the pending
  count.
- `PATCH /api/alerts` — update alert response (acted/ignored/dismissed) with optional note, or set
  `suggestedAction`.
- `POST /api/alerts/detect` — manual run of `detectAndFireAlerts` (the auto-refresh pipeline runs
  this automatically as Step 6).
- `POST /api/alerts/suggest` — Claude generates a one-sentence recommendation for an alert. Body
  `{ alertId?, limit? }` for single, otherwise fills up to `limit` (default 20) pending alerts
  without a suggestion.
- `POST /api/alerts/suggest?id=<alert id>` — **regenerate one alert's stored advice (2026-10-08).**
  One AI call, behind a per-alert rate limit (`claimRegenerateSlot`, `REGENERATE_WINDOW_MS`, in
  memory; the slot is released when the call fails, so a transient error does not use up the
  window). 400 for a bad id, 404 for an unknown alert, 429 when asked again too soon, 502 when the
  model call fails; on 502 the old advice is kept. Used by the regenerate control on
  `/dashboard/alerts`. Logic: `regenerateSuggestionForAlert` (`lib/alerts/generate-suggestion.ts`).
  A dry-run-default script, `scripts/repair-alert-suggestions.ts`, finds stored advice that quotes
  a stale price (written, not run). Test: `tests/alerts/regenerate-alert-advice-d5.test.ts`.

---

## Trade review

- `POST /api/trade-review` — SSE streaming, two-phase:
  - Phase 1 (no answers) prepares data + Sonnet Q&A.
  - Phase 2 (with answers) generates Opus/Sonnet review.
  - Body: `{ accountId, periodStart, periodEnd, answers?: [{tradeNumber, answer}] }`.
  - Auto-selects Sonnet for >20 trades.
- `GET /api/trade-review?accountId=&year=` — list trade reviews for account.
- `GET /api/trade-review?id=` — single review with grouped trades (lots grouped by
  `sale_transaction_id`).
- `GET /api/trade-review?periods=true&accountId=` — available review periods
  (COUNT DISTINCT `sale_transaction_id`).

---

## Research

### `POST /api/research/sync`

SSE streaming: fetch Gmail newsletters + AI-process with Claude Sonnet + backfill HTML + backfill
source URLs for old articles.

### `POST /api/cron/research-sync`

Cron-authenticated (X-Cron-Secret) background sync. Plain-JSON response (no SSE). Calls
`fetchNewArticles + processUnprocessedArticles + extractLevelsFromNewArticles` +
**`ingestForwardedDocuments`** (U6) — does NOT send any email. Called every 90 min during market
hours by `com.vanguard-skin.research-sync.plist`.

### `POST /api/research/ingest-inbox`

**Forward-to-research ingestion (U6, 2026-06-15).**

- Pulls forwarded emails (`to:read@myportfoliodesk.com`, Cloudflare catch-all routes them into
  Gmail) and turns each into a research document.
- In-app trigger for the Documents view "Check inbox" button; the same `ingestForwardedDocuments`
  also runs in the research-sync cron.
- Pipeline: `lib/research-inbox/{classify,gmail-inbox,ingest}.ts` classifies each message
  (pdf/image/link/long-read body) → `lib/research-documents/extract-forwarded.ts` Claude-extracts
  (`extractFromText` / `extractFromImage` vision / `extractFromUrl` web_fetch with fetch+sanitize
  fallback) → `createResearchDocument` (tagged `forwarded`).
- Dedup/audit: migration 060 `research_inbox_messages`.
- Address: `RESEARCH_INBOX_ADDRESS` env (default `read@myportfoliodesk.com`).
- **Key gotcha:** image/url extractors use the sentinel-delimited metadata+body format
  (`parseClaudeResponse`, `---RAW_TEXT_BEGIN---`) so a long article can't truncate the metadata
  JSON; the raw Claude call takes the **LAST** text block (server tools like web_fetch emit a
  preamble text block before the final answer).

### Articles

- `GET /api/research/articles?sourceId=&securityId=&startDate=&endDate=&search=&limit=&filtered=` —
  query research articles (includes `symbolMap`). `filtered=1` switches to the D5 audit list
  (`is_relevant=0` rows, no symbol map, no other filters honored).
- `GET /api/research/articles/[id]` — single article with `raw_text` + `raw_html` for expanded view.
- `POST /api/research/articles/[id]/unfilter` — D5 audit override. Flips `is_relevant=1` + clears
  `excluded_category`/`reason`. Returns 404 if already relevant. In-app only (no cron auth).

### Reconcile

- `POST /api/research/reconcile-cloud-fetched` — drains Worker `cloud-fetched-newsletter-*` KV
  entries into `research_articles` via INSERT OR IGNORE on `gmail_message_id`; applies the D3 gate
  at reconcile time. Cron-auth gated (X-Cron-Secret). Called as Phase 0 of `/api/research/sync` and
  as the first DB step of `/api/cron/research-sync`. No-op when `WORKER_MARKER_URL` unset.

### Sources & discovery

- `GET /api/research/sources` — list newsletter sources with article counts.
- `POST /api/research/sources` — create newsletter source.
- `PATCH /api/research/sources` — update newsletter source (`sender_email`, `is_active`,
  `processing_prompt`, etc.).
- `DELETE /api/research/sources` — delete newsletter source. Body: `{ id }`.
- `POST /api/research/discover` — scan Gmail for newsletter senders (90-day window, 1+ emails).

---

## Digest & email

- `POST /api/digest/email` — sync feeds + compile daily digest + send email.
  - Body: `{ to?, mode?: "today" | "since_last" | "since_date", sinceDate? }`. Default (no mode) =
    last 24h.
  - Records `last_digest_sent_at` in the `settings` table.
- `GET /api/digest/preview?since=` — read-only digest preview, no AI call. Returns the morning
  digest content rendered two ways in one fetch: `{ bySourceHtml, byCompanyHtml, structuredHtml:
  null, since, empty, caps }`.
  - **`caps` (2026-10-08)** is each layout's article cap, `{ structured, bySource, byCompany }`,
    so the viewer's caption can name the cap for the tab on screen. The cap constants live in
    server modules a client component must not import. Test: `tests/api/digest-preview-caps.test.ts`.
  - **With no `since`, the window is the sender's own** (`resolveDigestSince` /
    `defaultDigestSince`, `lib/digest/digest-window.ts`), so the preview shows what a send would
    cover. Both senders read the same rule.
- `POST /api/digest/preview?since=` — the same response plus the STRUCTURED layout
  (`structuredHtml`, `synthesisFallback`). This is the paid path: one AI synthesis when enough
  commentary is in the window. The viewer calls it only on a click (2026-10-08); opening the modal
  runs the GET alone.
  - Used by the `<DigestEmailViewer>` modal (mounted as the "Preview" button on the Research Feeds
    toolbar) for client-side toggling between layouts without a re-fetch.
  - By-source uses the existing `generateDigestSince`; by-company uses `generateDigestByCompanySince`
    from `lib/digest/group-by-company.ts`.
  - Email itself stays single-version (per-source) — the toggle is in-app only.
- `GET /api/digest/status` — last-sent timestamps (`lastDigestSentAt`, `lastBriefingSentAt`) and
  `defaultRecipient` from env. Cloud-aware: `cloudDigestToday`.
  - **`lastDigestSkip` (2026-10-08):** `{ reason, date, at }` or null. The last time the scheduled
    since-last-email window came back empty (`lib/digest/digest-skip.ts`, one `settings` row,
    read-only here). The catch-up banner uses it to say "nothing new to send" in place of "wasn't
    sent" (`decideDigestBanner`, `lib/digest/catchup-banner.ts`). Test:
    `tests/api/digest-status.test.ts`.

---

## Earnings

### `POST /api/earnings/email`

Manual trigger for an earnings preview / recap email.

- Body: `{ eventId: number, phase: "preview" | "recap", to?, footerNote? }`.
- Composer at `lib/digest/send-earnings-email.ts` builds context:
  - Cross-account positions including options via `underlying_symbol` traversal.
  - User notes via `getNotesForFamily`, rendered FIRST in the prompt.
  - Preferred-source newsletters last 7d with 30d fallback.
  - Analyst recs, press releases, prior-quarter transcript (best-effort).
- Runs through Sonnet 4.6 on Anthropic with `web_search_20250305` enabled (max_uses=5).
- Two feature keys (`earningsPreview`, `earningsRecap`) in `lib/ai/feature-keys.ts`.
- Email opens with a deterministic 6-row scoreboard table (light palette, white-bg cells) rendered
  by `renderHeadlineTable()` from `consensus_estimate` + `actual_value` + `reaction_snapshot`, then
  an AI-generated `## Line-by-line bogies` markdown table + prose. A PREVIEW keeps empty fill-in
  boxes for printing; since 2026-10-08 a RECAP scoreboard prints a dash in an empty cell, as its
  legend says. The renderer tells them apart by the scoreboard heading wording
  (`docs/reference/earnings-pipeline.md` §14). A reaction leg that is not a measurement yet is
  left out.
- **Calendar-row refusals.** The send service refuses a row that is not its print's email row
  (`emailRowRefusal`). The route passes on the service's status and sentence as `{ error }`: 409
  when the entry was replaced, **404** when no calendar row has that id (`event_not_found`,
  2026-10-08). Nothing is sent.
  - **`ignored_manual_twin` on a manual send (2026-10-08).** When one company has two hand-entered
    earnings entries, email follows the earlier one. A manual Send on the LATER entry now answers
    **409** as well. Before, only the automatic sweep refused it and the button still sent. The
    sentence says this is the later of two hand-entered entries, names the earlier date, and gives
    the way out: remove or re-date the earlier entry. The body is `{ error }` only; the code
    `ignored_manual_twin` stays inside the send service (`SendOutcome.code`). No flag skips the
    refusal. One constant in `lib/earnings/send-service.ts` (`refuseIgnoredManualTwin`) holds the
    decision. Test: `tests/earnings/superseded-event-send-path.test.ts`.
- Composer writes an audit row to `earnings_emails` (migration 042, UNIQUE(event_id, phase)) on
  success.
- Driver scripts: `scripts/preflight-earnings-data.ts <syms...>` and
  `scripts/fire-earnings-emails.ts <preview|recap> <YYYY-MM-DD> [bmo|amc] [--dry-run]`.

- **`markDelivered: true` (live print v2 slice E, 2026-09-04):** closes a `delivery_unknown` audit row the desk
  confirmed by hand — no email is composed or sent, so it runs BEFORE the recipient allowlist and the rate
  limit; 200 `{ ok, phase, eventId, resolved: "delivered" }`, 409 when the row is not `delivery_unknown`.
  A resend is the same route WITHOUT the flag (manual mode refires explicitly). Every other caller — the
  sweep loop, the Today nudge — goes through `lib/earnings/send-service.ts` in automatic mode and never refires.

### `GET /api/earnings/email-content?eventId=&phase=`

Read-only. Returns the full rendered HTML of a previously-sent earnings email so the in-app
`<EarningsEmailViewer>` modal can iframe it. Scoreboard is rebuilt deterministically from current
`calendar_events` fields via the exported `renderHeadlineTable`; AI prose comes verbatim from
`earnings_emails.ai_output_md`.

- Response carries `deliveryState: "sent" | "sent-by-cloud" | "delivery-unknown"` beside `sentBy` (slice E):
  a `delivery_unknown` row HAS a stored body (the attempted one, or the previously delivered one after a
  refire) and the viewer renders it with a "Delivery unknown" header and a reconciliation caveat.

### `POST /api/earnings/bogeys/upload` (multipart)

Drop a multi-symbol PDF (e.g. TMT Breakout's weekly preview); Claude extracts per-symbol bogeys via
`lib/earnings/extract-bogeys.ts`, fans out to matching `calendar_events` for
`[weekOf-3d, weekOf+10d]` via `issuerSiblings()`. Archives PDF to R2 (graceful no-op without R2 env
vars). Returns `{symbolsExtracted, eventsMatched, eventsUnmatched, results}`.

When the form carries no `sourceLabel`, the default label is `Upload <date> <file name>` with the
Eastern day (2026-10-09; it was the UTC day).

### `GET/POST/DELETE /api/earnings/bogeys`

Manual entry CRUD for the per-event `BogeysEditModal`. POST upserts via
`(event_id, source='manual', source_label)` UNIQUE.

### `GET/POST /api/earnings/actuals`

Manual override of reported EPS / Revenue when enrichment misses. POST writes back to
`calendar_events.actual_value` in Finnhub-shape (`"EPS X.XX · Rev N"`) so all downstream readers
(`renderHeadlineTable`, EarningsHub display, recap composer) pick up the override unchanged. GET
parses the current `actual_value` for modal pre-fill.

### `GET /api/earnings/emails?symbol=&limit=`

Archive listing of every completed earnings email send, newest-first
(`{success, count, emails}` — conflicts-route envelope).

- Backed by `lib/queries/earnings-emails.ts::getSentEarningsEmails` (excludes `'in_progress'` claims
  per the tri-state convention; `sent_by_cloud` flag; family-aware symbol filter via
  `issuerSiblings`).
- Backs the **Emails tab in `/dashboard/alerts` (`?view=emails`, 2026-07-28)** — flat newest-first
  list + symbol filter box, rows open the existing `<EarningsEmailViewer>` (cloud-sent rows show
  "no local copy" + the live-rebuilt scoreboard), lazy-fetched on tab activation.
- Companion surfaces: Security Detail "Earnings Emails" section (`SecurityEarningsEmails` — the name
  `EarningsEmailsSection` is the Settings panel; rendered only when the issuer family has ≥1 sent
  email, server-queried directly) + EarningsHub header "Email archive →" link.
- Spec: `docs/superpowers/specs/2026-07-28-earnings-email-archive-design.md`.

### `GET /api/earnings/conflicts`

Earnings whose Finnhub × Nasdaq dates disagree awaiting IBKR confirmation, next 14 days.

- `?countOnly=true` → `{success, count}` (NotificationBell badge).
- Default → `{success, count, conflicts}` via `getEarningsDateConflicts` (same predicate/window as
  the count — badge and surface can never disagree; sibling-filled `security_id`).
- Backs the **Conflicts tab in `/dashboard/alerts` (`?view=conflicts`, 2026-07-26)** — the
  mobile-reachable resolution surface reusing `EarningsDateChip` (which gained `onConfirmed` for
  client-fetched lists + `popoverAlign="right"` for right-edge chips; popover is z-[55] per the
  chat-rail precedent).

### `POST /api/earnings/confirm-date`

Record the earnings date the user confirmed. Thin wrapper over `confirmEarningsDate`
(`lib/mutations/confirm-earnings-date.ts`). In-app (no cron auth). Idempotent.

- Body: `{ symbol, confirmedDate: "YYYY-MM-DD", confirmedTime?: "bmo" | "amc" | "HH:MM" }`.
- Writes a locked, user-confirmed hand-entered row and hides the conflicting vendor rows for that
  name. Later syncs never revert it.
- 400 for a bad body. **409** with the mutation's reason when the date is in the past or too far
  ahead.
- **Result fields (2026-10-08):** `{ success: true, data: { eventId, eventDate, ... } }`. `eventId`
  is the one row that now carries the confirmed date. When the name already had ONE other showing
  hand-entered row for the same upcoming print, one of these is also present:
  - `movedEventId` — that row was moved onto the confirmed date (same id as `eventId`);
  - `deletedEventId` — a hand-entered row already sat on the confirmed date, so the other row was
    folded into it and deleted;
  - `foldedEventId` plus `note` — the other row was folded but something was still attached to it,
    so it was left hidden, not deleted. `note` names what remained (for logs).
- **`notice`** is a plain sentence for the user, present when the confirm could not tidy up fully:
  a kept entry (with the reason), or several hand-entered dates that nothing could choose between.
  The conflict marker and the Hub's date chip show it.
- Rules and the typed-time behaviour: `earnings-pipeline.md` §5. Tests:
  `tests/api/earnings-confirm-date-route.test.ts`, `tests/mutations/confirm-earnings-date.test.ts`.

### `POST /api/earnings/correct-date`

Fix a wrong sync-sourced earnings date/slot from the UI (feedback #7, 2026-08-03).

- Body: `{symbol, wrongDate, correctDate, slot?: "bmo"|"amc"}`; thin honest wrapper over
  `correctEarningsEventDate` (suppress+delete, manual mint / vendor adoption, bogeys migration).
- 404 when no earnings row exists on `wrongDate` (a typo'd date must not mint a phantom); 409 with
  the lib's `refusedReason` verbatim on captured actuals.
- In-app (no cron auth).
- UI: **every non-null-status `EarningsDateChip` is now tappable** — the passive statuses
  (✓ 2 src / 1 src / 🔒) open a "Date is wrong?" popover (date pre-filled for one-tap slot-only
  fixes, BMO/AMC select); the conflict flow is unchanged.
- Spec: `docs/superpowers/specs/2026-08-03-fix-date-chip-design.md`.

### `POST/DELETE/GET /api/earnings/skip`

Per-event one-off mute.

- POST `{ eventId, phase }` inserts an `earnings_email_skips` row (UNIQUE on event_id+phase,
  idempotent).
- DELETE `?eventId=N&phase=preview` undoes.
- GET `?eventIds=1,2,3` returns per-event skip state for the EarningsHub.
- `findEmailCandidates` LEFT JOINs both `earnings_emails` (sent audit) AND `earnings_email_skips`
  (user mute) and excludes either via NULL check.
- In-app pattern (no cron auth). Migration 045.

### `GET /api/earnings/cockpit`

Assembled earnings-day cockpit payload (`{success, data: CockpitPayload}`): today +
unfinished-yesterday reporters in BMO/AMC/unknown lanes + carryover strip, per-row 5-stage state,
family net exposure, `nextRelease` countdown target, `skippedRows` honesty counter.

- Thin wrapper over `lib/queries/earnings-cockpit.ts::buildCockpitPayload`.
- Since 2026-07-08 the route also awaits `ensureIntelForEvents` (TTL-guarded, best-effort,
  **released rows filtered out** — `cockpitRowsToIntelEvents` must never re-ensure a post-print event
  or it overwrites the recap's preview-time "priced-in" anchor), then
  `decorateCockpitIntel(db, payload)` so rows carry
  `intel: { impliedMovePct, impliedMethod, histAvgAbsMovePct, histBeatCount, histQuarterCount } | null`
  (`buildCockpitPayload` itself stays network-free).
- In-app (no cron auth), polled 60s by `<EarningsCockpit>`.

### `GET/POST /api/earnings/release-time`

Per-symbol standing release-time override (wire-time tracking, 2026-08-04).

- GET `?symbol=&slot=bmo|amc` →
  `{success, data: {symbol, resolved: {time, source}|null, override, overrideUse, observations}}`.
  `overrideUse` says whether the resolver actually uses the standing row for that slot (a
  web-verified after-close time at or after 17:00 is a suspect call time and is not used).
- POST `{symbol, releaseTime: "HH:MM"|null, replaceWebVerified?}` upserts a `source='user'`
  `symbol_release_times` row (null clears ONLY user rows; validates HH:MM shape + clock bounds +
  [04:00, 20:00] ET) and re-resolves upcoming family events, returning `updatedEvents`.
- **POST refusals (409, nothing stored), in order:**
  1. `slot_mismatch` (with `data: { slot, eventDate }`): the time's side of noon disagrees with the
     symbol's nearest upcoming event's slot (or its latest reported print when none is upcoming).
     There is no bypass: a forced wrong-side row would be ignored downstream anyway.
  2. `would_replace_web_verified` (2026-10-08; `data` carries the standing `releaseTime`,
     `verifiedForDate`, `note`): the Save would turn a standing web-verified time into a user
     time, and a later Clear could not bring it back. Send `replaceWebVerified: true` to save. The
     acknowledgement never answers the slot check. A suspect web-verified call time (after-close,
     at or after 17:00) is replaced without a question.
- In-app (no cron auth); consumed by the EarningsDateChip popover "Reports at" editor.

### `GET/POST /api/earnings/worksheet`

Printable desk worksheet (feedback #6, 2026-08-03; migration 074 `earnings_worksheet_flags`;
**rich rework 2026-08-05; email-identical PDF road 2026-08-06/07**).

- POST `{eventId, action: "arm"|"disarm"|"print"}` (earnings + symbol-bearing rows only, 400
  otherwise; in-app, no cron auth); GET `?eventIds=` → armed/printed map.
- **Primary road is the email-identical PDF** (see the "Earnings print-sheet pipeline" convention
  above) — `printWorksheetNow`/`printArmedWorksheets` try `lib/earnings/print-sheet.ts` +
  `lib/earnings/print-pdf.ts` first whenever a local preview exists, falling back to the rich
  monospace sheet on ANY failure.
- **The rich monospace sheet is now FALLBACK-ONLY** — `lib/earnings/worksheet-rich.ts`
  (pure/import-free):
  - Extracts the AI `## Line-by-line bogies` table + commentary span (Sources excluded) from
    `earnings_emails.ai_output_md`.
  - Rebuilds scoreboard + past prints live via the email's own exported renderers
    (`renderHeadlineTable`/`renderPastPrintsBlock`/`loadIntelView`).
  - Renders ruled 80-col monospace tables where `—` cells in fill-in columns become blank pen-sized
    boxes (bogies layout Metric 16 | Cons/Prior 41 | Actual 13 | Δ 6).
  - ≤3 form-feed 62-line pages, full-text word-wrapped notes (no chop — see notes-are-sacred above).
- **Auto-print WAITS for the local preview** (user decision 2026-08-05, unchanged by the PDF-road
  addition):
  - `printArmedWorksheets` skips-without-stamping until `getEmailAudit(db,id,"preview")` has non-null
    `ai_output_md` (`in_progress` claims + `sent-by-cloud` excluded — cloud-sent/muted/skipped
    previews never auto-print).
  - The pass runs AFTER the sweep's send loop so the tick that sends a preview prints it same-pass.
  - Window [now−30m, now+135m]; `printed_at` stamps once (on EITHER road's success); failed print
    retries stampless; never throws; DI `print`/`render` seams.
- Manual "Print now" always produces paper — PDF road when a local preview exists, else the
  unchanged deterministic one-page composer in `lib/earnings/worksheet.ts` (blank ACTUAL/Δ columns,
  whisper/segments/guidance fill-ins, footer-after-cap — this composer is untouched by the
  notes-are-sacred rule, see the deferred-minors TODO item).
- `printViaLp` untouched (spawn lp, stdin, 20s kill timeout for wedged cupsd, stdin EPIPE listener,
  optional `worksheet_printer_name` setting).
- UI unchanged: ⎙ chip in `EarningsRowChips` (arm/disarm) + "Print worksheet" in `BogeysEditModal`
  (immediate; success says "sent to printer QUEUE" — lp exit 0 ≠ paper out).
- Specs: `docs/superpowers/specs/2026-08-03-worksheet-print-design.md` +
  `docs/superpowers/specs/2026-08-05-worksheet-rich-preview-print-design.md` +
  `docs/superpowers/specs/2026-08-06-earnings-print-prose-round-design.md` (carries the 2026-08-07
  addendum).

### `GET/POST /api/earnings/call-notes?eventId=`

Structured post-call note CRUD (migration 064, one note per event). POST
`{eventId, guidance?: raised|inline|lowered|not_given, tone?, surprises?, followUps?}` validates the
enum + event existence, full-replace upsert. `{success, data|error}` envelope. In-app; consumed by
`<CallNoteModal>`.

### `POST /api/cron/earnings-sweep`

Top-level Phase-3 driver.

- Auth: X-Cron-Secret. No body.
- Called every 15 min by `scripts/enrich-calendar-events.sh` after the enrich call.
- `findEmailCandidates(db)` (in `lib/calendar/enrichment-runner.ts`) returns preview candidates
  (`release_time` in [now+105m, now+135m] AND no audit row AND held|watchlist) + recap candidates
  (`enriched_at` within 4h AND no recap audit row AND held|watchlist).
- Filtered by `getEarningsSettings(db).enabled` master toggle + `mutedSymbols` list.
- Returns `{swept, sent, failed, results}`.
- (The per-event routes `/api/cron/earnings-{preview,recap}` were deleted 2026-07-06 — dead code
  superseded by the sweep; the marker dance lives in `email-sweep.ts`.)

---

## Plaid

- `POST /api/plaid/link-token` — creates a Plaid Link token for the initial Connect flow, or (body
  `{ mode: "reauth" }`) a re-auth token scoped to the stored access token for the
  `ITEM_LOGIN_REQUIRED` recovery path. Requires `PLAID_CLIENT_ID`/`PLAID_SECRET` env vars
  (`lib/plaid/client.ts::loadPlaidConfig`); 400 when unconfigured.
- `POST /api/plaid/exchange` — exchanges a Link `public_token` for a persistent access token
  (`setPlaidItem`), fetches the Plaid investments/holdings accounts, and proposes + stores an initial
  Plaid-account → local-account map (`lib/plaid/map-accounts.ts::proposeAccountMap`) for the user to
  confirm on `/dashboard/plaid-link`.
- `POST /api/plaid/sync` — manual "Sync Vanguard now" trigger (Accounts tab `PlaidSyncButton`).
  Calls `refreshVanguardHoldingsFromPlaid(db, { force: true })`; returns `{success:false}` with a
  guidance message when Plaid isn't connected or a sync is already running.
- `GET /api/settings/plaid` + `PATCH /api/settings/plaid` — read Plaid connection status + cached
  Plaid accounts + current account map (`buildPlaidSettingsPayload`) for the Settings `PlaidSection`;
  PATCH updates the account map (validates every local id against `getAllAccounts`).
- `POST /api/cron/plaid-sync` — cron-authenticated (`X-Cron-Secret` header, matches
  `CRON_SHARED_SECRET`) daily Plaid holdings sync. Calls `refreshVanguardHoldingsFromPlaid(db)`
  (no force — respects the once-per-trading-day skip). Called by launchd
  `com.vanguard-skin.plaid-sync.plist` (07:30 ET weekdays).
  - **A skipped run names its cause (2026-10-08).** When the refresh did not run, the response is
    `{ success: true, result: null, cause, note }`. `cause` is one of `not_configured`,
    `not_connected`, `no_account_mapped`, `sync_in_progress`
    (`plaidRefreshBlocker`, `lib/plaid/refresh.ts`, the same gate the refresh itself checks), or
    `cleared_before_read` when the cause was gone by the time the route looked. `note` is
    `skipped: ` plus the sentence the in-app route shows (`plaidSyncUnavailableMessage`). Before,
    one catch-all note covered three causes and left out "no account mapped". A run that DID
    start still answers `{ success: true, result }`, where `result.skippedReason` may be
    `market_closed` or `already_synced_today`. Auth is unchanged. Test:
    `tests/api/cron-plaid-sync-skip-cause.test.ts`.

## Donations (Giving — R4, 2026-08-17)

All in-app (human-classified, DB session + CSRF via `apiFetch`); logic lives in `lib/queries/giving-view.ts`,
`lib/mutations/donations.ts`, `lib/mutations/donation-links.ts`, `lib/compute/donation-reconciliation.ts`.
Every mutation runs a tax-lot recompute in its OWN try/catch and returns
`{success:true, data:{saved:true, recomputed, recomputeError?, donationsConsumed?, replayWarnings?}}` —
never a 500 for a saved write.

- `GET /api/donations` — full Giving payload: `getGivingView(db)` → per-year totals (reversed excluded;
  year gainAvoided null while any stock donation lacks assignments) + `reconcileDonations` report
  (suggestions / ambiguous / attempts / legs-missing / duplicate-suspects / unmatched pairs).
- `GET /api/donations/[id]/lots` — as-of-donation-date open-lot listing for the assignment drawer
  (donation-date units, NOT today's post-split `quantity_remaining`; carries suggested highest-gain-LT
  preselection + this donation's current per-lot claim). Display-only; write-time truth is the mutation.
- `POST /api/donations/[id]/links` — confirm a suggested match (`{outTransactionId, artifactTransactionId?,
  amountForOutLeg?}`); `DonationLinkError` → 400 domain message; already-out-linked → 409.
  `DELETE` — unlink (restores a demoted artifact leg's `is_external_flow` + strips the note suffix).
- `POST /api/donations/[id]/lots` — replace lot assignments (`{assignments:[{acquisitionTransactionId,
  quantity}]}`, empty array clears); reject-not-clamp invariants live in `assignDonationLots`.
- `POST` / `DELETE /api/donations/lots/[acquisitionTransactionId]/basis-verified` — mark (`{sourceNote}`) or clear the "basis verified" marker on a flagged donated lot. No ledger-recompute acknowledgement: it changes no tax input. 409 while the ledger waits on a recompute or when no donation draws on the lot.
- `POST /api/donations/[id]/reverse` — `{reversedDate}` strict `YYYY-MM-DD`; sets `reversed_date`,
  unlinks + unassigns, excludes from totals.
- `POST /api/donations/[id]/resolve-security` — `{securityId}`; only when `security_id` IS NULL (else 409);
  validates existence + USD.

Import side: `daf-contributions` is a first-class format through the standard pipeline — preview carries a
`donations` block (count/new/updated/identityConflicts/absentPriorRows/unresolvedSymbols; computed via a
rolled-back transaction — never persists), commit is a metadata upsert for existing source keys, and undoing
a transactions batch referenced by donation links/assignments is refused 409 before the rate limit is burned.

## Print watch (live print v2, 2026-08-21 → 2026-09-04)

All routes are `human` by the proxy's default classification (session cookie + double-submit CSRF +
trusted `Origin` on unsafe methods); none has a `lib/auth/route-policy.ts` entry. Logic lives in
`lib/print-watch/*` and `lib/earnings/*`; the routes parse and delegate. Detail: `earnings-pipeline.md`.

- `GET /api/print-watch/status` — PURE READ (guarded by `tests/api/no-state-changing-get.test.ts`). One entry per
  live print: state, sources ladder, lines, `documents` + `documentRoads` (B), `forcedOpenAt` /
  `windowExtendedUntil` / `effectiveWindow` / `goRequest` (C), `read` / `activeRead` / `lastAttempt` / `callouts`
  (D), and `outputs` (E: `printSheet { enabled, reason }`, `sendRecap { enabled, reason, state, providerMessageId }`
  — the ONLY source the Today buttons render from, so a dark button and its route's refusal can never disagree).
- `GET /api/print-watch/record?eventId=<id>` — **PURE READ (2026-10-08).** One event's print in whatever state
  it is in, its sheet lines, a document-id-to-kind map and the same `outputs` evaluation the status route sends
  (`getPrintRecord`, `lib/earnings/print-record.ts`). The status route stops listing a finished print once its
  event date is no longer today, on purpose; this is the scoped read an armed Hub row uses to show a read-only
  record of such a print. 400 when `eventId` is not a positive whole number. An event with no print answers 200
  with `print: null` ("nothing was captured" is an ordinary answer). A human route by the proxy's default
  classification; no `route-policy` entry. Tests: `tests/api/print-watch-record.test.ts`,
  `tests/print-watch/print-record.test.ts`.
- `POST /api/print-watch/ensure` — keeps the in-process watcher lease alive (the Hub polls it every 60 s).
- `POST /api/print-watch/drop` — a dropped release file or a pasted `url` (B; SSRF-hardened fetch).
- `POST /api/print-watch/accept` — accept a line / a candidate, un-accept, `promoteHeadline` (validates inside an
  `.immediate()` transaction; 409 `superseded` + `forceSuperseded`). Refuses any `~retired~` line id (F).
- `POST /api/print-watch/go` (`{ eventId, url? }` or `{ eventId, contentBase64, filename? }`), `GET /api/print-watch/go?requestId=`,
  `POST /api/print-watch/extend` — the "print is live" action, its status, and the 30-minute window extension (C).
- `POST /api/print-watch/read` — regenerate the first-pass read (returns `generating`; the panel polls status);
  `POST /api/print-watch/callouts/accept` — flip a verified callout `proposed` ↔ `accepted` (D).
- `GET /api/print-watch/sources?symbol=` (pure read; `data: null` when nothing is stored) and
  `PUT /api/print-watch/sources` (`{ symbol, irPageUrl, linkMustContain? }`; an empty `irPageUrl` CLEARS) — the
  stored IR page (B route, F UI).
- `POST /api/print-watch/print-sheet { printId }` — the post-print paper sheet through the one-sheet ladder;
  409 with `outputs.printSheet.reason` verbatim when no line has a value; 200 `{ road: "pdf" | "monospace", pages, symbol }` (E).
- `POST /api/print-watch/send-recap { printId }` — 200 for EVERY coordination outcome, rendered verbatim by the row:
  `sent | in_progress | already_sent | delivery_unknown | refused | failed` (E). The gate requires the accepted
  headline pair, the promote stamp, and that the currently accepted pair still matches the stored `actual_value`.
  Since 2026-10-08 a press on the later of two hand-entered entries comes back `refused` with the same sentence the
  manual route gives (`{ outcome: "refused", reason }`; the status is still 200).
