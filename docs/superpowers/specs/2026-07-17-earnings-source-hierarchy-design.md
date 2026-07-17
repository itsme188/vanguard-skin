# Earnings Source Hierarchy — Design

**Date:** 2026-07-17
**Status:** Approved (brainstorming session)
**Supersedes:** the "Earnings preview — source hierarchy work" TODO item (docs/plans/TODO.md), scoped 2026-04-27.

## Problem

The earnings preview/recap composer (`lib/digest/send-earnings-email.ts`) treats its newsletter sources as a flat, hardcoded, equal-weight list (`PREFERRED_SOURCE_IDS` — 5 sources). Three defects:

1. **Starvation.** Tier 2 (any source, 30 days) fires only when tier 1 (preferred, 7 days) returns *zero* rows. One stale 6-day-old passing mention from a preferred source suppresses a fresh, detailed preview from a non-preferred one.
2. **No priority.** Within tier 1, pure recency ordering means a passing technicals mention can crowd out a bogies table under the 80k context cap — the exact wrong outcome for an earnings preview.
3. **No source semantics.** The composer doesn't know TMT Breakout carries bogies tables while Helene Meisler is technicals color; the model has to infer how to read each source from scratch every time. Cross-source repetition (same consensus numbers in 4 articles) burns cap space and prompt attention.

## Decisions (from brainstorming)

- **Manual ranking now, data later.** The user orders the list; schema leaves room for a future hit-rate signal. No earnings-grading subsystem this session.
- **Profiles = prompt guidance notes.** A short per-source "how to read this" note injected into the prompt. No pre-extraction AI pass — #11 (newsletter bogey auto-extraction, shipped 2026-07-16) remains the structured-numbers path.
- **Dedup = editions supersedence + prompt instruction.** Deterministic same-source same-day edition dropping via `lib/digest/editions.ts`, plus a framing instruction to collapse repeated cross-source claims with multi-source attribution. No AI dedup pre-pass.
- **Earnings-only consumer.** The Sunday briefing keeps its own hardcoded deep-read list. Revisit unification later.
- **Storage = columns on `research_sources`** (Approach A). A source's earnings note describes the source; it should die when the source dies and be edited where sources are edited (`ManageSourcesModal`, the `allow_off_topic` precedent). Settings JSON (Approach B) was rejected: Electron-only UI, no referential integrity, splits source config across two homes.

## Section 1 — Data model & API

**Migration `068_earnings_source_hierarchy.sql`:**

```sql
ALTER TABLE research_sources ADD COLUMN earnings_rank INTEGER;
ALTER TABLE research_sources ADD COLUMN earnings_note TEXT;
```

- `earnings_rank` non-NULL = in the hierarchy, ascending (1 = highest trust). NULL = general pool.
- `earnings_note` = per-source prompt guidance. Nullable; a ranked source without a note is fine.

**Seed in the same migration** — the 5 current preferred sources get ranks 1–5 in existing constant order:

| Rank | id | Source |
|------|----|--------|
| 1 | 1 | Vital Knowledge |
| 2 | 8 | TMT Breakout |
| 3 | 18 | Eliant Capital |
| 4 | 19 | Purple Drink's Market Musings |
| 5 | 28 | Helene Meisler |

TMT Breakout also gets a seeded note: `Morning Wrap carries sell-side bogies tables — quote exact numbers.` Seed UPDATEs are id-guarded (`WHERE id = N`) and no-op harmlessly on DBs without those rows (test DBs).

**Cutover is atomic:** the composer reads only from the DB; `PREFERRED_SOURCE_IDS` is deleted. No dual code paths, no fallback constant — migrations run at startup, so the seed is guaranteed before the first post-upgrade compose. (Rationale: seeding inside the migration is the moment of ownership transfer from code to data; a code fallback would leave two sources of truth alive forever.)

**Read path:** `getEarningsSourceHierarchy(db)` in `lib/queries/research.ts` → ordered `{id, name, earnings_rank, earnings_note}[]` (non-NULL ranks only, rank ascending).

**Write path:** extend `PATCH /api/research/sources` (and `lib/mutations/research.ts` behind it) to accept `earnings_rank: number | null` and `earnings_note: string | null`. Validation: rank must be a positive integer or null; note trimmed, empty string stored as NULL. Reordering = a few sequential PATCHes from the modal (≤10 items; no batch endpoint). The server does NOT enforce rank uniqueness (the client keeps ranks dense, but a mid-sequence PATCH failure can leave a duplicate); every rank-ordered read breaks ties by `id ASC` so ordering stays deterministic.

## Section 2 — Selection algorithm

`getNewsletterContext` (in `send-earnings-email.ts`) is rewritten as **rank-ordered fill**:

1. **Candidate fetch** — one query: all sources, last 7 days, family-matched (issuerSiblings-expanded symbols, as today), `processed_at IS NOT NULL`, `COALESCE(is_relevant,1)=1`, `LIMIT 30`. Row carries `earnings_rank`/`earnings_note` via the source join.
2. **Edition supersedence** — group candidates by (source, ET-day of `received_at`); classify subjects with `classifyEdition`; drop any article superseded by a later same-day edition of the same source (VK Dawn dies to the Mid-Day Update). Runs BEFORE the fill loop so no slot is spent on an article about to be discarded.
3. **Ordering** — ranked sources first (rank ascending), then unranked sources; recency descending within each source. This order governs both slot allocation and prompt position.
4. **Fill** — walk that order taking up to 6 articles under existing caps (`ARTICLE_BODY_CAP` 8k/article, `TOTAL_CONTEXT_CAP` 80k total). Unranked articles fill remaining slots — the starvation bug dies.
5. **Backstop** — zero 7-day candidates → re-run at 30 days (any source, same pipeline). Matches today's tier-2 semantics.

No per-rank byte quotas: rank controls admission and order only; uniform 8k/article. (Quotas add config surface for negligible gain at 6 articles.)

`getNewsletterContext` becomes exported for direct testing against in-memory DBs (the `renderHeadlineTable` precedent).

## Section 3 — Prompt rendering & dedup instruction

`renderNewsletterBlock` changes:

1. **Rank order + notes.** Articles render in the Section 2 order. A source's `earnings_note` renders once — on its first article only — as a `> How to read this source: …` line under that article's header. Repetition per-article is deliberately avoided (token burn + trains the model to skim it).
2. **Trust-order framing.** The preamble states sources appear in the user's trust order: when sources conflict, weight the earlier-listed source's framing more heavily, but always surface the disagreement.
3. **Dedup instruction (in the framing text, not the system prompt):** where multiple sources make the same factual claim (a bogey, a price target, a sell-side note), collapse it into one statement with multi-source attribution ("VK and TMT Breakout both flag $2.35 whisper") rather than repeating per source. Content-shaping guidance rides with the content block it governs; `callClaude`'s system prompt stays the format-discipline layer.

Preview and recap share the rendering; only the existing phase-specific framing sentence stays distinct.

**No Worker changes.** The cloud earnings fallback deliberately omits newsletter context (documented anti-divergence decision) — no mirror, no snapshot schema bump.

## Section 4 — UI & testing

**UI — `ManageSourcesModal` gains an "Earnings hierarchy" section** above the existing source list:

- Ranked sources in order: rank number · name · ↑/↓ buttons · remove button · inline note field (text input, saved on blur).
- Honest button feedback per convention: check `res.ok` AND `data.success`; optimistic updates reverted-and-said-so on failure.
- Each source row in the main list gets a **"+ earnings" chip-button** (sibling of "off-topic OK") appending the source at rank max+1.
- Reorder/remove renumbers client-side to dense 1..N and PATCHes only changed rows. Plain buttons — no drag-and-drop, no carets.

**Testing:**

- Query tests: `getEarningsSourceHierarchy` ordering, NULL-rank exclusion.
- Selection tests (the meat): starvation fix (stale ranked + fresh unranked both admitted), supersedence drop (VK Dawn vs same-day Mid-Day), rank-then-recency ordering, 30-day backstop only on zero 7-day hits, cap enforcement.
- Render tests: note once per source, dedup instruction present, trust-order framing pinned (synthesize prompt-pin style).
- Route/mutation validation tests for the PATCH extension.
- Full suite (`npx vitest run`) before commit.
- E2E: dev server + browser agent — Manage sources: add/reorder/remove, edit note, persistence across reopen. Then `scripts/fire-earnings-emails.ts preview <date> --dry-run` to inspect a real composed prompt.

**Docs:** CLAUDE.md conventions bullet (earnings source priority lives in `research_sources.earnings_rank`, never a constant), TODO.md item checked off.

## Out of scope

- Earnings hit-rate grading / automatic ranking (future; schema accommodates via a later column or joined table).
- Briefing deep-read list unification.
- AI pre-extraction or AI dedup passes.
- Worker/cloud-fallback newsletter context (deliberately absent today; stays absent).
