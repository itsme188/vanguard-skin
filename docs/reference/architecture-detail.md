> Archived from CLAUDE.md on 2026-08-10. All facts preserved; read when working in this area.

# Architecture Detail

Subsystem-level detail, historical phases, and deep integration notes moved out of CLAUDE.md.
Everything about the Cloudflare Worker, cron triggers, launchd schedules, and cloud fallbacks
lives in `docs/reference/cron-and-workers.md`.

---

## Core stack

- **App Router** — Server components for data loading, client components for interactivity.
- **SQLite** — Single `data/vanguard.db` file, WAL mode, foreign keys enforced.
- **Migrations** — Numbered `.sql` files in `lib/db/migrations/`, tracked in the
  `schema_migrations` table.

## UI shell

### Tab-based UI (post-redesign 2026-04-30)

Today | Accounts | Analysis | Research | Charts | Import (6 desktop tabs after the IA collapse).

Cut from top nav:

- **Overview** — absorbed into Today
- **Holdings** — absorbed into the Accounts cross-account section + Cmd+K ticker-jump
- **Calendar** — absorbed into the Today week-ahead block
- **Levels Review** — merged into the unified Alerts inbox

Header bell unified to `<NotificationBell>` (fired alerts + pending newsletter-extracted levels in
one stream). Theme toggle in header (light Amber / dark Bloomberg-pro), persists via `vgs:theme`
localStorage. Fonts: IBM Plex Sans + Mono only (Instrument Serif removed in Phase 8). NotesAmbient
overlay accessible from any tab via ⌘; (keyboard only — the floating button was removed 2026-09-04
per QA ruling: it sat over row controls on dense surfaces); on mobile, notes are reached through the
bottom-nav "Notes" entry (the Notes page). localStorage drafts persist either way.

### Chat drawer

Slide-out right panel (Cmd+J), accessible from any tab, persists conversation.

### Privacy toggle

`lib/privacy/context.tsx` (`PrivacyProvider` + `usePrivacy()` hook + localStorage
`vgs:privacyMode`). `lib/privacy/components.tsx` exports `<Money>` / `<Pct>` / `<Shares>` /
`<Count>` / `<PrivateText>` and `usePrivateFormatter` (wraps Recharts tick/tooltip formatters).
Header eye-icon `PrivacyToggle` flips between ink-faint and gold. When on, every user-facing dollar
/ percent / share-count masks to `•••`; symbols, dates, account names, and UI chrome stay visible.
The LightweightCharts security chart re-reads `localization.priceFormatter` + the volume formatter
+ marker text on toggle via an explicit `useEffect([isPrivate])`.

### Mobile Today view

`/dashboard/today` server component (mobile-first, single column). Server-rendered blocks:

- pending alerts (split triggered-today / older-pending)
- optional `TodayReleases` (macro + earnings with known release_time; enriched rows flip to
  "actual X · SPY ±X%")
- `NearbyLevelsCard` (armed levels within 5%)
- full-width chat launcher (`OpenChatButton` → `toggle-mobile-chat` event)
- IBKR holdings sorted by `|today_gain|` desc (today's move: latest close − prior close, via a
  ROW_NUMBER() CTE over `prices` picking rn=1 and rn=2) with a `data_quality` chip

`MobileBottomNav` maps Today to the leftmost slot (sun icon). **Today is the default landing**:
Electron `main.ts` loads `/dashboard/today`; the desktop tab nav has Today as the leftmost tab
alongside Overview. Architectural decision doc:
`docs/plans/2026-04-21-mobile-today-view-decision.md`.

### Week-ahead navigation (2026-07-28)

`/dashboard/today?view=week-ahead` honors `?weekOf=` via
`lib/calendar/date-utils.ts::resolveWeekOfParam` (any valid date snaps to its Monday via `mondayOf`;
absent/garbage falls back to the current Monday — forgiving by design, since it arrives from a URL).
`WeekAheadView` renders prev/next chevron `<Link>`s (server component — every week is a shareable
URL), a "This week" pill visible only off the current week (keyed on the RESOLVED week), an honest
micro-label (Week ahead / Past week / Upcoming week), and a past-week-aware empty message.

This is the Calendar Living Record's only week-level browse path — enriched past weeks (actuals +
reactions) are reachable here. Known display gap, filed pre-classified: the week view doesn't yet
render `reaction_snapshot` percentages (`today-week-ahead--reaction-snapshots-never-render`).

## Securities, watchlist, levels

- **Security Detail** — `/dashboard/security/[id]` hub page per security (chart, positions, lots,
  notes, events, factors, trade grades).
- **Watchlist** — Track securities not yet owned, with price targets and thesis.
- **Auto-Refresh** — TWS connect triggers the full sync pipeline automatically. Background refresh
  every 30 min. Data confidence scoring in the header.

### Security Levels & Alerts

Migrations 029–031. Per-security price levels (static OR moving-average-resolved: SMA/EMA
9/21/50/200) for both held + watchlist securities. `LevelsPanel` on Security Detail
(add/edit/pause/reactivate/delete) with chart `priceLine` overlays. `findCrossedLevels` +
`detectAndFireAlerts` run as **Step 6 of auto-refresh**; Sonnet 4.6 generates a one-sentence
recommendation per alert. Header `AlertsBell` shows the pending count; `/dashboard/alerts` is the
inbox.

Newsletter extraction (`extractLevelsFromNewArticles`) auto-runs after research sync, scoped to
held + watchlist symbols. The Sunday briefing surfaces "Levels Hit This Week" + "Active Levels
Within 5%". `/dashboard/levels/performance` (2026-04-24) scores each `source_author` by hit-rate +
30/60/90-day forward P&L with a <3-sample null rule + empty-state tolerance — linked from the
alerts inbox header. Chat tool `query_release_reactions` queries the same surface for macro +
earnings reactions.

### Mobile push (Mac side)

`lib/alerts/notify-pushover.ts`: `sendPushover` + `sendLevelAlertPush`. Graceful no-op when
`PUSHOVER_APP_TOKEN` or `PUSHOVER_USER_KEY` is missing. `detectAndFireAlerts` fires a
fire-and-forget push per new alert with symbol, triggered price, author, held quantity, and a deep
link to `/dashboard/security/[id]`. Env vars thread through `electron/settings-store.ts` +
`electron/main.ts`; UI field in Settings → "Mobile Push (Pushover)". The cloud-side mirror
(Tier 4a) is documented in `cron-and-workers.md`.

## Trade Reviews

Monthly AI trade analysis at `/dashboard/analysis?view=trade-reviews` (relocated from Research in
Phase 5, 2026-04-30; the old `/dashboard/research?view=reviews` URL redirects). Migrations
016 + 021 + 047. Two-phase: Sonnet Q&A → Opus review. Account-specific profiles
(IBKR / Vanguard / Roth). GroupedTrade abstraction (lots → trades). Auto model selection
(>20 trades → Sonnet, capped at 64k output tokens, 5000 + 400/trade).

### Column-naming rule (2026-05-04 / migration 047; legacy columns DROPPED by migration 075, 2026-08-03)

The AI's structured-output fields are `assessment` / `what_worked` / `what_didnt`, stored in DB
columns `assessment` / `what_went_well` / `what_went_wrong` respectively. The pre-047 scrambled
columns (`entry_thesis` / `exit_assessment`) and every pragma-detect reader fallback were removed
in 075 — 047's UPDATE had already copied all data (zero legacy-only rows verified at drop time).

### Period-high computation

`lib/trade-review/market-context.ts::getStockPriceContext` merges `ohlcv_bars` + `prices` into a
unified per-date map and folds the trade's own entry/exit prices into the range — neither table is
preferred outright, and the trade's actual fill prices guarantee the period range encompasses what
really happened. Defensive against the two pipelines drifting apart (TWS daily-bar sync vs
daily-snapshot prices).

### Pre-save guard

`generateTradeReview` throws "AI returned an incomplete response" when `result.review_markdown` is
empty/missing — without this, output-token truncation surfaces as the misleading SQLite NOT NULL
constraint error. The prompt instructs Claude to write `review_markdown` first as additional
defense.

### Stale-narrative banner (2026-07-06)

`lib/trade-review/stale-narrative.ts::isNarrativeStale` flags reviews whose prose predates the
2026-07-04 option-dollar repair (`9003ec4` — computeTaxLots had omitted the option contract
multiplier; stored metrics were repaired, `review_markdown` deliberately frozen) AND whose trade
set includes options. Keyed on `generated_at`, **NOT** `created_at` — the saveTradeReview upsert
refreshes `generated_at` on regeneration so the banner self-clears. All 4 affected reviews
(4 / 8 / 10 / 12) were regenerated 2026-07-06.

## Calendar Living Record

Migration 041 (2026-04-24). Post-release enrichment pipeline. `calendar_events` gains
`release_time` (HH:MM ET), `actual_value`, `consensus_value`, `reaction_snapshot` (JSON:
SPY/QQQ/TLT + sector ETF), `enriched_at`. New `sector_etf_gaps` table logs earnings with unmappable
sectors for later backfill.

### Release times

`lib/calendar/release-times.ts::resolveReleaseTime` uses a priority cascade:
`event_time` → `RELEASE_TIMES_ET` lookup → `raw_json.entry.hour` for earnings → null.

**Any new macro event source must set `event_time` at insert time (preferred) OR register its
event_type in `RELEASE_TIMES_ET`.** The hardcoded non-FRED schedule in
`lib/calendar/macro-events.ts` has a `NonFredEvent.releaseTime` field that flows to `event_time` on
insert specifically because UMich + Consumer Confidence use `event_type: "other_macro"`, which has
no lookup entry. If `event_time` is null AND the event_type isn't in the lookup, `release_time`
stays null and the enrichment runner silently filters those rows out — this broke Consumer
Confidence for 2 weeks before the 2026-04-25 UMich gap surfaced it.
`scripts/backfill-calendar-release-times.ts` is the recovery path for rows that slipped through
with a null release_time.

### Actuals dispatch

`lib/calendar/enrich-actuals.ts` dispatches on `source_key` pattern:

| Pattern | Road |
|---|---|
| `fred:<releaseId>` | FRED series |
| `fomc:<date>` | DFEDTARU |
| `finnhub:<symbol>:<date>` | Finnhub |
| `nonfred:<name>:<date>` | Claude + `web_search_20250305` |
| `manual:<SYM>:<date>:earnings` and `nasdaq:<SYM>:<date>` | both ride the Finnhub symbol+date road |

The Worker mirror carries the same regexes — see `cron-and-workers.md`.

**Any NEW earnings source's source_key must get a road here.** An unrouted key means the
retry-until-complete runner attempts forever but never fetches, the recap gate never opens, and
every print ends in a blocked-recap Pushover — this bit `manual:` rows until 8/02 and `nasdaq:`
rows until 8/04/XMTR. Diagnostic signature: `enrichment_attempted_at` fresh + `actual_value` NULL +
vendor has the data ⇒ suspect the dispatch.

### Reaction snapshots

`lib/calendar/reaction-snapshot.ts::captureReactionFromTws` fetches 1-min bars (TRADES, 9000s
duration, `endDateTime = release+125min UTC`, **useRTH=0 — never revert to 1**: RTH-only bars start
9:30 ET, so every BMO t_pre / AMC t_post / 8:30-macro pre failed the 10-min bar tolerance and the
TWS road silently lost to Yahoo for every off-hours release until 2026-08-04). Its bar-matching
helpers are pure and shared with the Worker cloud path (see `cron-and-workers.md`).

**Earnings reactions are prior-close-anchored (2026-08-04):** earnings rows pass an
`earnings`/`earningsCloseMs` opt to the capture functions so every ticker's t_pre is the last
regular-session close before the release (BMO → prior daily close via TWS daily bars / Yahoo
`chartPreviousClose`; AMC → the event day's 16:00 bar), flagged `pre_anchor:"prior_close"` and
labeled "moves vs prior close" by `formatReactionSnapshot`. This is immune to
wire-beats-the-recorded-slot: XMTR printed 7:05 vs its 8:00 slot, the old release-window pre bar
was already +8% post-news, and the email reported the fade as −4.8% when the day move was +2.9%.

**Macro rows NEVER pass an anchor** — an 8:30 CPI pre bar really is pre; don't
"consistency"-refactor the asymmetry. `composeReleaseInstant` does DST-aware ET→UTC so release
timestamps and bar timestamps stay in one reference frame. The `ReactionSnapshot.source`
discriminator is `"tws" | "polygon" | "yahoo"`.

### Candidate windowing — why the filter is in JS, not SQL

`release_time` is ET wall-clock; `datetime('now')` in SQLite is UTC; a string compare silently
offsets by 4–5h under DST. `findCandidates` does a SQL pre-filter by `event_date` range, then a JS
final filter via `composeReleaseInstant`.

### UI + plan

`EnrichmentChips` on Calendar rows ("actual 3.2% · SPY -0.41%"), the `TodayReleases` block on the
Today view, and "Released Last Week" context in the briefing via `formatReleasedEventForPrompt`.
Plan: `docs/plans/2026-04-24-calendar-living-record.md`.

## Research ingestion

### Long-email ingestion caps (single source, 2026-07-03 `ea64aad`)

`lib/gmail/prompt-caps.ts` owns `RAW_TEXT_STORE_CAP` / `RAW_HTML_STORE_CAP` (500k) +
`EXTRACTION_PROMPT_CHAR_CAP` (150k) + `truncateForPrompt`. The Worker mirror is parity-pinned —
see `cron-and-workers.md`.

Gmail REST (`format:"full"`) returns complete bodies (the web UI's ~102KB clipping is cosmetic);
every truncation is ours. History: the old 50k-store / 15k-prompt caps meant long weeklies'
(Eliant) summaries reflected only the opening ~15% for months. **Never add a new `.slice()` on
newsletter body text outside prompt-caps.** Repair path: `scripts/backfill-longform-bodies.ts`
(refetch from Gmail) + `scripts/process-unprocessed-articles.ts` (re-summarize). Briefing deep-read
caps are separate cost-gated constants in `lib/calendar/briefing.ts` (100k/400k since 2026-07-03).

### Email filtering (D-tier, single source of truth)

Three gates flip `research_articles.is_relevant=0` so digest / briefing / earnings-email readers
exclude noise:

- **(D1/D2)** `lib/gmail/short-circuit.ts::checkShortCircuit` regex-matches Substack admin mail
  (payment receipts, welcome, gift, password reset) at fetch time — the body never reaches Claude.
- **(D3)** `lib/gmail/process.ts::processUnprocessedArticles`, in its post-extraction branch, reads
  Claude's `is_portfolio_relevant: boolean` vote on `ANALYSIS_SCHEMA` and flips
  `is_relevant=0 + excluded_category='off_topic'` when false AND the source's
  `research_sources.allow_off_topic` column (migration 055) is 0. The **prompt is biased to
  under-filter** — it defaults to TRUE on uncertain content, with `is_portfolio_relevant !== false`
  normalization in `extractWithClaude`. The Worker path stores the raw vote and the Mac applies D3
  at reconcile time (see `cron-and-workers.md`).

UI for the opt-out (2026-06-09 `b89b9cf`): a per-source "off-topic OK" chip-button in
`ManageSourcesModal` → `PATCH /api/research/sources {id, allow_off_topic}`.

Digest read paths opt in via `getRecentArticles(db, { relevantOnly: true })`; `getFullTextForSources`
+ `getArticlesForSecurity` + `getRecentArticleSummaries` + the earnings-email inline queries filter
unconditionally. The Research → Feeds main listing does NOT filter (the user should see everything).

**D5 audit UI:** `<FilteredArticlesList>` in `app/dashboard/components/ResearchFeedsView.tsx`
(desktop-only via `hidden md:flex`) renders `is_relevant=0` rows grouped by category with an
`<Unfilter>` button; `POST /api/research/articles/[id]/unfilter` flips them back via
`lib/mutations/research-articles.ts::unfilterArticle`. For admin-short-circuited rows (no
`processed_at`), unfilter exposes them to the next `processUnprocessedArticles` pass; for D3 rows,
content flows straight into the next digest because all consumers re-query with the predicate.

## AI model routing

`lib/ai/provider.ts` is the translation layer between logical feature keys (`FeatureKey` in
`lib/ai/feature-keys.ts`) and concrete AI SDK language models. `lib/ai/models.ts::FEATURE_MODELS`
maps each feature to a `"<provider>/<spec>"` string where `<spec>` is normally a **tier token**
(`$frontier` / `$workhorse` / `$cheap`) that `resolveFeatureModel` expands to a concrete callable
model (see Tier-based model resolution below); the deliberate Workers-AI experiment
(`alertSuggestion`) stays an explicit `<provider>/<model-id>` spec.

Most Claude call sites use the tier-aware wrappers `generateTextForFeature` /
`generateObjectForFeature` (`lib/ai/generate.ts`, which add reactive failover + `AIRefusalError`
handling) or `getModelForFeature("<key>")` instead of instantiating `new Anthropic()`. The **two**
raw-client exceptions:

1. `vanguard-pdf.ts` uses `getRawAnthropicClient("pdfParsing")` to keep its custom
   `messages.stream()` retry logic.
2. `lib/digest/send-earnings-email.ts::callClaude` uses `getRawAnthropicClient` because
   Claude-native `web_search_20250305` is required and not yet exposed by the AI SDK provider — but
   it **must still derive its model id from `resolveFeatureModel(featureKey)`**, never hardcode
   `SONNET_MODEL` / `OPUS_MODEL`. Pre-fix earnings emails ignored every FEATURE_MODELS swap
   silently (`921d552`, 2026-05-05).

Swapping Kimi K2 / Llama 3.3 / GPT-5 into any feature is a one-line change in `FEATURE_MODELS`.

### User-facing override layer (2026-06-09)

Settings key `feature_model_overrides` (JSON featureKey→spec) is consulted FIRST by
`resolveFeatureModel` via the `lib/ai/override-source.ts` injection seam (30s TTL cache + write
invalidation; `lib/db.ts` registers the reader — **never import the db singleton into `lib/ai`**).
UI: `AiModelsSection` in SettingsModal; API `GET/PATCH /api/settings/ai-models`. `vanguard-pdf.ts`
resolves its model per-call (`pdfModelId()`) — a module-level const would freeze past the override.

### AI Gateway

When `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` env vars are set, every call routes through
Cloudflare AI Gateway with `cf-aig-metadata: {"feature":"<key>"}` for per-feature cost tracking.
Missing env vars transparently fall back to direct provider URLs — no behavior change for dev
without Cloudflare creds.

### Live Phase 2 experiments

`alertSuggestion` → Llama 3.3 70B on Workers AI (~2.4s/call). `newsletterLevelExtraction` was on
Kimi K2.6 but reverted to `anthropic/${SONNET_MODEL}` on 2026-04-30 (`c819c55`) after 30 days /
40 articles produced 0 visible content — Kimi's `reasoning_content` consumed the full 2048
`max_tokens` budget on extraction-style prompts (`finish_reason: length`, `content: null`).

Three Workers AI gotchas:

1. Kimi K2.x is a *reasoning* model whose `reasoning_content` shares the `max_tokens` budget — even
   `maxOutputTokens=2048` was insufficient for prompts asking for structured JSON over
   multi-thousand-token input; safe only for short prompts with short structured output.
2. Llama on Cloudflare's compat endpoint auto-parses JSON-shaped output into an object instead of a
   string, breaking AI SDK's schema — don't use Llama for raw-JSON prompts.
3. Reasoning models bill the reasoning tokens as completion tokens, so cost-per-call is
   meaningfully higher than the model card's $/MTok suggests.

See `memory/project_ai_gateway.md`.

### Tier-based model resolution (2026-06-14)

The app picks Claude models by capability **tier**, never a hardcoded id. `lib/ai/model-tiers.ts`
is the ONE human-editable policy file — ordered family ladders
(`frontier: [fable, opus, sonnet]`, `workhorse: [sonnet, haiku]`, `cheap: [haiku]`) +
`TIER_STATIC_FALLBACK`; `resolveTier` (pure) picks the newest available version of the
top-priority family. A version bump and a model pull are both automatic; only a brand-new FAMILY
NAME needs a ladder edit (plus its parity-pinned Worker mirror — see `cron-and-workers.md`).

The "available" set is the live **catalog** (`lib/ai/model-catalog.ts`, settings key
`model_catalog`, refreshed weekly by the Sunday briefing pipeline, read synchronously via the
`lib/ai/catalog-source.ts` seam — same db-singleton-avoidance pattern as `override-source.ts`).

**CRITICAL gotcha (verified live):** a PULLED model stays LISTED in `/v1/models` but 404s on use
(e.g. `claude-fable-5` under the gov cyber hold — listed but uncallable; `claude-opus-4-8`
callable), so discovery alone does NOT avoid it. `refreshModelCatalog` therefore **probes
callability** (`pruneToCallable` — a 1-token test call per tier selection, drops only on a
definitive 404/403, never on 429/500) and stores **callable-only** models → `frontier` resolves to
`claude-opus-4-8` today, and auto-returns to Fable when its probe passes.

**Reactive failover** (`generate.ts` wrappers: 404/not_found → drop dead model → retry next rung) is
the mid-week safety net for wrapped calls; chat (`streamText`) has refusal-logging only and relies
on the callable-only catalog.

**When recording/displaying a concrete model id, use `resolveFeatureModel(key).modelId`, NEVER
`FEATURE_MODELS[key]` (now a tier token)** — this bit gmail/process, the briefing's saved `model`,
and trade-review progress strings (all fixed).

Precedence: user override (`feature_model_overrides`) → tier token / explicit default → static
fallback; a `$tier` override expands too, and a malformed override falls back to the tier-aware
default. Observability: `[ai] tier "X" now resolves to Y (was Z)` logs on a change.
Spec/plan: `docs/superpowers/specs/2026-06-14-model-tier-resolution-design.md`; topic:
`memory/reference_model_tier_resolution.md`.

## R2 statement archival

`lib/storage/r2.ts` uploads source PDFs to Cloudflare R2 via `aws4fetch` (S3-compatible, Sigv4).
Migration 033 adds `import_batches.raw_file_r2_key`. `/api/import?mode=commit` fires an async
upload after the DB commit (graceful no-op when `R2_*` env vars are missing). Key format:
`{sourceType}/{filename}`. 39 existing Vanguard PDFs were backfilled via
`scripts/backfill-r2-statements.ts` (idempotent via a HEAD check). Env vars: `R2_BUCKET_NAME`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` (falls back to
`CLOUDFLARE_ACCOUNT_ID`). Pure disaster-recovery — parsed data still lives in SQLite; R2 is
insurance against Mac loss.

## Earnings digest (2026-04-27 → 2026-04-28; redesigned 2026-04-28 evening)

Pre-/post-earnings preview + recap emails for held names.

### Sweep

The Mac launchd enrichment loop calls `POST /api/cron/earnings-sweep` every 15 min (schedule detail
in `cron-and-workers.md`). The sweep route reads `findEmailCandidates(db)` from
`lib/calendar/enrichment-runner.ts` — preview window `[release-135min, release-105min]`, recap
window `[enriched_at, enriched_at+4h]` — filtered by held|watchlist (`getSymbolStatus`) +
audit-row absence (`earnings_emails`, migration 042, UNIQUE(event_id, phase)) +
`getEarningsSettings(db).enabled` master toggle + the muted-symbol list.

### Composer

`lib/digest/send-earnings-email.ts` produces a deterministic 6-row scoreboard table at the top
(`renderHeadlineTable` parses `consensus_estimate` + `actual_value` + `reaction_snapshot` JSON),
then an AI-generated line-by-line bogies markdown table, then prose.

`briefingToHtml` parses GitHub markdown tables and emits a **light palette** (white-bg cells, dark
text, warm-gold-tint header, 14px padding on empty cells) so the email is print-and-fill-by-hand-able
for live earnings calls — locked 2026-04-28 after user feedback that dark scoreboard tables are
unprintable.

Issuer-family aware (`issuerSiblings`) so a TER LEAP option in Vanguard Taxable rolls up under
TER's earnings event. Two feature keys (`earningsPreview` / `earningsRecap` → Sonnet 4.6 on
Anthropic with `web_search_20250305` to fill consensus / sell-side gaps). User notes from the
`notes` table render FIRST in the prompt so the AI frames the briefing as a conversation with the
prior thesis.

### Earnings Hub

Block on `/dashboard/today` (between TodayReleases and Alerts) listing deduped earnings (Finnhub
preferred over manual via ROW_NUMBER) with held / watchlist / no-position chips + preview-sent /
recap-sent chips. Inline `+ Add ticker` form posts to `/api/calendar/events` POST/PATCH/DELETE,
which writes `source='manual'` rows (`source_key='manual:SYMBOL:DATE:TYPE'`).

### Pre-season hardening (2026-07-05, `f13a340..4274ed2`)

- The sweep is single-sourced at `lib/calendar/email-sweep.ts::runEarningsEmailSweep` (route + tsx
  fallback both delegate; it carries the marker dance — pre-fix the dance lived only in per-event
  routes nothing calls, and every awake-Mac preview would have double-sent).
- Enrichment is retry-until-complete (migration 062).
- Sends are claim-mutexed (`earnings_emails.error` tri-state).
- A blocked-recap Pushover alert fires when a previewed print sits 2h+ with no actuals.
- The Worker preview window differs from Mac's (see `cron-and-workers.md`).

Full audit: `docs/plans/2026-07-04-earnings-season-audit.md` (remaining open: cockpit +
intelligence tier; B8 closed 2026-07-07; B15–B20 closed 2026-07-06). Manual week backfill:
`npx tsx scripts/sync-calendar-weeks.ts <monday>...`.

### Wave 1 (2026-07-05 evening, `f3cc804..8eace90`) — Mac side

- The Sunday briefing syncs **4 weeks ahead** plus a coverage guard
  (`lib/calendar/coverage-guard.ts` — due = last report >75d with nothing scheduled in 45d;
  `coverage_guard_ignored_symbols` settings valve; the block is appended to the briefing at SEND
  time only + a once-per-ET-day Pushover).
- **B10** — watchlist + held-option underlyings join the Finnhub AND Nasdaq scans (one hoisted
  symbol set).
- Cloud-side Wave 1 items (push-at-print, B7, snapshot v8) are in `cron-and-workers.md`.
- Spec: `docs/superpowers/specs/2026-07-05-earnings-wave1-design.md`.

## Earnings-day cockpit (2026-07-08)

`<EarningsCockpit>` on `/dashboard/today` (above EarningsHub): BMO/AMC lanes of today's +
unfinished-yesterday held/watchlist reporters, live 5-stage chips (preview → released → actual →
reaction → recap), a countdown to the next print, per-family delta-adjusted net exposure
(`lib/compute/exposure.ts::getNetExposureForSymbolFamilies` — family rollup via `issuerSiblings`,
shorts signed, options via a Greeks map with a ±2.5× fallback), and 60s visibility-gated polling of
`GET /api/earnings/cockpit`.

**Read-only over the pipeline** — stage state derives in the pure
`lib/earnings/cockpit-stages.ts::deriveEventStages` (blocked = ≥2h past a KNOWN release instant —
`isPastDay` alone only blocks when no instant exists; the reaction-ready label mirrors
`REACTION_READY_MS`; consensus precedence + `isPlausibleEarnings` inherited).

**Email tri-state read:** `lib/queries/earnings-emails.ts::getEmailStatesForEvents` is the ONLY
`earnings_emails` reader that surfaces `'in_progress'` claims (as "in-flight") — never reuse
`getSentPhasesForEvents` where in-flight must show. The cockpit deliberately uses BOTH (tri-state
for chips, sent-phases for the carryover completion check).

**Structured post-call capture:** migration 064 `earnings_call_notes` (UNIQUE(event_id), guidance
enum raised/inline/lowered/not_given, full-replace upsert), `<CallNoteModal>` (BogeysEditModal
idioms: portal + cancelled-flag + typed responses + synchronous field reset on open), feeding the
recap prompt (`renderCallNoteBlock` — immediately AFTER user notes) and next quarter's preview
(`renderPriorCallNoteBlock` via the family-aware
`getLatestCallNoteForFamily(db, symbol, event_date)`, exclusive-before).

**React gotcha locked in review: never define a component inside `EarningsCockpit`'s body** — the
1s countdown tick re-creates the type each render and React remounts the subtree, silently closing
open modals (the Lane hoist fix).

The blocked chip deep-links to BogeysEditModal's always-inline actuals form; sent chips open
`<EarningsEmailViewer>`. Spec: `docs/superpowers/specs/2026-07-08-earnings-cockpit-design.md`.
