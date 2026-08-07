# Earnings preview prose — formatting artifact catalog (2026-08-06)

Source: the 6 most recent successful earnings-preview sends as of 2026-08-06
19:26 ET — `Sample A`, `Sample B`, `Sample C`, `Sample D`, `Sample E`, `Sample F` (`earnings_emails.ai_output_md`,
`phase='preview'`, `error IS NULL`). Read via a **read-only** `sqlite3
-readonly` query against the live `data/vanguard.db`; no writes.

Driving complaint (user, verbatim intent): the prose after the `## Line-by-line
bogies` table "is formatted poorly and doesn't flow nicely." This catalog is
the evidence base Task 5 uses to add prompt rules.

> **Redaction note (public repo):** the 6 symbols below were real held/watchlist
> tickers at write time. Per this repo's "never push real financial data to a
> public asset" rule, every symbol (and the one full company-name mention it
> came with) has been replaced with a stable pseudonym (`Sample A`..`Sample F`,
> consistent across the whole doc) and the one position-revealing quote has
> been paraphrased. The artifact taxonomy below is otherwise unchanged.

Preview prompt sections requested (`lib/digest/send-earnings-email.ts:1486-1509`):
`## Line-by-line bogies` (table) → `## The setup` → `## Bull case / bear
case` → `## What to watch on the call` → `## Position implications` → `##
Sources`.

> **Revision note (post-review, same day):** the first pass of this task
> added a general bare-continuation-line merge rule directly to the shared
> `lib/calendar/briefing-html.ts::convertMarkdown` renderer. Code review
> caught that this renderer is shared by all four email composers
> (briefing, digest, earnings preview/recap) and several of them
> deliberately rely on the pre-existing "every non-blank line is its own
> paragraph" behavior for correct visual structure (the Sunday briefing's
> `**Holdings exposed:** SYM, SYM` trailing cluster line and per-name
> `**Label**\nbody` blocks used by `lib/digest/call-transcripts.ts` /
> `lib/earnings/debrief.ts`). The general renderer merge was **reverted**.
> The citation-fragmentation fix now has two, correctly-scoped layers
> instead: (1) `joinClaudeTextBlocks` at the send/compose root cause
> (unchanged, confirmed correct against all 117 mid-prose block boundaries
> in the 6 live rows), and (2) a new pure, earnings-scoped
> `repairCitationLineBreaks` applied ONLY where stored earnings
> `ai_output_md` is read for display/print. See the revised "Fix" section
> under Finding 1 below.

## Finding 1 (dominant artifact) — citation text-block fragmentation

**Present in all 6/6 samples, in every prose section** (see the per-section
breakdown after "What it looked like" below). Classification: **assembly
bug — fixed in this task** (not `prompt`, not strictly a markdown-`renderer`
bug either — see below).

### What it looked like

Raw stored markdown had single bare `\n` characters splitting ONE sentence
across 3-6 physical lines, with **no blank line** separating them — e.g. the
live Sample A `## The setup` section (verbatim, `cat -e` byte dump):

```
Flag this first: multiple sources, including $
[Company]'s own release stating it will release its [quarter] financial results$
, with $
a conference call scheduled for [time] ET the same day$
. That press release is dated [date] — [timespan] ago — and is corroborated
```

Every one of those bare-newline lines then rendered through
`lib/calendar/briefing-html.ts::convertMarkdown` as its **own**
`<p style="margin:22px 0; ...">` block — a wall of disjoint one-line
paragraphs, several of which open or close mid-sentence with dangling
punctuation (a paragraph consisting of just `, with`). This is exactly the
"doesn't flow" complaint.

The same fragmentation also broke numbered/bulleted lists mid-item. Live
Sample C `## What to watch on the call`:

```
4. **[Program name]** — $
investors await updates on [company]'s work on the [key initiative]$
, a milestone that's gone quiet since the initial announcement.$
5. **[Government agency funding]** — status of conversion from letter of intent to funded commitment.$
```

Pre-fix, item 4's continuation lines (`investors await…`, `, a milestone…`)
did not match the list-item regex, so the renderer's line-based parser
**closed the `<ul>`** right after item 4, emitted the two fragments as orphan
`<p>` paragraphs *outside* the list, then reopened a **second** `<ul>` for
items 5-6 — one logical list rendered as two visually disconnected lists with
stray paragraph text wedged between them.

### Per-section incidence (spec-gap fill — every requested section assessed, 6/6)

| Section | Symbols affected | Notes |
|---|---|---|
| `## The setup` | 6/6 | Every sample. Example above. |
| `## Bull case / bear case` | 6/6, and the **most heavily** fragmented section overall | This section leans hardest on cited sell-side/analyst material (price targets, guidance quotes, ratings changes), so nearly every supporting clause is its own citation and thus its own bare-newline fragment. Per-sample citation-span count: Sample A 5, Sample B 5, Sample C 4, Sample D 6 (heaviest — the China-export-control bear case alone strings together 4 separate cited clauses), Sample E 3, Sample F 1 (lightest — Sample F's bear case leans on the model's own guided-range analysis rather than quoting sell-side notes). |
| `## What to watch on the call` | 1/6 (Sample C, list-item case above) | Numbered-list items are short and often don't need an inline citation; Sample C's item 4 is the only observed list-splitting instance in this batch. |
| `## Position implications` | 1/6 (Sample A only, one fragment: `"...[position-specific sentence redacted — original quoted the live stock price against the option strike, split mid-citation by a bare newline]..."`) | **Structurally the most resistant section.** Sample B, Sample C, Sample D, Sample E, and Sample F all render this section as a single, clean, un-fragmented paragraph. The section asks the model to reason about the USER's OWN position (strike, expiry, hedge structure) rather than report external facts, so there's little for web_search to cite — Sample A is the outlier only because it re-cites the live stock price mid-sentence while comparing it to the option strike. |
| `## Sources` | 0/6 | Synthesized fresh by the model at the end, not built from cited spans — see "Categories checked with negative results" below. |

Both `## Bull case / bear case` and `## Position implications` are covered
by the same fix as every other section (no separate classification needed)
— this table exists to close the spec gap flagged in review (these two
sections were not explicitly assessed in the first pass).

### Root cause

`lib/digest/send-earnings-email.ts::callClaude` calls Claude with the native
`web_search_20250305` server tool. When the model cites a source, Anthropic
splits the response's prose across multiple adjacent `TextBlock`s around the
cited span — reconstructing the full text is documented as "concatenate all
text blocks in order" (no separator: whatever whitespace the model intended
already lives *inside* each block's own `.text`, e.g. a trailing space right
before the citation). The pre-fix code did:

```ts
const text = textBlocks.map((b) => b.text).join("\n").trim();
```

`.join("\n")` manufactured a literal, unintended newline at **every**
citation boundary — with no blank line around it, since neither adjacent
block's own text contained one. This is not something a prompt instruction
can fix (it's an artifact of how the web_search tool's response is shaped,
not a model behavior choice), and it is not, strictly, "invalid markdown
rendered wrong" either — the *stored* markdown itself was malformed relative
to what the model actually produced. It is a code bug in our own
text-assembly step. **Empirically confirmed** (code review pass): checked
all 117 mid-prose TextBlock boundaries across the 6 live rows (after
filtering out `server_tool_use`/non-text blocks) — `join("")` reconstructs
the model's intended text exactly; `join("\n")` is wrong at every one.

### Fix (this task, TDD) — two correctly-scoped layers

1. **Root cause, send/compose time** — `lib/digest/send-earnings-email.ts`:
   extracted the assembly into an exported, unit-tested pure function
   `joinClaudeTextBlocks(blocks)` that joins with `""` (empty string, i.e.
   direct concatenation) instead of `"\n"`, then `.trim()`s. `callClaude` now
   calls it. Test: `tests/digest/earnings-claude-text-assembly.test.ts`
   (5 cases, including the exact Sample A fragment reproduced verbatim above).
   Benefits **both** `preview` and `recap` phases (same function, single
   `phase` parameter) and prevents new instances of this artifact going
   forward. **Unchanged since the first pass — confirmed correct by
   review.**

2. **Display/print time, earnings-scoped only** — a NEW pure module
   `lib/earnings/repair-citation-linebreaks.ts::repairCitationLineBreaks(md)`
   repairs ALREADY-STORED `ai_output_md` rows (written before the fix
   above landed) when they're read for display or print. It implements the
   same bare-continuation-line merge logic the first pass had put directly
   in the shared renderer, but as a markdown-to-markdown transform applied
   ONLY at the two genuine earnings-display read sites:
   - `app/api/earnings/email-content/route.ts` (the `<EarningsEmailViewer>`
     modal's HTML source)
   - `lib/earnings/worksheet.ts::loadRichWorksheetInputs` (feeds
     `worksheet-rich.ts::extractPreviewSections`, the printed desk sheet)

   Grepped every `.ai_output_md` property-access site in the repo
   (`lib`/`app`/`scripts`/`workers`) to confirm these are the only two
   display-read call sites (`getEmailAudit` has exactly two callers) — no
   compose-time consumer reads a prior email's stored prose back in, so the
   repair never runs at send time. `repairCitationLineBreaks` is a
   zero-import pure function (`continuationJoiner`, `isNewBlockLine`,
   `isMergeTarget` helpers), never merges into/across a header, table row,
   blockquote, hr, or bold-label-only line (`**Label**` / `**Label**:` on
   its own line — defensive parity with `lib/ai/strip-preamble.ts`'s
   `BOLD_LABEL_LINE_RE`, even though earnings prose doesn't currently
   produce that shape), and IS a valid merge target for list items (so the
   Sample C-style list-splitting case is repaired too). Idempotent on
   already-clean markdown (verified by test). Test:
   `tests/earnings/repair-citation-linebreaks.test.ts` (7 cases, including
   the exact Sample A fragment TDD'd first).

   **The shared `briefing-html.ts` renderer itself is unchanged from its
   pre-Task-1 state** (diffed byte-identical against the prior commit) —
   the general merge rule and the list-continuation rule were reverted.
   Regression pins for the RESTORED original behavior, plus two CRITICAL
   pins for the exact shapes review flagged (a bold-label line immediately
   followed by body text stays two `<p>` elements; the §6
   `**Holdings exposed:**` trailing cluster line stays a distinct line),
   live in `tests/calendar/briefing-html-continuation-lines.test.ts` (6
   cases). No Worker mirror needed (`workers/cron/src/html.ts` untouched;
   parity with the Mac renderer is preserved because the Mac renderer
   itself didn't change).

### Verified against real data

Re-processing the live, already-stored Sample A `ai_output_md` through
`repairCitationLineBreaks` (then `briefingToHtml`, matching the
`/api/earnings/email-content` route's actual pipeline) collapses the
`## The setup` section from ~6 disjoint one-line paragraphs down to the
model's actual **2** intended paragraphs, reading as continuous flowing
prose with correct punctuation spacing — while `briefingToHtml` in
isolation (no repair applied, matching how the Sunday briefing renders)
still produces the original one-`<p>`-per-line output, confirming the
shared renderer is unaffected. Full suite (`npx vitest run`) and
`npx tsc --noEmit` both clean after the change.

### Related, out of scope for this task

The same `client.messages.create(... tools: [web_search...])` → `content.filter(text)`
→ `.map(b => b.text).join("\n")` shape (with the same theoretical exposure to
this bug) also exists in `lib/securities/verify-sector-tags.ts` and
`lib/calendar/verify-earnings-dates.ts`, both of which use `web_search` and
then feed the joined string into JSON parsing. A stray mid-JSON-string
newline there would already be getting silently repaired by the "collapse C0
controls to spaces" JSON-parse retry documented in the repo's LLM-JSON
conventions — which is itself a workaround for what may be this exact
upstream issue. Not touched here (out of scope for an earnings-preview-prose
task); flagged for a future pass if worth generalizing
`joinClaudeTextBlocks` into a shared helper.

## Finding 2 — inconsistent `## What to watch on the call` formatting

**Classification: `prompt`.** The prompt (line 1501) does not specify a
structural format for this section, so the model picks inconsistently across
names:

| Symbol | Format used |
|---|---|
| Sample A | numbered markdown list (1-5) |
| Sample B | numbered markdown list (1-6) |
| Sample C | numbered markdown list (1-6) |
| Sample E | numbered markdown list (1-7) |
| Sample D | **inline prose** — "Four things matter more than the headline EPS/revenue line: (1) whether the **heavy rare-earth separation circuit**… (2) any update… (3) **capex pacing**… and (4) direct management commentary…" — one run-on sentence, not a list at all |
| Sample F | **dash-bulleted** list (`- **Q3 2026 guide** — …`), not numbered |

None of these is "wrong" in isolation, but the print-and-fill-by-hand design
intent (same rationale as the bogies table itself, and as the light
scoreboard-table palette locked 2026-04-28) benefits from one consistent
scannable shape across every preview email.

**Proposed rule for Task 5** (verbatim, to append to the preview prompt's
`## What to watch on the call` instruction, item 4 at line 1501):

> Format this section as a numbered markdown list (`1. **Label** — detail`),
> one line per watch item — never inline parenthetical numbering
> ("(1)...(2)...") inside a run-on paragraph, and never a dash-bulleted list.
> Match the list style already used in the "Line-by-line bogies" table's
> row density: aim for 4-7 items.

## Finding 3 — `## The setup` sometimes opens on a bare citation, no framing sentence

**Classification: `prompt` (weak signal, 2/6 samples).** Sample E and Sample F both
open `## The setup` directly with a quoted statistic — no lead-in sentence
naming the setup in the model's own words first:

- Sample E: `According to [N] analysts, the average rating for the stock is
  "[Rating]," with a 12-month price target of $[X.XX], against a stock
  that has fallen [%] over the past month…`
- Sample F: `[Company]'s Q1 2026 revenue surged [%] to $[X.XCCB] with $[X.XX] adjusted
  EPS, boosted by $[X]M from [specific event], and the stock has been on
  a tear ever since…`

The other four (Sample A, Sample B, Sample C, Sample D) each open with the model's own framing
sentence first ("Sample B trades at…", "Sample C goes into the print having ripped
higher…", "Sample D has been one of the most violent single-name round-trips…")
and cite supporting figures after. The citation-first openings read
adequately but arrive "in medias res" — a minor stylistic wobble, not a
structural break.

**Proposed rule for Task 5** (optional, low-priority — append to the `##
The setup` instruction at line 1497):

> Open with one sentence in your own words framing where the name sits
> going into the print, before citing any supporting figure or source.

## Finding 4 — doubled blank line at section start (same root cause as Finding 1, no separate fix needed)

Sample E and Sample F both had **two** consecutive blank lines between `## The
setup` and the first prose line (`cat -e` confirms two bare `$` lines, not
one). Same joining mechanism as Finding 1 — a header-ending block's own
trailing newline plus the (pre-fix) inserted `"\n"` separator double up at a
section boundary. **No separate fix required**: `convertMarkdown` already
collapses any number of consecutive blank markdown lines to zero extra HTML
(each blank line independently hits `continue`; paragraph spacing is a fixed
`margin:22px 0` regardless of source blank-line count), so this never had a
visible rendering effect — and the Finding 1 join fix removes the extra
blank line at the source anyway (the display-time repair also passes blank
lines through untouched). Logged here only because it was observed
alongside Finding 1 and shares the same cause.

## Categories checked with negative results (no artifact found, 6/6 samples)

- **Orphan bold fragments** — every sample's raw markdown has an even count
  of `**` (paired). No unclosed bold spans.
- **Broken emphasis/links** — every `[label](url)` in every `## Sources`
  section is well-formed on a single line; no link was split across a
  citation-fragment newline (the Sources footer is synthesized fresh by the
  model at the end, not itself built from cited spans).
- **Stray table fragments** — the `## Line-by-line bogies` table body is
  clean in all 6 samples (checked: no row lacking a terminating `|`
  mid-table). The renderer's existing multi-line-row absorption
  (`consumeTableBody`, from the prior "multiline-table-row-spills-raw-markdown-pipes"
  fix) was never actually exercised by this batch.
- **Filler openers / meta-narration** — none observed; the `SYSTEM_PROMPT`'s
  "first character must be `#`, no preamble" rule + `stripModelPreamble`
  failsafe are holding. Every sample's very first line is `## Line-by-line
  bogies`.
- **Section restarts** (a later section duplicating an earlier one) — not
  observed in this batch.

## Summary for Task 5 (prompt rules to append)

1. Finding 2's numbered-list rule for `## What to watch on the call`
   (medium priority — 2/6 samples deviate from the numbered-list norm).
2. Finding 3's framing-sentence rule for `## The setup` (low priority —
   2/6 samples, cosmetic).

Finding 1 required no prompt rule — it was a code bug, now fixed at the
source (`joinClaudeTextBlocks`, send/compose time) with a display-time
repair scoped to the earnings read boundary (`repairCitationLineBreaks`)
for already-stored rows. The shared `briefing-html.ts` renderer used by
the other three composers is untouched.
