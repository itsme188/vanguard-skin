# Printable one-page earnings worksheet — design

**Date:** 2026-08-03
**Status:** Approved by user (per-event toggle trigger; monospace text via `lp`)
**Origin:** Earnings feedback backlog #6 (user review 2026-08-02): the preview email's line-by-line bogeys table doubles as a fill-by-hand worksheet for live calls, but printing it means zooming Gmail to 60%. Wanted: a one-page auto-print for the reports the user flags.

## Decisions (user-approved 2026-08-03)

- **Per-event toggle** — nothing prints unless the user arms that specific event (a printer chip in EarningsHub). No curated symbol list, no exposure threshold, zero surprise pages.
- **Monospace text via `lp`** — a fixed-width (80-col) desk sheet piped to CUPS. Zero rendering dependencies, works from the launchd sweep, always exactly one page (hard 62-line cap; scratch lines absorb slack).

## Design

- **Migration 074** `earnings_worksheet_flags` (`event_id` UNIQUE → `calendar_events` ON DELETE CASCADE, `printed_at` nullable) — the `earnings_email_skips` shape. Arm/disarm/stamp in `lib/mutations/earnings-worksheet-flags.ts`; reads in `lib/queries/earnings-worksheet-flags.ts`.
- **Composer** `lib/earnings/worksheet.ts::composeWorksheet` (pure): header (symbol · date · slot · resolved expected move via the #5 resolver, source-labeled), scoreboard rows (CONS from bogeys falling back to `effectiveConsensus`, WHISPER from bogeys, compact `formatLargeUSD` figures) each with blank `ACTUAL`/`Δ` columns, segment splits, guidance lines with `→ ___` fill-ins, user note excerpts (family-aware, 90d), scratch lines to the page floor. `loadWorksheetInputs` assembles from the DB.
- **Printing** `printViaLp` — `spawn("lp")`, text on stdin, optional `worksheet_printer_name` settings key (blank = default printer). `printWorksheetNow(db, eventId)` is the immediate path.
- **Auto-print pass** `printArmedWorksheets(db, {now, print?})` — armed unprinted flags whose release instant sits in **[now−30m, now+135m]** (the preview band plus a late-arming grace) print once (`printed_at` stamp; a FAILED print does not stamp and retries next tick). Rows with no computable release instant never auto-print (Print-now covers them). Hooked into `runEarningsEmailSweep` right after the debrief pass, **independent of the email candidate set** — a sent/skipped/AI-failed preview must not block the deterministic paper. Never throws. `print` param is the DI seam for tests.
- **API** `POST /api/earnings/worksheet` `{eventId, action: "arm"|"disarm"|"print"}` + `GET ?eventIds=` (in-app, no cron auth — skip-route family).
- **UI** — `EarningsRowChips` gains a ⎙ chip (faint = unarmed, gold = armed, green = printed; tap toggles; honest toasts). `BogeysEditModal` footer gains **"⎙ Print worksheet"** (immediate print, inline error on failure).

## Non-goals

- No PDF / HTML rendering, no Worker involvement (printing is physically Mac-side), no auto-flagging heuristics.

## Testing

- Composer: layout + 80-col + one-page invariants, segments/guidance, no-bogeys degradation.
- Flags: arm/disarm idempotence, disarm clears the stamp.
- Auto-pass: window gating (early hold → in-window print), once-only, failed-print-no-stamp retry with per-event isolation, null-release exclusion.
- Physical `lp` smoke test on a real event at the end.
