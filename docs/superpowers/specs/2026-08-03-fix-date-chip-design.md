# Fix earnings date/slot from the EarningsHub date chip — design

**Date:** 2026-08-03
**Status:** Approved by user (placement: inside the date chip, every status)
**Origin:** Earnings feedback backlog #7 (user review 2026-08-02): wrong sync dates/slots happen (RKT single-source phantom, IMAX slot, MELI) and the only correction paths were the CLI (`scripts/correct-earnings-date.ts`) and the autonomous verifier — no UI, nothing reachable from a phone.

## Problem

`correctEarningsEventDate` (lib/mutations/calendar.ts) is the safe correction primitive — transactional suppress+delete of the wrong rows, manual-row mint (or vendor-row adoption on date moves), bogeys migration, refusal on captured actuals, same-date slot-only fixes. But the EarningsHub date chip only opens a popover in `conflict` status; a wrong date that both vendors agree on (or that only one vendor carries) shows a reassuring `✓ 2 src` / `1 src` chip with no way to say "this is wrong."

## Design

### API — `POST /api/earnings/correct-date`

In-app route (no cron auth — same family as `confirm-date` / `skip`). Body:

```json
{ "symbol": "RKT", "wrongDate": "2026-07-30", "correctDate": "2026-08-06", "slot": "bmo" }
```

- Validation: `symbol` non-empty string; both dates `YYYY-MM-DD`; `slot` optional `"bmo" | "amc"` (uppercased before the lib call).
- **404 when no earnings row exists for (symbol, wrongDate)** — the lib would happily mint a new row with nothing to correct; the route is honest instead ("no earnings row for RKT on 2026-07-30").
- Calls `correctEarningsEventDate(db, { symbol, wrongDate, correctDate, slot })`.
- Refusal (`ok: false`, e.g. captured actuals) → **409** `{ success: false, error: refusedReason }` verbatim.
- Success → `{ success: true, data: { newEventId, deletedIds, bogeysMigrated } }`.

### UI — `EarningsDateChip`

- The three passive statuses (`confirmed` ✓ 2 src, `single` 1 src, `user_confirmed` 🔒) become tappable buttons sharing the popover shell the conflict branch already has (`z-[55]`, `popoverAlign` honored, touch hit-extension idiom on the chip).
- Their popover: a header line (formatted current date + status wording), then a **"Date is wrong?"** form — date input **pre-filled with the current event date** (slot-only fixes are then one select away), BMO/AMC select defaulting to the row's current slot (derived from `release_time < "12:00"`), and a `Fix date` button. Button disabled while submitting or when the date input is emptied.
- The `conflict` branch is unchanged (its pick-source flow already covers the disagreement case via `confirmEarningsDate`).
- Honest feedback: non-OK responses render the server's error inline in `text-down` (the captured-actuals refusal reads exactly as the lib wrote it); popover stays open on failure. Success closes the popover, fires `onConfirmed?.()`, and `router.refresh()`.

### Non-goals

- No Pushover (user-initiated action).
- No cockpit/preview changes — every downstream surface re-derives from the corrected `calendar_events` row.
- No change to the conflict flow or the verifier.

## Testing

- Route tests: validation 400s, 404 on no-row, 409 refusal passthrough (seed a row with `actual_value`), success shape on a date move (deleted+suppressed, bogeys migrated) and on a slot-only fix.
- Full Mac suite green; browser E2E on the dev server: `+ Add ticker` a scratch symbol, fix its date via the chip, verify the row moved, delete it.
