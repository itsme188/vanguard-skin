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

### `POST /api/calendar/enrich`

Post-release enrichment trigger.

- Body: `{ eventId?: number, upgradeReactionToTws?: boolean }`.
  - Omit `eventId` for a window-filter sweep: unenriched rows whose `release_time` falls in
    `[now-2h, now-5min]`.
  - Set `upgradeReactionToTws: true` with a specific `eventId` to overwrite a cloud-sourced
    `reaction_snapshot` with a fresh TWS capture via `runTwsReactionUpgrade`.
- **Auth: `X-Cron-Secret` header is mandatory on every call** (UI, launchd, Worker) — missing
  `CRON_SHARED_SECRET` env returns 500; mismatch returns 403.
- Hardened 2026-04-27 (Codex critical-bug-pass) — the earlier "trusted local UI without secret"
  path was removed because the reconcile fetch built its target URL from the inbound `Host` header,
  leaking the secret to a caller-controlled origin.
- Internally calls `reconcileCloudEnrichment(db, secret)` first to drain cloud-enriched KV payloads,
  then runs `lib/calendar/enrichment-runner.ts::runEnrichment`, which orchestrates
  `fetchActualForEvent` + `captureReactionFromTws` per candidate.

### `POST /api/calendar/reconcile-cloud-enrich`

Phase 9b Mac-side reconcile.

- Polls the Worker's `GET /internal/cloud-enriched` for KV payloads written during Mac-off windows,
  upserts into `calendar_events` with TWS-always-wins precedence (existing
  `reaction_snapshot.source === "tws"` → skip reaction overwrite, still upsert actual+consensus),
  then DELETEs the KV key per reconciled event.
- **Auth: `X-Cron-Secret` mandatory** — same model as `/api/calendar/enrich`.
- No-op when `WORKER_MARKER_URL` is unset.

### `POST /api/calendar/events` (PATCH, DELETE also)

CRUD for manually-curated calendar events.

- POST body:
  `{ symbol, event_date, event_type='earnings', event_time?='AMC', release_time?, expected_impact?, consensus_estimate?, description? }`
  — inserts row with `source='manual'`,
  `source_key='manual:SYMBOL:DATE:TYPE'`, `week_of` derived from `event_date`, `release_time`
  auto-derived 08:00/16:15 from BMO/AMC.
- PATCH read-first-guards on `source='manual'` and 403s sync-owned rows so a stray edit can't
  corrupt the next sync's idempotency.
- DELETE (2026-07-26 `9cade35`): manual rows delete directly; sync-owned EARNINGS rows
  suppress-then-delete via `deleteAndSuppressCalendarEvent` (see the calendar-event-suppressions
  convention); symbol-less macro rows stay 403.
- Used by the Earnings Hub `+ Add ticker` form + per-row ✕ on `/dashboard/today`.

---

## Cron-authenticated triggers

- `POST /api/cron/briefing` — cron-authenticated briefing trigger (X-Cron-Secret required, matches
  `CRON_SHARED_SECRET` env). Pre-checks the Worker's `cloud-sent-*` marker via
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

- `GET /api/compute/xirr?startDate=&endDate=&accountId=` — compute XIRR for arbitrary date ranges.
- `GET /api/compute/risk?startDate=&endDate=&accountId=` — portfolio risk metrics (drawdown,
  volatility, Sharpe, Herfindahl).
- `GET /api/compute/position-risk?accountId=&topN=10` — per-position volatility, risk contribution,
  correlation matrix.
- `GET /api/compute/factors?accountId=&benchmark=SPY` — market beta regression + portfolio tilts
  (size, style, sector, geography).
- `GET /api/compute/scenarios?accountId=&scenario=` — scenario modeling (9 presets: crash, rate
  shocks, rally, sector rotation).
- `POST /api/compute/scenarios` — custom what-if scenario.
  Body: `{ marketMove, rateMove?, sectorMoves?, name? }`.
- `GET /api/compute/fixed-income` — bond exposure: weighted avg duration, credit quality breakdown,
  bond positions.
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
  - Multi-account scope resolution via `resolveScope` (not `resolveScopeToSingleId`) — Expirations
    renders across all accounts in a scope, not just the first.
- `GET /api/compute/options-strategies?accountId=` — detected option strategies (covered calls,
  spreads, etc.).
- `GET /api/compute/reconciliation?accountId=` — cost basis reconciliation: broker-reported vs
  computed.

---

## Analysis

### `GET /api/analysis/trust-state?scope=`

5-dimension data-quality state for the Analysis page Trust Strip (factor coverage / last classify /
performance reconciled-thru / stale prices / bond duration). Single-shot query in
`lib/queries/analysis-trust-state.ts::getAnalysisTrustState`. `performanceReconciledThru` populated
via `reconcileTwrAgainstStatements` per account — strict semantic ("all accounts agree at least
through this month"); any account that fails or can't be evaluated forces null.

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
  (CSV for filing, TXF for TurboTax).
- `GET /api/search?q=` — global search across securities, notes, transactions.
- `POST /api/benchmark/sync` — SSE streaming: fetch benchmark prices from TWS (falls back to cached
  `ohlcv_bars`/`prices` on timeout).
- `GET /api/benchmark/prices?mode=prices|chart|stats|available&symbol=SPY` — benchmark data and
  analytics.

---

## Status & summary

- `GET /api/data-confidence` — 5-dimension data confidence score with actionable fix list.
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
  `{ alertId? }` for single, otherwise fills all pending alerts without a suggestion.

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
- `GET /api/digest/preview?since=` — read-only digest preview. Returns the morning digest content
  rendered two ways in one fetch: `{ bySourceHtml, byCompanyHtml, since, empty }`.
  - Used by the `<DigestEmailViewer>` modal (mounted as the "Preview" button on the Research Feeds
    toolbar) for client-side toggling between layouts without a re-fetch.
  - By-source uses the existing `generateDigestSince`; by-company uses `generateDigestByCompanySince`
    from `lib/digest/group-by-company.ts`.
  - Email itself stays single-version (per-source) — the toggle is in-app only.
- `GET /api/digest/status` — last-sent timestamps (`lastDigestSentAt`, `lastBriefingSentAt`) and
  `defaultRecipient` from env.

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
- Email opens with a deterministic 6-row scoreboard table (light palette, white-bg cells with
  empty-cell padding for fill-by-hand printing) rendered by `renderHeadlineTable()` from
  `consensus_estimate` + `actual_value` + `reaction_snapshot`, then an AI-generated
  `## Line-by-line bogies` markdown table + prose.
- Composer writes an audit row to `earnings_emails` (migration 042, UNIQUE(event_id, phase)) on
  success.
- Driver scripts: `scripts/preflight-earnings-data.ts <syms...>` and
  `scripts/fire-earnings-emails.ts <preview|recap> <YYYY-MM-DD> [bmo|amc] [--dry-run]`.

### `GET /api/earnings/email-content?eventId=&phase=`

Read-only. Returns the full rendered HTML of a previously-sent earnings email so the in-app
`<EarningsEmailViewer>` modal can iframe it. Scoreboard is rebuilt deterministically from current
`calendar_events` fields via the exported `renderHeadlineTable`; AI prose comes verbatim from
`earnings_emails.ai_output_md`.

### `POST /api/earnings/bogeys/upload` (multipart)

Drop a multi-symbol PDF (e.g. TMT Breakout's weekly preview); Claude extracts per-symbol bogeys via
`lib/earnings/extract-bogeys.ts`, fans out to matching `calendar_events` for
`[weekOf-3d, weekOf+10d]` via `issuerSiblings()`. Archives PDF to R2 (graceful no-op without R2 env
vars). Returns `{symbolsExtracted, eventsMatched, eventsUnmatched, results}`.

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
  email, server-queried directly) + EarningsHub header "All sent →" link.
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
  `{success, data: {symbol, resolved: {time, source}|null, override, observations}}`.
- POST `{symbol, releaseTime: "HH:MM"|null}` upserts a `source='user'` `symbol_release_times` row
  (null clears ONLY user rows; validates HH:MM shape + clock bounds + [04:00, 20:00] ET) and
  re-resolves upcoming family events, returning `updatedEvents`.
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
