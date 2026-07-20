# Digest thin-coverage handling — calendar-only roster + essay deep-dive pointers

**Date:** 2026-07-20
**Status:** Approved (user-validated brainstorm, same-day session)
**Motivation:** The 7/20 morning digest audit surfaced two coordinated design tensions created by the held-ticker section rule (prompt rule + the `enforceHeldSections` backstops shipped 2026-07-20):

1. **Calendar-only stub sections** — a single weekly-calendar roundup article ("this week: MSFT, HD, GS, JPM, XOM, RBRK, NSC…") lands in one bucket per mentioned symbol, so every held name it lists gets a forced `##` section whose only content is "listed on this week's earnings calendar". The 7/20 digest carried ~7 such empty-calorie sections.
2. **Essay-only invisibility** — essays never enter synthesis buckets (commentary-only by design) and `insertCrossFilePointers` only annotates *existing* `## SYM` sections, so a held name whose only coverage is a Research Desk deep-dive (7/20: NFLX, the day after its print) is invisible in the digest body.

## Decisions (user-validated)

| Question | Decision |
|---|---|
| Calendar-only held names | Compact roster line, sections waived |
| Detection | Symbol-breadth ≥ 8, deterministic, no AI |
| Essay-only held names | 📄 deep-dives pointer line (Mac only) |
| Worker scope | Roster waiver mirrored into `fallback-evening`; essay line Mac-only |

## Design

### 1. New module `lib/digest/thin-coverage.ts` (pure, zero AI)

- `LISTING_BREADTH_MIN = 8`.
- `isListingArticle(article): boolean` — parsed `mentioned_symbols` count ≥ `LISTING_BREADTH_MIN` marks the article as a roundup/listing *for every symbol it mentions*. Null/missing/unparseable `mentioned_symbols` → count 0 → NOT a listing (safe default: never waive a section on a parse failure).
- `partitionListingOnlyHeldBuckets(buckets, heldSymbols)` → `{ active, rosterSymbols }`:
  - A bucket moves to the roster iff it is **held** (issuerSiblings-aware membership, identical test to `enforceHeldSections`) AND **every** article in it is a listing article AND it has ≥ 1 article.
  - Mixed buckets (any single non-listing article) stay in `active` untouched.
  - Watchlist-only and non-held buckets always stay in `active` — they were never section-forced, and the model may still place them in `## Also covered`.
  - The `(no symbol)` macro bucket is never partitioned.
- `renderThinCoverageLines(rosterSymbols, unfiledEssays)` — up to two plain lines (no `##` headers), each omitted when its input is empty:
  - `On this week's calendar: GS · HD · JPM · MSFT` (alphabetical)
  - `📄 Deep dives: NFLX (Stratechery — "Netflix and the Anthology Era", see Research Desk below)` — one entry per unfiled essay, `SYMBOL (SourceName — "Subject")`.
- `insertBeforeAlsoCovered(markdown, block)` — extracted from the inline logic currently duplicated in both `enforceHeldSections` implementations: insert `block` immediately before the `^## Also covered$` line, or append at the end when that section is absent. Both enforcement backstops (Mac + Worker) refactor onto this helper; the new lines use it too, so all three insertions share one placement behavior.

### 2. Mac composer wiring (`lib/digest/daily-digest.ts::generateDigestSinceAdaptive`)

- Partition runs **before** `synthesize()`; only `active` buckets reach the prompt. Consequences, both free:
  - Listing-only buckets never consume prompt tokens and the model cannot write sections for them.
  - `enforceHeldSections` iterates `input.buckets` — receiving `active` means it stops stubbing roster names with **zero enforcement-logic changes**.
- `insertCrossFilePointers` signature changes from `string` to `{ markdown, unfiled: EssayLike[] }` — `unfiled` collects essays whose held/watchlist symbols matched no `## SYM` section (today's silent `continue` path). Gating unchanged (held + watchlist, family-expanded both sides).
- Composer renders `renderThinCoverageLines(rosterSymbols, unfiled)` and inserts via `insertBeforeAlsoCovered` after synthesis + cross-file pointers. Applies to BOTH Mac emails (morning + evening — they share the adaptive composer).
- Empty roster AND empty unfiled → byte-identical output to today.

### 3. Worker mirror (`workers/cron/src/fallback-evening.ts`)

- Same partition (its `RecentArticleMeta` carries `mentioned_symbols`) before `buildSynthesisPrompt`; `enforceHeldSections` and the prompt both receive only `active` buckets.
- Roster line rendered + inserted deterministically after synthesis validation passes (same insert helper, local copy).
- No essay line — the Worker path has no essay/commentary split; essays sit in its buckets and get sections normally.
- `LISTING_BREADTH_MIN` duplicated with a cross-reference comment (hand-mirror convention, same as `issuerSiblings`/`presence-position`); a one-value parity assertion rides in the existing editions parity test file.

### 4. Testing

- Partition units: all-listing held bucket → roster; mixed bucket → stays active; family-aware (GOOGL bucket, GOOG held); non-held/watchlist listing bucket → stays active; null `mentioned_symbols` → not listing; macro bucket untouched.
- `renderThinCoverageLines`: both lines, one line, neither (empty string), alphabetical roster order.
- `insertBeforeAlsoCovered`: before-`## Also covered` placement; append when absent (behavior pinned once, both backstops covered by refactor).
- `insertCrossFilePointers`: unfiled return for essay with no matching section; filed essay NOT in unfiled.
- Wiring: one Mac adaptive-composer test + one Worker `runFallbackEvening` test asserting a listing-only held bucket produces the roster line, no `##` section, and no enforcement stub.
- Estimated +12 tests. All pure or existing-mock-AI patterns.

### 5. Error handling

All new code is pure; no network or DB. Failure surface is limited to parsing `mentioned_symbols`, which already has a safe default. The lines render from data already present in the composer — no new failure modes on the send path.

## Out of scope

- Watchlist names in the roster line (held-only, matching enforcement scope; revisit if watchlist listing noise appears).
- The morning `## Today's reporters` block (unchanged; the roster line covers the whole week and needs no cross-reference to it).
- Worker morning digest (`fallback-digest`) — per-source composition, no synthesis, no sections to waive.

## Expected effect on the next morning digest

The ~7 calendar-only stub sections collapse into one roster line; essay-only held names surface via the 📄 line; every remaining `##` section is backed by real commentary coverage.
