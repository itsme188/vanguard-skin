# Earnings Date Cross-Check (Finnhub × Nasdaq) with Human-in-the-Loop Confirmation

**Date:** 2026-06-08
**Status:** Design — approved in brainstorming, pending spec review
**Topic owner:** Yitzi

## Problem

"Earnings this week" on the Today view is inaccurate. Concretely (2026-06-08): the Hub
shows **RBRK (Rubrik) as upcoming on Mon Jun 8**, but Rubrik actually reported **Thu Jun 4,
2026 at 5:00pm ET** ([SEC 8-K](https://www.sec.gov/Archives/edgar/data/0001943896/000194389626000041/rubrikinc-991pressrelease4.htm)).
A past earnings is listed as still ahead — wrong by 4 days.

Root cause: **Finnhub is the sole working automated earnings source.** WSH (the TWS path)
contributes **zero** rows (blocked by error 10276, "news feed not allowed"). Of 73 earnings
rows in `calendar_events`, 70 are `finnhub`, 3 `manual`. Finnhub mis-dates names by days,
drifts on foreign-exchange suffixes (asks GFL, returns GFL.TO), and its `hour` field is
unreliable — and nothing corroborates or corrects it.

The user's primary pain (chosen explicitly): **wrong dates** for held names.

## Goal

Make held-name earnings dates trustworthy by **cross-checking two independent free
forward-looking calendars** (Finnhub + Nasdaq). Auto-confirm when they agree; for genuine
future-vs-future disagreements, **route to a human-in-the-loop confirmation** the user
resolves by checking IBKR (the one definitive source for their own names). User-confirmed
dates are locked and never re-overwritten by sync.

Non-goals: replacing Finnhub's consensus estimates or actuals pipeline (kept as-is); fixing
coverage of non-held names; touching the macro-events or read-through pipelines.

## Why Nasdaq

`api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD` (free, no auth, US-listed only).
Validated against the failing case: it correctly returns **RBRK on 2026-06-04** with
`epsForecast ($0.44)`, `eps ($0.19)`, `time time-not-supplied`. Time field encodes
`time-pre-market` (BMO) / `time-after-hours` (AMC) / `time-not-supplied`. US-listed only,
which structurally eliminates the GFL→GFL.TO foreign-suffix bug. One request per trading day
covers all names at once.

Rejected: Yahoo per-symbol `calendarEvents` (~60 req/sync, fuzzy date ranges for unconfirmed
names, brittle crumb auth) and a 3rd-source tiebreaker (two solid calendars resolve it).

## Resolution Model

Per held/watchlist symbol-family (`issuerSiblings`), cluster earnings rows that refer to the
same reporting event (proximity window: **±14 days**), then resolve:

| Condition | Canonical date | `date_status` | Surfaced? |
|---|---|---|---|
| Finnhub == Nasdaq | that date | `confirmed` | subtle "✓ 2 src" |
| One candidate already occurred (date < today **and** has actuals/Nasdaq reports an actual EPS) | the occurred date | `confirmed` | auto-corrected, silent |
| Both **future**, dates differ >1 day | **Nasdaq** (provisional) | `conflict` | ⚠ "confirm date" + bell count |
| Only one source has it | that date | `single` | subtle "1 src" |
| User confirmed / entered | **user's date** | `user_confirmed` | 🔒, never re-synced |

Notes:
- **Past-vs-future auto-resolve** (row 2) handles the RBRK ghost without nagging: Nasdaq shows
  RBRK on Jun 4 *with a reported actual*, so it demonstrably happened — auto-correct to Jun 4,
  no prompt. RBRK then drops off "this week" (Jun 4 is last week) and the Jun 8 Finnhub row is
  superseded. User confirmation is reserved for genuinely ambiguous **future-vs-future**
  disagreements.
- Provisional display on conflict shows the **Nasdaq** best-guess so the user is never blind.
- A `user_confirmed`/`manual` row in a cluster always wins and is **locked** — reconciliation
  treats it as canonical and never reverts it on re-sync.

## Architecture

### 1. New source — `lib/calendar/nasdaq.ts`
- `fetchNasdaqEarnings(symbols, window, { fetchDay? })`: for each trading day in `window`
  (`[today−7, today+14]` — the past-7 reach is what lets Nasdaq contradict a stale future
  Finnhub date), GET the Nasdaq calendar, parse rows → `{ symbol, date, time: "bmo"|"amc"|null,
  epsForecast: number|null, epsActual: number|null }`. Intersect with held+watchlist via
  `issuerSiblings`. DI boundary: `fetchDay` injectable for tests; real adapter sends the
  `User-Agent`/`Accept` headers Nasdaq requires. Graceful degrade: per-day failures skipped;
  total failure returns `[]` (reconcile still runs on Finnhub-only data).
- Time mapping: `time-pre-market`→`bmo`, `time-after-hours`→`amc`, `time-not-supplied`→`null`
  (then existing `deriveReleaseTime` / AMC-default applies, same as today).
- EPS parsing: `($0.44)`→`-0.44`, `$0.12`→`0.12` (parenthesis = negative).

### 2. Sync integration — `lib/calendar/sync.ts::syncCalendarForWeek`
- Add a Nasdaq phase after the Finnhub phase: write rows with `source='nasdaq'`,
  `source_key='nasdaq:SYMBOL:DATE'`, populating `event_date`, `release_time` (from time
  mapping), `consensus_estimate` (from epsForecast when present). Idempotent re-import.
- After both sources have written, call the reconciler (below).

### 3. Reconciliation — `lib/calendar/reconcile-earnings-dates.ts`
- `reconcileEarningsDates(db, { today })`: for each held/watchlist symbol-family, gather
  earnings rows in `[today−21, today+30]`, cluster by ±14-day proximity, apply the resolution
  model, and write per row: `date_status`, `date_conflict_with` (the losing source's date when
  `conflict`, else null), `superseded` (1 on non-canonical rows). Pure/deterministic given
  `today`; idempotent (re-running yields the same marks); never mutates a `user_confirmed`/
  `manual` cluster's canonical date.

### 4. Migration 057 — `057_earnings_date_crosscheck.sql`
```sql
ALTER TABLE calendar_events ADD COLUMN date_status TEXT;        -- confirmed|conflict|single|user_confirmed
ALTER TABLE calendar_events ADD COLUMN date_conflict_with TEXT; -- e.g. "finnhub:2026-06-08"
ALTER TABLE calendar_events ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_calendar_events_superseded ON calendar_events(superseded);
```

### 5. User confirmation — `POST /api/earnings/confirm-date`
- Body: `{ symbol, confirmedDate, confirmedTime?: "bmo"|"amc"|"HH:MM" }`. Writes (or updates) a
  `source='manual'` row at the confirmed date (`source_key='manual:SYM:DATE:earnings'`),
  `date_status='user_confirmed'`, `superseded=0`; supersedes the cluster's sync rows. Reuses
  the existing manual-event authority + the read-first 403 guard for sync-owned rows. In-app
  auth (no cron secret). Idempotent.

### 6. Readers (all filter `superseded=0`)
- `lib/queries/calendar.ts::getEarningsForWeekDeduped` — exclude superseded; expose
  `date_status` + `date_conflict_with`.
- `app/dashboard/today/page.tsx` today/upcoming releases queries — add `superseded=0`.
- Week-ahead view query — add `superseded=0`.
- `lib/calendar/enrichment-runner.ts::findEmailCandidates` — add `superseded=0` so the earnings
  email cron can never fire on a superseded wrong-date row.

### 7. UI
- **EarningsHub row chip** (`EarningsRowChips`/`EarningsHub.tsx`): drive off `date_status` —
  `confirmed`→subtle "✓ 2 src"; `single`→"1 src"; `user_confirmed`→"🔒 confirmed";
  `conflict`→a **⚠ "confirm date"** button opening a small popover: *"Finnhub: Mon Jun 8 ·
  Nasdaq: Thu Jun 4 · [date input]"* → pick one or type the IBKR date → `POST
  /api/earnings/confirm-date` → `router.refresh()`. Use `<Chip>` tones (warn/up/neutral).
- **NotificationBell**: add the count of `date_status='conflict'` rows in the
  `[today, today+14]` window to the existing aggregated count (reuse the levels-review pattern);
  bell item links to the Hub.

## Testing

- `tests/calendar/nasdaq.test.ts` — parse fixture JSON → rows; time mapping; EPS paren parse;
  held/watchlist intersect via siblings; graceful-degrade on fetch failure (DI stub).
- `tests/calendar/reconcile-earnings-dates.test.ts` — agree→`confirmed`; future-future
  disagree→`conflict` (Nasdaq canonical, Finnhub superseded, `date_conflict_with` set);
  past-with-actuals vs future→auto-`confirmed` to past, future ghost superseded (the RBRK case,
  seeded from real values); single→`single`; `user_confirmed` cluster locked + idempotent on
  re-run (sync rows re-superseded, canonical date unchanged).
- `tests/queries/earnings-hub.test.ts` (extend) — `getEarningsForWeekDeduped` excludes
  superseded and surfaces status.
- `tests/api/earnings-confirm-date.test.ts` — confirm writes locked manual row + supersedes
  siblings; re-sync doesn't revert.
- All in-memory SQLite with injected fetchers (no network in tests), per project convention.

## Risks / Mitigations
- **Unofficial Nasdaq endpoint** could change/break → DI fetcher + graceful degrade to
  Finnhub-only (`single`); never crashes the sync. A broken Nasdaq simply removes corroboration.
- **Clustering false-merge** (two real events within 14 days) → rare for quarterly earnings;
  ±14d is well inside a quarter. Documented constant, tunable.
- **Provisional Nasdaq could itself be wrong** on a future-future conflict → that's exactly why
  it's flagged `conflict` for user confirmation rather than trusted silently.

## Rollout
- Mac-side only; ships on the next DMG rebuild. No Worker/cloud changes (earnings emails read
  `calendar_events`, which now carries corrected dates).
- Backfill: first post-deploy `syncCalendarForWeek` reconciles existing rows; the RBRK ghost is
  superseded on that run.
