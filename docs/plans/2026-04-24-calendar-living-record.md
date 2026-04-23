# Calendar as a Living Record — Tier 3 Sprint

> **Drafted:** 2026-04-24 (afternoon, post–polish + global-search session)
> **Tier:** 3 (max swing — all three bundled + Workers cron parity)
> **Estimated scope:** ~10–12 hr, one long focused session
> **Expected test delta:** 1158 → ~1180 (+20–25)

## Decisions locked (2026-04-24)

1. **Scheduler:** A1 — launchd, Mac-local (primary). Workers cron mirrors with full parity (see §9 Phase 9).
2. **Reaction scope:** R2 — SPY + QQQ + TLT + sector ETF when mapped.
3. **Reaction window:** **T + 2 hours** (fixed) for all event types — macro and earnings alike. Rationale: overshoot beats undershoot; trim per-event later if briefing commentary feels off. Macro releases at 8:30 ET → reaction read at 10:30 ET.
4. **Earnings BMO / AMC:** Capture in v1. Finnhub `/calendar/earnings` returns `hour: "bmo" | "amc" | "dmh"`. Map BMO → 08:00 ET release_time, AMC → 16:15 ET, DMH → 16:15 ET (default to after-close when ambiguous).
5. **Sector ETF gaps:** When an earnings event's sector can't be mapped to an ETF, log to a `sector_etf_gaps` table with a PRIMARY KEY on (symbol, sector) so dedup is free. After a few weeks, query the table to backfill mappings.
6. **Workers cron fallback:** Full parity with launchd. Worker fetches macro + earnings actuals from FRED / Finnhub independently; on Mac reachable writes via `/api/calendar/enrich`, on Mac unreachable stages to KV under a well-known key pattern. Mac reconciles from KV on next auto-refresh. Reaction snapshots from cloud use Polygon free-tier intraday (Mac's Polygon key already set for Stock Contest — reuse). Cloud reaction is strict fallback: Mac's TWS snapshot always wins when both exist.

---

## 1. Why this matters

The calendar today is a **lookahead**: it shows what's scheduled, when, and a pre-release expectation. Once the event happens, the row just sits there as dead data. You have no way to answer "how did SPY react to last month's CPI?" from inside the app — the information is lost to news feeds and memory.

This sprint turns the calendar from a lookahead into a **living record**: scheduled events automatically fill in their actual outcome and the market's immediate reaction. Once the data accumulates, patterns become queryable ("what happens to QQQ on hot CPI prints?") and briefings can reference last week's surprises as context for this week's schedule.

**Three bundled deliverables, in execution order:**

- **(a) Macro / earnings post-release enrichment** — the core architectural novelty. New scheduler dimension, new schema columns, three data sources wired, four UI surfaces updated.
- **(b) L9 — Calendar × Levels cross-reference** — cheap bundle with (a) because it touches the same calendar-page components. "2 active levels on NVDA" pill on earnings events.
- **(c) Theme D — Level source performance attribution v1** — capstone. Ship the scaffolding with empty-state tolerance; scores fill in as alerts accumulate. New query, new page, new chat tool.

---

## 2. Architecture — what's genuinely new

This is the first feature that introduces **time-of-day** as a first-class dimension. The whole app has been YYYY-MM-DD-date-based. Events need a release time ("8:30 AM ET") to know when to sweep, and market reactions need timestamps ("SPY at T−5min vs T+60min"). The schema shift is small but worth calling out — future intraday-alert and session-aware features will lean on the same fields.

Two new subsystems:

```
                    ┌──────────────────────────────────────┐
                    │  launchd: .calendar-enrich.plist     │
                    │  every 15 min during market hours    │
                    │  09:30 → 16:00 ET (Mon–Fri)          │
                    └───────────────┬──────────────────────┘
                                    │
                                    ▼
      ┌─────────────────────────────────────────────────┐
      │  scripts/enrich-calendar-events.ts              │
      │  1. Find unenriched events with release_time    │
      │     in [now - 2h, now - 5min]                   │
      │  2. For each, fetch actual_value from source    │
      │  3. If TWS connected, capture reaction snapshot │
      │  4. UPDATE calendar_events SET ...              │
      └─────────────────────────────────────────────────┘
                    │                             │
        ┌───────────┴──────────┐       ┌──────────┴────────────┐
        ▼                      ▼       ▼                       ▼
  ┌──────────┐         ┌──────────┐ ┌──────────┐      ┌────────────────┐
  │ FRED     │         │ Finnhub  │ │ Claude + │      │ TWS snapshot   │
  │ macro    │         │ earnings │ │ web      │      │ SPY/QQQ/TLT/   │
  │ actuals  │         │ actuals  │ │ search   │      │ sector ETF     │
  └──────────┘         └──────────┘ └──────────┘      └────────────────┘
```

---

## 3. Schema — Migration 041

New file: `lib/db/migrations/041_calendar_enrichment.sql`

```sql
-- Enrichment columns for post-release data capture.
-- Additive only — existing rows unaffected, all nullable defaults.

ALTER TABLE calendar_events ADD COLUMN release_time TEXT;
-- Time-of-day for scheduled release, "HH:MM" ET. Nullable —
-- backfill on a per-event-type lookup table at enrichment time.

ALTER TABLE calendar_events ADD COLUMN actual_value TEXT;
-- Released value as a string. Handles "3.2%", "250K", "0.0%",
-- "$3.45" EPS uniformly without lossy coercion.

ALTER TABLE calendar_events ADD COLUMN consensus_value TEXT;
-- Pre-release consensus. Some rows already have a similar field in
-- raw_json — we surface it to a first-class column here.

ALTER TABLE calendar_events ADD COLUMN reaction_snapshot TEXT;
-- JSON: {
--   "t0_utc":     "2026-04-24T12:30:00Z",   -- release instant (UTC)
--   "window_min": 120,                      -- fixed 2h; future: per-event
--   "source":     "tws" | "polygon",        -- Mac vs cloud fallback
--   "spy":    {"t_pre": 585.21, "t_post": 582.84, "delta_pct": -0.41},
--   "qqq":    {"t_pre": 495.10, "t_post": 492.30, "delta_pct": -0.57},
--   "tlt":    {"t_pre":  92.30, "t_post":  91.80, "delta_pct": -0.54},
--   "sector": {"symbol": "XLF", "t_pre": 51.20, "t_post": 50.85, "delta_pct": -0.68}
-- }
-- t_pre = last bar before release (~T-5min). t_post = bar nearest
-- T+120min. Nullable when neither TWS nor Polygon could provide bars.
-- Sector is optional — only present when EVENT_SECTOR_MAP has a hit.

ALTER TABLE calendar_events ADD COLUMN enriched_at TEXT;
-- datetime('now') when enrichment completed. Used to skip already-
-- done rows on the next sweep.

CREATE INDEX idx_calendar_events_enrichment
  ON calendar_events(enriched_at, event_date);
-- Fast "unenriched events today" scan for the launchd tick.

-- Running log of earnings events whose sector couldn't be mapped to an
-- ETF. Let the list accumulate, then backfill EVENT_SECTOR_MAP once we
-- see patterns. PRIMARY KEY(symbol, sector) gives free dedup on upsert.
CREATE TABLE IF NOT EXISTS sector_etf_gaps (
  symbol TEXT NOT NULL,
  sector TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (symbol, sector)
);
```

**Why strings for `actual_value` / `consensus_value`:** events publish in incompatible units (percent, dollars, thousands, index points). A single string column keeps the UI honest — we render what the source published, not a lossy coercion. Any comparison math is done at read time with explicit parsing.

---

## 4. Data source coverage

### 4.1. Macro via FRED (~70% of sweeps)

Already wired in `lib/calendar/macro-events.ts`. Extend it, don't duplicate.

**Covered indicators** (add to `RELEASE_MAP` lookup):

| Event type     | FRED series       | Release time | Notes |
|----------------|-------------------|--------------|-------|
| CPI            | CPIAUCSL          | 08:30 ET     | Monthly |
| Core CPI       | CPILFESL          | 08:30 ET     | Monthly |
| PPI            | PPIACO            | 08:30 ET     | Monthly |
| Core PCE       | PCEPILFE          | 08:30 ET     | Monthly |
| GDP (adv)      | GDP               | 08:30 ET     | Quarterly |
| Nonfarm payrolls | PAYEMS          | 08:30 ET     | First Friday |
| Unemployment   | UNRATE            | 08:30 ET     | First Friday |
| Retail sales   | RSAFS             | 08:30 ET     | Monthly |
| Housing starts | HOUST             | 08:30 ET     | Monthly |
| Fed funds rate | FEDFUNDS          | 14:00 ET     | FOMC meetings |

**Call pattern:** `lib/calendar/fred.ts::fetchLatestObservation(seriesId)` — returns `{value: string, date: string}`. The `date` field confirms we're reading the just-released observation, not a stale prior month.

**Release-time lookup:** new file `lib/calendar/release-times.ts`:

```typescript
export const RELEASE_TIMES_ET: Record<string, string> = {
  cpi: "08:30",
  core_cpi: "08:30",
  ppi: "08:30",
  core_pce: "08:30",
  gdp: "08:30",
  nonfarm_payrolls: "08:30",
  unemployment: "08:30",
  retail_sales: "08:30",
  housing_starts: "08:30",
  fomc_rate_decision: "14:00",
  ism_manufacturing: "10:00",
  ism_services: "10:00",
  umich_sentiment: "10:00",
  consumer_confidence: "10:00",
  // Per-company earnings: generally before-market (08:00) or
  // after-market (16:15). Fill in per-ticker overrides as needed;
  // default to before-market.
};
```

### 4.2. Non-FRED macro via Claude + web_search (~15% of sweeps)

For ISM, UMich Sentiment, Consumer Confidence — already a precedent pattern in `verifyNonFredReschedules`. Reuse `web_search_20250305` tool. Accept probabilistic results; store result with a `source: "claude_web_search"` flag for audit.

### 4.3. Earnings via Finnhub (~15% of sweeps)

Extend `lib/calendar/finnhub.ts`. Existing `/calendar/earnings` endpoint already returns actual EPS + revenue after release — AND returns `hour: "bmo" | "amc" | "dmh"` alongside each event. Capture the `hour` at event-creation time (not enrichment time) so the scheduler knows when the release window opens.

**BMO / AMC → release_time mapping** (new function in `lib/calendar/finnhub.ts`):

```typescript
export function earningsHourToReleaseTime(
  hour: "bmo" | "amc" | "dmh" | null | undefined
): string {
  switch (hour) {
    case "bmo": return "08:00";  // before-market-open
    case "amc": return "16:15";  // after-market-close
    case "dmh": return "16:15";  // during-market-hours is rare;
    default:    return "16:15";  // treat as after-close for sanity
  }
}
```

This runs at two moments:
1. **Initial calendar sync** (`POST /api/calendar/sync`) — set `release_time` when inserting earnings rows.
2. **Migration 041 backfill** — for existing earnings rows, re-hit Finnhub once to fill `release_time`. Acceptable one-time cost (~60 calls × 550ms = ~35s).

For each `calendar_events` row with `event_type = 'earnings_earnings'` and `event_date = today`, hit `/stock/earnings?symbol=X` AFTER the BMO or AMC window opens (08:30 ET or 16:30 ET) and take the most recent row whose date matches `event_date`.

Known free-tier gap: `/stock/earnings` returns estimates only for some tickers. Accept null actuals; enrichment stays null, UI renders "Actual pending."

### 4.4. Market reaction — 2-hour window, TWS primary + Polygon fallback

**Window:** fixed **T + 120 min** for every event type. Simpler than per-event windows, errs on the side of capturing follow-through. Future v2 decision if briefing commentary feels stale.

New file: `lib/calendar/reaction-snapshot.ts`.

```typescript
export interface BenchmarkReaction {
  t_pre:     number;    // last bar before release (~T-5min)
  t_post:    number;    // bar nearest T+120min
  delta_pct: number;    // (t_post - t_pre) / t_pre * 100, 2 decimals
}

export interface ReactionSnapshot {
  t0_utc:     string;              // ISO release timestamp (UTC)
  window_min: 120;                 // fixed for v1
  source:     "tws" | "polygon";   // provenance
  spy:        BenchmarkReaction;
  qqq:        BenchmarkReaction;
  tlt:        BenchmarkReaction;
  sector?:    BenchmarkReaction & { symbol: string };
}

// Primary — Mac-local via TWS. Used by launchd tick.
export async function captureReactionFromTws(
  ib: IBApiNext,
  eventType: string,
  underlyingSymbol: string | null,  // for earnings; null for macro
  releaseInstant: Date,
): Promise<ReactionSnapshot | null>;

// Fallback — cloud-only via Polygon free tier. Used by Workers cron.
export async function captureReactionFromPolygon(
  polygonApiKey: string,
  eventType: string,
  underlyingSymbol: string | null,
  releaseInstant: Date,
): Promise<ReactionSnapshot | null>;
```

**TWS implementation (primary):** call `reqHistoricalData` for SPY / QQQ / TLT with `endDateTime = releaseInstant + 125min`, `durationStr = "130 mins"`, `barSize = "1 min"`. Take the bar closest to T−5min as `t_pre`, bar closest to T+120min as `t_post`. For earnings events, add the sector ETF resolved via §4.5.

**Polygon implementation (fallback):** `GET /v2/aggs/ticker/{SPY|QQQ|TLT}/range/1/minute/{from}/{to}` where `from = releaseInstant - 10min` and `to = releaseInstant + 125min`. Same bar-nearest-timestamp matching logic; factor the matcher into a shared helper so TWS + Polygon paths use identical logic.

**Rate limits:**
- IBKR historical-data — 500ms pacing between calls. 4 ETFs × 500ms = 2s per event. Typical sweep is 0–3 events; well inside limits.
- Polygon free tier — 5 calls/min. 4 ETFs per event = 1 event per minute worst case. Sweeps on a 15-min cadence; fine.

**Failure modes:**
- TWS offline + Polygon unreachable → return null, `reaction_snapshot` stays null
- TWS offline + Polygon OK → fallback runs, `source: "polygon"`
- TWS OK → primary runs, `source: "tws"`
- TWS-vs-Polygon reconciliation: if BOTH produce snapshots (shouldn't happen, but): TWS wins. Compare on reconcile, log a warning if drift > 0.1%.

### 4.5. Sector ETF mapping

New constant in `lib/calendar/reaction-snapshot.ts`:

```typescript
const EVENT_SECTOR_MAP: Record<string, string | null> = {
  nonfarm_payrolls: "XLF",     // jobs → financials / rate-sensitive
  unemployment:     "XLF",
  cpi:              "XLF",     // inflation → financials + rate bets
  core_cpi:         "XLF",
  ppi:              null,      // ambiguous
  core_pce:         "XLF",
  fomc_rate_decision: "XLF",
  retail_sales:     "XLY",     // consumer discretionary
  ism_manufacturing: "XLI",    // industrials
  ism_services:     "XLY",
  housing_starts:   "XHB",     // homebuilders
  gdp:              null,      // broad — SPY already captures it
  // Earnings: use the individual stock's sector via securities.sector
  // — keyed dynamically at enrichment time, not in this map.
};
```

For earnings, look up `securities.sector` for the underlying ticker and map to an ETF via a second lookup:

```typescript
const SECTOR_TO_ETF: Record<string, string> = {
  "Financials":              "XLF",
  "Technology":              "XLK",
  "Health Care":             "XLV",
  "Consumer Discretionary":  "XLY",
  "Consumer Staples":        "XLP",
  "Energy":                  "XLE",
  "Utilities":               "XLU",
  "Industrials":             "XLI",
  "Materials":               "XLB",
  "Real Estate":             "XLRE",
  "Communication Services":  "XLC",
};
```

**Gap logging.** When neither `EVENT_SECTOR_MAP` nor `SECTOR_TO_ETF` yields a mapping, the enrichment runner writes to `sector_etf_gaps` (see migration 041 in §3):

```typescript
function logSectorGap(db: Database.Database, symbol: string, sector: string | null) {
  db.prepare(`
    INSERT INTO sector_etf_gaps (symbol, sector, last_seen_at, count)
    VALUES (?, ?, datetime('now'), 1)
    ON CONFLICT(symbol, sector) DO UPDATE SET
      last_seen_at = datetime('now'),
      count = count + 1
  `).run(symbol, sector);
}
```

New admin surface (Phase 7 scope): a small read-only section on `/dashboard/data-health` (already exists) listing top N unmapped symbols with counts. After a few weeks of accumulation, run a one-off backfill script to extend the two sector maps.

Reaction snapshots for events without a sector mapping still capture SPY / QQQ / TLT — the `sector` field is simply absent.

---

## 5. Scheduler — A1 (launchd, Mac-local)

New plist: `scripts/launchd/com.vanguard-skin.calendar-enrich.plist`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.vanguard-skin.calendar-enrich</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/Yitzi/code/vanguard-skin/scripts/enrich-calendar-events.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <!-- Every 15 min during US market hours, Mon-Fri -->
    <!-- Uses local Mac time; adjust in docs for DST context -->
    <dict><key>Minute</key><integer>30</integer><key>Hour</key><integer>9</integer><key>Weekday</key><integer>1</integer></dict>
    <dict><key>Minute</key><integer>45</integer><key>Hour</key><integer>9</integer><key>Weekday</key><integer>1</integer></dict>
    <!-- ... expand to every 15 min through 16:00 for each weekday ... -->
  </array>
  <key>StandardOutPath</key>
  <string>/tmp/vgs-calendar-enrich.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/vgs-calendar-enrich.err</string>
</dict>
</plist>
```

Wrapper: `scripts/enrich-calendar-events.sh` sources the project's `.env.local` and runs `npx tsx scripts/enrich-calendar-events.ts`.

Main script: `scripts/enrich-calendar-events.ts`:

```typescript
// 1. Open DB
// 2. Query: SELECT * FROM calendar_events
//           WHERE enriched_at IS NULL
//             AND event_date = date('now')
//             AND release_time IS NOT NULL
//             AND datetime(event_date || ' ' || release_time)
//                 BETWEEN datetime('now', '-2 hours')
//                 AND     datetime('now', '-5 minutes');
// 3. For each: fetch actual + (optionally) reaction snapshot
// 4. UPDATE with actual_value, consensus_value (if new),
//            reaction_snapshot, enriched_at
// 5. Log summary to /tmp/vgs-calendar-enrich.log
```

**Why 15-min cadence:** FRED release-time lag up to 30 min post-scheduled. A 15-min sweep window catches the data within 2 ticks of release, well inside our T+2h enrichment window.

**Why Mon–Fri only:** no market moves to snapshot on weekends. Macro events scheduled for weekends are rare enough to accept null reaction.

**Rollback:** `launchctl unload ~/Library/LaunchAgents/com.vanguard-skin.calendar-enrich.plist`. No schema rollback needed; enrichment columns just stay null.

---

## 6. API surface

### 6.1. `GET /api/calendar/events` — existing, extend response

Currently returns the base calendar_events row shape. Add the 4 new columns to the payload so the frontend can render result chips without a second fetch.

### 6.2. `POST /api/calendar/enrich` — new, manual re-trigger

For debugging and for on-demand enrichment when the user notices a stale event. Body: `{ eventId?: number }`. Omitting `eventId` enriches all unenriched same-day events. Protected like other mutation routes (no auth — local-only app).

### 6.3. Chat tool `query_release_reactions` (Theme D bundle)

New entry in `lib/chat/tools.ts`. Signature:

```typescript
{
  name: "query_release_reactions",
  description:
    "Look up how the market reacted to past macro releases or earnings. " +
    "Useful for questions like 'what did SPY do on the last three hot CPI prints?' " +
    "or 'how did NVDA typically respond to earnings?'",
  input_schema: {
    type: "object",
    properties: {
      event_type: { type: "string", description: "e.g. 'cpi', 'fomc_rate_decision', 'earnings_NVDA'" },
      since_date: { type: "string", description: "YYYY-MM-DD" },
      limit: { type: "number", default: 10 },
    },
    required: ["event_type"],
  },
}
```

---

## 7. UI surfaces

### 7.1. `/dashboard/calendar` — event row enrichment

Existing row renders title + date + consensus. Add a result chip when `enriched_at IS NOT NULL`:

```
Consumer Price Index      8:30 ET   cons 3.1%   →   actual 3.2% · SPY -0.41% / QQQ -0.57%
```

Color logic:
- `actual > consensus` → amber (hawkish for most macro)
- `actual < consensus` → emerald (dovish)
- `actual ≈ consensus` (within 10%) → neutral gray

Delta chips use existing `<Chip>` primitive with `up` / `down` / `neutral` tones.

### 7.2. `/dashboard/today` — mobile Today view

Add a "Today's releases" block above the existing alerts block. Same chip format as §7.1. Hidden when there are no events today.

### 7.3. Weekly briefing email

`lib/calendar/briefing.ts` — extend the prompt's context block with last week's released events + actuals. Claude can reference "last Tuesday's CPI surprise" in commentary.

Specifically: in the context chunk sent to Opus, add a new section "Released last week":

```
## Released last week
- CPI (Apr 16): actual 3.2%, consensus 3.1%. SPY -0.41% / QQQ -0.57% / XLF -0.68% in the hour post-release.
- Nonfarm payrolls (Apr 18): actual 245K, consensus 220K. SPY +0.22% / TLT -0.81%.
```

### 7.4. Chat drawer

New `query_release_reactions` tool surfaces in the tool palette. No UI changes to the drawer itself.

### 7.5. L9 — Calendar × Levels cross-reference

Same calendar page. For each earnings event row, read `security_levels WHERE security_id = ? AND is_active = 1` via existing `getActiveLevelCountsForSecurityIds` (already implemented in `lib/queries/security-levels.ts:187`). If count > 0, render a pill "N active levels" linking to `/dashboard/security/[id]`.

File: `app/dashboard/calendar/page.tsx` (or wherever the event list renders). **Do this after §7.1's chip rendering lands** so both chips coexist without layout churn.

---

## 8. Theme D — Level source performance attribution v1

### 8.1. New query

`lib/queries/level-performance.ts`:

```typescript
export interface SourcePerformance {
  source_author: string;
  alerts_fired: number;
  hit_rate: number;              // alerts / levels_created
  responses: {
    acted:     number;
    ignored:   number;
    dismissed: number;
    pending:   number;
  };
  pnl_acted_30d: number | null;  // avg P&L on acted alerts, 30-day window
  pnl_acted_60d: number | null;
  pnl_acted_90d: number | null;
  pnl_acted_vs_ignored: number | null;
  // Diff between acted and ignored windows — did following the source
  // outperform ignoring it? Null when either set has < 3 samples.
}

export function getSourcePerformance(
  db: Database.Database,
  opts?: { minAlerts?: number }, // default 1; filter out noise sources
): SourcePerformance[];
```

**P&L attribution rule (documented on the page):** for each acted alert, `pnl_acted = (price_at_window_end - triggered_price) / triggered_price`, where `window_end = min(today, triggered_at + N days, next SELL on security)`. For `ignored` alerts, same formula (hypothetical "what if you had acted"). This is imperfect for positions the user already held; the rule explicitly ignores prior position state.

### 8.2. New page

`/dashboard/levels/performance` — renders a table per source author. Columns: Source · Alerts · Hit Rate · P&L Acted (30/60/90) · vs Ignored.

Empty-state tolerance: when `opts.minAlerts` filters out everything (first few weeks), render:

```
Not enough data yet — 0 alerts fired.
Scoreboard will fill in as you respond to alerts.
Current rule: attribution uses 30/60/90-day price windows from the trigger.
```

### 8.3. Sidebar / Alerts inbox link

Add a "Source performance →" link to the alerts inbox header so the feature is discoverable.

---

## 9. Implementation order

Phase 1 — Schema + backfill (45 min)
- Write migration 041 (enrichment columns + sector_etf_gaps table)
- Backfill `release_time` for existing macro events from `RELEASE_TIMES_ET` map
- Backfill `release_time` for existing earnings events via Finnhub `/calendar/earnings` lookup (one-time cost, ~35s for ~60 tickers)
- Run migration against data/vanguard.db
- Unit test: migration idempotent

Phase 2 — FRED + non-FRED enrichment (90 min)
- Extend `lib/calendar/macro-events.ts` with `fetchActualForEvent(db, event) → {value, consensus}`
- Wire `web_search_20250305` fallback for non-FRED events (ISM, UMich, etc.)
- Unit tests with mocked FRED client (existing harness)

Phase 3 — Reaction snapshot — TWS path (75 min)
- New file `lib/calendar/reaction-snapshot.ts` with `captureReactionFromTws`
- Shared bar-nearest-timestamp matcher (reused by Phase 9's Polygon path)
- Unit tests with mocked IBApiNext; weekend/off-hours edge cases
- Integration gated on TWS connection (skip gracefully when offline)

Phase 4 — Enrichment runner + on-demand API (60 min)
- `scripts/enrich-calendar-events.ts` orchestrates Phases 2 + 3
- Launchd plist + wrapper script `scripts/enrich-calendar-events.sh`
- `POST /api/calendar/enrich` for manual re-trigger + Worker upsert (used in Phase 9)
- First live sweep logged successfully

Phase 5 — UI surfaces on Mac (90 min)
- Calendar page event rows + result chips (§7.1)
- Today mobile view "Today's releases" block (§7.2)
- Briefing email "Released last week" context block (§7.3)

Phase 6 — L9 cross-reference (60 min)
- Levels-count pill on earnings events in calendar page
- Reuses existing `getActiveLevelCountsForSecurityIds`

Phase 7 — Theme D performance attribution + sector-gap admin (165 min)
- `lib/queries/level-performance.ts` with documented attribution rule
- `/dashboard/levels/performance` page with empty-state tolerance
- Chat tool `query_release_reactions` in `lib/chat/tools.ts`
- Link from alerts inbox header
- Small "Unmapped sector ETFs" section on `/dashboard/data-health` reading from `sector_etf_gaps`

Phase 8 — Test sweep + Mac commit checkpoint (30 min)
- `npx vitest run` full suite — should show 1158 → ~1175
- `tsc --noEmit` clean
- Commit Phases 1–7 as separate logical commits (expect ~7 commits)
- **NOT deploying yet — Phase 9 still to ship**

Phase 9 — Workers cron fallback parity (90 min)
- New Worker cron trigger `*/15 9-16 * * MON-FRI` (both DST slots, mirrors launchd cadence)
- `workers/cron/src/calendar-enrich.ts`:
  - Try `POST ${MESH_HOSTNAME}/api/calendar/enrich` with `X-Cron-Secret` first
  - On Mac reachable (primary success) — Worker is done, log skip marker in KV
  - On Mac unreachable — fetch actuals via FRED (already in worker bindings) + earnings via Finnhub + reaction via `captureReactionFromPolygon`
  - Stage results to KV with key pattern `calendar-enrich-{eventId}-{YYYY-MM-DD}` (24h TTL)
- New Mac endpoint `POST /api/calendar/reconcile-cloud-enrich`:
  - Reads KV via existing Worker-to-Mac helper (or polls Worker for queued reconciles)
  - Upserts into `calendar_events` — TWS-sourced reaction ALWAYS wins over Polygon-sourced if both exist
  - Called as new final step of `lib/tws/auto-refresh.ts` pipeline
- Polygon client in Worker — aws4fetch-style fetch, free-tier key from Stock Contest (reuse via env)
- Worker tests extend `tests/workers/cron.test.ts` (+ ~8 tests)

Phase 10 — Final sweep + deploy (45 min)
- Re-run full test suite
- Commit Phase 9
- `wrangler deploy` the updated Worker
- Push to origin/main
- `npm run electron:deploy` — installed DMG picks up all new Mac paths
- MEMORY.md + TODO.md updates

**Total estimate:** 11 hr (660 min). Plan for 12 hr (720 min) with contingency.

---

## 10. Test plan

New tests go in:
- `tests/calendar/enrichment.test.ts` — orchestrator happy path + error paths + BMO/AMC release_time mapping
- `tests/calendar/reaction-snapshot.test.ts` — TWS bar-matching happy path + weekend/off-hours + shared matcher exported for Polygon reuse
- `tests/calendar/release-times.test.ts` — `earningsHourToReleaseTime` + `RELEASE_TIMES_ET` lookup integrity
- `tests/calendar/sector-gaps.test.ts` — `sector_etf_gaps` upsert dedup + count increment
- `tests/queries/level-performance.test.ts` — P&L attribution edge cases (no prior position, prior position, multiple sales, < 3 samples returns null)
- `tests/chat/query-release-reactions.test.ts` — new chat tool end-to-end
- `tests/workers/cron.test.ts` extend — Worker calendar-enrich Mac-reachable + Mac-unreachable → KV stage paths; Polygon reaction fallback; reconcile precedence (TWS wins)
- `tests/api/calendar-reconcile.test.ts` — Mac `/api/calendar/reconcile-cloud-enrich` reads KV + applies precedence

Expected: +20–25 tests. Goal: 1158 → ~1180.

---

## 11. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| FRED release-time lag > 30 min | Med | Retry with backoff to T+90min, then null; Worker cron sweeps cover any Mac miss |
| `calendar_events.event_date` isn't always time-tagged | High | Phase 1 backfill populates `release_time` per event_type; null rows skip enrichment |
| TWS offline during market hours | Med | Polygon fallback in Phase 9; `source` field records provenance |
| Polygon free-tier rate limit (5/min) | Low | 15-min sweep cadence; 4 ETFs per event = 1 event/min worst case — well inside |
| Polygon API key not accessible to Worker | Med | Reuse Stock Contest's key via `.env` + `wrangler secret put`. Verify key is still valid before Phase 9 starts |
| Finnhub earnings actuals return null | Med | Accept; UI renders "Actual pending" chip; no retry needed |
| Finnhub `/calendar/earnings` hour field unreliable for some tickers | Med | Default to AMC (16:15 ET) when hour is missing or `"dmh"` |
| Claude web-search rate limit | Low | 1 call / event / type / day via `extract-newsletter-levels.ts` precedent pattern |
| Theme D scoring is subjective | Low | Document the rule on-page; accept imperfect attribution for already-held positions |
| Launchd plist timezone drift across DST | Med | Document both EDT + EST cron slots like `workers/cron/wrangler.toml` already does |
| TWS-vs-Polygon reconcile drift | Low | Log warning if delta > 0.1%; TWS always wins precedence |
| KV staging fills if Mac is offline for weeks | Low | 24h TTL on KV entries auto-cleans; events older than 24h can still be re-enriched on demand |

---

## 12. Open questions — RESOLVED 2026-04-24

All four answered before sprint kickoff. Keeping the originals here so the decisions trail is auditable.

1. **Release time for earnings** — ✅ Yes, capture BMO/AMC at event-creation via Finnhub `hour` field. Map BMO → 08:00 ET, AMC → 16:15 ET, DMH → 16:15 ET (default to after-close). See §4.3.
2. **Reaction window** — ✅ Fixed **T + 2 hours** for all event types. Overshoot > undershoot. Revisit per-event if briefing commentary feels stale.
3. **Sector ETF for earnings** — ✅ Use `securities.sector` → `SECTOR_TO_ETF` map. Missing mappings log to `sector_etf_gaps` (PRIMARY KEY on symbol+sector for dedup). Backfill after a few weeks of accumulation. See §4.5.
4. **Workers cron fallback** — ✅ Full parity. Worker mirrors launchd cadence (15-min tick during US market hours). Primary: Mac `/api/calendar/enrich` via Mesh. Fallback: Worker fetches actuals from FRED/Finnhub + reaction from Polygon free tier, stages to KV; Mac reconciles on next auto-refresh. TWS always wins over Polygon when both exist. New Phase 9 in §9.

---

## 13. Definition of done

Session is complete when:

- [ ] Migration 041 ran against data/vanguard.db, all existing rows unaffected (enrichment columns + sector_etf_gaps table)
- [ ] `release_time` backfilled for existing macro + earnings events
- [ ] Launchd plist loaded; at least one successful Mac-side enrichment sweep logged
- [ ] Worker cron deployed with calendar-enrich trigger; at least one successful cloud sweep logged
- [ ] Mac `/api/calendar/enrich` + `/api/calendar/reconcile-cloud-enrich` endpoints both respond to manual test
- [ ] TWS-vs-Polygon precedence verified: `source: "tws"` overwrites `source: "polygon"` on reconcile
- [ ] Calendar page renders result chips on past events with data (both sources)
- [ ] Mobile Today view shows "Today's releases" block
- [ ] Briefing email includes "Released last week" context block
- [ ] L9 pills on earnings events link to Security Detail
- [ ] Theme D page renders with empty state (0 alerts) AND renders with mocked test data
- [ ] Chat tool `query_release_reactions` registered and callable
- [ ] Data Health page shows "Unmapped sector ETFs" section (empty or populated)
- [ ] `npx vitest run` → all passing, +20–25 tests (target 1158 → ~1180)
- [ ] `tsc --noEmit` → clean in repo root AND `workers/cron/`
- [ ] Commits pushed to origin/main
- [ ] `wrangler deploy` — Worker updated at vanguard-skin-cron.isaac-3d1.workers.dev
- [ ] `npm run electron:deploy` → installed DMG launches, calendar page renders enrichment
- [ ] MEMORY.md updated with session entry
- [ ] TODO.md — three items moved from open to shipped; add new backlog entries for anything deferred

---

## 14. Files touched (estimate)

**New files (~14):**
- `lib/db/migrations/041_calendar_enrichment.sql`
- `lib/calendar/release-times.ts`
- `lib/calendar/reaction-snapshot.ts` (exports TWS path + shared bar matcher + Polygon path)
- `lib/queries/level-performance.ts`
- `scripts/enrich-calendar-events.ts`
- `scripts/enrich-calendar-events.sh`
- `scripts/launchd/com.vanguard-skin.calendar-enrich.plist`
- `app/dashboard/levels/performance/page.tsx`
- `app/api/calendar/enrich/route.ts`
- `app/api/calendar/reconcile-cloud-enrich/route.ts`
- `workers/cron/src/calendar-enrich.ts` (Worker scheduled handler)
- `workers/cron/src/polygon-client.ts` (aws4fetch-style Polygon client)
- `tests/calendar/*.test.ts` (4 new files per §10)
- `tests/api/calendar-reconcile.test.ts`

**Modified files (~12):**
- `lib/calendar/macro-events.ts` — extend with `fetchActualForEvent`
- `lib/calendar/finnhub.ts` — extend with earnings actuals + `earningsHourToReleaseTime` + hour capture at sync time
- `lib/calendar/briefing.ts` — add "Released last week" context block
- `lib/chat/tools.ts` — register `query_release_reactions`
- `lib/tws/auto-refresh.ts` — add final step that calls `/api/calendar/reconcile-cloud-enrich`
- `app/dashboard/calendar/page.tsx` (or component) — result chips + L9 pills
- `app/dashboard/today/page.tsx` — today's releases block
- `app/dashboard/data-health/page.tsx` — unmapped-sector section
- `app/api/calendar/events/route.ts` — expose new columns
- `workers/cron/wrangler.toml` — new cron trigger + POLYGON_API_KEY secret
- `workers/cron/src/index.ts` — dispatch calendar-enrich alongside existing briefing/digest
- `tests/workers/cron.test.ts` — extend with new paths
- `docs/plans/TODO.md` — mark items shipped, note any spill-over

---

## 15. Rollback

In order of invasiveness:

1. **UI regression only:** revert the specific commit.
2. **Mac scheduler misbehaving:** `launchctl unload ~/Library/LaunchAgents/com.vanguard-skin.calendar-enrich.plist`. Mac enrichment stops; Worker still runs fallback.
3. **Worker cron misbehaving:** remove the calendar-enrich cron trigger from `wrangler.toml` and redeploy. Mac launchd continues as primary.
4. **Both schedulers off:** disable Mac plist + remove Worker trigger. Existing enriched data stays; new events stay null until re-enabled.
5. **Bad reconcile:** Mac `/api/calendar/reconcile-cloud-enrich` endpoint returns 503 until fixed. Worker KV entries expire naturally (24h TTL); no cleanup needed.
6. **Data contamination:** `UPDATE calendar_events SET actual_value=NULL, consensus_value=NULL, reaction_snapshot=NULL, enriched_at=NULL;`. Reverts to pre-sprint state; re-run enrichment at leisure.
7. **Migration rollback:** additive columns + `sector_etf_gaps` table can't cleanly drop without a rebuild. If needed, leave everything in place and disable both schedulers.

---

## 16. Post-session offers

After shipping, two natural follow-ups warrant a `/schedule` offer:

- **In 2 weeks**: "Check if enrichment has ≥30 events captured; if so, run a coverage report and identify any event types with stuck-null actuals." Strong signal (data accumulation → verify the feature is actually producing value).
- **In 3 weeks**: "Read `sector_etf_gaps` — any symbols with count ≥ 3? Extend `SECTOR_TO_ETF` and/or `EVENT_SECTOR_MAP` to cover them, open a small PR." Closing the loop on the known-unknowns bucket.

No soak-window metrics or flag-cleanup items anticipated.

---

*End of plan. Ready to execute post-compact.*
