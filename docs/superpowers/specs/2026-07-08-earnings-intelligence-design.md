# Earnings Intelligence — implied move + print history (audit §4C #9/#10)

**Date:** 2026-07-08
**Status:** Approved (user, 2026-07-08 session)
**Scope source:** `docs/plans/2026-07-04-earnings-season-audit.md` §4C items 9 + 10
**Deadline pressure:** banks kick off earnings season 2026-07-14 — previews start firing daily.

## Problem

The preview email and the earnings-day cockpit tell the user *what* is expected (consensus EPS/Rev, bogeys) but not *how much the market has priced in* or *how this name has actually traded post-print*. The two classic single-manager prep lines are missing:

- **#9 Implied vs historical move** — the options market's expected move (ATM straddle for the first post-print expiry) vs the name's average realized move over its past prints.
- **#10 Per-symbol earnings history** — the last 4-8 quarters of EPS surprise % and post-print reaction, i.e. "does this name fade beats or chase them".

## Decisions locked with user

1. **Surfaces:** preview email (scoreboard rows + a `Past prints` block) AND the earnings-day cockpit lane rows. NOT EarningsHub, NOT Security Detail (later passes can reuse the cache).
2. **Implied move method:** true ATM straddle via the headless IBKR Web API, with IV-approximation fallback (`iv_underlying × √(DTE/365)`) labeled `~ (IV approx)`; `—` when neither available.
3. **History source:** Alpha Vantage `EARNINGS` endpoint (free tier, key already integrated for transcripts, 25 req/day shared budget) for surprise history; Yahoo daily closes for each quarter's post-print move. Own `calendar_events` history (one season deep) is NOT the source.
4. **Cloud parity:** snapshot-carry both (R2 snapshot v9); Worker renders read-only with an "as of" label. No Worker-side market-data computation.
5. **Architecture:** Approach A — cache tables + compute-at-need. Fresh straddle at preview-compose time; TTL-guarded lazy compute for the cockpit; nightly snapshot ships the cache.

## Data model — migration 065

```sql
-- Symbol-level: one row per past print. Read family-aware (issuerSiblings),
-- written under the queried symbol (Finnhub queried-symbol-canonical rule).
CREATE TABLE earnings_report_history (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol              TEXT NOT NULL,             -- canonical queried symbol, uppercase
  reported_date       TEXT NOT NULL,             -- YYYY-MM-DD (AV reportedDate)
  fiscal_date_ending  TEXT,                      -- AV fiscalDateEnding
  eps_actual          REAL,
  eps_estimate        REAL,
  surprise_pct        REAL,                      -- AV surprisePercentage (percent units)
  report_time         TEXT,                      -- 'pre-market' | 'post-market' | NULL (AV reportTime)
  post_print_move_pct REAL,                      -- next-day close convention, percent units
  source              TEXT NOT NULL DEFAULT 'alphavantage',
  fetched_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, reported_date)
);
CREATE INDEX idx_earnings_report_history_symbol ON earnings_report_history(symbol);

-- Event-level implied-move cache. Separate table, NOT calendar_events columns:
-- sync/enrichment write paths (COALESCE guards, enrichment-aware delete) stay
-- untouched, and ON DELETE CASCADE cleans up when sync removes an orphan row.
CREATE TABLE earnings_intel (
  event_id         INTEGER PRIMARY KEY REFERENCES calendar_events(id) ON DELETE CASCADE,
  implied_move_pct REAL,                         -- percent units, always positive
  implied_method   TEXT,                         -- 'straddle' | 'iv_approx'
  expiry_used      TEXT,                         -- YYYY-MM-DD option expiry the straddle priced
  straddle_mid     REAL,                         -- call mid + put mid (USD)
  spot             REAL,                         -- underlying price used
  computed_at      TEXT NOT NULL
);
```

- History staleness: `MAX(fetched_at)` per symbol older than **70 days** (≈ once per quarter per name) or no rows.
- Keep at most the last **12 quarters** per symbol on refresh (delete older).
- Percent-unit convention: both `_pct` columns store percent (e.g. `4.8` = ±4.8%), matching `residual_std` precedent.

## Compute engines

### `lib/earnings/implied-move.ts` — PURE, zero-import (plausibility.ts pattern)

- `straddleImpliedMovePct(callMid, putMid, spot)` → `(callMid + putMid) / spot × 100`; null on non-finite/≤0 inputs.
- `ivApproxMovePct(iv, dteDays)` → `iv × sqrt(dteDays / 365) × 100` (iv as fraction, e.g. 0.43).
- `pickPostPrintExpiry(expirations: string[], eventDate: string, eventTime: 'BMO'|'AMC'|null)` → nearest expiry **strictly after** eventDate for AMC/null, **≥** eventDate for BMO. Null when none within 21 calendar days of the event (a far-month straddle overstates the event move).
- `pickAtmStrike(strikes: number[], spot)` → nearest strike to spot; null on empty.
- `computeMid(bid, ask, last)` → `(bid+ask)/2` when `bid > 0 && ask >= bid`; else `last` when `> 0`; else null. Wide-spread guard: when mid is from bid/ask and `(ask − bid) > 0.5 × mid`, treat as unreliable → fall through to `last`, else null.
- Corrupt-quote ceiling: implied move `> 60%` → discard straddle result (caller falls back to IV approx). Real event pricing tops out ~±25-30%; >60% near-dated straddle/spot means bad quotes.

### `lib/ibkr/option-chain.ts` — headless Web API chain resolution

- `resolveAtmContracts(cfg, { conid, symbol, eventDate, eventTime, spot })` → `{ callConid, putConid, expiry, strike } | null`.
- Uses `/iserver/secdef/strikes` (list strikes for an expiry month) and `/iserver/secdef/info` (resolve specific option conids incl. `maturityDate`), riding the existing OAuth session (`lib/ibkr/web-api.ts`).
- Quotes via the existing `getMarketDataSnapshot` extended with BID/ASK field codes.
- **PROBE FIRST (hard gate):** `scripts/probe-ibkr-option-chain.ts` runs against the live session BEFORE any endpoint params or field-code constants are committed — exact `secdef/strikes`/`secdef/info` param shapes and the bid/ask field codes (expected 84/86, NOT trusted until probed) get pinned from probe output. Same discipline that caught the R1b `C`-prefix. Probe also verifies whether option bid/ask carry prefix markers like field 31 does.
- Underlying conid from `securities.ib_con_id`; missing conid (foreign names, unenriched) → return null (caller falls back).

### `lib/earnings/report-history.ts` — AV + Yahoo, DI-injected fetchers

- `fetchAvEarningsHistory(symbol, deps)` → parsed `quarterlyEarnings` (AV `function=EARNINGS`). Defensive parsing: numeric strings → numbers, `"None"`/missing → null. Take newest 12.
- `computePostPrintMoves(reports, dailyCloses)` — PURE. Convention: `post-market` → `(close[D+1] − close[D]) / close[D]`; `pre-market` → `(close[D] − close[D−1]) / close[D−1]`; null/unknown `report_time` → post-market convention (most prints are AMC); missing closes → null move for that quarter (surprise still stored). D±1 means adjacent *available trading days* in the close series.
- One Yahoo daily-chart call per symbol (`interval=1d`, range covering oldest kept report −7d → today) via a small shared helper `lib/quotes/yahoo-daily.ts::fetchYahooDailyCloses(symbol, fromDate, toDate)` (same endpoint family + error handling as `lib/benchmark/yahoo-benchmarks.ts` / `market-snapshot.ts`).
- `refreshReportHistory(db, symbol, deps)` — orchestrates fetch → move computation → upsert (INSERT OR REPLACE on (symbol, reported_date)) → prune to 12.
- `summarizeHistory(rows)` — PURE → `{ avgAbsMovePct, beatCount, missCount, quarterCount }` over the newest ≤8 rows with data (beat = eps_actual > eps_estimate, both non-null).

### `lib/earnings/intel.ts` — orchestrator

- `ensureIntelForEvents(db, events, opts?: { forceFresh?: boolean })` — resolves the IBKR config internally (`lib/ibkr/config.ts`; unconfigured → straddle road skipped, IV road still runs):
  1. Per event symbol (family-aware dedup via `issuerSiblings`): refresh history when stale. **AV cap: ≤5 fetches per invocation** (protects the shared 25/day budget; transcripts use the same key).
  2. Per event: compute implied move — straddle road (chain resolve → snapshot quotes → pure math) → IV-approx road (`security_quotes.iv_underlying` for the underlying, DTE from picked/derived expiry — when no chain resolved, DTE = calendar days from now to the first Friday ≥ event date, the standard weekly-expiry assumption) → null. Upsert `earnings_intel`.
  3. In-process TTL Map (module-level, `INTEL_TTL_MS = 30 min`, macro-themes-limiter pattern) keyed by event id; `forceFresh` bypasses. Cockpit polling therefore costs at most one OAuth roundtrip per event per 30 min.
- Everything best-effort: any failure logs and leaves prior cache; **never throws to the caller**.

## Queries / mutations (DI convention)

- `lib/queries/earnings-intel.ts`: `getIntelForEvents(db, eventIds)`; `getReportHistoryForFamily(db, symbol, limit=8)` (family-aware via `issuerSiblings`, newest-first); `isHistoryStale(db, symbol)`.
- `lib/mutations/earnings-intel.ts`: `upsertEarningsIntel(db, row)`; `replaceReportHistory(db, symbol, rows)` (transactional upsert + prune).

## Consumers

### Preview email (`lib/digest/send-earnings-email.ts`)

- `sendEarningsEmail` (preview): `ensureIntelForEvents(db, [event], { forceFresh: true })` before compose — T-2h fresh straddle. Failure cannot block the send (claim mutex / marker dance untouched).
- `renderHeadlineTable(event, symbol, phase, intel?)` — optional 4th arg (both callers updated: composer + `/api/earnings/email-content` viewer, which reads the cached row so the viewer matches the sent email). Two new rows after Revenue:
  - `| **Expected move (options)** | ±4.8% (straddle, Jul 18 exp) | — | — |` — IV road renders `~±3.1% (IV approx)`; missing → `—`.
  - `| **Avg move last 8 prints** | ±3.2% · beat 6/8 | — | — |` — from `summarizeHistory`; missing history → `—`.
  - **Recap phase**: Expected-move row echoes the preview-cached implied in the Consensus column, realized `|symbol @ T+2h|` reaction in the Actual column, and Δ = `inside` / `outside` the implied range. No recompute post-print.
- **`## Past prints` block** — deterministic markdown table rendered in code (`renderPastPrintsBlock(rows)`), preview only, after the scoreboard: `| Reported | EPS act / est | Surprise | Next-day move |` × ≤8 rows. The same block text is injected into the AI prompt (after bogeys, before read-throughs) so the model can reference the pattern; the model never generates the numbers.
- All figures are public market data → plain formatters, no privacy masking.

### Cockpit (`lib/queries/earnings-cockpit.ts` + `/api/earnings/cockpit` + `<EarningsCockpit>`)

- The **route** (`/api/earnings/cockpit`) calls `ensureIntelForEvents` (TTL-guarded, no forceFresh) for today's + carryover rows BEFORE `buildCockpitPayload`; the query stays read-only (DB cache only, no network — house queries/ convention). Payload rows gain `intel: { impliedMovePct, impliedMethod, histAvgAbsMovePct, histBeatCount, histQuarterCount } | null`.
- Lane row renders a compact line: `impl ±4.8% · hist ±3.2% (6/8 beat)`; `~` prefix on IV-approx; omitted when null. **No new component defined inside `EarningsCockpit`'s body** (the Lane remount trap — hoist to module scope).
- Contract test entry in `tests/contracts/api-component-contracts.test.ts`.

### Snapshot + Worker (read-only parity)

- `scripts/snapshot-state-to-r2.ts` → **schemaVersion 9**: `earningsIntel: Array<{ eventId, sourceKey, impliedMovePct, impliedMethod, expiryUsed, computedAt }>` for events in the snapshot's calendar window; `earningsHistory: Record<symbol, { rows: ≤8, summary }>` for upcoming-14d reporter symbols.
- `workers/cron/src/fallback-earnings.ts` renders the same two scoreboard rows + Past prints block from snapshot data; implied figure carries `(as of <computedAt, ET>)`. Pre-v9 snapshots → rows omitted (graceful degradation, same as v7/v8 precedents). No Worker fetches added (B13 budget untouched).

## Error handling summary

| Failure | Behavior |
|---|---|
| AV limit/outage | keep stale cache; empty → history row + block omitted, email ships |
| No conid / no chain / foreign listing | IV-approx fallback; no IV → `—` |
| Bad quotes (no bid, wide spread) | mid → last → null; straddle >60% → discard → IV road |
| Yahoo miss on a past date | that quarter's move `—`, surprise kept |
| Any intel failure at compose | logged, email sends without the rows |
| Cockpit poll storms | 30-min in-process TTL per event |

## Testing

- Pure engines: straddle/IV math, expiry picker (AMC strictly-after vs BMO same-day, 21d ceiling), ATM picker, mid computation + wide-spread + 60% ceiling, BMO/AMC move conventions incl. holiday-gap adjacency, staleness boundary, summarize (beat counting with null estimates), 12-quarter prune.
- DI-mocked AV/Yahoo fetch tests (AI-test-mocking rule — never key-dependent).
- Render pins: scoreboard rows all three states (straddle / approx / dash), recap inside/outside echo, Past prints block, prompt-injection position.
- Cockpit payload contract + component render (null intel → no line).
- Worker: v9 fixture render + pre-v9 degradation.
- Live E2E before ship: probe script output pinned; one real preview dry-run against a 2026-07-14 bank; cockpit visual check.

## Out of scope (explicit)

Audit #11 (bogey automation), #12 (same-day transcripts), #13 (read-through pushes), #17/#18 (volume management), B13 (Worker subrequest cap), EarningsHub + Security Detail surfaces, Worker-side market-data computation, historical intraday reactions (next-day close convention is the standard proxy).

## Cost

$0 new spend: AV free tier (capped at 5/run within the existing 25/day), Yahoo unofficial daily endpoint (existing risk posture, graceful null), IBKR quotes ride the existing OAuth session.
