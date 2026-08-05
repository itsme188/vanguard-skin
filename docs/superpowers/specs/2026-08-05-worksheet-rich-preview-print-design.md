# Rich preview-based earnings worksheet print — design

**Date:** 2026-08-05
**Status:** Approved (approach A; user chose "wait for the preview" for the no-preview case)
**Supersedes (partially):** `2026-08-03-worksheet-print-design.md` — the deterministic composer survives as the manual-print fallback; the auto-print path changes.

## Motivation

The 2026-08-03 worksheet shipped and the auto-print mechanics worked on the first
live morning (armed the night before → paper at the desk). But the *content* is
the thin deterministic skeleton: headline EPS/Revenue rows, guidance blanks,
notes, scratch pad. What the user actually works from — evidenced by a
hand-worked AMZN sheet — is the **preview email**: its `## Line-by-line bogies`
table (Metric | Consensus/Prior | Actual | Δ) hand-filled during the call, plus
past prints and the commentary sections. The user had been printing the email
manually; the worksheet should produce that sheet automatically, with fill-in
columns actually sized for a pen.

Key realization: **no new AI work is needed.** A local preview send already
persists the full AI prose (bogies table included) in
`earnings_emails.ai_output_md`, and the scoreboard + `## Past prints` sections
are code-rendered (`renderHeadlineTable`, `renderPastPrintsBlock` +
`loadIntelView`, all exported from `lib/digest/send-earnings-email.ts` and
already reused this way by the read-only email-content viewer route). The
printer re-plumbs to reuse that content.

## Goals

- Auto-printed worksheet = the preview email's content restructured for
  pen-and-paper: scoreboard → past prints → line-by-line bogies (blank ruled
  ACTUAL/Δ columns) → commentary.
- Keep the entire `lp` plain-text printing road (zero new dependencies; the
  cupsd hardening in `printViaLp` stays untouched).
- Pure, testable composer.

## Non-goals

- No HTML/PDF printing (approach B rejected: fragile HTML→PDF dependency on a
  launchd path, untestable, can't widen the fill-in columns).
- No new AI calls at print time. The worksheet is preview-phase only — recaps
  are read on screen.
- No change to the deterministic composer's output (it remains the manual
  fallback).
- No cloud/Worker involvement.

## Architecture

### New pure module: `lib/earnings/worksheet-rich.ts`

Three pure units, no DB access:

1. **`extractPreviewSections(aiOutputMd)`** — splits the stored preview prose:
   - the `## Line-by-line bogies` markdown table (parsed into
     `{ header: string[], rows: string[][] }`);
   - the commentary: everything after the bogies table up to but excluding
     `## Sources` (tolerates prompt drift in section names — we take the span,
     not a whitelist). Missing pieces return null/empty; the composer degrades
     gracefully (a preview with a malformed table still prints its commentary,
     and vice versa).

2. **`renderMonospaceTable(table, layout)`** — markdown table → fixed-width
   ruled monospace table. One renderer serves all three tables (scoreboard,
   past prints, bogies) since all three exist as markdown:
   - Column widths per layout; cells word-wrap within their column; row height
     = max wrapped lines across the row's cells; `─`/`│`/`┼` ruling so every
     row is a box the pen can write inside (mirrors the user's printed sheet).
   - **Blank-cell rule:** a cell that is exactly `—` (or empty) in a column
     marked `fillIn` renders as blank space — the ruled box IS the fill-in
     area. This converts the email's placeholder em-dashes into writing room.
   - Bogies layout (79 cols incl. 3 `│` separators): Metric 16 |
     Consensus/Prior 41 | Actual 13 | Δ 6; Actual + Δ are `fillIn`.
     Scoreboard reuses the same shape; past prints has no fill-in columns.

3. **`composeRichWorksheet(inputs)`** — assembles the page text:
   - Header line (symbol — date — slot — expected move), same clamp discipline
     as the deterministic composer.
   - Sections in order: SCOREBOARD → PAST PRINTS (omitted when history empty)
     → LINE-BY-LINE BOGIES → COMMENTARY → NOTES (≤4 lines) → SCRATCH (only
     whatever remains on the last page; the table boxes and margins are the
     real scratch space now).
   - Commentary markdown → plain text: `##` headings become uppercase section
     titles, `**`/`*` markers stripped, `[text](url)` links reduced to their
     text, list bullets kept.
   - **Pagination:** pages of ≤62 lines joined by form feeds (`\f`) so CUPS
     page breaks are deterministic. Soft target 2–3 pages, hard cap 3.
     Commentary is the flex section — it truncates last with an explicit
     `… (full text in the preview email)` line. The bogies table never
     truncates by page-budget; a pathological table caps at 20 rows with a
     `(+N more rows — see email)` line.
   - Footer on the final page: `[from preview email sent <timestamp>]`.

### Loader: rich-or-nothing for auto, rich-or-fallback for manual

In `lib/earnings/worksheet.ts`:

- **`loadRichWorksheetInputs(db, eventId)`** — returns null unless a *local
  completed* preview exists: `getEmailAudit(db, eventId, "preview")` row with
  `ai_output_md` non-null. (`getEmailAudit` already excludes live
  `'in_progress'` claims; `'sent-by-cloud'` rows have `ai_output_md = NULL`
  and are excluded by the non-null check — per the tri-state convention.)
  When present, assembles: event row + `loadIntelView(db, eventId, symbol)`
  (synchronous, cache-read-only) + `renderHeadlineTable(event, symbol,
  "preview", intelView)` + `renderPastPrintsBlock(intelView.history)` +
  `extractPreviewSections(ai_output_md)` + note lines.

- **`printArmedWorksheets` (auto pass)** — user decision: **wait for the
  preview.** For each armed, unprinted, in-window event: if
  `loadRichWorksheetInputs` returns null, skip WITHOUT stamping (retries next
  15-min tick; the window closing at release+30m naturally ends retries).
  Otherwise print the rich sheet and stamp. Consequence (accepted): an event
  whose preview was cloud-sent never auto-prints — the Mac was asleep at
  preview time, so nobody was home to collect paper; "Print now" covers it. The
  same holds for any armed event whose preview never sends at all — muted symbol,
  per-event skip row, or the already-reported guard — no preview means no
  derived sheet; "Print now" (deterministic fallback) is the road for those too.

- **`printWorksheetNow` (manual)** — prefers the rich sheet; falls back to the
  existing deterministic composer when no local preview exists. An explicit
  button press always produces paper.

### Sweep ordering

`runEarningsEmailSweep` currently runs `printArmedWorksheets` BEFORE the
per-candidate send loop (the 2026-08-03 rationale — don't let 60–180 s sends
delay paper — assumed a send-independent sheet). With the wait-for-preview
gate the pass MUST run after sends, or the tick that sends the preview would
not print it until the next tick. Move the call to after the candidate loop
(before the best-effort transcripts step). The auto-print window
([−30 m, +135 m] around release) has ample slack for the loop's runtime.

## Error handling

- `extractPreviewSections` never throws: malformed/absent table → null table +
  whatever commentary parses; composer renders remaining sections.
- If BOTH table and commentary come back empty from a non-null `ai_output_md`
  (pathological), `loadRichWorksheetInputs` returns null — auto pass retries /
  manual falls back, same as no-preview.
- Print/lp failure semantics unchanged: failed auto-print logs and retries
  next tick (no stamp); `printViaLp` hardening untouched.

## Testing

`tests/earnings/worksheet-rich.test.ts` (pure, no DB):
- table extraction: normal, missing, malformed, extra columns, drifted section
  headings; commentary span excludes Sources.
- monospace rendering: wrapping, multi-line rows, blank-cell conversion of `—`
  fill-in cells, ruling widths ≤80.
- pagination: form-feed placement, 62-line pages, 3-page cap, commentary
  truncation message, bogies row cap.

`tests/earnings/worksheet.test.ts` additions (in-memory DB):
- auto pass: armed+in-window with no local preview → no print, no stamp;
  with local preview → rich print + stamp; `sent-by-cloud` row → no print.
- `printWorksheetNow`: rich when preview exists, deterministic fallback
  otherwise.
- sweep ordering: a tick that sends a preview also prints the worksheet.

## Files touched

- `lib/earnings/worksheet-rich.ts` (new, pure)
- `lib/earnings/worksheet.ts` (loader + gating + fallback wiring)
- `lib/calendar/email-sweep.ts` (move the auto-pass call after the send loop)
- tests as above

No migrations, no API shape changes, no UI changes (the ⎙ arm chip and
"Print worksheet" button behave identically from the user's side).
