# Earnings-Day Cockpit — Design

**Date:** 2026-07-08
**Status:** Approved (user, 2026-07-08; spec-review gate waived by user — proceed straight to implementation)
**Source:** Earnings-season audit `docs/plans/2026-07-04-earnings-season-audit.md` §4 items 5 + 7 + 8 (the last open P1-adjacent audit scope besides the intelligence tier).

## What & why

A day-of command center for earnings season. EarningsHub is week-oriented; on a 3-call evening the user needs a time-ordered view of **today's** reporters with live per-stage pipeline status (preview → released → actual → reaction → recap), a countdown to the next print, exposure-based priority, and a structured post-call note captured while the call is fresh. The cockpit is **read-only over the pipeline** — it never advances sweep/enrichment state; it renders it honestly and deep-links to the existing manual tools (actuals override, email viewer).

User decisions locked during brainstorm:

1. **Scope**: full cockpit — day view + exposure ranking + structured quick capture. Intelligence tier (implied move, surprise history, bogey automation, EOD wrap) stays a later batch.
2. **Day window**: today's reporters **plus** yesterday's rows whose recap is neither sent nor skipped (carryover — the morning "nothing slipped" check). Carryover rows drop off once the recap completes/skips or at end of the next day.
3. **Placement**: auto-appearing block at the top of `/dashboard/today` (desktop + mobile). Hidden entirely on days with no qualifying rows (normal case, not an empty state — mirrors TodayReleases).
4. **Quick capture**: structured fields in a new `earnings_call_notes` table (queryable later: "which names lowered guidance this season"), not a templated free-text note.
5. **Row order**: time-ordered within BMO/AMC lanes + net-exposure figure on every row; largest `|exposure|` per lane gets a weight marker. No sort toggle.

## Architecture (Approach A, approved)

New client component + one new endpoint. No changes to sweep/enrichment logic.

```
lib/earnings/cockpit-stages.ts        pure stage state machine (deriveEventStages)
lib/queries/earnings-cockpit.ts       row set + assembly (getCockpitEvents)
lib/compute/exposure.ts               + getNetExposureForSymbolFamilies (new export)
lib/queries/earnings-call-notes.ts    getCallNoteForEvent, getLatestCallNoteForFamily
lib/mutations/earnings-call-notes.ts  upsertCallNote
lib/db/migrations/064_earnings_call_notes.sql
app/api/earnings/cockpit/route.ts     GET — assembled cockpit payload
app/api/earnings/call-notes/route.ts  GET/POST
app/dashboard/today/EarningsCockpit.tsx   client block (mounted above EarningsHub)
app/dashboard/today/CallNoteModal.tsx     structured capture modal
lib/digest/send-earnings-email.ts     + call-note blocks in recap & preview prompts
```

## Stage state machine (`deriveEventStages`)

Pure function: `(event, emailRows, skipRows, mutedSymbols, now) → Stages`. No DB access — callers pass rows. All email-audit reads follow the pinned tri-state convention (`error`: `'in_progress'` = live claim, `'sent-by-cloud'` = cloud delivery, NULL = local send).

| Stage | Inputs | States |
|---|---|---|
| preview | `earnings_emails(phase='preview')`, skips, mute | `sent`, `sent-by-cloud`, `in-flight`, `skipped`, `pending` (release ahead), `missed` (release passed, nothing sent/skipped) |
| released | `composeReleaseInstant(event_date, release_time)` vs `now` | `upcoming` (payload carries the instant for the countdown), `released`; null `release_time` → `unknown` |
| actual | `actual_value`, `consensus_estimate`/`consensus_value`, `isPlausibleEarnings` | `pending`, `captured`, `implausible` (⚠, same guard as scoreboard/EarningsHub), `blocked` (released ≥2h AND `actual_value IS NULL` — same 2h rule as `alertBlockedRecaps`) |
| reaction | `reaction_snapshot` JSON | `pending` (before release+115m shows "ready at T+120m" — mirrors `REACTION_READY_MS`), `captured` + source (`tws`/`yahoo`/`polygon`); malformed JSON → `pending`, never throws |
| recap | `earnings_emails(phase='recap')`, skips, mute, actual stage | `sent`, `sent-by-cloud`, `in-flight`, `skipped`, `waiting` (gates not yet met), `blocked` (inherited from actual=blocked) |

Mute semantics: muted symbol → preview/recap render `skipped` with a "muted" annotation (matches sweep behavior; family-aware, case-insensitive like B20).

## Row set (`getCockpitEvents`)

- Earnings rows (`source='finnhub'` OR `event_type='earnings'`), deduped Finnhub-preferred-over-manual via ROW_NUMBER (same as EarningsHub), `superseded=0`.
- `event_date = todayET()` OR (`event_date = yesterdayET` AND recap neither sent nor skipped) — carryover flagged.
- Filter to held/watchlist via `getSymbolStatus` (issuer-family aware; "held" = ANY exposure incl. shorts + option underlyings, per the pinned convention).
- Lanes by `event_time`/`release_time`: BMO / AMC / unknown; time-sorted ascending within lane using `release_time`.
- `nextRelease`: earliest not-yet-released instant across today's rows.

## Exposure (`getNetExposureForSymbolFamilies`)

New export in `lib/compute/exposure.ts`: for each reporter family (`issuerSiblings`), across ALL accounts (latest-holdings CTE, `quantity != 0`): stock/ETF market value **signed** (shorts negative) with FX threading (`getUsdPerUnit`), plus delta-adjusted option exposure from `getOptionExposureMap`, with `optionExposureFallback` when Greeks are unavailable. Watchlist-only names → 0 (row renders a "watch" chip instead of a dollar figure). Largest `|netExposure|` per lane → `isTopExposure: true`.

## API

`GET /api/earnings/cockpit` (in-app, no cron auth — `/api/alerts` pattern):

```jsonc
{ "success": true, "data": {
    "generatedAt": "…",
    "nextRelease": { "eventId": 1, "symbol": "NVDA", "releaseInstant": "…" } | null,
    "lanes": { "bmo": [CockpitRow], "amc": [CockpitRow], "unknown": [CockpitRow] },
    "carryover": [CockpitRow],
    "skippedRows": 0
}}
```

`CockpitRow`: `eventId, symbol, securityId, title, eventDate, releaseTime, eventTime, symbolStatus, consensus (formatFinnhubFigureCompact), actual, stages{preview,released,actual,reaction,recap}, netExposure, isTopExposure, hasCallNote, carryover`.

`GET/POST /api/earnings/call-notes?eventId=` — POST body `{eventId, guidance?, tone?, surprises?, followUps?}`; validates guidance enum; standard `{success:false,error}` envelope on failure.

## Quick capture

Migration 064:

```sql
CREATE TABLE earnings_call_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL UNIQUE REFERENCES calendar_events(id) ON DELETE CASCADE,
  security_id INTEGER REFERENCES securities(id),
  symbol TEXT NOT NULL,
  guidance TEXT CHECK(guidance IN ('raised','inline','lowered','not_given') OR guidance IS NULL),
  tone TEXT,
  surprises TEXT,
  follow_ups TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_earnings_call_notes_symbol ON earnings_call_notes(symbol);
```

One note per event (UNIQUE event_id); `upsertCallNote` updates in place + refreshes `updated_at`. `symbol` denormalized so family-history reads survive event cleanup. All fields optional — save with any subset.

`<CallNoteModal>`: guidance as 4 segmented buttons (Raised / Inline / Lowered / Not given), three textareas (tone / surprises / follow-ups). Opens from the cockpit row's note button, which is **visible only once stage ≥ released** (hidden, not disabled). Honest-feedback save (explains failure, no premature close, no empty catch).

## Prompt wiring (send-earnings-email.ts)

1. **Recap**: render the event's call note as `## Your call notes` immediately AFTER the user-notes block (user notes stay first), with guidance direction stated explicitly ("You marked guidance: LOWERED") so beat/miss framing anchors on what the user heard.
2. **Preview**: render `getLatestCallNoteForFamily(symbol)` from the prior quarter as `## Last quarter's call, in your words`.
3. Call-note prose is user commentary on a public call — no position data — so it passes to prompts as-is; the presence-only position rule is untouched.

## Component

`<EarningsCockpit>` (client): mounted in `today/page.tsx` above EarningsHub. Returns `null` when `lanes` + `carryover` are all empty.

- Header: terminal micro-label `EARNINGS DAY`, reporter count, live countdown to `nextRelease` (1s client tick, single interval).
- Carryover strip first (amber tint, "yesterday — unfinished"), then BMO, then AMC, then unknown-time.
- Row: `SymbolLink` + held/watch `<Chip>`, release slot, consensus → actual (public data — plain formatters), net exposure via `<Money>` (portfolio-derived → privacy-masked), five stage chips via `<Chip>` (`up`=done, `neutral`=pending, `warn`=in-flight/waiting, `info`=cloud-sent, `down`=blocked/missed). Implausible actual renders the ⚠ convention.
- Chip actions (all always-visible buttons — no hover-reveal, per the tap-trap rule; hit areas via the `after:` extension pattern): blocked → opens actuals-override modal (reuse `BogeysEditModal` actuals section); sent preview/recap → `<EarningsEmailViewer>`; note button → `<CallNoteModal>` (filled-state indicator when `hasCallNote`).
- Polling: refetch every 60s while mounted AND `document.visibilityState === 'visible'`. Fetch failure keeps last good data + inline "stale, retrying" hint; never blanks a rendered cockpit.
- Mobile: single column, lanes stack, chips wrap.

## Error handling

- Endpoint: standard envelope; any per-row derivation error skips the row with a `console.warn` and continues (one bad row can't kill the cockpit) — count surfaced as `data.skippedRows` for honesty.
- Stage function: total — every input combination maps to a state; null release_time → unknown lane + `released: unknown`; malformed JSON → pending.
- Call-note POST: 404 unknown event, 400 bad guidance, honest messages.

## Testing

- `tests/earnings/cockpit-stages.test.ts` — full state machine incl. tri-state `error`, skips, mute (family-aware), cloud-sent, blocked 2h boundary, T+115m reaction gate label, DST edges via `composeReleaseInstant`, carryover predicate.
- `tests/queries/earnings-cockpit.test.ts` — dedup, held/watchlist gate, lanes, nextRelease, carryover inclusion/drop-off.
- `tests/compute/exposure-families.test.ts` — family rollup, shorts signed, option delta + fallback, FX, watchlist zero.
- `tests/earnings/call-notes.test.ts` — upsert semantics, enum guard, family latest-lookup.
- Composer tests extended: recap note block placement (after user notes), preview prior-quarter block, absent-note no-op.
- API contract test additions (`tests/contracts/api-component-contracts.test.ts`) for both new endpoints.
- Pre-ship: agent-browser E2E against seeded events staged at each pipeline state; touch-target audit on the new buttons.

## Non-goals

- No changes to sweep, enrichment, marker, or send logic (read-only surface).
- No intelligence-tier items (implied move, history block, bogey automation, EOD wrap).
- No Worker/cloud mirror — the cockpit is a Mac/app surface; cloud state already reconciles into the DB it reads.
- No sort toggle, no per-user layout config.
