# Bogey Automation (#11) + Same-Day Transcripts (#12) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (A) Auto-extract earnings bogeys from newsletters mentioning upcoming reporters + a Sunday-briefing reminder line; (B) same-day transcript retry-fetch with AI desk-note summaries surfaced in the morning digest + TranscriptCard.

**Architecture:** Part A mirrors the levels-extraction pattern (scanned-marker column, symbol pre-filter, Claude JSON extraction, family fan-out to calendar events) writing through the existing `upsertBogey`. Part B is an orchestration layer over the EXISTING transcript fetch chain (`lib/transcripts/fetch.ts::fetchTranscript`) with retry pacing on a new `calendar_events.transcript_attempted_at` column, plus a `transcriptSummary` AI pass and a deterministic digest block.

**Tech Stack:** TypeScript, better-sqlite3 + numbered SQL migrations, Vitest (`:memory:` DBs), `generateTextForFeature` AI seam (mock in tests per the AI-mocking memory pattern).

**Spec:** `docs/superpowers/specs/2026-07-16-bogey-automation-transcripts-design.md`

## Global Constraints

- Feature keys: `newsletterBogeyExtraction` → `"anthropic/$workhorse"`, `transcriptSummary` → `"anthropic/$workhorse"` in `lib/ai/models.ts::FEATURE_MODELS` + `lib/ai/feature-keys.ts`.
- Migrations: `066_research_articles_bogeys_scanned.sql` (ALTER TABLE research_articles ADD COLUMN bogeys_scanned_at TEXT), `067_calendar_events_transcript_attempted.sql` (ALTER TABLE calendar_events ADD COLUMN transcript_attempted_at TEXT).
- Scanned-marker semantics (Part A): mark scanned on success AND on no-relevant-symbols; do NOT mark on transient failure (retries next run) — the `extractLevelsFromArticle` idiom.
- Bogey rows: `source: 'newsletter'`, `source_label: <research_sources.name>`; event matching fans out via `issuerSiblings` to earnings `calendar_events` in `[today, today+14d]`, `COALESCE(superseded,0)=0`.
- LLM JSON parsing MUST go through `lib/ai/extract-json.ts::extractJsonArray`; numeric coercion through `parseLargeUSD` (`lib/format.ts`).
- Transcript retry: ≥30 min between attempts per event, 36h deadline from the release, ≤2 fetch attempts per sweep tick, NEVER throws out of the sweep.
- Digest blocks are morning-edition-only, deterministic, `null` self-quiet, never block the digest (Overnight/reporters-block precedent).
- All DB functions take `db` param; case-insensitive symbol compares; run full suites + `npx tsc --noEmit` at the end of each task.

---

### Task A1: Newsletter bogey extraction module

**Files:**
- Create: `lib/db/migrations/066_research_articles_bogeys_scanned.sql`
- Create: `lib/earnings/extract-newsletter-bogeys.ts`
- Modify: `lib/ai/feature-keys.ts` (add `"newsletterBogeyExtraction"`), `lib/ai/models.ts` (add `newsletterBogeyExtraction: "anthropic/$workhorse"`)
- Test: `tests/earnings/extract-newsletter-bogeys.test.ts`

**Interfaces:**
- Consumes: `upsertBogey` (`@/lib/mutations/earnings-bogeys`, existing `UpsertBogeyInput`), `extractJsonArray` (`@/lib/ai/extract-json`), `parseLargeUSD` (`@/lib/format`), `generateTextForFeature` (`@/lib/ai/generate`), `getSymbolStatus` (`@/lib/queries/briefing-symbols`), `issuerSiblings` (`@/lib/securities/issuer-family`), `todayET`/`addDays` (`@/lib/calendar/date-utils`).
- Produces: `extractBogeysFromNewArticles(db, opts?: { sinceDays?: number; batchSize?: number }): Promise<{ articlesScanned: number; bogeysStored: number; eventsMatched: number }>` — consumed by Task A2's wiring.
- Model reference: read `lib/alerts/extract-newsletter-levels.ts` FIRST and mirror its structure (getUnscannedArticles → per-article extraction → mark-scanned discipline). The migration mirrors whichever migration added the levels `scanned` marker.

**Behavioral contract (each is a test; mock `generateTextForFeature`):**
1. Article mentioning no upcoming reporter → marked scanned, zero AI calls.
2. Article mentioning a held reporter in the 14d window → AI called; JSON `[{"symbol":"TSM","eps_consensus":3.8,"eps_whisper":4.0,"revenue_consensus":40200000000,"revenue_whisper":null,"notes":"street leaning higher"}]` → one `earnings_bogeys` row per matched event with source='newsletter', source_label=the article's source name.
3. Family fan-out: extraction says GOOGL, calendar row is GOOG → matched.
4. Model preamble prose around the array → still parses (extractJsonArray).
5. AI failure → article NOT marked scanned (retry next run); no partial rows.
6. Re-run over the same article → no duplicate rows (scanned marker) ; re-mention from the same source on a new article → upsert-in-place (UNIQUE event_id+source+source_label).
7. Non-held reporter mention → no AI call for that symbol set (relevant = held/watchlist only).

- [ ] Steps: failing tests → red run → implement → green run (`npx vitest run tests/earnings/extract-newsletter-bogeys.test.ts`, then full suite + tsc) → commit `feat(earnings): auto-extract newsletter bogeys for upcoming reporters (#11 A1)`

---

### Task A2: Sync wiring + Sunday-briefing reminder line

**Files:**
- Modify: `app/api/research/sync/route.ts` + `app/api/cron/research-sync/route.ts` (call `extractBogeysFromNewArticles` immediately after `extractLevelsFromNewArticles`, best-effort try/catch — a bogey failure never fails the sync)
- Create: `lib/earnings/bogeys-reminder.ts`
- Modify: `lib/digest/send-briefing.ts` (append the reminder line at SEND time, adjacent to the coverage-gaps block append at ~line 175 — same never-blocks pattern)
- Test: `tests/earnings/bogeys-reminder.test.ts` + extend the research-sync route test if one exists (check `tests/api/`)

**Interfaces:**
- Consumes: Task A1's `extractBogeysFromNewArticles`.
- Produces: `renderBogeysReminderLine(db, weekOf: string): string | null`.

**Behavioral contract:**
1. ≥3 held/watchlist reporters in `[weekOf, weekOf+4d]` and zero `earnings_bogeys` rows on those events → one-sentence line naming the count + up to 5 symbols.
2. Any bogeys exist for the week's events → null.
3. <3 reporters → null.
4. Briefing wiring: line appended after the coverage-gaps block, wrapped so a throw never blocks the send (copy the coverage-guard try/catch discipline).

- [ ] Steps: failing tests → red → implement → green (full suite + tsc) → commit `feat(earnings): wire newsletter bogey extraction into research sync + briefing reminder line (#11 A2)`

---

### Task B1: Same-day transcript orchestrator

**Files:**
- Create: `lib/db/migrations/067_calendar_events_transcript_attempted.sql`
- Create: `lib/transcripts/same-day.ts`
- Modify: `lib/calendar/email-sweep.ts` (best-effort call AFTER `alertBlockedRecaps`, mirroring its try/catch; add `transcriptsFetched: number` to `SweepSummary`)
- Test: `tests/transcripts/same-day.test.ts`

**Interfaces:**
- Consumes: `fetchTranscript` + `deriveFilingReportingQuarter` (`@/lib/transcripts/fetch`), `getCachedTranscript` (`@/lib/queries/transcripts`), `getSymbolStatus`, `composeReleaseInstant` (`@/lib/calendar/reaction-snapshot`).
- Produces: `fetchSameDayTranscripts(db, opts?: { now?: Date; maxAttempts?: number }): Promise<{ attempted: number; fetched: number }>` (default maxAttempts 2).
- NOTE: `runEarningsEmailSweep` may have gained a wrap pass at its end from the concurrent #17 branch — this task edits the MAIN working tree AFTER #17 merges; append the transcript step after whatever is last. If `email-sweep.ts` in your tree has no `runWrapPass`, append after `alertBlockedRecaps` regardless.

**Behavioral contract (mock `fetchTranscript`):**
1. Held reporter, actual present, released 3h ago, no cached transcript → fetch attempted; on success `attempted:1, fetched:1` and `transcript_attempted_at` stamped.
2. Attempted 10 min ago → skipped (pacing ≥30 min).
3. Released 40h ago → skipped (36h deadline).
4. No actual yet → skipped.
5. Cached transcript exists for (ticker, year, quarter) → skipped.
6. 3 eligible candidates, maxAttempts 2 → only 2 attempted this tick.
7. fetchTranscript throws → caught, event still stamped attempted, sweep result returned (never throws).

- [ ] Steps: failing tests → red → implement → green (full suite + tsc) → commit `feat(transcripts): same-day retry-fetch orchestrator in the earnings sweep (#12 B1)`

---

### Task B2: AI desk-note summary

**Files:**
- Modify: `lib/transcripts/same-day.ts` (summarize branch), `lib/ai/feature-keys.ts` + `lib/ai/models.ts` (add `transcriptSummary: "anthropic/$workhorse"`)
- Test: extend `tests/transcripts/same-day.test.ts`

**Interfaces:**
- Consumes: `generateTextForFeature` (`@/lib/ai/generate`), `upsertTranscript` (`@/lib/mutations/transcripts`).
- Produces: after a successful fetch whose transcript text exists, the summary is regenerated via the AI prompt (guidance / tone / surprises / 2-3 key quotes, ≤300 words, plain markdown) and stored via `upsertTranscript` over the cached row; transcript text capped at 50_000 chars before prompting.

**Behavioral contract (mock `generateTextForFeature`):**
1. Fetched transcript with text → AI called once; `summary` column replaced with AI output.
2. AI throws/refuses → cached row keeps its extractive summary (no error surfaces).
3. Transcript with no text (EDGAR metadata-only row) → no AI call.

- [ ] Steps: failing tests → red → implement → green (full suite + tsc) → commit `feat(transcripts): AI desk-note summaries via transcriptSummary feature key (#12 B2)`

---

### Task B3: Morning-digest "Call transcripts" block

**Files:**
- Create: `lib/digest/call-transcripts.ts`
- Modify: `lib/digest/daily-digest.ts` (morning branch, directly after the Today's-reporters block — same `lines.push(block); lines.push(""); lines.push("---"); lines.push("");` shape)
- Test: `tests/digest/call-transcripts.test.ts`

**Interfaces:**
- Consumes: `earnings_transcripts` reads (join `securities` on ticker for held/watchlist filter via `getSymbolStatus`).
- Produces: `composeCallTranscriptsBlock(db, opts?: { now?: Date }): string | null`.

**Behavioral contract:**
1. Transcript cached in the last 24h for a held ticker → `## Call transcripts` block with `### SYM — QN YYYY call` + summary (≤4 lines rendered) + `Guidance:` line when present.
2. Nothing in 24h → null.
3. Non-held ticker's transcript → excluded.
4. Never throws (DROP TABLE test → warn + null).
5. Wiring: morning edition renders it after the reporters block; evening never calls it.

- [ ] Steps: failing tests → red → implement → green (FULL Mac suite + tsc) → commit `feat(digest): morning Call-transcripts block (#12 B3)`

---

### Task C1: Docs

**Files:**
- Modify: `CLAUDE.md` (earnings-digest/bogeys bullets: newsletter auto-extraction + reminder line; transcripts: same-day orchestrator + digest block + transcriptSummary key)

- [ ] Steps: update docs → full suites both roots + tsc both roots → commit `docs: #11/#12 conventions (newsletter bogeys, same-day transcripts)`
