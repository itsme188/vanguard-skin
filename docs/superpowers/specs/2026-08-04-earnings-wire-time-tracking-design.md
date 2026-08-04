# Earnings Wire-Time Tracking — Design

**Date:** 2026-08-04
**Status:** Approved (brainstorm session 2026-08-04)
**Origin:** XMTR Q2 2026 printed ~07:05 ET against its recorded 08:00 BMO default. The enrichment runner only polls after the recorded `release_time`, so the pipeline is structurally blind to early wires: actuals, push-at-print, and the recap window all lagged ~an hour. Memory: `project_earnings_wire_time_tracking.md`; TODO item filed 2026-08-04.

## Goal (user decision: observation + live early-capture)

Two outcomes from one mechanism:

1. **Live**: capture actuals the moment they exist on Finnhub, not the moment the recorded slot says they should — push-at-print, recap window, and reaction anchoring key on reality.
2. **Calibration**: every print leaves an observed wire-time record; next quarter's `release_time` resolves from observed history automatically, with an in-app per-symbol standing override for the user (user decision: automatic + manual override surface, per-symbol standing).

## External data research (2026-08-04)

No free API provides exact expected report times:

- **Wall Street Horizon** is the specialist (expected timing, confirmed vs forecasted) and rides the TWS API we already call (`reqWshEventData`) — but the account hits WSH error 10276 ("News feed is not allowed"): subscription not enabled. **User side-quest, not a design dependency**: enable the WSH research subscription in IBKR Account Management and revisit.
- **EarningsWhispers** publishes exact confirmed times but has no public API. Consumed here via Claude `web_search` in the existing daily verification tier (below) — the IMAX "07:30 wire-verified" precedent. Never scraped directly.
- **Benzinga** (HH:MM:SS EST) is paid/partner-gated. **Nasdaq / Finnhub / FMP / API Ninjas** are categorical only (BMO/AMC) — already consumed.

Conclusion: own-observation loop is the primary source; EarningsWhispers (via web search) is the jump-start for symbols the desk doesn't know yet.

## Data model (migration 076)

```sql
CREATE TABLE earnings_wire_observations (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,              -- UPPER, as queried
  event_date TEXT NOT NULL,          -- YYYY-MM-DD
  event_id INTEGER,                  -- calendar_events.id at observation time (no FK CASCADE need; row survives event deletion)
  first_seen_at TEXT NOT NULL,       -- ISO instant the probe/normal road first saw actuals
  last_empty_probe_at TEXT,          -- ISO instant of the latest probe that returned nothing (NULL = unbounded)
  source TEXT NOT NULL DEFAULT 'finnhub_probe',  -- 'finnhub_probe' | 'web_verified' | 'manual' (room for 'edgar' later)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, event_date, source)
);

CREATE TABLE symbol_release_times (
  symbol TEXT PRIMARY KEY,           -- UPPER
  release_time TEXT NOT NULL,        -- HH:MM ET
  source TEXT NOT NULL,              -- 'user' | 'web_verified'
  note TEXT,                         -- provenance ("EarningsWhispers confirmed 8/04", user-entered)
  verified_for_date TEXT,            -- web_verified rows: the upcoming event_date the verification targeted
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- plus one column on the existing events table:
ALTER TABLE calendar_events ADD COLUMN wire_probe_empty_at TEXT;  -- ISO instant of the latest pre-release probe that found nothing
```

`wire_probe_empty_at` lives on the event row (not the observations table) so `earnings_wire_observations` only ever holds real sightings — an event that never prints early leaves no observation row, just a stamp that expires with the event.

**Bounded vs unbounded observations.** An observation is **bounded** when `last_empty_probe_at` is non-null and ≤30 min before `first_seen_at` — we saw "nothing yet" then "actuals out", so the wire time lies inside a tight interval. Unbounded observations (Mac woke late; actuals were already out at first probe) prove only "at or before `first_seen_at`" and are **excluded from calibration** — but they still tighten a too-late resolved time (see cascade rule 3). This honesty rule is the difference between calibrating on evidence and calibrating on wake-up schedules.

## Resolution cascade

`resolveReleaseTime` (`lib/calendar/release-times.ts`) stays pure; it gains an injectable per-symbol lookup seam (the `lib/ai/override-source.ts` registration pattern — `lib/db.ts` registers a reader; never import the db singleton into release-times). Precedence for an earnings event's release time:

1. **User standing override** — `symbol_release_times` row with `source='user'`.
2. **Web-verified** — `symbol_release_times` row with `source='web_verified'`, honored ONLY while the symbol has zero bounded observations (once we've watched a real print, our own eyes outrank a website).
3. **Observed-derived** — earliest bounded `first_seen_at` (ET wall-clock HH:MM) across the symbol's last 4 quarters of observations, minus a 10-minute margin, rounded down to :05. Additionally, ANY observation (bounded or not) earlier than the otherwise-resolved time pulls it down to that observation's HH:MM minus margin — an early sighting is proof regardless of bounding.
4. **Legacy constant** — `SYMBOL_RELEASE_TIMES_ET` (IMAX precedent; kept as seed, not migrated).
5. **Existing defaults** — event_time BMO/AMC → 08:00/16:15, `RELEASE_TIMES_ET`, `raw_json.entry.hour`.

**Slot-mismatch guard**: layers 1–3 apply only when the stored HH:MM lands on the same side of 12:00 as the event's BMO/AMC classification (a symbol that moves BMO↔AMC across quarters must not inherit the wrong half of the day). Mismatch → fall through to the next layer. Sanity floor: never resolve earlier than 04:00 ET.

**Family-aware**: lookups walk `issuerSiblings` like every other symbol-keyed surface.

Worker: NO mirror. The Worker consumes `release_time` from calendar rows/snapshot as today; Mac-resolved times flow through data.

## Live probe window (enrichment runner)

New `findProbeCandidates(db, now)` in `lib/calendar/enrichment-runner.ts`, run by `runEnrichment` BEFORE the normal candidate pass:

- **Eligibility**: earnings rows (same source predicate as enrichment), symbol non-null, not superseded, held/watchlist/read-through-reporter (`getSymbolStatus` + reporter symbols — the existing enrichment universe), no `actual_value` yet, and `now ∈ [resolvedRelease − 90min, resolvedRelease)`. Past `resolvedRelease` the normal road owns the event.
- **Per tick**: probe Finnhub (`probeFinnhubActualExists` — already exists as the preview guard's live layer; existing 550ms pacing). Cap 6 probes/tick, nearest-release first, to protect the free tier; un-probed candidates wait for the next 15-min tick.
- **Empty probe** → stamp `calendar_events.wire_probe_empty_at = now` (no observation row yet).
- **First non-null** → in one flow: (a) record the observation (`first_seen_at = now`, `last_empty_probe_at` copied from the event's `wire_probe_empty_at`); (b) pull the event's `release_time` EARLIER to the observed HH:MM — earlier-only, never later, and applied uniformly (a user-set later time on a manual row loses too: an observed print is direct evidence); (c) run the normal enrichment road for that event immediately (actuals captured → push-at-print fires, recap window opens; reaction stays gated by `REACTION_READY_MS` keyed on the now-corrected release instant).
- **Normal-road hook**: when the post-release road lands a null→non-null actual WITHOUT a prior probe sighting (e.g. AMC print captured at the 16:15 tick), record an observation there too (`last_empty_probe_at` from `wire_probe_empty_at`, likely NULL → unbounded). One recorder function, two call sites.

**Macro rows are untouched at every point.** Pacing: probe attempts do NOT stamp `enrichment_attempted_at` (that would interfere with the post-release retry pacing); the probe has its own implicit 15-min tick pacing.

## EarningsWhispers jump-start (verification-tier extension)

`lib/calendar/verify-earnings-dates.ts` (daily, 05:00 ET gate) gains a second concern: for candidate symbols reporting within 7 days that have **no user override AND no bounded observations AND no still-fresh web_verified row** (`verified_for_date >= upcoming event_date` counts as fresh), the verification prompt additionally asks for the exact expected report time, naming EarningsWhispers as the preferred source (company IR / BusinessWire as fallbacks). A confirmed HH:MM upserts `symbol_release_times` as `source='web_verified'` with `verified_for_date` and a provenance note. Unconfirmed → no row (defaults stand). Times outside 04:00–20:00 ET are rejected as hallucination-guarding, same spirit as the date-window guard in `applyVerdict`.

Self-extinguishing by design: once a symbol has a bounded observation, cascade rule 2 stops consulting the web row and the verifier stops re-asking.

## UI + API

- **`EarningsDateChip` popover** (both the conflict flow and the passive "Date is wrong?" flow) gains a "Reports at" line: resolved HH:MM + source chip (`override` / `verified` / `observed` / `default`), with an inline time input + Save that writes the standing per-symbol override, and a Clear when a `user` row exists. Touch idioms per the tablet-tier conventions.
- **`POST /api/earnings/release-time`** `{symbol, releaseTime}` upserts `source='user'`; `{symbol, releaseTime: null}` deletes the user row. `GET ?symbol=` returns resolved time + source + observation history (for the popover). In-app route, no cron auth. Honest-feedback conventions apply (explain no-ops).

## Testing

TDD throughout, `:memory:` DBs:

- Resolution cascade: each precedence layer, slot-mismatch guard, bounded-only rule 3, family walk, 04:00 floor, margin/rounding.
- Probe eligibility window: in/out of T−90m, held/watchlist/reporter gates, cap-6 ordering, macro exclusion, superseded exclusion.
- Observation recording: bounded vs unbounded from `wire_probe_empty_at`, probe road + normal road call sites, UNIQUE upsert idempotency.
- Early-capture flow: release_time pulled earlier (never later), push-at-print fires on the probe road, REACTION_READY keys on corrected instant.
- Verifier extension: only-when-unknown gating, freshness via `verified_for_date`, out-of-range rejection, user-row precedence.
- Route: upsert/clear/validation.

## Accepted gaps / follow-ups

- **No Worker probe** (v1): Mac pmset wake is 07:40 weekdays; a pre-7:40 print records as an unbounded observation honestly. Revisit only if live coverage disappoints.
- **No EDGAR refiner** (v1): `source` column leaves the door open.
- **WSH subscription** (user): enable in IBKR Account Management; if 10276 clears, WSH expected times become a candidate cascade layer.
- Weekend/holiday probing inherits the existing enrichment scheduler (24/7 ticks) — no new gating.
