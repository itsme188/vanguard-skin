> Archived from CLAUDE.md on 2026-08-10. All facts preserved; read when working in this area.

# Data Integrity

## 0. First principles

When working with financial data (prices, valuations, dates, events), **NEVER** use hardcoded or
guessed values. Always use authoritative data sources (APIs like FRED, Hebcal, IBKR) instead of
generating dates, prices, or financial figures from training data.

When data appears missing or wrong, **investigate the root cause** (check the API response, query
the DB directly) before building UI workarounds. The import engine now derives prices from holdings
`market_value` — every holding with a market value produces a price automatically on import.

---

## 1. Number rendering on user surfaces — single source of truth

- `lib/format.ts::formatLargeUSD`:
  - ≥ $1B → `$N.NNB`
  - ≥ $1M → `$N.NM`
  - ≥ $1k → comma-grouped
  - sub-$1k → 2dp EPS-scale
- `lib/format.ts::parseLargeUSD` accepts `$4.34B` / `4340M` / raw / commas.

Anywhere a Finnhub-shaped string `"EPS X.XX · Rev N"` reaches the user, it goes through
`lib/format/finnhub-figure.ts::formatFinnhubFigure[Compact]` first — **never render the raw
string**.

Applies to: EarningsHub rows, TodayReleases est line, EnrichmentRowSummary, EnrichmentDetail, email
scoreboard, BogeysEditModal display.

Pure formatters at the file level (`formatUSD` / `formatPercent`) are still OK for LLM prompts, CSV
exports, and aria-labels.

---

## 2. Risk-free rate — single source of truth

`lib/queries/risk-free-rate.ts::getRiskFreeRate(db)` reads the cached FRED **DGS3MO** 3-month T-bill
rate from `settings` (key `risk_free_rate`). It falls back to **0.045** if never fetched OR if the
settings table doesn't exist (in-memory test DBs).

Used by:

- `lib/compute/risk.ts` (Sharpe ratio)
- `lib/compute/options-greeks.ts` (Black-Scholes drift)

It replaces the prior 0.045 hardcodes. `scripts/refresh-risk-free-rate.ts` is the manual refresh
path; cache TTL is **48h** via `isRiskFreeRateStale()`.

**Never hardcode 0.045 in new code — always go through `getRiskFreeRate(db)`.**

---

## 3. Empty-state shell — `<EmptySection>` instead of silent `return null`

`app/dashboard/components/EmptySection.tsx` is the single primitive for sections whose data
prerequisite is absent. It renders a titled card with a `reason` (one sentence) plus an optional
`hint` (italic explanation in a tooltip and below-text).

It replaces the silent-null pattern in OptionsGreeksCard / OptionsStrategies / ExpirationCalendar /
FixedIncomeCard.

New Analysis sections that may have no data (no held bonds, no options, etc.) should render
`<EmptySection>`, not `return null` — the page should look intentional, not partially-broken.

---

## 4. Per-scope benchmark default + picker pattern

`app/dashboard/components/FactorAnalysis.tsx` exports `DEFAULT_BENCHMARK_BY_SCOPE`:

| Scope | Benchmark |
|---|---|
| Vanguard | VTI |
| IBKR | QQQ |
| Roth | SPY |
| ALL | SPY |

The Factor Analysis card auto-applies the scope default but lets the user override via a `<select>`
next to the section title.

The same pattern can extend to other scope-aware comparisons (Performance vs. index, e.g.) — keep
the per-scope defaults in one place and reuse the dropdown idiom.

---

## 5. Dual-class symbol resolution — always via `issuerSiblings()`

- `lib/queries/briefing-symbols.ts::getSymbolStatus` walks the issuer family so GOOGL events classify
  as HELD when the user owns GOOG.
- `getSecurityIdForSymbolWithSiblings` does the same for `security_id` lookup.
- `getEarningsForWeekDeduped` post-resolves null `security_id` via family so `<SymbolLink>` fires
  across class A/B variants.

**Pattern:** never compare symbol-string-equal when the surface is user-visible — run
`issuerSiblings(symbol).map(s => s.toUpperCase())` first, then check membership.

---

## 6. Earnings recap requires `actual_value IS NOT NULL`

Commit `921d552`, 2026-05-05.

Enforced in two places:

1. The SQL gate in `findEmailCandidates` (`lib/calendar/enrichment-runner.ts`).
2. A defensive guard in `sendEarningsEmail` (returns **409**).

`enriched_at` alone is **not** sufficient: it only signals that the runner attempted enrichment, not
that actuals were captured. Pre-fix, recaps fired the moment enrichment touched the row and the AI
filled actuals via `web_search` or — worse — drifted back to consensus.

Better no email than a wrong one. The user can re-fire once enrichment lands, or via
`POST /api/earnings/actuals` manual override.

---

## 7. `renderHeadlineTable` consensus precedence

Both columns read `consensus_value ?? consensus_estimate`, never split.

`consensus_value` wins because it's set by the enrichment runner at release time;
`consensus_estimate` is the older Finnhub-sync-time snapshot.

Pre-fix, the cons column read `consensus_estimate` while the actual fallback read `consensus_value`
— when those diverged, the user's printable Δ column was wrong (`921d552`).

---

## 8. `getCrossAccountPositions` cost-basis fallback

TWS auto-refresh writes intra-day positions with `cost_basis = NULL`. Statement imports write the
same `(account, security)` pair with `cost_basis` populated on the period-end date.

The query keys off `MAX(as_of_date)` per `(account, security)` for quantity + `as_of_date`, but
**must `COALESCE(h.cost_basis, latest non-null statement row)`**.

Pre-fix, the most recent TWS row's NULL `cost_basis` silently masked the statement value, the AI saw
"cost basis ?" and hallucinated "around your cost basis" for PRIM (user up 115%) (`921d552`).

---

## 9. Earnings composer model self-talk discipline

`callClaude` passes a strict `system` prompt ("first character must be `#`, no preamble, no
narration, no closing commentary") and post-processes through `stripModelPreamble`, which trims any
leading lines that aren't markdown structure markers (`#`, `|`, `-`, `*`, `>`, `---`, code fence).

Sonnet 4.6 occasionally leaks "Good, now I have enough to construct the brief. Let me synthesize…"
without these guards. The system prompt is the primary defense; `stripModelPreamble` is the
failsafe.

Don't write helper output that needs to start with anything other than a markdown structure marker —
the stripper will eat it (`921d552`).

---

## 10. `isPlausibleEarnings` — applied at `renderHeadlineTable` AND `EarningsHub.tsx`

Same `>1.7×` / `<0.5×` EPS sanity guard that read-throughs use.

- **Email scoreboard:** actual cells blank out and a
  `⚠ Reported actuals were flagged as implausible` italic sub-line surfaces beneath the table.
- **Today-view EarningsHub:** `actualsAreImplausible(consensus, actual)` helper wraps
  `parseFinnhubFigure` + `isPlausibleEarnings`. Flagged rows render `—` in the Cons EPS / Act EPS /
  Cons Rev / Act Rev cells with a `⚠` glyph in the delta cell (desktop), or an italic warning
  replacing the Act line (mobile).

Add a guard on any new surface that displays a Finnhub-shape `actual_value` string — the helper
lives in `app/dashboard/today/EarningsHub.tsx` and is exported for reuse.

---

## 11. Finnhub queried-symbol canonical

`fetchFinnhubEarningsForSymbols` uses the symbol the app **queried** as the canonical identifier —
never trust `entry.symbol` from the response, which can come back with a foreign-exchange suffix
(e.g. asking for "GFL" returns "GFL.TO", the Toronto listing).

The raw Finnhub-returned symbol stays in `raw_json.finnhub_symbol` for debugging.

Pre-fix, GFL.TO events never surfaced as held in EarningsHub because `getSymbolStatus` matched on the
user's "GFL" while we'd stored "GFL.TO" (`921d552`).

---

## 12. Earnings bogeys — `earnings_bogeys` is the single home for user-curated consensus + whisper

**Migration 043.**

### 12.1 Upload inlet (PDF or screenshot)

Multi-symbol PDF **or screenshot** upload (2026-07-26, `c6e6598`): PNG / JPEG / WebP / GIF via the
Claude `image` block — iPhone screenshots are PNG; HEIC photos are rejected with guidance;
`resolveBogeysUploadMediaType` maps MIME-first, with extension fallback only on empty/octet-stream.

Flow: `lib/earnings/extract-bogeys.ts::extractBogeysFromUpload` (`extractBogeysFromPdf` is the
back-compat wrapper; Sonnet + native document/image block + `parseLargeUSD` defensive coercion) →
fan-out via `issuerSiblings()` to matching `calendar_events` rows in `[weekOf-3d, weekOf+10d]`.

### 12.2 Composer integration

`send-earnings-email.ts::renderBogeysBlock` slots after the user-notes block; the recap prompt
explicitly anchors beat/miss on whisper when present.

### 12.3 Per-event UI

`BogeysEditModal` has three sections:

1. Existing list + delete.
2. **Actuals override** — writes back to `calendar_events.actual_value` in Finnhub-shape via
   `POST /api/earnings/actuals`.
3. Manual entry.

UNIQUE on `(event_id, source, source_label)` so re-uploads update in place.

### 12.4 Newsletter auto-extraction (#11, 2026-07-16)

`lib/earnings/extract-newsletter-bogeys.ts::extractBogeysFromNewArticles` runs after
`extractLevelsFromNewArticles` in **BOTH** research-sync routes (best-effort, never fails the sync).

- Scanned-marker column `research_articles.bogeys_scanned_at` (**migration 066**) — mark on success
  AND on no-mention, never on transient failure.
- Symbol pre-filter gated on the `AMBIGUOUS_TICKER_WORDS` stoplist: common-English-word tickers like
  IT / ALL / NOW / MET / LOW need a `$cashtag` or a finance cue; normal tickers including 3-char
  TSM / AMD / GS match plain prose. **NEVER re-gate on length** — the length gate silently killed
  major holdings.
- `extractJsonArray` + `parseLargeUSD` parsing.
- Rows land with `source='newsletter'`, `source_label=<source name>`, and `ai_extraction_model` from
  `resolveFeatureModel`.
- Feature key `newsletterBogeyExtraction` → `$workhorse`.

### 12.5 Sunday-briefing reminder

`lib/earnings/bogeys-reminder.ts::renderBogeysReminderLine` appends one sentence at **SEND** time
(coverage-guard discipline) when ≥3 held/watchlist reporters in `[weekOf, weekOf+4d]` have zero
bogeys.

### 12.6 Expected move (feedback #5, migration 073, 2026-08-03)

`earnings_bogeys.expected_move_pct` — absolute percent (±6% → 6) — captured by all three inlets:
PDF/screenshot + newsletter extraction prompts, and the manual modal.

Parsed everywhere through `lib/format.ts::coercePercent` (single source; tolerates `"±6.0%"` /
`"+/-6%"`). **Never `parseLargeUSD` for percents.**

**Sheet > straddle > iv_approx precedence** lives in
`lib/earnings/expected-move.ts::resolveExpectedMove` (zero-import; byte-parity Worker mirror
`workers/cron/src/expected-move.ts`, parity-pinned), applied at exactly three choke points:

1. Composer `loadIntelView`
2. Cockpit `decorateCockpitIntel`
3. Worker `resolveIntelCtx`

**Never inline a second precedence.**

Sheet-resolved renders source-labeled (`±6.0% (TMT Breakout 7/28 weekly)`) with no staleness suffix —
a curated bogey doesn't decay like options pricing. Snapshot bogey rows carry the column; pre-8/03
snapshots degrade to market-derived.

---

## 13. Earnings intelligence cache (migration 065)

`earnings_intel` holds per-event implied move: straddle via headless IBKR chain
(`lib/ibkr/option-chain.ts`, with params/field-codes pinned by
`scripts/probe-ibkr-option-chain.ts` — **NEVER edited from docs alone**), with an `iv_approx`
fallback.

### 13.1 Chain cache warm-up (2026-07-20 live probe)

`/iserver/secdef/strikes` returns the empty cold-cache shape **INDEFINITELY** (9+ polls, multiple
months, RTH included) unless a `/iserver/secdef/search?symbol=X&secType=STK` call runs first.

`resolveAtmContracts` issues a best-effort warm-up search before the month scan (failure non-fatal,
retry loop kept as defense) and `ResolveArgs` carries `symbol` for it.

**Never remove the warm-up:** without it, every intel row silently degrades to `iv_approx` — the
entire Apr–Jul season did. The 7/8 probe's "polling warms it" note held only because that session's
own search calls had primed the cache.

### 13.2 `earnings_report_history`

Per-symbol AV surprise history + Yahoo next-day moves. 70d staleness, ≤12 quarters, family-aware
reads.

### 13.3 Orchestration

Single orchestrator `lib/earnings/intel.ts::ensureIntelForEvents` — 30-min in-process TTL, AV cap
5/run, never throws (intel can never block a send).

Consumers:

- Preview composer (`forceFresh` at T-2h)
- Recap echo (read-only)
- Cockpit route (`decorateCockpitIntel` — `buildCockpitPayload` itself stays network-free)
- Snapshot v9 → Worker read-only rows with "as of"

All figures are public market data — plain formatters, never privacy-masked.

Spec: `docs/superpowers/specs/2026-07-08-earnings-intelligence-design.md`.

---

## 14. Same-day transcripts (#12, 2026-07-16)

`lib/transcripts/same-day.ts::fetchSameDayTranscripts` runs as the **LAST** best-effort step of
`runEarningsEmailSweep` (never throws, never blocks).

### 14.1 Candidate selection and pacing

Candidates = held/watchlist earnings events with actuals, released ≤36h ago (negative age excluded —
a pre-print manual actual never fetches), family-deduped, with no cached transcript for
`(ticker, year, quarter)`.

Pacing via `calendar_events.transcript_attempted_at` (**migration 067**) — stamped BEFORE the fetch,
≥30 min between attempts, `datetime()` on both sides. ≤2 fetch attempts per tick (Alpha Vantage free
tier).

### 14.2 Cached-EDGAR rows are UPGRADE candidates, not terminal (thin-8-K fix, 2026-07-19)

An `edgar_8k` cache row is a press-release excerpt — a thin one is just the 8-K cover page. It keeps
the event a candidate on a **slower clock**: a 10-day deadline from release, 24h pacing (AV posts
transcripts DAYS after the call; ≤1 AV call/day/name), flowing into `fetchTranscript`, whose
built-in cache-hit AV upgrade does the work.

Fresh candidates spend the shared per-tick budget first, and a FAILED upgrade (fromCache echo) counts
as attempted-not-fetched and never re-runs the AI desk note.

**Never re-add an orchestrator-level `if (cached) continue`** — that exact check dead-coded the
upgrade path and permanently poisoned NFLX Q2 on a 4,091-char cover page. Repair path:
`scripts/upgrade-edgar-transcript.ts <TICKER> <YEAR> <Q>`.

### 14.3 Digest-side dedupe and heading demotion

`composeCallTranscriptsBlock` dedupes same-`(ticker, year, quarter)` rows to the best source (EDGAR
plus its AV upgrade can land in one 24h window), and `demoteEmbeddedHeadings` demotes desk-note
H1/H2s at **RENDER** time (leading title dropped, section heads → `**bold**`) — before truncation,
so the bold-marker balancing sees the final set.

Fetch goes through the existing `lib/transcripts/fetch.ts` chain — the orchestrator's only write is
the stamp.

### 14.4 AI summary

Transcripts with text get a desk-note rewrite via feature key `transcriptSummary` (`$workhorse`, 50k
char cap, preamble-stripped at store time — same marker set as `stripModelPreamble`).

**Since 2026-07-23 the output is VALIDATED before the upsert:**

- `isValidDeskNote` requires a mandated `**Guidance**` / `**Tone**` / `**Surprises**` /
  `**Key quotes**` label.
- `looksLikeDeskNoteRefusal` rejects request-for-input phrasing.
- Transcripts under `MIN_TRANSCRIPT_CHARS_FOR_AI` = **5000** chars skip the AI call entirely.

Why: a thin-8-K soft refusal ("Please provide the transcript…") overwrote 3 extractive summaries and
shipped in the 7/23 digest. Rejection keeps the extractive summary; repair path
`scripts/repair-desk-note-refusals.ts`.

The upsert echoes every other cached column (full-replace UPSERT — a partial payload silently nulls
`guidance` / `risk_factors`). AI failure keeps the extractive summary.

### 14.5 Digest surface (redesigned 2026-07-20, user decision)

`lib/digest/call-transcripts.ts::composeCallTranscriptsBlock` (sync, never throws) renders last-24h
held/watchlist transcripts as `## Call transcripts` in the **MORNING digest only**, as a compact
desk-note notice:

- When the (heading-demoted) summary has a `**Guidance**` section → Guidance section (900-char cap) +
  a one-line `Tone:` digest + a deep link to Security Detail via `PUSHOVER_LINK_BASE` (plain text
  when unset).
- Extractive-only rows keep the 600-char teaser.

**The raw `guidance` column is NEVER rendered** — `extractGuidance` keyword-matches transcript
paragraphs and on real calls captures the safe-harbor boilerplate + opening Q&A (the 7/20 NFLX
render).

The header carries the call date, COALESCE'd in SQL from sibling rows of the same
`(ticker, year, quarter)` — the AV upgrade row never has `call_date` and its 8-K sibling usually sits
OUTSIDE the 24h window, so the subquery scans the whole table.

Truncation is markdown-span-safe: an odd `**` count closes the span, and `briefingToHtml`'s inline
regex needs same-line closure.

**Rationale:** the user wants reactions/commentary the morning after a print, not the transcript; the
days-late AV desk note is a notice + two takeaways, with full text in-app. TranscriptCard picks new
rows up with zero UI work.

---

## 15. In-app email viewer — read-only, no schema work

- `earnings_emails.ai_output_md` already persists the AI prose.
- `briefingToHtml` is pure (markdown → email-safe HTML).
- The scoreboard rebuilds deterministically from `calendar_events` columns via the exported
  `renderHeadlineTable(event, symbol, phase)`.
- `<EarningsEmailViewer>` modal iframes the full HTML for fidelity.
- Mounted on `EarningsHub` via clickable `EarningsRowChips`, and on `CalendarView`'s expanded panel
  via the `getSentPhasesForEvents` query.

---

## 16. Outbound email = Resend; inbound = Gmail (intentional split)

Shipped 2026-04-29 (`dc9577d`).

### 16.1 Outbound

`lib/email.ts::sendEmail({to, subject, html, fromLocalPart, replyTo?})` is the single Mac-side
outbound entry point. It uses nodemailer over `smtp.resend.com:465`, reads `RESEND_API_KEY` +
`RESEND_FROM_DOMAIN`, and sends `From: "Portfolio Desk" <{localPart}@{domain}>`.

`workers/cron/src/resend.ts::sendEmail(env, opts)` is the Worker mirror, via plain `fetch` to the
Resend REST API.

**Per-call `fromLocalPart` is the only knob** — `briefing` / `digest` / `earnings`, or any new
surface (the domain accepts any local-part).

### 16.2 Inbound — do NOT consolidate to Resend

- `lib/vital-knowledge.ts` + `lib/calendar/briefing.ts` IMAP-fetch newsletters from the user's
  personal Gmail using `GMAIL_ADDRESS` + `GMAIL_APP_PASSWORD`.
- `workers/cron/src/gmail.ts` (now read-only after stripping `sendMessage`) lists Gmail messages in
  the fallback-digest using the `WORKER_GMAIL_*` OAuth refresh-token.

Newsletter senders deliver to a personal inbox, not the verified domain — **keep these split
forever**.

### 16.3 Domain setup

Subdomain isolation: Resend's bounce/return-path is on `send.myportfoliodesk.com` while DKIM signs
the apex — **don't undo this**.

Cloudflare Email Routing catch-all (`*@myportfoliodesk.com`) handles inbound replies for free.

Topic file: `memory/project_resend_email_swap.md`.

---

## 17. Tax export filing-readiness gate (marker-gated, supersedes the blanket NOT-FOR-FILING banner)

Number-trust durable fixes, 2026-08-23 (predecessor: containment `6ae273b`, same day). Spec:
`docs/superpowers/specs/2026-08-23-number-trust-durable-fixes-design.md` (WS1).

The containment-era blanket `-NOT-FOR-FILING` banner is replaced by a fail-closed, per-(account,
tax-year) marker gate — `lib/compute/tax-report.ts`'s `filingReady` and
`lib/compute/tax-convention.ts`'s `getTaxConventionState` / `isYearAccepted`.

- **Generation counter**: `tax_input_generation` (a `settings` row) bumps on every material tax-input
  mutation. Two markers bind to it — `tax_lots_convention = "v2:<generation>"` (stamped by
  `computeTaxLots` as its final in-transaction act: the engine ran under the current true-dollar
  convention — see `docs/reference/conventions-detail.md`) and
  `tax_report_broker_accepted = {generation, coverage: [{accountId, taxYear}]}` (stamped ONLY by
  `scripts/reconcile-tax-report-vs-broker.ts --stamp`, and only on a PASSING reconciliation against
  transcribed statement/IBKR-activity realized figures). A stale generation on either marker reads as
  absent — fail-closed by construction.
- **`filingReady`**: true only when the recompute marker is current AND every account with ANY
  `tax_lot_sales` activity that year (not just the filing-eligible rows — an account whose only
  activity is an engine-owned `RECONCILE_CLOSE` still needs acceptance) is covered by the acceptance
  marker. An empty account universe never vacuously passes.
- **Filename gate**: `buildTaxReportFilename` appends `-NOT-FOR-FILING` unless `filingReady` — the
  single-sourced call site for both the CSV/TXF `Content-Disposition` and the client-side download
  name (`TaxReportCard.tsx`). Never re-derive the filename inline.
- **Never bypass the gate** — there is no override flag. The only way a year's banner clears is
  running the recompute (`scripts/recompute-tax-lots-v2.ts --apply`, rehearsed on a DB copy first)
  and the acceptance harness with `--stamp` against real transcribed broker figures (statement
  realized-gain sections + IBKR annual activity CSV). See the spec's Rollout runbook.
- **Wash-sale W codes stay advisory permanently** — `detectWashSales` is a heuristic 30-day
  same-security scan, not a broker-confirmed 1099-B adjustment, regardless of `filingReady`.
  `washSaleAdvisory` (exported string, `lib/compute/tax-report.ts`) travels with every report surface
  (UI card + CSV trailing note) so a reader never mistakes a "W" code for a reconciled determination.

---

## 18. TWR "reconciliation" is now an independent cross-check, not statement-self-reference

Number-trust durable fixes, 2026-08-23. The prior gap: `reconcileTwrAgainstStatements` compared the
statement TWR against `computeTwr`, which just echoes `monthly_snapshots.twr` back — divergence always
read ~0bp regardless of whether the statement figure was actually right. `lib/compute/dietz.ts`'s
`computeMonthlyDietz` closes that gap by recomputing a Modified Dietz return from the ledger (holdings
+ flows) from first principles; `reconcileTwrAgainstStatements` (`lib/compute/twr-reconcile.ts`) now
compares THAT independent figure against the statement — never `computeTwr`'s passthrough.

Four bands — `consistent` / `investigate` / `not_comparable` / `insufficient` — never a green
"reconciled ✓ / 0bp" claim. **Never re-add that claim without gating it on `band === "consistent"`** —
UI copy (`PerformanceView.tsx`, `TrustStripDrawer.tsx`, `TrustStrip.tsx`) is pinned by
`tests/dashboard/twr-reconcile-labels.test.ts` to disclose the band, never bare "reconciled." Detail:
`docs/reference/conventions-detail.md`'s TWR cross-check contract; API surface:
`docs/reference/api-patterns.md`'s `/api/analysis/trust-state`.
