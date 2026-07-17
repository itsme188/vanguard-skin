# "Today's reporters" block in the morning digest — design (#18)

**Date:** 2026-07-16
**Status:** Approved (earnings-batch session 2026-07-16)
**Sibling precedent:** `docs/superpowers/specs/2026-07-15-overnight-digest-block-design.md`

## What

A deterministic `## Today's reporters` block in the **morning digest email only**
(`edition === "morning"`), listing today-ET's earnings reporters as a compact
markdown table — schedule, position chip, street consensus, and the cached
implied move. Rendered on both the Mac and cloud (Worker fallback) delivery
paths. During the off-season the block self-quiets (no reporters → omitted).

```
## Today's reporters

| | Sym | Pos | Cons | Impl move |
|---|---|---|---|---|
| BMO 08:00 | TSM | held | $3.80 | ±4.0% |
| BMO 08:00 | UNH | — | $4.84 | — |
| AMC 16:15 | NFLX | held | $0.80 · $12.84B | ±6.2% |
```

## Decisions (locked with user, 2026-07-16)

- **Row scope: ALL of today's calendar reporters** (not held/watchlist-only),
  with position chips distinguishing `held` / `wl` / `rt` (read-through
  reporter) / `—` (none of those). The calendar's ingest scope (held +
  watchlist + read-through reporters + manual adds) is the natural bound.
- **Row content: rich** — slot + release time, symbol, chip, consensus via
  `formatFinnhubFigureCompact` (raw Finnhub strings never reach the user),
  and `±X.X%` implied move **read from the `earnings_intel` cache only**.
  The digest NEVER computes intel (no IBKR/AV calls at digest time) — same
  read-only decoration rule as the cockpit route's `decorateCockpitIntel`.
- **Cloud mirror: yes** — the Worker fallback digest renders the same block
  from the R2 snapshot (v9 ships `calendarEvents`, `heldSymbols`,
  `watchlistSymbols`, `earningsIntel`). Zero additional subrequests.
  Accepted degradation: the Worker has no read-through table, so an `rt`
  name renders `—` in a cloud digest.

## Architecture

### Shared pure renderer — byte-parity pair

- `lib/digest/todays-reporters-render.ts` (new, **zero imports** by design)
  — `ReporterRowView` type + `renderTodaysReportersBlock(rows)`. Empty rows
  → `null` (block omitted).
- `workers/cron/src/todays-reporters-render.ts` — byte-parity hand-copy
  below the header (the `print-push-message.ts` / `presence-position.ts`
  pattern), pinned by a parity test. Change BOTH files together.

### Mac assembly — `lib/digest/todays-reporters.ts` (new)

`composeTodaysReportersBlock(db, opts?: { today?: string }): string | null`
(synchronous — all local reads):

- Events: `getEarningsForWeekDeduped(db, mondayOf(today))` filtered to
  `event_date === today`. Reusing the Hub's query means the digest can never
  disagree with the EarningsHub about who reports (superseded-filtered +
  family-deduped + sibling security_id fallback, already tested).
- Slot: `event_time` BMO/AMC match → title "Before/After Market" match →
  `release_time < "12:00"` → `TBD` (mirrors the cockpit's `laneFor`
  precedence).
- Chip: `getSymbolStatus` (held wins over watchlist, family-aware) → `held`
  / `wl`; else `rt` when the symbol is in `getReadThroughReporterSymbols`;
  else empty (renders `—`).
- Intel: one `SELECT event_id, implied_move_pct FROM earnings_intel WHERE
  event_id IN (…)`; `±X.X%` when present.
- Sort: BMO → AMC → TBD, then release_time asc (nulls last), then symbol.
- Never throws: any failure logs one `[todays-reporters]` warn and returns
  `null` — the digest is never blocked by this block (the 5/20 lesson).

### Wiring — Mac

`lib/digest/daily-digest.ts::generateDigestSinceAdaptive`, inside the
existing `edition === "morning"` branch, immediately AFTER the Overnight
block — the read order becomes "what happened overnight → who prints
today". The block alone never produces an email (no-articles short-circuit
stays upstream, same rule as Overnight).

### Worker assembly — `workers/cron/src/todays-reporters.ts` (new)

`buildTodaysReportersBlock(snapshot, today): string | null`:

- Filters `snapshot.calendarEvents` to today's earnings, skips
  `superseded` rows (index-signature access, same as fallback-earnings'
  B12 read), dedupes per (UPPER(symbol), date) preferring `finnhub` source
  (the Hub's ROW_NUMBER rule, hand-rolled).
- Chips from `heldSymbols` / `watchlistSymbols` expanded through the Worker
  `issuerSiblings` mirror (B20 rule: never symbol-string-equal). No `rt`.
- Intel from `snapshot.earningsIntel` by `eventId`.
- Pre-v8/v9 snapshots degrade gracefully (missing arrays → no chips / no
  impl column values), never throw.

### Wiring — Worker

`composeDigestMarkdown` gains an optional `reporters?: string | null` param
rendered directly after the `overnight` block; `runFallbackDigest` builds it
from the snapshot before compose. Subrequest budget unchanged (49/50).

## Failure modes

| Failure | Behavior |
|---|---|
| No reporters today | Block omitted (off-season auto-quiet) |
| earnings_intel row missing | `—` in the Impl column |
| Snapshot missing v8/v9 fields | Chips/impl degrade to `—`, block still renders |
| Any assembly error | One warn log, block omitted, digest unaffected |

## Testing

- `tests/digest/todays-reporters.test.ts`: empty-day → null; family dedup
  inherited from the Hub query; chip precedence (held > wl > rt > —);
  compact consensus formatting; impl rendering + absence; BMO/AMC/TBD sort;
  never-throws (broken table → null + warn); morning-only wiring pin.
- `workers/cron/test/todays-reporters.test.ts`: renderer byte-parity with
  the Mac file; snapshot assembly (superseded skip, finnhub-preferred dedup,
  sibling-aware chips, pre-v9 degradation); composeDigestMarkdown placement
  pin + "reporters block alone never produces an email".

## Out of scope

Evening edition (EOD wrap is #17), Today-view surface (cockpit owns it),
AI involvement of any kind, storing anything in the DB, Worker-side
read-through chips.
