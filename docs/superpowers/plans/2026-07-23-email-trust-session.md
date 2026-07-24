# Email Trust Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop AI-instruction leaks from reaching outbound emails (3 verified classes from the 7/21–7/23 digests) and stop earnings previews/intel from firing after a company has already reported (the IMAX 7/23 case).

**Architecture:** All fixes are storage-boundary or send-boundary guards, following the repo's established pattern (`stripModelPreamble`, `sanitizeModelSummary`): validate AI output where it's stored, guard sends where they're triggered, repair poisoned rows with idempotent dry-run-default scripts. Mac + Worker mirrors change together where parity conventions apply.

**Tech Stack:** TypeScript, better-sqlite3, Vitest (in-memory DBs, `vi.mock` module mocking), Cloudflare Worker (`workers/cron/`), tsx scripts.

## Global Constraints

- Every DB function takes `db: Database.Database` (DI for `:memory:` tests).
- Repair scripts: dry-run by default, `--apply` gates writes, idempotent (copy `scripts/repair-xml-summaries.ts` shape).
- Worker mirror files change together with Mac counterparts; `SUMMARY_TAG_REMNANT` is byte-identical between `lib/gmail/process.ts` and `workers/cron/src/fallback-digest.ts`.
- Commit messages via temp file + `git commit -F <file>` (never inline `-m` with quotes/apostrophes).
- Run `npx vitest run <file>` per task; the full suite runs once in the final task.
- Work directly on `main` (bug-fix session precedent; baseline was clean).
- Never hardcode/guess financial data — the IMAX release time must be verified against the real press release before being added.

---

### Task 1: Desk-note store-time validation (leak a — the CSX "Please provide the transcript" refusal)

**Files:**
- Modify: `lib/transcripts/same-day.ts` (the `summarizeTranscript` function, ~lines 102–149)
- Test: `tests/transcripts/same-day.test.ts` (extend describe `fetchSameDayTranscripts — AI desk-note summary (#12 B2)`, lines ~432–503)

**Interfaces:**
- Consumes: `stripModelPreamble` (`lib/ai/strip-preamble.ts`), `generateTextForFeature`, `upsertTranscript` — all already wired in `summarizeTranscript`.
- Produces: `export function isValidDeskNote(text: string): boolean` and `export function looksLikeDeskNoteRefusal(text: string): boolean` (Task 2's repair script imports both), plus `export const MIN_TRANSCRIPT_CHARS_FOR_AI = 5000`.

**Background for the implementer:** `summarizeTranscript` calls the `transcriptSummary` AI feature and upserts `res.text` over the row's `summary` column. The prompt (`buildSummaryPrompt`, lines 82–95) mandates a desk note with bold section labels `**Guidance**`, `**Tone**`, `**Surprises**`, `**Key quotes**`. On 7/22 a thin 8-K cover page (3,774 chars, no exhibit body) produced a *soft refusal* — a bulleted request for input ending "**Please provide the transcript text or the press release/financial report content**, and I'll produce the structured desk note as specified." It passed `stripModelPreamble` (first line is a `- ` list marker) and `generateTextForFeature`'s refusal guard (finishReason was `stop`, not `content-filter`), overwrote the good extractive summary, and shipped in the 7/23 morning digest. The existing `catch` (lines 143–148) only protects against *thrown* errors.

- [ ] **Step 1: Write the failing tests**

Add to the `fetchSameDayTranscripts — AI desk-note summary (#12 B2)` describe block in `tests/transcripts/same-day.test.ts` (mirror the setup of the existing "strips a chatty AI preamble before storing the desk-note summary" test at ~line 458 — it shows how the AI call is mocked and how the row's summary is asserted):

```ts
it("rejects a soft-refusal AI output and keeps the extractive summary", async () => {
  // Exact shape of the 2026-07-22 CSX poison: bulleted request-for-input.
  const refusal = [
    "- Exhibit 99.1 (press release with results)",
    "- Exhibit 99.2 (Quarterly Financial Report)",
    "- And/or the earnings call transcript itself (Q&A and prepared remarks)",
    "",
    "**Please provide the transcript text or the press release/financial report content**, and I'll produce the structured desk note as specified.",
  ].join("\n");
  // ...mock generateTextForFeature to resolve { text: refusal } exactly like
  // the existing preamble test mocks it, seed a cached transcript row whose
  // summary is the extractive text "Extractive summary text", transcript
  // length >= 5000 chars, then run the same summarize path that test runs...
  // Assert: the row's summary column is STILL "Extractive summary text".
});

it("skips the AI call entirely for transcripts under MIN_TRANSCRIPT_CHARS_FOR_AI", async () => {
  // Seed transcript text of 3_774 chars (the CSX cover-page length).
  // Assert generateTextForFeature mock was NOT called and summary unchanged.
});

it("stores a valid structured desk note (has **Guidance** section) unchanged", async () => {
  const good = "**Guidance**\n- Raised FY guide\n\n**Tone**\n- Confident\n\n**Surprises**\n- None\n\n**Key quotes**\n- \"We can't predict rates.\"";
  // Assert the row's summary becomes `good` (regression: quote containing
  // "can't" must NOT trip the refusal detector).
});
```

Also add a small pure-function describe (same file):

```ts
describe("isValidDeskNote / looksLikeDeskNoteRefusal (pure)", () => {
  it("CSX refusal shape: not valid, is refusal", () => { /* refusal fixture from above */ });
  it("structured desk note: valid, not refusal", () => { /* good fixture */ });
  it("plain extractive prose (no bold labels): NOT valid, NOT refusal", () => {
    const extractive = "CSX reported second quarter results. Revenue was flat year over year and management discussed network performance.";
    expect(isValidDeskNote(extractive)).toBe(false);
    expect(looksLikeDeskNoteRefusal(extractive)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/transcripts/same-day.test.ts`
Expected: FAIL — `isValidDeskNote` not exported; refusal test fails because the refusal is stored.

- [ ] **Step 3: Implement in `lib/transcripts/same-day.ts`**

Add near the top (after existing constants `SUMMARY_PROMPT_CHAR_CAP` / `SUMMARY_MAX_OUTPUT_TOKENS`):

```ts
/**
 * A desk note the prompt actually asked for carries at least one of the
 * mandated bold section labels. A soft refusal (model asking for its inputs
 * — the 2026-07-22 CSX leak) carries none, and typically asks the operator
 * to "please provide" content. stripModelPreamble can't catch this: the
 * refusal opened with a `- ` list marker (valid markdown), and the refusal
 * finish-reason guard can't either (finishReason was "stop").
 */
const DESK_NOTE_SECTION_RE = /\*\*(Guidance|Tone|Surprises|Key quotes)\*\*/i;
const DESK_NOTE_REFUSAL_RE =
  /please provide|provide the transcript|i(?:'|’)ll produce the|as specified[.,]?\s*$/im;

export function looksLikeDeskNoteRefusal(text: string): boolean {
  return DESK_NOTE_REFUSAL_RE.test(text);
}

export function isValidDeskNote(text: string): boolean {
  if (!text) return false;
  if (!DESK_NOTE_SECTION_RE.test(text)) return false;
  if (looksLikeDeskNoteRefusal(text)) return false;
  return true;
}

/** Below this, an 8-K is a bare cover page (observed thin covers: 3,774 and
 * 4,091 chars) — there is nothing for the AI to summarize, so don't ask. */
export const MIN_TRANSCRIPT_CHARS_FOR_AI = 5000;
```

In `summarizeTranscript`, add the length gate at the top (before the AI call):

```ts
  if (!transcript.transcript || transcript.transcript.length < MIN_TRANSCRIPT_CHARS_FOR_AI) {
    console.log(
      `[transcripts] Skipping AI desk note for ${transcript.ticker} Q${transcript.quarter}: transcript too thin (${transcript.transcript?.length ?? 0} chars)`
    );
    return;
  }
```

And replace the post-strip check (currently `const summary = stripModelPreamble(res.text.trim()); if (!summary) return;`) with:

```ts
    const summary = stripModelPreamble(res.text.trim());
    if (!summary || !isValidDeskNote(summary)) {
      console.warn(
        `[transcripts] AI desk note for ${transcript.ticker} Q${transcript.quarter} rejected (not desk-note shaped) — extractive summary kept`
      );
      return;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/same-day.test.ts`
Expected: PASS (all existing tests in the file must stay green — if the existing "strips a chatty AI preamble" test's fixture lacks a `**Guidance**`-style label or is under 5,000 transcript chars, update THAT FIXTURE to a valid desk-note shape / long-enough transcript rather than weakening the validator).

- [ ] **Step 5: Commit**

```bash
cd /Users/Yitzi/code/vanguard-skin
git add lib/transcripts/same-day.ts tests/transcripts/same-day.test.ts
printf 'fix(transcripts): validate AI desk-note output before storing\n\nA thin 8-K fed to transcriptSummary produced a soft refusal ("Please\nprovide the transcript text...") that overwrote the extractive summary\nand shipped in the 7/23 morning digest. Store-time validator requires a\nmandated bold section label and rejects request-for-input phrasing;\ntranscripts under 5k chars skip the AI call entirely.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01TVtVNZfUDWhGKSVjSw2kxz\n' > /tmp/commit-msg.txt
git commit -F /tmp/commit-msg.txt
```

---

### Task 2: Desk-note refusal repair script + repair the live CSX row

**Files:**
- Create: `scripts/repair-desk-note-refusals.ts`
- No test file (repair scripts are exercised by their dry-run, per repo pattern — `scripts/repair-xml-summaries.ts`).

**Interfaces:**
- Consumes: `isValidDeskNote`, `looksLikeDeskNoteRefusal` (Task 1), `generateSummary` (exported at `lib/transcripts/fetch.ts:51` — extractive summarizer, `(text: string) => string`).

**Background:** live row `earnings_transcripts.id = 13` (CSX 2026 Q2, source `edgar_8k`) holds the 302-char refusal in `summary`. `scripts/upgrade-edgar-transcript.ts` only helps if Alpha Vantage has the transcript now — and even then it leaves the poisoned edgar row in place (out-ranked, not scrubbed). This script restores the extractive summary directly, for any refusal-shaped row.

- [ ] **Step 1: Write the script**

```ts
/**
 * Repair earnings_transcripts rows whose `summary` is an AI soft refusal
 * (request-for-input) instead of a desk note — the 2026-07-22 CSX leak
 * class. Recomputes the extractive summary from the stored transcript.
 *
 * Dry-run by default:  npx tsx scripts/repair-desk-note-refusals.ts
 * Apply:               npx tsx scripts/repair-desk-note-refusals.ts --apply
 *
 * Idempotent: a repaired row no longer matches looksLikeDeskNoteRefusal.
 */
import Database from "better-sqlite3";
import path from "path";
import { generateSummary } from "../lib/transcripts/fetch";
import { looksLikeDeskNoteRefusal } from "../lib/transcripts/same-day";

const apply = process.argv.includes("--apply");
const db = new Database(path.join(process.cwd(), "data", "vanguard.db"));

const rows = db
  .prepare(
    `SELECT id, ticker, year, quarter, transcript, summary
       FROM earnings_transcripts
      WHERE summary IS NOT NULL AND summary != ''`
  )
  .all() as {
  id: number;
  ticker: string;
  year: number;
  quarter: number;
  transcript: string | null;
  summary: string;
}[];

let matched = 0;
let repaired = 0;
const update = db.prepare(`UPDATE earnings_transcripts SET summary = ? WHERE id = ?`);

for (const row of rows) {
  if (!looksLikeDeskNoteRefusal(row.summary)) continue;
  matched += 1;
  const fixed = generateSummary(row.transcript ?? "");
  console.log(
    `row ${row.id} (${row.ticker} ${row.year} Q${row.quarter}): refusal ${row.summary.length} chars -> extractive ${fixed.length} chars`
  );
  if (apply) {
    update.run(fixed, row.id);
    repaired += 1;
  }
}

console.log(
  apply
    ? `Repaired ${repaired} of ${matched} refusal-shaped rows.`
    : `Would repair ${matched} refusal-shaped rows. Re-run with --apply.`
);
db.close();
```

- [ ] **Step 2: Dry-run and verify it matches exactly the CSX row**

Run: `npx tsx scripts/repair-desk-note-refusals.ts`
Expected output: exactly one matched row — `row 13 (CSX 2026 Q2)`. If other rows match, eyeball each printed line: every match must actually be a refusal (if a legit desk note matches, narrow `DESK_NOTE_REFUSAL_RE` in Task 1 before applying).

- [ ] **Step 3: Apply + verify**

```bash
npx tsx scripts/repair-desk-note-refusals.ts --apply
sqlite3 data/vanguard.db "SELECT id, substr(summary,1,120) FROM earnings_transcripts WHERE id=13;"
```
Expected: summary now begins with extractive press-release prose (starts from the 8-K text), NOT "- Exhibit 99.1".

- [ ] **Step 4: Commit**

```bash
git add scripts/repair-desk-note-refusals.ts
printf 'chore(transcripts): repair script for refusal-shaped desk notes\n\nRestores the extractive summary for rows poisoned by AI soft refusals\n(ran with --apply: CSX 2026 Q2 row 13 repaired).\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01TVtVNZfUDWhGKSVjSw2kxz\n' > /tmp/commit-msg.txt
git commit -F /tmp/commit-msg.txt
```

---

### Task 3: `key_themes` tag-remnant cleaning (leak b) — Mac + Worker together

**Files:**
- Modify: `lib/gmail/process.ts` (add `sanitizeThemeList`, extend `SUMMARY_TAG_REMNANT`, replace the inline themes guard at ~lines 258–262)
- Modify: `workers/cron/src/fallback-digest.ts` (extend `SUMMARY_TAG_REMNANT` at ~line 283 — byte parity with Mac — and add the same per-element cleaning inside `normalizeThemes` at ~lines 293–305)
- Modify: `lib/digest/research-desk.ts` (~lines 62–66) and `lib/digest/daily-digest.ts` (~lines 193–196 and 362–365): route rendered themes through `sanitizeThemeList`
- Test: `tests/gmail/sanitize-model-summary.test.ts` (new describe), `workers/cron/test/fallback-digest.test.ts` (extend `normalizeThemes` describe)

**Interfaces:**
- Produces: `export function sanitizeThemeList(v: unknown): string[]` in `lib/gmail/process.ts` (Task 4's repair script imports it). Worker `normalizeThemes` keeps its existing name/signature — cleaning goes inside it (semantic parity, NOT byte parity — the two sides have different shapes by history; `SUMMARY_TAG_REMNANT` stays byte-identical).

**Background:** the 7/22 Research Desk leak (DB row 55380) is a *valid JSON array* whose first element is the string `<parameter name="key_themes">["Google AI Overviews impact on publisher traffic"` and whose later elements carry stray `"`/`]` punctuation. Every existing guard (`Array.isArray` filter, Worker `normalizeThemes`, render-site `parseJsonArray`) only rejects non-strings — a tag-contaminated string sails through. Also: `<parameter` is NOT in `SUMMARY_TAG_REMNANT`, so the same variant landing in `summary` would leak too.

- [ ] **Step 1: Write the failing Mac tests**

New describe in `tests/gmail/sanitize-model-summary.test.ts`:

```ts
import { sanitizeThemeList } from "@/lib/gmail/process"; // add to existing imports

describe("sanitizeThemeList (pure)", () => {
  it("cleans the 7/22 row-55380 shape: tag wrapper + stray brackets/quotes", () => {
    const poisoned = [
      '<parameter name="key_themes">["Google AI Overviews impact on publisher traffic"',
      '"search/AI Mode reducing outbound clicks"',
      '"publisher data licensing deals and long-tail disadvantage"',
      '"antitrust/policy implications for search dominance"',
      '"user experience vs. publisher traffic tradeoffs"]',
    ];
    expect(sanitizeThemeList(poisoned)).toEqual([
      "Google AI Overviews impact on publisher traffic",
      "search/AI Mode reducing outbound clicks",
      "publisher data licensing deals and long-tail disadvantage",
      "antitrust/policy implications for search dominance",
      "user experience vs. publisher traffic tradeoffs",
    ]);
  });

  it("keeps normal arrays untouched and caps at 5", () => {
    expect(sanitizeThemeList(["fed policy", "tech earnings", "a", "b", "c", "d"])).toEqual([
      "fed policy", "tech earnings", "a", "b", "c",
    ]);
  });

  it("splits a comma-joined string (legacy model behavior)", () => {
    expect(sanitizeThemeList("fed policy, tech earnings")).toEqual(["fed policy", "tech earnings"]);
  });

  it("drops elements that are pure tag debris; null/objects -> []", () => {
    expect(sanitizeThemeList(['\n<par', "real theme"])).toEqual(["real theme"]);
    expect(sanitizeThemeList(null)).toEqual([]);
    expect(sanitizeThemeList({})).toEqual([]);
  });

  it("legit angle brackets in themes survive (rates <1%, >50% upside)", () => {
    expect(sanitizeThemeList(["rates <1% scenario", ">50% upside case"])).toEqual([
      "rates <1% scenario", ">50% upside case",
    ]);
  });
});
```

Extend the existing `sanitizeModelSummary (pure)` describe with one case:

```ts
it("cuts at a <parameter remnant too", () => {
  expect(sanitizeModelSummary('Real prose here.<parameter name="key_themes">["x"]')).toBe("Real prose here.");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/gmail/sanitize-model-summary.test.ts`
Expected: FAIL — `sanitizeThemeList` not exported; `<parameter` case fails.

- [ ] **Step 3: Implement Mac side (`lib/gmail/process.ts`)**

Extend the remnant regex (keep the existing doc comment; add `parameter` to the alternation — this exact regex is byte-mirrored in the Worker, change both):

```ts
const SUMMARY_TAG_REMNANT =
  /<\/?(?:summary|key_themes|sentiment_score|sentiment|mentioned_symbols|portfolio_relevance|is_portfolio_relevant|parameter)\b/i;
```

Add below `sanitizeModelSummary`:

```ts
/**
 * key_themes twin of sanitizeModelSummary: the model intermittently wraps a
 * theme element in structured-output tag debris (`<parameter
 * name="key_themes">["theme"` — the 2026-07-22 Research Desk leak, row
 * 55380) or leaves stray brackets/quotes from a JSON-in-string dump. Every
 * upstream guard only filtered NON-STRING elements, so contaminated strings
 * sailed through to the rendered italics line. Clean per element at the
 * storage boundary AND at render (old rows). Worker semantic mirror:
 * workers/cron/src/fallback-digest.ts::normalizeThemes.
 */
const THEME_TAG_STRIP = /<\/?(?:summary|key_themes|sentiment_score|sentiment|mentioned_symbols|portfolio_relevance|is_portfolio_relevant|parameter)\b[^>]*>?/gi;

function cleanThemeElement(raw: string): string {
  return raw
    .replace(THEME_TAG_STRIP, " ")
    .replace(/^[\s"'[\]]+|[\s"'[\]]+$/g, "")
    .trim();
}

export function sanitizeThemeList(v: unknown): string[] {
  const parts = Array.isArray(v)
    ? v.filter((t): t is string => typeof t === "string")
    : typeof v === "string"
      ? v.split(",")
      : [];
  return parts.map(cleanThemeElement).filter((t) => t.length > 0).slice(0, 5);
}
```

Replace the inline guard in `extractWithClaude` (~lines 258–262, the `const themes = Array.isArray(object.key_themes) ...` block) with:

```ts
  const themes = sanitizeThemeList(object.key_themes);
```

and where the result is returned (`key_themes: themes.slice(0, 5)`), the `.slice(0, 5)` becomes redundant — change to `key_themes: themes`.

- [ ] **Step 4: Implement Worker side (`workers/cron/src/fallback-digest.ts`)**

Update its `SUMMARY_TAG_REMNANT` to the identical regex from Step 3 (byte parity). Inside `normalizeThemes`, apply the same per-element cleaning — add the same `THEME_TAG_STRIP` const + `cleanThemeElement` helper above it (copy the code; adjust nothing), and change both return paths:

```ts
export function normalizeThemes(v: unknown): string[] {
  const parts = Array.isArray(v)
    ? v.filter((t): t is string => typeof t === "string")
    : typeof v === "string"
      ? v.split(",")
      : [];
  return parts.map(cleanThemeElement).filter((t) => t.length > 0).slice(0, 5);
}
```

Add to `workers/cron/test/fallback-digest.test.ts` in the existing `normalizeThemes` describe — the same row-55380 fixture test from Step 1 (expecting the cleaned 5 themes), plus the tag-debris-drop case.

- [ ] **Step 5: Wire render sites (Mac)**

`lib/digest/research-desk.ts` (~line 62) and BOTH sites in `lib/digest/daily-digest.ts` (~193, ~362): wrap the parsed themes, e.g.

```ts
import { sanitizeThemeList } from "@/lib/gmail/process";
// ...
const themes = sanitizeThemeList(parseJsonArray(article.key_themes));
```

(Check each file's existing import style/alias and match it. The Worker render path already flows through `normalizeThemes` for live rows; snapshot rows at line ~408 use `parseJsonArray` — change that one to `normalizeThemes(parseJsonArray(a.key_themes))`.)

- [ ] **Step 6: Run both test suites**

Run: `npx vitest run tests/gmail/ tests/digest/` and `cd workers/cron && npx vitest run && cd ../..`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/gmail/process.ts workers/cron/src/fallback-digest.ts lib/digest/research-desk.ts lib/digest/daily-digest.ts tests/gmail/sanitize-model-summary.test.ts workers/cron/test/fallback-digest.test.ts
printf 'fix(digest): clean tag-contaminated key_themes elements (7/22 leak)\n\nRow 55380 shipped a literal <parameter name="key_themes"> fragment into\nthe 7/22 Research Desk italics line: every guard filtered non-string\nelements but passed contaminated strings. sanitizeThemeList (Mac) +\nnormalizeThemes cleaning (Worker) strip tag debris per element at the\nstorage boundary and at render; SUMMARY_TAG_REMNANT learns <parameter\n(byte parity both sides).\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01TVtVNZfUDWhGKSVjSw2kxz\n' > /tmp/commit-msg.txt
git commit -F /tmp/commit-msg.txt
```

---

### Task 4: `key_themes` repair script + run

**Files:**
- Create: `scripts/repair-key-themes.ts`

**Interfaces:**
- Consumes: `sanitizeThemeList` (Task 3).

- [ ] **Step 1: Write the script** (copy the `repair-xml-summaries.ts` pattern)

```ts
/**
 * Repair research_articles.key_themes rows contaminated with structured-
 * output tag debris (the 2026-07-22 Research Desk leak) or mangled non-JSON
 * strings. Re-cleans through sanitizeThemeList and stores canonical JSON.
 *
 * Dry-run by default:  npx tsx scripts/repair-key-themes.ts
 * Apply:               npx tsx scripts/repair-key-themes.ts --apply
 */
import Database from "better-sqlite3";
import path from "path";
import { sanitizeThemeList } from "../lib/gmail/process";

const apply = process.argv.includes("--apply");
const db = new Database(path.join(process.cwd(), "data", "vanguard.db"));

const rows = db
  .prepare(
    `SELECT id, key_themes FROM research_articles
      WHERE key_themes IS NOT NULL AND key_themes != '' AND key_themes != '[]'`
  )
  .all() as { id: number; key_themes: string }[];

let matched = 0;
let repaired = 0;
const update = db.prepare(`UPDATE research_articles SET key_themes = ? WHERE id = ?`);

for (const row of rows) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.key_themes);
  } catch {
    parsed = row.key_themes; // mangled non-JSON string — clean as raw string
  }
  const cleaned = JSON.stringify(sanitizeThemeList(parsed));
  // Skip rows where cleaning is a no-op on CONTENT (ignore pure JSON
  // formatting noise like whitespace differences from re-serialization).
  const originalContent = Array.isArray(parsed)
    ? JSON.stringify(parsed.filter((t): t is string => typeof t === "string").map((t) => t.trim()))
    : null;
  if (cleaned === row.key_themes || cleaned === originalContent) continue;
  matched += 1;
  console.log(`row ${row.id}: ${row.key_themes.slice(0, 100)} -> ${cleaned.slice(0, 100)}`);
  if (apply) {
    update.run(cleaned, row.id);
    repaired += 1;
  }
}

console.log(
  apply
    ? `Repaired ${repaired} of ${matched} rows.`
    : `Would repair ${matched} rows. Re-run with --apply.`
);
db.close();
```

Note: because `sanitizeThemeList` trims/caps, some healthy rows may re-serialize with cosmetic differences (whitespace inside JSON). Inspect the dry-run output — expected genuine hits are rows **47645, 48259, 55380** (sized 2026-07-23). If the dry run reports many rows with content-identical themes (only formatting diffs), tighten the skip condition to compare parsed arrays element-wise instead of string equality.

- [ ] **Step 2: Dry-run, inspect, apply**

```bash
npx tsx scripts/repair-key-themes.ts
# verify the printed rows are genuinely contaminated (47645, 48259, 55380 expected)
npx tsx scripts/repair-key-themes.ts --apply
sqlite3 data/vanguard.db "SELECT id, key_themes FROM research_articles WHERE id IN (47645,48259,55380);"
```
Expected after apply: row 55380 = clean 5-theme JSON array with no `<parameter`; 47645/48259 = `[]` (nothing salvageable) or clean fragments.

- [ ] **Step 3: Commit**

```bash
git add scripts/repair-key-themes.ts
printf 'chore(digest): repair script for tag-contaminated key_themes rows\n\nRan with --apply: rows 47645, 48259, 55380 cleaned.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01TVtVNZfUDWhGKSVjSw2kxz\n' > /tmp/commit-msg.txt
git commit -F /tmp/commit-msg.txt
```

---

### Task 5: Third-person voice fix (leak c) — schema + prompt + repair

**Files:**
- Modify: `lib/gmail/process.ts` (ANALYSIS_SCHEMA descriptions ~lines 159–205; extraction prompt ~lines 236–247)
- Create: `scripts/repair-third-person-voice.ts`
- Test: `tests/gmail/sanitize-model-summary.test.ts` (add a voice-lint describe) — or a new `tests/gmail/analysis-schema-voice.test.ts` if imports get awkward.

**Background:** the 7/21 and 7/22 digests rendered "…are in **the user's** portfolio" / "read-through for **the user's** VIS…" in the `> **Portfolio relevance**:` blockquote. The model parrots the schema's own field descriptions: `portfolio_relevance` says "…relevant to the user's current portfolio holdings" and `is_portfolio_relevant`'s description repeatedly says "the user holds…", "names the user doesn't own…". The Worker schemas carry no description strings (verified — no "the user" anywhere in `workers/cron/src/*.ts`), so this is Mac-only. 6 stored `summary` rows also contain "the user", but several are legitimate prose about end-users generally (e.g. "Google absorbing more of the user's information journey") — **repair only the `portfolio_relevance` column**, where "the user" always means the portfolio owner.

- [ ] **Step 1: Write the failing voice-lint test**

```ts
import { ANALYSIS_SCHEMA } from "@/lib/gmail/process"; // export it if it isn't yet

describe("extraction voice — reader-facing fields must not say 'the user'", () => {
  it("ANALYSIS_SCHEMA descriptions are second-person", () => {
    expect(JSON.stringify(ANALYSIS_SCHEMA).toLowerCase()).not.toContain("the user");
  });
});
```

(If `ANALYSIS_SCHEMA` is module-private, add `export` to its declaration — it's a plain const, no circularity risk.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/gmail/`
Expected: FAIL — descriptions contain "the user".

- [ ] **Step 3: Rewrite the schema descriptions**

In ANALYSIS_SCHEMA:
- `portfolio_relevance` description → `"One sentence on how this article is relevant to the current portfolio holdings, written in second person addressed to the portfolio owner ('relevant to your NVDA position') — NEVER third person like 'the user'."`
- `is_portfolio_relevant` description: replace every "the user holds" → "held in the portfolio", "the user doesn't own" / "names the user doesn't own" → "names not held in the portfolio", and any other "the user" phrasing → portfolio-neutral wording. Keep the classification semantics word-for-word otherwise (this description encodes the under-filter bias — don't change its meaning).

Append a VOICE paragraph to the extraction prompt, directly after the ATTRIBUTION paragraph (~line 247):

```
VOICE: the summary and portfolio_relevance fields are read directly by the portfolio owner in their morning email. Address them in second person ("your CSX position", "your semis exposure") or neutral prose; NEVER refer to "the user", "the client", or "the portfolio manager" in third person.
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/gmail/`
Expected: PASS (including all pre-existing tests — the extraction tests mock the AI, so prompt changes don't break them).

- [ ] **Step 5: Write + run the repair script**

```ts
/**
 * Rewrite third-person "the user" phrasing in research_articles.
 * portfolio_relevance (rendered as a blockquote in digest emails).
 * Deliberately does NOT touch `summary` — "the user" there is often
 * legitimate prose about end-users of a product.
 *
 * Dry-run by default; --apply to write.
 */
import Database from "better-sqlite3";
import path from "path";

const apply = process.argv.includes("--apply");
const db = new Database(path.join(process.cwd(), "data", "vanguard.db"));

const rows = db
  .prepare(
    `SELECT id, portfolio_relevance FROM research_articles
      WHERE portfolio_relevance LIKE '%the user%'`
  )
  .all() as { id: number; portfolio_relevance: string }[];

const update = db.prepare(`UPDATE research_articles SET portfolio_relevance = ? WHERE id = ?`);
let repaired = 0;

for (const row of rows) {
  const fixed = row.portfolio_relevance
    .replace(/\bthe user(?:'|’)s\b/gi, "your")
    .replace(/\bthe user\b/gi, "you");
  if (fixed === row.portfolio_relevance) continue;
  console.log(`row ${row.id}:\n  - ${row.portfolio_relevance}\n  + ${fixed}`);
  if (apply) {
    update.run(fixed, row.id);
    repaired += 1;
  }
}

console.log(apply ? `Repaired ${repaired} rows.` : `Would repair ${rows.length} rows. Re-run with --apply.`);
db.close();
```

```bash
npx tsx scripts/repair-third-person-voice.ts        # inspect every printed diff
npx tsx scripts/repair-third-person-voice.ts --apply
```

- [ ] **Step 6: Commit**

```bash
git add lib/gmail/process.ts scripts/repair-third-person-voice.ts tests/gmail/
printf 'fix(gmail): second-person voice for reader-facing extraction fields\n\nThe 7/21-7/22 digests rendered "the user'"'"'s portfolio" in Portfolio\nrelevance blockquotes — the model parrots the schema descriptions, which\nsaid "the user" throughout. Descriptions + a VOICE prompt rule are now\nsecond-person; lint test pins "the user" out of ANALYSIS_SCHEMA; repair\nscript rewrote stored portfolio_relevance rows (summary column left\nalone deliberately - "the user" there is often legit product prose).\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01TVtVNZfUDWhGKSVjSw2kxz\n' > /tmp/commit-msg.txt
git commit -F /tmp/commit-msg.txt
```

---

### Task 6: Already-reported guard for earnings previews + intel (IMAX case)

**Files:**
- Modify: `lib/calendar/enrich-actuals.ts` (export a probe wrapper around the private `fetchFinnhubActual`)
- Modify: `lib/calendar/email-sweep.ts` (guard in the per-candidate loop; extend the `skipped` union at line ~44)
- Modify: `lib/digest/send-earnings-email.ts` (~lines 185–195: skip the preview `forceFresh` intel refresh when actuals exist)
- Modify: `lib/queries/earnings-intel.ts` (~lines 97–98: `cockpitRowsToIntelEvents` also excludes rows with a captured/implausible actual)
- Test: `tests/calendar/email-sweep.test.ts` (new describe), plus extend whichever test pins `cockpitRowsToIntelEvents` (find with `grep -rn "cockpitRowsToIntelEvents" tests/`)

**Interfaces:**
- Produces: `export async function probeFinnhubActualExists(symbol: string, date: string): Promise<boolean>` in `lib/calendar/enrich-actuals.ts`.
- Consumes: `recordEarningsEmailSkip(db, eventId, phase)` from `lib/mutations/earnings-skips.ts` (INSERT OR IGNORE into `earnings_email_skips` — permanently drops the candidate from future sweeps because `findEmailCandidates` LEFT JOINs that table).

**Background:** IMAX 7/23 was tagged AMC (`release_time 16:15`) by both Finnhub and Nasdaq but reported pre-market. The preview window is measured against the *recorded* release instant only — `findEmailCandidates` never checks `actual_value`, and Finnhub had the actuals hours before the 14:07 ET preview fired. Guard at the sweep (send boundary): (1) cheap `calendar_events.actual_value` check, (2) live Finnhub probe. On detection: permanent preview skip row + `skipped: "already-reported"`. Recap path untouched — enrichment still delivers the recap (it did, at 16:43). The same wrongness poisoned intel: `ensureIntelForEvents` was force-refreshed at preview compose time (post-print → IV-crush shown as "expected move"), and the cockpit's released-rows filter keys on the same wrong instant.

- [ ] **Step 1: Write the failing sweep tests**

New describe in `tests/calendar/email-sweep.test.ts` (reuse `seedHeldPreviewCandidate` and the mock structure of the existing "counts a cross-process 409 claim refusal as skipped, not failed" test at ~line 428). Add a module mock for the probe alongside the existing `vi.mock` blocks:

```ts
vi.mock("@/lib/calendar/enrich-actuals", () => ({
  probeFinnhubActualExists: vi.fn().mockResolvedValue(false),
}));
import { probeFinnhubActualExists } from "@/lib/calendar/enrich-actuals";
```

```ts
describe("already-reported preview guard (IMAX 7/23 case)", () => {
  it("skips the preview when the event row already has an actual_value", async () => {
    const eventId = seedHeldPreviewCandidate(db /* , ...whatever args the helper takes */);
    db.prepare(`UPDATE calendar_events SET actual_value = 'EPS 0.43 · Rev 102,840,000' WHERE id = ?`).run(eventId);
    const summary = await runEarningsEmailSweep(db);
    expect(sendEarningsPreview).not.toHaveBeenCalled();
    const r = summary.results.find((x) => x.eventId === eventId)!;
    expect(r.skipped).toBe("already-reported");
    expect(r.ok).toBe(true);
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
    // permanent skip row recorded so the candidate never re-enters
    const skip = db.prepare(`SELECT 1 FROM earnings_email_skips WHERE event_id = ? AND phase = 'preview'`).get(eventId);
    expect(skip).toBeTruthy();
  });

  it("skips when the live Finnhub probe says the print is out", async () => {
    const eventId = seedHeldPreviewCandidate(db);
    vi.mocked(probeFinnhubActualExists).mockResolvedValueOnce(true);
    const summary = await runEarningsEmailSweep(db);
    expect(sendEarningsPreview).not.toHaveBeenCalled();
    expect(summary.results.find((x) => x.eventId === eventId)!.skipped).toBe("already-reported");
  });

  it("sends normally when neither layer detects a print", async () => {
    seedHeldPreviewCandidate(db);
    vi.mocked(probeFinnhubActualExists).mockResolvedValueOnce(false);
    await runEarningsEmailSweep(db);
    expect(sendEarningsPreview).toHaveBeenCalledTimes(1);
  });

  it("a probe failure never blocks the send (guard is best-effort)", async () => {
    seedHeldPreviewCandidate(db);
    vi.mocked(probeFinnhubActualExists).mockRejectedValueOnce(new Error("network"));
    await runEarningsEmailSweep(db);
    expect(sendEarningsPreview).toHaveBeenCalledTimes(1);
  });

  it("recap candidates are never probed", async () => {
    seedHeldRecapCandidate(db);
    await runEarningsEmailSweep(db);
    expect(probeFinnhubActualExists).not.toHaveBeenCalled();
    expect(sendEarningsRecap).toHaveBeenCalledTimes(1);
  });
});
```

(Adapt seed-helper signatures to what the file actually defines; if `email-sweep.ts` imports anything else from `enrich-actuals`, include it in the mock factory.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/calendar/email-sweep.test.ts`
Expected: FAIL — `probeFinnhubActualExists` doesn't exist; previews send despite actuals.

- [ ] **Step 3: Implement the probe (`lib/calendar/enrich-actuals.ts`)**

Below `fetchFinnhubActual`:

```ts
/**
 * Standalone probe: has Finnhub published an actual for (symbol, date)?
 * Used by the email sweep's already-reported preview guard (2026-07-23
 * IMAX case: a BMO reporter mis-slotted as AMC put the preview window
 * AFTER the real print). Best-effort — missing API key, network failure,
 * and the foreign-listing symbol-echo guard all return false (preview
 * proceeds; false negatives are safe, false positives are not).
 */
export async function probeFinnhubActualExists(symbol: string, date: string): Promise<boolean> {
  try {
    const { actual } = await fetchFinnhubActual(symbol, date);
    return actual !== null;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Implement the sweep guard (`lib/calendar/email-sweep.ts`)**

Extend the union at ~line 44:

```ts
skipped?: "cloud-already-sent" | "claim-held" | "not-ready" | "wrap-pending" | "already-reported";
```

Insert between the cloud-marker check (ends ~line 209) and `void setEarningsRunningMarker(...)` (~line 211):

```ts
    // Already-reported guard (2026-07-23, IMAX): a wrong AMC/BMO slot from
    // the calendar source can put a preview candidate in-window AFTER the
    // real print — the window is measured against the RECORDED release
    // instant only. A post-print "preview" prices the actuals as estimates,
    // which is worse than no preview. Two layers: the row's own
    // actual_value (manual overrides / early enrichment), then a live
    // Finnhub probe. On detection, record a permanent per-event preview
    // skip (the recap path is untouched — enrichment still delivers it).
    // Best-effort: any guard error falls through to the normal send.
    if (cand.phase === "preview") {
      let alreadyReported = false;
      try {
        const evRow = db
          .prepare(`SELECT actual_value, event_date FROM calendar_events WHERE id = ?`)
          .get(cand.eventId) as { actual_value: string | null; event_date: string } | undefined;
        if (evRow?.actual_value) {
          alreadyReported = true;
        } else if (evRow) {
          alreadyReported = await probeFinnhubActualExists(cand.symbol, evRow.event_date);
        }
      } catch (err) {
        console.warn(`[email-sweep] already-reported guard errored for ${cand.symbol}:`, err);
      }
      if (alreadyReported) {
        console.warn(
          `[email-sweep] ${cand.symbol} preview skipped — already reported (recorded release slot looks wrong for event ${cand.eventId})`
        );
        recordEarningsEmailSkip(db, cand.eventId, "preview");
        results.push({
          eventId: cand.eventId,
          symbol: cand.symbol,
          phase: cand.phase,
          ok: true,
          skipped: "already-reported",
          durationMs: Date.now() - t0,
        });
        continue;
      }
    }
```

Add imports: `probeFinnhubActualExists` from `@/lib/calendar/enrich-actuals`, `recordEarningsEmailSkip` from `@/lib/mutations/earnings-skips` (check the exact export name in that file first).

- [ ] **Step 5: Gate the composer's forceFresh intel + the cockpit ensure list**

`lib/digest/send-earnings-email.ts` (~line 185) — the preview intel refresh must not run post-print (it would overwrite the preview-time "priced-in" anchor with crushed IV):

```ts
  if (phase === "preview" && !event.actual_value) {
```

(Verify the loaded `event` row includes `actual_value` — it's used by `renderHeadlineTable`, so it should. If the local type lacks the field, extend the SELECT/type, not the guard.)

`lib/queries/earnings-intel.ts::cockpitRowsToIntelEvents` (~line 97) — a wrong-slot event reads "not released" from the recorded instant, so also require the actual stage to be pending:

```ts
  return allCockpitRows(payload)
    .filter((r) => r.stages.released.state !== "released" && r.stages.actual === "pending")
```

(`r.stages.actual` is a bare string union `"captured" | "implausible" | "blocked" | "pending"` from `lib/earnings/cockpit-stages.ts`; `"blocked"` implies released so it's already excluded — requiring `"pending"` excludes captured/implausible, i.e. any row with an actual_value.)

Extend the existing `cockpitRowsToIntelEvents` test (find with `grep -rn "cockpitRowsToIntelEvents" tests/`) with one case: a row whose released state is `"upcoming"` (wrong slot) but whose `actual` stage is `"captured"` must be excluded.

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/calendar/email-sweep.test.ts tests/earnings/ tests/queries/`
Expected: PASS, including all pre-existing sweep tests (the default probe mock resolves `false`, so existing preview tests keep sending).

- [ ] **Step 7: Commit**

```bash
git add lib/calendar/enrich-actuals.ts lib/calendar/email-sweep.ts lib/digest/send-earnings-email.ts lib/queries/earnings-intel.ts tests/
printf 'fix(earnings): already-reported guard for previews + post-print intel\n\nIMAX 7/23: both calendar sources tagged a BMO reporter as AMC 16:15, so\nthe preview fired at 14:07 ET hours after the real print and the\nforceFresh intel line showed post-print crushed IV as the expected move.\nThe preview window keys only on the recorded release instant - nothing\nchecked whether actuals already existed. Sweep guard: actual_value check\n+ live Finnhub probe -> permanent preview skip (recap untouched);\ncomposer skips forceFresh intel when actuals exist; cockpit ensure list\nexcludes rows with a captured actual regardless of recorded slot.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01TVtVNZfUDWhGKSVjSw2kxz\n' > /tmp/commit-msg.txt
git commit -F /tmp/commit-msg.txt
```

---

### Task 7: Preview prompt backstop + IMAX release-time override

**Files:**
- Modify: `lib/digest/send-earnings-email.ts` (`renderPreviewPrompt`, ~lines 1401–1460)
- Modify: `lib/calendar/release-times.ts` (`SYMBOL_RELEASE_TIMES_ET`, lines 54–61)

**Background:** even with the Task 6 guard, the AI is the last line of defense (guard errors, Finnhub lag). The preview prompt currently has no instruction for the "results already out" case — the 7/23 IMAX preview quoted the actual revenue as a street-estimate "split". And IMAX itself needs a release-time override so future quarters slot BMO.

- [ ] **Step 1: Add the prompt backstop**

In `renderPreviewPrompt`, immediately after the web_search instruction paragraph (~line 1445, the one beginning "Use the structured context above as the source of truth…"), add:

```ts
  `**Already-reported check:** if your web search shows ${ctx.symbol} has ALREADY released these results (figures published as actuals dated today or earlier), do NOT frame them as expectations. Open the briefing by stating plainly that the report is already out, label every published figure as an ACTUAL, and skip the "into the print" framing — the calendar slot for this event was wrong.`
```

(Match the surrounding template-literal style — these prompt lines are segments of one template string; splice the sentence in as its own paragraph.)

- [ ] **Step 2: Verify the IMAX release time against the real press release**

Data-integrity rule: never guess. WebSearch for the IMAX Q2 2026 earnings press release (e.g. `"IMAX" "second quarter 2026" results press release`) and note its publication time (wire timestamp). IMAX's press releases have historically gone out pre-market. Use the observed wire time rounded DOWN to the nearest quarter hour for the override; if no precise time is verifiable, use `"08:00"` (the generic BMO default in `deriveReleaseTime` — being in the right half of the day is what matters for window math).

- [ ] **Step 3: Add the override + backfill**

```ts
export const SYMBOL_RELEASE_TIMES_ET: Record<string, string> = {
  AAPL: "16:30",
  AMZN: "16:01",
  GOOGL: "16:01",
  GOOG: "16:01",
  IMAX: "08:00", // ← replace with the verified HH:MM from Step 2; BMO reporter mis-slotted AMC by Finnhub+Nasdaq (2026-07-23)
  META: "16:05",
  MSFT: "16:05",
};
```

Run: `npx tsx scripts/backfill-symbol-release-times.ts --dry-run` then without the flag.
Expected: any FUTURE IMAX earnings rows get `release_time` updated; today's past row is untouched (script only selects `event_date >= date('now')`).

- [ ] **Step 4: Quick regression run + commit**

Run: `npx vitest run tests/calendar/release-times.test.ts tests/digest/` (if a release-times test file exists; otherwise `npx vitest run tests/calendar/`)
Expected: PASS.

```bash
git add lib/digest/send-earnings-email.ts lib/calendar/release-times.ts
printf 'fix(earnings): preview prompt already-reported backstop + IMAX BMO override\n\nPrompt-level last line of defense behind the sweep guard: web results\nshowing published actuals must be labeled as actuals, never framed as\nexpectations. IMAX added to SYMBOL_RELEASE_TIMES_ET (verified BMO\nreporter; Finnhub+Nasdaq both mis-slotted it AMC on 7/23).\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01TVtVNZfUDWhGKSVjSw2kxz\n' > /tmp/commit-msg.txt
git commit -F /tmp/commit-msg.txt
```

---

### Task 8: Full verification + deploy + docs reconcile

**Files:**
- Modify: `docs/plans/TODO.md` (mark the two email-trust items closed, note what shipped)
- No new code.

- [ ] **Step 1: Full Mac test suite**

Run: `npx vitest run`
Expected: ALL PASS (baseline was 3,768; expect ~3,780+). Report exact counts. Do not proceed with failures.

- [ ] **Step 2: Worker test suite + typecheck + build check**

```bash
cd workers/cron && npx vitest run && cd ../..
npx tsc --noEmit
```
Expected: Worker tests all pass (baseline 431); tsc clean.

- [ ] **Step 3: Deploy the Worker** (normalizeThemes/SUMMARY_TAG_REMNANT changes are cloud-path live code)

```bash
CLOUDFLARE_API_TOKEN=$(grep '^CLOUDFLARE_API_TOKEN=' .env.local | cut -d= -f2-) npx wrangler deploy --cwd workers/cron 2>&1 | tail -5
```
Expected: a new version id. (Token gotcha documented in `.env.local` — wrangler reads the shell env, not `.env.local`.)

- [ ] **Step 4: Reconcile TODO.md**

In `docs/plans/TODO.md`, flip the two items added 2026-07-23 (**Digest instruction leaks** and **Earnings already-reported guard**) to `- [x]` with a one-line "FIXED 2026-07-23" note each (commit hashes from Tasks 1–7), and append a "Closed this session (2026-07-23 — email trust)" block at the bottom following the file's existing pattern. Leave the sector-corruption and dead-clicking items open.

- [ ] **Step 5: Commit docs**

```bash
git add docs/plans/TODO.md docs/superpowers/plans/2026-07-23-email-trust-session.md
printf 'docs: reconcile TODO for email-trust session\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01TVtVNZfUDWhGKSVjSw2kxz\n' > /tmp/commit-msg.txt
git commit -F /tmp/commit-msg.txt
```

(Push + Electron rebuild happen at `/session-end` per the user's global rules — do NOT push here.)
