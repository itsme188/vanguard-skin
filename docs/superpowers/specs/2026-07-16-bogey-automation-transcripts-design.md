# Bogey automation (#11) + same-day transcripts (#12) — design

**Date:** 2026-07-16
**Status:** Approved (earnings-batch session 2026-07-16)
**Note:** Two independent subsystems, one document — they share only the
earnings-season context. The implementation plan keeps their tasks disjoint.

---

## Part A — Bogey automation (#11)

### What

Auto-extract earnings bogeys (consensus / whisper EPS + revenue) from
newsletter articles that mention reporters scheduled in the next 14 days,
mirroring the levels-extraction pattern. Plus a deterministic Sunday-briefing
reminder line when a busy week has no uploaded bogeys PDF.

### Decisions (locked with user, 2026-07-16)

- **Auto-insert, labeled by source** — no review gate (mirrors the existing
  PDF path; rows visible + deletable in `BogeysEditModal`).
- **TMT reminder: briefing line only** — no Pushover.

### Architecture

**Extraction — `lib/earnings/extract-newsletter-bogeys.ts` (new)**

- `extractBogeysFromNewArticles(db, opts?: { sinceDays?, batchSize? })` —
  the `extractLevelsFromNewArticles` shape:
  - Candidate articles: processed `research_articles` not yet
    bogey-scanned. New nullable column `bogeys_scanned_at` on
    `research_articles` (migration; the levels pattern's scanned-marker
    idiom — mark scanned on completion AND on empty result, do NOT mark on
    transient failure so it retries).
  - Relevant symbols: reporters in `[today, today+14d]` from
    `calendar_events` (earnings, not superseded, family-deduped) filtered
    held/watchlist via `getSymbolStatus`.
  - Cheap SQL pre-filter: article `raw_text` mentions ≥1 relevant symbol
    (LIKE) before any AI call.
  - Claude call: new feature key `newsletterBogeyExtraction` → `$workhorse`
    via `generateTextForFeature`; prompt asks for STRICT JSON array of
    `{symbol, eps_consensus, eps_whisper, revenue_consensus,
    revenue_whisper, notes}` — parse through
    `lib/ai/extract-json.ts::extractJsonArray` then coerce numbers with
    `parseLargeUSD` (both existing; same defenses as the PDF extractor).
  - Store: `upsertBogey` per hit with `source: 'newsletter'`,
    `source_label: <source_name>` — the UNIQUE(event_id, source,
    source_label) upsert updates in place on re-mention. Event matching by
    `issuerSiblings` fan-out to calendar rows in the window (the PDF
    path's matching, reused).
- Wiring: runs after `extractLevelsFromNewArticles` in BOTH
  `/api/research/sync` (SSE) and `/api/cron/research-sync` — same
  incremental-by-construction guarantee (scanned-marker means each article
  is Claude-read once).

**TMT reminder — extend `lib/calendar/coverage-guard.ts` sibling logic**

- `lib/earnings/bogeys-reminder.ts` (new):
  `renderBogeysReminderLine(db, weekOf): string | null` — non-null when
  (a) ≥3 held/watchlist reporters have events in `[weekOf, weekOf+4d]`
  AND (b) zero `earnings_bogeys` rows exist for those events. Rendered
  into the Sunday briefing at SEND time (the coverage-guard precedent in
  `lib/digest/send-briefing.ts` — appended by code, never via the AI
  prompt). One deterministic sentence: "N names report this week with no
  bogeys uploaded — the TMT Breakout weekly PDF usually covers ⟨symbols⟩."

### Failure modes

| Failure | Behavior |
|---|---|
| Claude returns prose/malformed JSON | extractJsonArray isolates or errors loudly; article NOT marked scanned (retries) |
| Article mentions no upcoming reporter | Marked scanned, no AI call |
| Same newsletter re-covers a name | Upsert updates in place |
| Reminder week has bogeys | Line omitted |

### Testing

Scanned-marker semantics (skip/retry), symbol pre-filter (no AI call
without a mention), JSON parse + coercion, family fan-out event matching,
upsert idempotence, reminder line threshold + suppression, briefing
send-time wiring.

---

## Part B — Same-day transcripts (#12)

### What

After a held/watchlist reporter's print completes enrichment, fetch its
call transcript (providers lag hours — retry each sweep tick until found or
a 36h deadline), Claude-summarize it, and surface: a "Call transcripts"
block in the NEXT morning digest + the existing Security Detail
TranscriptCard. No push (push-at-print already covered the numbers).

### Decisions (locked with user, 2026-07-16)

- **Retry-fetch + morning digest block + card** — no recap coupling, no
  extra push.
- **New feature key `transcriptSummary` → `$workhorse`** — structured
  desk-note summary (guidance / tone / surprises / key quotes), same
  fields as `CallNoteModal` so the surfaces rhyme. Replaces the extractive
  `generateSummary` output for these fetches (the heuristic stays as the
  fallback when the AI call fails).

### Architecture

**Orchestration — `lib/transcripts/same-day.ts` (new)**

- `fetchSameDayTranscripts(db, opts?: { now? })` — runs as a best-effort
  step at the END of `runEarningsEmailSweep` (after `alertBlockedRecaps`;
  never throws, never blocks the sweep):
  - Candidates: earnings events (held/watchlist, family-deduped) with
    `actual_value IS NOT NULL` and event_date within the last 36h, having
    NO cached transcript for (ticker, year, quarter) yet and NO exhausted
    marker. Attempt pacing: reuse the event row — new nullable column
    `transcript_attempted_at` on `calendar_events` (migration), ≥30 min
    between attempts per event; give up silently past 36h.
  - Fetch: existing `fetchTranscript` chain (cache → API Ninjas → Alpha
    Vantage → EDGAR). Quarter derivation: existing
    `deriveFilingReportingQuarter(event_date)`.
  - Summarize: when a transcript arrives WITHOUT a provider summary, run
    `generateTextForFeature("transcriptSummary", …)` over capped
    transcript text (~50k chars) with the structured desk-note prompt;
    store into `earnings_transcripts.summary` (+ `guidance` when the
    model returns it). AI failure → keep the extractive `generateSummary`
    result (existing behavior).
- Cap: ≤2 fetch attempts per sweep tick (Alpha Vantage free tier is
  25/day; a 5-name night converges over a few ticks).

**Digest block — `lib/digest/call-transcripts.ts` (new)**

- `composeCallTranscriptsBlock(db, opts?: { today? })` → `string | null`:
  transcripts cached in the last 24h for held/watchlist tickers, rendered
  as `## Call transcripts` with per-name 2-4 line summary extracts +
  guidance line. Wired morning-edition-only in
  `generateDigestSinceAdaptive`, after the Today's-reporters block. Null
  when none (self-quiets). Never throws.

**Card:** `TranscriptCard` reads `earnings_transcripts` already — new rows
appear with zero UI work.

### Failure modes

| Failure | Behavior |
|---|---|
| Provider has nothing yet | Retry next tick (≥30 min pacing) until 36h |
| All providers miss forever | Silent stop at 36h (EDGAR 8-K usually catches it) |
| AI summary fails | Extractive summary kept |
| Sweep pressure | ≤2 attempts/tick, never blocks emails |

### Testing

Candidate selection (held, actual-required, 36h window, pacing column,
cached-transcript exclusion), per-tick cap, summary-generation branch
(mock `generateTextForFeature` — AI-mocking memory pattern), extractive
fallback, digest block rendering + 24h window + morning-only wiring,
never-throws.

### Out of scope (both parts)

Worker mirrors (transcript fetch + bogey extraction are Mac-only — both
need API keys and DB writes the snapshot path doesn't carry; cloud
mornings simply lack the transcript block), per-pair mute controls,
transcript push notifications, whisper-number sourcing beyond newsletters.
