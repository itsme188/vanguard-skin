# Earnings preview print + prose round — design

**Date:** 2026-08-06
**Status:** Approved (brainstorm session, user-validated section by section)
**Scope:** items (a)–(c) of the 2026-08-06 earnings-workflow TODO entry. Item (d) — post-print automation — is deliberately excluded and gets its own brainstorm.

## Problem

Three user reports from live earnings-season use:

1. **(a)** The auto-printed worksheet should be ONE physical sheet whose line-by-line bogies table is **visually identical to the preview email's** — not the current re-columned 80-col monospace layout (≤3 pages). The user's original habit was printing the email at 60% Gmail zoom; the monospace sheet traded away that fidelity.
2. **(b)** The prose after the bogies table often has formatting artifacts and doesn't flow as analysis. Separately, when two sheet sources (e.g. TMT Breakout and FundaAI) carry different bogeys, the email never shows each source's numbers clearly — the prompt sends labeled per-source bogeys but the single "Consensus / Prior" column forces a merge.
3. **(c)** The user's own stock notes get cut off in printouts. Confirmed worse than reported: the rich worksheet clamps notes to 4 × 74 chars, silently, no ellipsis (`lib/earnings/worksheet.ts:256-258` + `worksheet-rich.ts:270`), while the email prompt gives each note 1,500 chars.

## User decisions (recorded verbatim from the brainstorm)

- **Fidelity:** visually identical to the email — the styled HTML table on paper, not a content-exact monospace rendering. This reopens the HTML→PDF road the 2026-08-05 spec rejected; the rejection is answered by fallback (below), not dismissed.
- **Sheet content:** tables + notes only, **never prose**. The sheet is the pure fill-in artifact; prose is read on screen.
- **Notes overflow:** overflow to a second PDF page printed **duplex on the back of the same sheet** (`lp -o sides=two-sided-long-edge`) — physically one sheet.
- **Prose shape:** keep the Setup / Bull-bear / Watch / Position sections; fix the writing inside them (no restructure to a single desk note).
- **Attribution:** conflicting sheet bogeys must be visible per source.

## Design

### 1. Print pipeline — email HTML → headless Chrome PDF → duplex lp

New module **`lib/earnings/print-sheet.ts`** (pure HTML composer) plus a thin DI-shaped spawn layer.

**Document content, in order (front → back):**

1. **Scoreboard** — rebuilt live via the email's own `renderHeadlineTable` (identical output by construction; same road the EarningsEmailViewer uses).
2. **Sheet bogeys (by source)** — the new deterministic table (§2), when ≥1 curated bogey row exists.
3. **Line-by-line bogies** — the table's markdown lifted **verbatim** from the sent preview's stored `ai_output_md`. New extractor `extractBogiesTableMarkdown(aiOutputMd): string | null` returns the raw heading + contiguous `|` lines (unlike `extractPreviewSections`, which parses and strips) so every row/cell is exactly what the email shows. No row cap.
4. **Your notes** — every family note from the last 90 days (`getNotesForFamily`, same window the AI sees), newest first, **complete text**, each headed `[date] · type · symbol`.
5. **Past prints** — last, so it usually lands on the back.

All content runs through the same **`briefingToHtml`** the email uses (pixel-identical tables), wrapped in print CSS: `@page` US Letter with margins, `break-inside: avoid` on tables (a table never splits across pages), notes allowed to flow. Sections 1–3 fit page 1 at full email size for realistic row counts; notes start on the front and continue on the back.

**Render:** Chrome headless — binary path `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, existence-checked at runtime. Invocation: `--headless --print-to-pdf=<tmp>/sheet.pdf --no-pdf-header-footer --disable-gpu --no-first-run --user-data-dir=<tmp-profile> <tmp>/sheet.html`, 30s kill timer (same wedged-process treatment as `printViaLp`'s 20s cupsd timer). Temp files under a per-job tmp dir, cleaned after.

**Print:** `lp -d <printer> -o sides=two-sided-long-edge -t <title> <file>.pdf` — CUPS accepts PDF natively. The duplex option is harmless on a 1-page PDF. Printer name via the existing `worksheet_printer_name` setting. (Implementation verifies the live printer advertises duplex via `lpoptions -l`; if not, the job still prints — on two sheets — and the composer is unaffected.)

**One-sheet enforcement (2026-08-07: extended to a 3-render ladder, capped — never loops):** after rendering, read the PDF page count (parse `/Count` from the PDF bytes — no new dependency). If > 2 pages: drop Past prints and re-render. If still > 2, re-render **once more** with a compaction option (`composePrintSheetHtml(sheet, { compact: true })`, stacked on the already-dropped Past prints) — smaller base font-size, tighter line-height, reduced table/cell padding and margins — which shrinks the layout to fit **without truncating any content**. If still > 2 after compaction (notes alone exceed the back even compacted), **print anyway** — the user's explicit rule is notes never truncate; at that extreme, complete beats one-sheet. Expected rare (~6–8k chars of notes fit on the back, and compaction buys meaningfully more).

**Failure = downgrade, never silence:** Chrome missing / spawn error / timeout / zero-byte or unparseable PDF → the existing monospace sheet (`composeRichWorksheet` → `printViaLp`) prints instead, unchanged. `printed_at` stamps only after a successful queue on **either** road; failures retry stampless next tick — exactly today's semantics in `printArmedWorksheets`. Manual "Print now" uses the same road; events with no local preview keep the current deterministic monospace composer (`composeWorksheetForEvent`) — that behavior is untouched.

**Fallback also improved:** the monospace sheet's notes section becomes full-text wrapped notes within its existing page budget — degraded paper still respects notes-are-sacred. The 4-notes × 74-chars silent chop (no ellipsis, no marker) is retired on both roads.

### 2. Deterministic "Sheet bogeys — by source" table

New **`renderSheetBogeysBlock(ctx)`** in `lib/digest/send-earnings-email.ts` — code-built from the `earnings_bogeys` rows, zero AI involvement (per the standing "never let the model author numbers the system already has structured" principle):

```
## Sheet bogeys — by source
| Metric          | TMT Breakout (8/04) | FundaAI (8/05)   |
|-----------------|---------------------|------------------|
| EPS             | 4.30 · **w 4.42**   | 4.28             |
| Revenue         | $4.34B              | $4.40B · **w $4.5B** |
| Expected move   | ±6.0%               | —                |
| Cloud rev (seg) | $1.2B               | $1.25B           |
```

- One column per source (`source_label`, most recent first), **cap 3 columns** + a `(+N older sheets not shown)` line beneath when exceeded.
- Rows: EPS, Revenue, Expected move (only rows where ≥1 source has a value), then segment rows **unioned across sources** from `segment_breakdown_json` (malformed JSON skipped silently — existing pattern).
- Whisper values marked `w` and bolded. Values via `formatLargeUSD` / `coercePercent` conventions.
- Rendered into **both preview and recap** markdown, after Past prints and before the AI output — so it appears in the email AND on the printed sheet. Recap benefit: actuals sit next to each source's bar (beat-the-whisper per source).
- Empty (`ctx.bogeys.length === 0`) → returns `""`; emails for names without sheets are unchanged.

### 3. Prompt updates (`renderPreviewPrompt`; attribution rule mirrored in `renderRecapPrompt`)

- **System-rendered notice:** the sheet-bogeys table is rendered by the system — do not re-list its rows.
- **In-table attribution:** when a line-by-line row uses a sheet number, cite the label in-cell (`4.42 (TMTB w)`); when sources disagree on a metric, **show both, never merge** (`$4.34B TMTB / $4.40B FundaAI`).
- **Section prose rules:** each of Setup / Bull-bear / Watch / Position implications is 1–3 flowing paragraphs; bullets only for genuinely enumerable items (max 4); no orphan bold-line fragments; no filler openers ("Investors will be watching…"); sections build on one another instead of restarting the story. The 600–1,000-word budget stands.
- Existing pins untouched: compact-number formatting, tone, scoreboard-no-repeat, already-reported guard, web_search directive.

### 4. Formatting-artifact diagnosis (implementation step 1)

Before touching the prompt, read the last handful of stored preview `ai_output_md` rows and catalog the actual artifacts (bullet walls, broken emphasis, stray table fragments, whatever the evidence shows). Fixes target the cataloged failures — prompt rule, post-processing in the `stripModelPreamble` family, or a `briefingToHtml` tweak — whichever layer the evidence indicates. No speculative renderer changes.

## Error handling summary

| Failure | Behavior |
|---|---|
| Chrome binary missing | Monospace fallback prints; `console.warn` breadcrumb |
| Chrome hang | 30s kill → fallback |
| PDF unparseable / 0 bytes | Fallback |
| PDF > 2 pages | Drop Past prints, re-render; still >2 → compact layout, re-render once more; still >2 → print anyway (notes win) |
| `lp` fails on the PDF road | Monospace fallback prints; stamp on its success (never-silent wins — decided 2026-08-07) |
| `lp` fails on the monospace road | No stamp, retry next tick (unchanged) |
| No curated bogeys | Sheet-bogeys block absent; email/sheet otherwise unchanged |
| Malformed segment JSON | Segment rows skipped for that source |
| No local preview (cloud-sent / muted) | Existing deterministic monospace road, unchanged |

## Testing

- `composePrintSheetHtml`: scoreboard HTML byte-equal to the email renderer's output; bogies markdown verbatim (no re-wrap); notes complete at any length; print CSS present; section order pinned.
- `extractBogiesTableMarkdown`: normal, missing-heading, malformed-table, table-after-next-heading cases.
- `renderSheetBogeysBlock`: multi-source disagreement, whisper marking, segment union, 3-source cap, empty → `""`.
- Prompt pins for the new attribution + prose rules (existing prompt-test pattern).
- `printArmedWorksheets` with DI-mocked render/print: rich-PDF success stamps; render failure falls back to monospace and still stamps; both-fail retries stampless.
- Page-count rule: mocked 3-page PDF → past-prints-less re-render → print.
- Monospace fallback notes: full-text wrapping, no 74-char chop.

## Out of scope (unchanged)

- Arming stays opt-in per event (⎙ chip); wait-for-preview gate; cloud-sent previews never auto-print; recaps never auto-print; no Worker involvement.
- Item (d) — post-print automation (auto-fetch/fill actuals, fewer manual touchpoints) — separate brainstorm.
- The 2026-08-05 "worksheet rich-print deferred minors" list: items touching the monospace renderer remain deferred (that renderer becomes fallback-only); the notes-chop item is superseded by this design.

## Addendum — 2026-08-07 user feedback (post-ship, from live printed sheets)

Two reports after the first live rich auto-prints:

1. **"Blank background, just black on white without the colored background."** The sheet was printing the outbound-email envelope's amber/cream palette verbatim (cream canvas body, amber-tinted table headers, gold headings/links, gold-glow blockquote/code fill — `lib/calendar/briefing-html.ts`'s `COLORS`/`TABLE_COLORS`). Fixed in `lib/earnings/print-sheet.ts`'s `PRINT_CSS`: a `@media print` block forces every inline background the envelope emits (body, both wrapper tables, table cells, headings, blockquote, code, links) to white and all text to black, with `!important` on every declaration (inline styles otherwise win — `briefingToHtml` is inline-styles-only by design, no id/class to hook, and it is NOT modified — it's shared by every outbound email). Table header cells keep a light-gray tint (`#eeeeee`) rather than going pure white, so the header row still reads as a header once the amber tint is gone. Table BORDERS are untouched — the ruled grid is what makes the sheet fillable by hand.
2. **"It did not quite make it to one double-sided page. A second page printed with just 'from preview email sent at...'."** Two defects, both fixed: (a) the footer block (`briefingToHtml`'s "Portfolio Desk · Generated ..." + the `footerNote` line) was landing on its own orphan page — its inline 64px top spacer plus the ancestor table's `break-inside: avoid` left no room for it at the bottom of the prior page, so the browser pushed the whole block to a fresh page. Fixed by targeting the footer's unique inline-style substrings (`td[style*="padding:64px 0 0"]`, `div[style*="border-top:1px solid"]`) with a shrunk top spacer and a `break-before: avoid` + `break-inside: avoid` ban so it can't start a page alone. (b) The one-sheet ladder only had one fallback rung (drop Past prints); extended to a third rung — a `{ compact: true }` re-render (smaller font, tighter spacing, `lib/earnings/print-sheet.ts`'s `COMPACT_CSS`) — so overflow that survives dropping Past prints gets one more, notes-preserving shot at fitting before the "print anyway" floor. See the updated One-sheet enforcement paragraph and error-handling table above.

## Why reopening HTML→PDF is safe now

The 2026-08-05 spec rejected HTML→PDF as "fragile on a launchd path, untestable, can't widen fill-in columns." Two of three concerns are answered: fragility degrades to the proven monospace road instead of to silence (the never-silent guarantee holds), and the compose step is pure + unit-testable with only the spawn wrapper mocked (same treatment `printViaLp` already gets). The third (fill-in column width) is overridden by the user's explicit fidelity decision — the email's own em-dash cells are the fill-in space, exactly as in the original 60%-zoom habit.
