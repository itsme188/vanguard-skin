# Armed-print filing summary — design

Status: APPROVED by the owner 2026-10-22 ("go ahead straight through
implementation after getting a review from codex"); Codex round 2 folded in
below (§ Codex round 2).

## Why

On the Meta print (2026-10-21) the news that mattered was not in the press
release. The new non-voting Class C stock and the Founder Alignment Agreement
sat in the 8-K cover (Item 1.01) and EX-10.1, and the owner's "money quote" sat
in a preliminary information statement (PRE 14C) filed seven minutes after the
8-K. Print-watch reads only EX-99 press releases, so none of it reached the
desk. A fast reader of the headline numbers misses this class of news.

The feature: on every **armed** print, read the company's earnings 8-K in full
when it arrives, plus the substantive filings that follow it that evening, and
put a bullet summary of what stands out in front of the owner — every statement
footnoted to the page and paragraph it came from, so the owner can check it.

A six-run model test on the Meta filing (Sonnet 5.5 low / medium / high,
Opus 5.5 medium / high, Fable 5.1 high; results in the session's published
comparison page) settled the defaults below. One run (Sonnet low) called a
revenue beat a miss; three runs compared a nine-month figure with a full-year
one. The footnote check and the prompt rules below exist because of those.

## Goals

1. Every armed earnings print gets a filing summary without the owner doing
   anything beyond arming.
2. The summary reads the earnings 8-K **cover and every exhibit**, not only
   EX-99.
3. Companion filings accepted after the 8-K and before **20:00 Eastern that
   day** are read too and each adds its own section.
4. Every statement carries a footnote: document, page, paragraph, the exact
   sentence, and a link to that sentence on sec.gov. A bogey comparison also
   footnotes the newsletter and date it came from.
5. The model is chosen per print, at arming, from a short list of model
   **families**, each resolving to the newest model in that family.
6. A summary can be re-run with another choice; earlier versions are kept.
7. On demand, a standalone shareable HTML page can be made from a summary.
8. Every figure-bearing claim is checked by the app: the number is in its
   quote, periods and bases match, comparisons and computed figures are
   recomputed. A contradiction is shown, never hidden.

## Non-goals

- Prints that are not armed. 8-Ks that are not the earnings 8-K (other than as
  same-evening companions of an armed print's 8-K).
- The cloud Worker. This is Mac-only; no Worker mirror, no snapshot field.
- Reading the DJ wire or IR page text. The summary reads SEC filings only; the
  existing first-pass read and bogey sheet keep covering the release numbers.
- The Settings redesign (separate project, logged in TODO).
- Changing print-watch's accept / promote flow or its document gate.

## Anti-goals (would be a failure even if it "works")

- A quote shown as sourced when it is not in the filing. Unfound quotes are
  marked **not verified**, never silently kept or silently dropped.
- A figure the model computed itself presented as the company's (growth rates,
  sums, midpoints) unless the inputs are shown and footnoted. Enforced by the
  figure check, not only by the prompt.
- Comparing figures for different periods (nine months vs full year) without
  the app flagging it.
- A claim the arithmetic contradicts shown without the contradiction.
- The model silently changing: the owner must always see which concrete model
  wrote a summary, and a family that resolves to a new version shows that.
- The summary job slowing or blocking the print panel, the accept / promote
  flow, or the first-pass read.
- Portfolio data (positions, quantities, cost, account names) in the shareable
  page or in the prompt.

## Owner decisions (as stated, 2026-10-21)

- Runs on every armed print; earnings 8-K only (plus its same-evening
  companions, below).
- Companion filings: read through **20:00 Eastern** on the print day.
- Default model: **Opus, high effort**.
- Picker choices, framed as families that follow new releases (when a newer
  Fable ships, "Fable" moves to it with no code change):
  - Sonnet · medium
  - Opus · medium
  - Opus · high (default)
  - Fable · medium
  - Fable · high
- The choice is made **from the Earnings Hub when arming**, per print.
- Footnotes on every statement: page and paragraph, so the owner can check.
- Display stays inside the app. A **button** makes a shareable HTML page on
  demand (one or two recipients, occasionally); it is never made by default.
- Agreed playback: change the choice until the print goes live; the armed row
  shows the choice; a push when the summary is ready and when a companion
  filing adds a section; re-run keeps earlier versions; failures say so in
  plain words with a retry; never show a half summary as complete.

## How it works

### 1. Arming and the model choice

- The armed row in the Earnings Hub shows the current choice
  ("Filing summary: Opus · high") and lets the owner change it until the
  summary job starts. No caret-dropdown affordance (project rule): a native
  select or a pill row.
- Arming stores the default choice; changing it updates the stored choice for
  that print only. Storage: a new nullable column on
  `earnings_worksheet_flags` or a small side table keyed by `event_id` —
  builder's call, **migration shown to the owner before it is applied**
  (project rule). NULL means the default.
- **The choice locks when the summary job starts** (the earnings filing is
  found), my call; that is the moment the print "goes live" for this feature.
  After that, a different model means a re-run.
- The default lives in one place in code (Opus · high). A settings key for the
  default may come with the Settings redesign; not in this project (my call).
- A choice is stored as `{family, effort}`, never a model id.

### 2. Resolving a family to a model

- New pure resolver beside `resolveTier` (`lib/ai/model-tiers.ts`): newest
  available model in one family from the live catalog
  (`getCachedModelCatalog`), using the existing `parseModelId` /
  `compareVersions`. A new version in a known family is picked up
  automatically; a brand-new family name still needs a code edit (existing
  deliberate rule).
- If the chosen family has no callable model, fall back down the frontier
  ladder (fable → opus → sonnet), never up to a more expensive family; if
  nothing below is callable, the run fails visibly with Retry (my call). The
  panel says which model ran instead and why. The shared call path's hidden
  retry-once failover must not switch a pinned model silently: either skip it
  for this call or record the switch so it reaches the panel (my call).
- The picker shows what each family resolves to now ("Fable · now 5.1").
- The resolved model id and effort are stored with every summary version.

### 3. The AI call needs two new seams

Today `generateTextForFeature` / `generateObjectForFeature` take only a feature
key and never pass effort. This feature needs:

- an explicit per-call model (the resolved id), still routed through
  `lib/ai` so the "never inline a model id" rule holds — the id comes from the
  resolver, never a literal;
- an effort level (`output_config.effort`). The builder confirms whether the
  installed `@ai-sdk/anthropic` passes it through `providerOptions`; if not,
  this one call may use `@anthropic-ai/sdk` directly (already a dependency)
  behind a `lib/ai` function. Builder's call; the seam must keep the existing
  feature-key logging and error classification.
- a new feature key (e.g. `printFilingSummary`) for logging, overrides and the
  test-mock pattern.
- Explicit `maxOutputTokens` (project rule), sized for adaptive thinking at
  high effort on a long input (the Meta runs used up to 9k output tokens).
- Native structured output describes shape only; counts (Top 3, bullet caps)
  are enforced in code (project rule).

### 4. Finding the filings

Print-watch's EDGAR road stops at the window end (release + 45 min) and only
looks at 8-K / 6-K EX-99 exhibits. This feature adds its **own** poll per
armed print, separate from the watcher's road so the gate and the accept flow
are untouched:

- Starts when the print's window opens; ends at **20:00 Eastern on the print
  day** (also for a before-open print).
- Polls the company's SEC submissions list (by CIK, which print-watch already
  resolves) about once a minute; SEC fair-access limits and a declared
  User-Agent apply.
- Decides acceptance time from the filing header's `<ACCEPTANCE-DATETIME>`
  (Eastern), never the submissions JSON alone (known EDGAR quirk).
- **The earnings 8-K:** the first 8-K accepted that day carrying Item 2.02.
  If none by 20:00, the panel says "no earnings 8-K filed by 8 pm" and nothing
  runs.
- **Foreign filers (6-K), my call:** print-watch already treats a 6-K as a
  qualifying form (some armed names, e.g. Spotify, file 6-Ks). For a company
  that files 6-Ks, the earnings filing is the first 6-K accepted that day with
  an EX-99 exhibit; companions are later 6-Ks and F-3 / 424B* filings. The
  panel wording names the form ("no earnings 6-K filed by 8 pm").
- **Companion filings:** any other filing by the same company accepted after
  the earnings 8-K and before 20:00, on an allow list. Initial list (my call,
  builder may extend with reason): PRE/DEF 14A, PRE/DEF 14C, 8-K and 8-K/A,
  10-Q, 10-K, S-3, S-3ASR, S-8, 424B*, SC TO-I. Always ignored: Forms 3, 4, 5,
  144 and other insider or holder filings.
- Fetches **every document** in each filing (main document and all exhibits),
  skipping XBRL / graphic / zip parts. Raw HTML is kept on disk like
  print-watch documents, so footnotes can be located later.

### 5. The summary

Input: the filing's documents (each named by its EDGAR type, e.g. `8-K`,
`EX-99.1`, `EX-10.1`, `PRE 14C`) plus the event's **pre-print** bogeys
(same pre-release floor as the armed deep read; a newsletter received after
the release is not a bogey).

Prompt rules carried from the test prompt, plus fixes for what the test
showed:

- Read the whole filing; "stands out" = differs from the bogeys, guidance
  changes, one-offs that distort headlines, capital structure / governance,
  anything outside Item 2.02, new or changed disclosure language.
- Top 3, then everything else; 12 bullets maximum; say plainly when something
  is routine.
- Only figures from the filing or the supplied bogeys; no computed figures
  unless inputs are shown; name the bogey source; **never compare different
  periods without saying so**; call a beat a beat (compare the numbers, not
  the wording).

Output: structured, not prose. Each bullet holds one or more **claims**; each
claim carries citations, each citation `{document, exact quote}`, and
optionally bogey references `{bogey row id}`. Quotes must be short exact
sentences or phrases from the document (table rows are allowed and marked as
table rows).

### 6. Footnotes — the app locates, the model only quotes

- For each quote the app searches the stored document text (whitespace,
  quote-mark and dash normalised). Found: footnote = document, **page**,
  **paragraph**, the sentence, and a link. Not found: the statement shows
  **quote not found** with the quote as the model gave it.
- Wording is exact: a found quote means **the sentence is in the filing**, not
  that the model's claim about it is right. The panel never says "verified"
  for a claim (Codex finding 1).
- **Page** = count of printed page breaks before the match (EDGAR HTML marks
  them with `page-break-before/after` styles or `<hr>`; the Meta documents
  have 5, 9 and 14). A document with no page breaks is one page, and the
  footnote says "paragraph N" only.
- **Paragraph** = index of the block element (p, div, table row) within the
  page, counting only blocks with text. Builder may refine the counting rule
  if the result is checked against a real filing by eye.
- **Link** = the document's sec.gov archive URL plus a text fragment
  (`#:~:text=`) for the sentence, which Safari and Chrome scroll to and
  highlight. If the fragment fails the link still opens the document.
- Bogey footnotes name the newsletter (`source_label`) and its date.
- Bogey figures, source label and date are **copied into the summary version
  when it is written** (my call), so an old version and its shareable page do
  not change when a bogey row is later edited or deleted.

### 7. Companion filings add sections

Each companion filing runs one more call that reads the new filing plus the
current summary, and adds a section headed with the form and time
("PRE 14C · 4:10 pm"), with its own Top items and footnotes. It does not
rewrite the earlier sections. Same model choice as the print.

### 8. Versions and re-runs

- A summary has versions. A re-run ("Re-run with…" picker) creates a new
  version over the same filings with the chosen family and effort; earlier
  versions stay and can be switched between. The newest is shown by default.
- A re-run redoes the whole chain: the earnings filing first, then each
  companion in acceptance order, each reading the summary so far (my call).
  A companion that arrives later is added to the newest version only; older
  versions stay as they were and say so.
- Automatic runs never retry forever: at most two attempts per filing
  (my call, matching the recap modal rule); a refusal or a truncation at the
  output cap is not retried, and the panel says which.

### 9. Where it shows

- **Print panel** (`LivePrintRow.tsx`, after the first-pass read): status line
  while running ("Reading 8-K + 3 exhibits · Opus 5.5 high"), then the Top 3
  with footnote markers, the model that wrote it, and **Open full summary**.
  Also in the read-only finished-print view (`PrintRecordView`).
- **Full summary page:** a new in-app route (e.g.
  `/dashboard/print/[printId]/filings`), behind the existing login; it must be
  classified in `proxy.ts` as a human route (trust boundary rule). Footnotes
  beside or under the text, version switcher, the re-run picker, the
  companion sections, and the **Make shareable page** button. Works at phone
  width.
- **Push:** one Pushover message when the first summary is ready, one per
  companion section. These are new pushes for armed prints, approved by the
  owner 2026-10-21; they do not change the three existing earnings push gates.

### 10. The shareable page

- Built only when the owner clicks **Make shareable page**. The app renders a
  single self-contained HTML file (inline styles, no scripts needed, no app
  links that need login) from the stored summary version: the summary, the
  footnotes with sec.gov links, the bogey comparisons with their newsletter
  names, the model used and the filing times.
- Delivered as a download from the full summary page (works on the Mac and on
  the phone through remote access); the owner sends it however they like.
- No portfolio data. The prompt never receives portfolio data either.

### 11. Failures are visible

Every state has words on the panel: waiting for the 8-K, no earnings 8-K by
8 pm, reading, model call failed (with the reason class and a Retry button),
family unavailable (which model ran instead), quotes not verified (count).
A half-written or failed run is never shown as a summary.

## Cost and time

From the Meta test (one 8-K with two exhibits, ~43k input tokens):
Opus · high ≈ $0.32 and ~65 s; Fable · high ≈ $0.68; Sonnet · medium ≈ $0.11
and ~18 s. A companion filing adds one call (a long 10-Q could add $0.50+ at
Opus prices). Builder sets an input cap per call (e.g. 400k tokens) and states
on the panel anything left out because of it.

## Late arms (owner ruling 2026-10-21)

- **Armed on the print day after the earnings filing landed, before 20:00:**
  the job goes back, collects that day's filings so far, and runs at once;
  later companions still add sections until 20:00.
- **Armed after 20:00, or for a past print:** nothing runs on its own. The
  panel offers **Run summary**; money is spent only on that click.
- **Disarm and re-arm the same day:** an existing summary stays; nothing
  re-runs unless asked.

## What the summary hangs off

The calendar event (`event_id`), like arming does (my call). The print-watch
print row may not exist at arming, and a date correction re-homes the event
onto a new print; the choice, the filings found and the summaries follow the
event. The full-page route may be keyed by event id for the same reason.

## Hardening requirements (from the Codex review, 2026-10-21)

Codex returned REVISE with 18 findings. Adopted as requirements:

1. **Filing identity gate.** The earnings filing must pass an issuer and
   fiscal-period check like print-watch's document gate (reuse its period
   tokens), not "first Item 2.02 8-K of the day". Ambiguity is shown, never
   guessed. The existing gate is not weakened.
2. **Event moves.** Summary state registers with the existing calendar merge
   handlers (moves with a date correction or merge, inside the same
   transaction; collision rule: keep both versions, newest shown). A move that
   changes the date or issuer revalidates the filings.
3. **Idempotent paid runs.** Unique identity per (event, filing accession) and
   per run; input fingerprint; claim token with deadline and bounded takeover
   (same shape as prepare steps); compare-and-set finalisation so a stale
   worker never overwrites a newer result; SDK retries count inside the
   two-attempt budget.
4. **Run manifests.** Each run freezes its list of filings and its bogey
   snapshot before the call; sections are written in acceptance order, one at
   a time. While a re-run is in progress the panel keeps showing the last
   completed version.
5. **Bogey snapshot at job start,** with each figure's source label, article
   date and row kind (manual, upload, deep read, newsletter, vendor). A deep
   read row is labelled as the deep read, not as a newsletter.
6. **Coverage manifest.** Every document in a filing is listed as read,
   skipped (with reason: graphic, XBRL, over the input cap) or failed. A run
   that skipped or failed anything is labelled **incomplete** on the panel,
   in the push and in the shareable page.
7. **Privacy by allowlist.** The prompt and the shareable page are built from
   an explicit list of fields (filing text; bogey figure, source label, date).
   No free-text bogey notes unless they pass the same list; no portfolio
   fields. Test fixtures are synthetic; real filings used for replay stay in
   gitignored paths.
8. **Untrusted input.** Filing text and model output are data: every rendered
   field is escaped, the model output is validated against the schema at
   runtime, and sec.gov links are built only from stored accession and file
   name, never from model text.
9. **Routes.** Every action (change choice, run, retry, re-run, make page) is a
   human-session route with the existing CSRF check; paid actions are
   idempotent per request; downloads are GETs.
10. **Poll lifecycle states,** persisted, on the Eastern clock: waiting,
    found, past cutoff, **SEC unreachable** (never shown as "no filing"),
    cancelled by disarm. A filing accepted before 20:00 but discovered later
    (app asleep) is still read; the cutoff is on acceptance time.
11. **SEC traffic** goes through the existing host scheduler and lease, with
    size and time limits per fetch and lower priority than print-watch's
    release acquisition.
12. **One model per run.** The family resolves once at run start; that exact
    model and effort are recorded per section. The per-print choice wins over
    the global Settings override for this feature (my call).
13. **Footnote identity:** accession, file name, content hash and the
    extractor version are stored with each location; a quote that matches
    more than once is marked ambiguous; when page breaks are unreliable the
    footnote gives the paragraph only.
14. **Amendments.** An 8-K/A section marks the earlier claims it corrects
    ("corrected by 8-K/A, 5:40 pm") on the panel, the page and the export.
15. **Push identities** are stored, so a restart or retry never sends twice;
    a re-run sends no push (the owner asked for it); push wording says
    incomplete when it is.
16. **Migration** is additive, with explicit unique and foreign-key rules,
    rehearsed on a copy of the live database; no automatic paid backfill of
    past prints.
17. **Tests** cover: wrong-period filing, the figure-check acceptance cases
    below, duplicate discovery, event move,
    concurrent re-run and companion, restart across 20:00, privacy canary on
    prompt and export, route auth. Browser pass adds failure/retry, no-filing,
    an amendment, and a real download on Safari and the phone.

**Codex finding 1 adopted in full (owner ruling 2026-10-21):** figures are
checked by the app, below.

## Figure checking (owner ruling 2026-10-21)

A found quote proves a sentence is in the filing; it does not prove the claim
built on it. The Meta test produced three claim errors with genuine quotes:
Sonnet low called a $64.601B result "below" a $64.57B consensus; three runs
compared nine-month free cash flow with a full-year Street figure; Sonnet high
used a 29% nine-month growth rate it computed itself. The app checks every
figure-bearing claim so these are caught, not left to the owner's reading.

### What the model must return

Every claim that states or compares a number carries **typed figures**. Each
figure: value, unit (USD, %, per-share USD, shares, count, people), scale
(units, thousands, millions, billions), metric (free text, e.g. "revenue",
"free cash flow"), **period** (e.g. Q3 2026, nine months 2026, FY 2026, FY
2027 outlook), **basis** (reported / GAAP, excluding a named item,
constant currency, guidance range low / high), and **source**: a filing quote
(citation) or a bogey (snapshot row). A comparison claim names its two
operands and its stated relation (above, below, in line, raised, lowered,
narrowed, unchanged). A computed figure names its inputs and its operation
(difference, ratio, growth, sum).

### What the app checks

1. **The number is in its quote.** The figure's value, at its scale, appears
   in the cited text (allowing the filing's own formats: "64,601" in a table
   stated "in millions", "$64.60 billion", "26%"). The table's scale comes from
   the table or document heading ("in millions, except per share"); if the
   app cannot find it, the figure is **scale unconfirmed**.
2. **Period and basis match the source.** For a table figure, the column
   heading must name the period ("Three Months Ended September 30, 2026");
   for prose, the sentence or its paragraph must ("third quarter", "nine
   months", "full year 2026"). Not establishable: **period unconfirmed**.
   Bogey periods and bases come from the snapshot row.
3. **Comparisons are recomputed.** The app compares the two operands itself.
   Different periods or bases: **periods differ** (the claim is flagged, not
   hidden). Same period: the stated relation must match the arithmetic;
   "in line" is accepted only within ±0.5% of the comparator (my call), and
   the app shows the exact difference beside the claim either way.
4. **Computed figures are recomputed** from their cited inputs and must match
   within rounding of the stated precision. A figure with no source and no
   inputs is **not in the filing**.

### What the owner sees

Each claim carries one status, worst first:
- **Contradicted** (relation or computed figure is wrong): shown in the
  danger colour, with the app's own result ("filing: $64.601B is above
  $64.57B, +0.05%"). The model's text is never rewritten.
- **Periods differ** / **not in the filing** / **quote not found**: warning
  colour, with the reason.
- **Scale or period unconfirmed**: muted, with the reason.
- **Checked**: every figure found, period and basis confirmed, any comparison
  matches.
- **Qualitative**: no figures to check (governance, tone); footnotes still
  required.

The panel heading, the push and the shareable page state the counts
("12 claims · 9 checked · 1 contradicted · 2 unconfirmed"). A contradicted
claim in the Top 3 is called out at the top of the panel.

### Acceptance cases

Real outputs from the Meta test, kept as synthetic fixtures with the same
shape:

- "below the $64.57B Finnhub consensus" against $64.601B: **contradicted**.
- Nine-month FCF +$11,049M against a full-year Street −$7.3B: **periods
  differ**.
- "29% for the nine months" with no inputs: **not in the filing**; with
  inputs 181,712 and 141,073: recomputed 28.8%, **checked** only if stated as
  29% rounded and the inputs are cited.
- "$12.99B operating income" against table "12,988" in millions: **checked**.

### Cost

Typed figures add output tokens (estimate +30–50% per run, about $0.10 more
per Opus · high run); the checking itself is app code and costs nothing.
Builder measures on the Meta replay and reports the real figure.

## Codex round 2 (2026-10-22): rulings folded in

Codex reviewed the figure check and returned REVISE with 18 findings. All are
adopted; the owner approved going straight to build after this review, so the
rules below are my calls, marked as such. They tighten the check so that it
can only say **Checked** or **Contradicted** on established evidence.

**R1. No number reaches the screen except through a typed figure.** The model
writes each claim's text as a template with placeholders (`{f1}`, `{f2}`) and
returns the figures separately; the app renders the figure's value text into
the placeholder. Any other digit in the claim text, apart from a four-digit
year, an Item / exhibit number ("Item 1.01", "EX-10.1") or a share-class letter,
makes the claim **figure not bound**: warning colour, never Checked.

**R2. Metric identity.** Each sourced figure carries the row label (table) or
the phrase (prose) that names it, quoted. The app checks the number sits in
that row (or that sentence) and that the figure's metric shares a content word
with the label. Otherwise **metric unconfirmed** (muted). The panel's wording
for Checked is "number, period and label found in the cited line", never "true".

**R3. Tables are read as grids.** The text extractor keeps every table as rows
and cells with each column's header text (all header rows above it, merged
cells spread across the columns they cover). Scale comes from the nearest
statement inside or immediately above the table ("in millions, except per
share"), else the document's; "except per share" exempts per-share and
percentage figures. A value that maps to more than one column, or a column
without a period header, is **period unconfirmed**.

**R4. One number rule, with rounding.** Shared decimal normaliser: commas,
currency signs, parentheses = negative, "—" / "-" / "n/a" cells = missing
(never zero), "%" kept as unit. A stated figure matches its source when the
difference is at most half a unit in the stated figure's last digit
(`$12.99B` vs `12,988` million: 12.988 within 12.99 ± 0.005 → match). The
same rule applies to computed figures.

**R5. Periods are structured.** A period is `{kind: quarter | year_to_date |
fiscal_year | instant, endDate?, fiscalYear?, fiscalQuarter?, role: actual |
outlook}`. From a column header the app reads the duration ("Three Months
Ended", "Nine Months Ended", "Year Ended", "As of") and the end date. Two
periods are equal when kind, role and end date match, or, with no end date,
kind, role, fiscal year and quarter match. Anything less is unconfirmed, not
different.

**R6. Bogey periods and bases are what the row says, nothing more.** A
consensus or whisper field on a bogey row means "this print's reported
quarter, actual". The app identifies the reported quarter as the
quarter-duration column with the latest end date in the cited table. Extra
metric lines carry their own coarse kind (`Q`, `NQ_guide`, `FY_guide`) and
basis (`gaap`, `non_gaap`, `na`); `na` and the vendor EPS consensus have
**basis unknown**. A comparison that needs a basis it does not have is
**basis unconfirmed**, never Contradicted. Only rows from before the print's
pre-release floor are snapshotted (same floor as the deep read); the snapshot
is taken at run start and frozen in the run.

**R7. Relations, exactly.** `above` ⇔ stated − comparator > 0; `below` ⇔ < 0;
`in line` ⇔ |difference| ≤ 0.5% of |comparator| (inclusive). "Above" inside
the band is still true. A zero comparator makes "in line" unconfirmed (the
direction is still checked). Percentage operands use percentage points for the
shown difference and the same relative band. A range comparator (guidance
low–high): `in line` = inside the range inclusive, above / below = outside it;
`raised` / `lowered` compare midpoints, `narrowed` compares widths, and each
needs both ranges for the same period.

**R8. Computed figures.** Operations are typed with ordered inputs:
`difference(a, b)`, `sum(a, b, …)`, `ratio(a, b)` (shown as %), `growth(new,
old) = new / old − 1`. `difference` and `sum` need the same unit, scale-
normalised, and the same period; `growth` needs the same kind with `old`
ending one year (or one quarter, for quarter-on-quarter) before `new`; a
negative or zero `old` makes growth unconfirmed. The arithmetic is checked;
the financial meaning (that a difference is "free cash flow") is not, and the
figure is labelled **computed** in the footnote.

**R9. Status precedence.** Every check result and reason is stored. The single
shown status is derived: **Contradicted** only when every operand is
established (found, scale, period and, if needed, basis confirmed) and the
arithmetic disagrees; otherwise any unconfirmed result shows as unconfirmed
with its reasons. A quote that matches in more than one place is **ambiguous
quote** (warning).

**R10. Cost** is provisional. The replay records input, output and thinking
tokens per call, retries and the whole-chain cost including a long filing,
and the panel's per-run cost line uses measured usage.

**R11. Discovery is its own code, stricter than print-watch's.** A filing
counts only on the header's `<ACCEPTANCE-DATETIME>`; a filing whose header
lacks it is listed as **time unconfirmed** and is not run automatically. Each
filing and each document records its own fetch result; a failed fetch is in
the coverage list and makes the run incomplete. Document cap 16 MB each
(10-Qs are large); larger is skipped with the reason.

**R12. Lifecycle.** One 60-second tick (started with print-watch registration,
and on app start) walks every armed earnings event dated today (Eastern):
polls from 06:00 to 20:00 Eastern whatever the slot (a print with no known
time is covered), and on the first tick after 20:00 or after a wake does one
catch-up pass for filings accepted before 20:00. Event state is persisted;
disarm sets **cancelled** (a section already running finishes; nothing new
starts). Paid work is guarded by row claims, not by process memory.

**R13. Runs, companions and order.** A run's sections run one at a time per
event, in the order filings were discovered (acceptance time breaks ties).
A companion found later is appended to the newest run that is done or still
running; if the newest run failed, to the newest done run; with none done, it
waits in the failed run and runs on Retry. Older runs never gain sections and
say "does not include filings found after 4:10 pm". A re-run's filing list is
frozen at its start; companions found during it are appended to it.

**R14. Merges.** Filings are keyed (event, accession). On a date-correction
merge, donor runs move to the target with their numbers after the target's;
a donor filing whose accession the target already has is folded into the
target's row and its sections re-pointed; a live claim on a donor section is
cleared so the next tick retakes it under the target. Each section stores its
schema, prompt, extractor and checker versions.

**R15. Provenance labels are public-safe.** The prompt and the shareable page
name a bogey by kind and, for newsletter and deep read rows, by the
newsletter's name as stored; a manual row is "your manual entry", an upload
"uploaded PDF"; notes and free-text definitions are never sent. sec.gov links
and stored paths are built from validated accession and file-name patterns.
The privacy canary covers the prompt, the export, the push text and the logs.

**R16. Pushes are at most once.** States `pending → sending → sent`; a crash
while `sending` becomes **delivery unknown** and is never resent (a lost push
beats a double one, my call).

**R17. Pinned model loss and amendments.** A family resolves once, at run
start (down-ladder fallback allowed there, shown). If that model disappears
mid-run, the remaining sections fail with "model no longer available" and the
offer to re-run. An 8-K/A section may mark earlier claims it corrects, but the
mark shows only when its own correcting quote is found; otherwise the link is
"unresolved" and the earlier claim is untouched.

**R18. More tests.** Add: wrong metric with the right number, swapped
columns, omitted typed figures, a digit in the text outside a placeholder,
EPS under a "millions" heading, vendor EPS with unknown basis, zero and
negative comparators, rounding at the half-unit boundary, valid
year-on-year growth, restart while running, merge, a companion arriving
during a re-run. The browser pass checks every status and that the counts
agree across panel, full page, push text and export.

## Left to the builder

- Storage shape (tables for filings, documents, summary versions), shown to the
  owner as a migration before applying.
- The job runner: reuse the first-pass read scheduler pattern
  (`lib/print-watch/read-scheduler.ts`: debounce + durable reconcile tick) or
  a new loop; it must survive an app restart mid-evening.
- How the poll shares the watcher lease, CIK resolution and SEC fetch helpers.
- Exact paragraph-counting rule (checked against the Meta filing by eye).
- UI layout details within the project's UI rules (chips, contrast, phone
  width, no carets, app dialog for questions).

## Verification the owner will see

- Replay on the Meta filing set (8-K, EX-99.1, EX-10.1, PRE 14C) from saved
  copies: the summary appears, the 14C adds a section, every footnote's page
  and paragraph checked by eye against sec.gov for at least five quotes.
- Browser pass on a sandbox: arm, change the choice, panel states, full page,
  re-run, shareable page download, phone width, both themes.
