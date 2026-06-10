# Digest Redesign: Edition-Aware Structured Composer

**Date:** 2026-06-09
**Status:** Approved (user-selected Approach B)
**Scope:** Morning Research Digest + Evening Recap emails (Mac path + Worker fallback mirror). The Sunday briefing and earnings emails are out of scope.

## Problem

A 30-day audit (2026-05-10 → 2026-06-09, ~510 emails, 28 sources) of the research feed found:

1. **Two fire-hose sources are 37% of volume** and have fixed daily edition clocks:
   - **Vital Knowledge** (138 emails, 5.5/day): Dawn ~5:20am, BMO company news ~7:20am, Mid-Day ~11am, Market Recap 16:04, AMC company news ~16:45, ~1.4 one-off thematic notes/day, Friday Catalyst Watch + Talking Points, Sunday Weekend edition. Dawn → Mid-Day → Recap is the same session narrated three times.
   - **TMT Breakout** (52 emails, 2.3/day): Morning Wrap ~8:35am (research-note roundup), EOD Wrap ~17:25 (market moves), occasional one-off notes.
2. **Cross-source overlap is structural**: META was mentioned by 20 sources (97 source-day pairs) in 30 days; NVDA 17; AMZN 19; INTC 14. The current per-source layout re-tells the same story 3–6×.
3. **Send-time boundaries clip the best wraps**: TMTB Morning Wrap arrives 8:14–8:48 vs. the 8:45 send (missed at least once → arrived 10h stale in the evening email); Friday EOD Wrap can arrive 21:32 vs. the 17:30 Friday send (→ 60h stale on Monday).
4. **Stale-window bug**: `last_digest_sent_at` is only written by Mac-side sends. When the cloud fallback wins (it won every send 6/4 evening → 6/9 morning), the Mac pointer goes stale; the next Mac-won email re-covers old ground (observed 6/9 7pm: window opened at June 4, trimmed to ~June 8 by the 30-article cap).
5. Content splits cleanly into **market commentary** (time-sensitive, repetitive by design) and **research essays** (timeless, near-zero overlap, avg 15–40k chars) — the pipeline currently treats both identically.

## Decisions (user-confirmed)

| Question | Decision |
|---|---|
| Job of each email | **Complete record, better organized** — each email stands alone; grouped by story, not source; edition-aware collapsing. Some cross-email repetition is acceptable by design. |
| Send-time boundaries | **Keep times** (8:45 / Mon–Thu 19:00 / Fri 17:30) **+ late-arrival rescue block** at the top of the next email. |
| Essays | **Research Desk section** (one summary per essay, never merged) **+ cross-file pointers** into a held/watchlist name's story section when the essay covers it. |
| Cloud fallback | **Mirror the structure, accept less depth** (≤10 articles, no TWS blocks). |

## Email layout

Both emails share one skeleton; the narrative header and anomalies block differ by edition:

```markdown
# Evening Recap — Tuesday, June 9          ← or "Morning Research Digest"
28 articles from 11 sources

## ⏰ Late arrivals                          ← only when non-empty
- **TMTB Morning Wrap** (arrived 8:48, just after this morning's email) — per-article summary…

## Price Levels Triggered                    ← existing block, unchanged
## Significant Moves in Vanguard Holdings    ← existing anomalies block (evening only)

## The Session                               ← morning version: "## Overnight & Setup"
One coherent narrative synthesized from the commentary stream, editions collapsed
(VK Dawn→Mid-Day→Recap told once), with inline source citations.

## Your Names                                ← held first, then watchlist, then notable others
### NVDA (NVIDIA)
Merged cross-source coverage for the window, with citations.
📄 *Deep dive today: MBI Deep Dives — "Title" (see Research Desk)*   ← cross-file pointer
### INTC (Intel)
…

## Research Desk                             ← one entry per essay, rendered in code
- **Stratechery** — [Title](url): existing per-article AI summary.

## Also covered
SNOW (VK AMC), CRDO (TMTB) — one-line roll-up of thin coverage.
```

Every article lands in exactly one home: Late arrivals, The Session, a name group, Research Desk, or Also covered.

## Components

### 1. `lib/digest/editions.ts` (new) — pure functions, no DB changes

- `SOURCE_KINDS: Record<string, "commentary" | "essay">` keyed by `research_sources.name`. Unknown sources default to **essay** (safe: listed individually, never merged).
  - **commentary**: Vital Knowledge, TMT Breakout, Purple Drink's Market Musings, Helene Meisler, Torsten Slok, TBPN, James Bulltard, FundaAI, JRo's Notes.
  - **essay**: Stratechery Updates, The Diff, MBI Deep Dives, Semi Doped, Eliant Capital, Paul Kedrosky, Sam Ro from TKer, Liberty's Highlights, BEP Research, Simon Willison, Irrational Analysis, Mobile Dev Memo, Bloomberg Odd Lots, Northbeam - The Media Buyer, Consumer Ascent, TickerTrends Research, Sharp Text, Emerging AI, Investing With Martin.
  - Classifications are best-effort and live in one constant; moving a source between kinds is a one-line edit.
- `classifyEdition(sourceName, subject): { edition: string; supersedes: string[] }` — regex table:
  - Vital Knowledge: `dawn | bmo_news | midday | recap | amc_news | weekend | catalyst_watch | talking_points | one_off`; supersedence `recap ⊐ midday ⊐ dawn`.
  - TMT Breakout: `morning_wrap | eod_wrap | note`.
  - All other sources: `standalone`, no supersedence.
- Design note: an earlier draft had a third source kind `company_pulse`; dropped — VK's BMO/AMC blasts are *editions* of a commentary source, and `bucketByCompany` already routes their content into per-symbol buckets.
- Worker mirror: `workers/cron/src/editions.ts` is a byte-parity hand-copy (same pattern as `presence-position.ts`), parity-tested.

### 2. Composer rework — `lib/digest/daily-digest.ts`

`generateDigestSinceAdaptive` becomes the structured composer:

- Article cap raised **30 → 40** (`getRecentArticles` limit). Edition collapsing keeps synthesis input tokens roughly flat; 40 covers heavy Mondays (weekend accumulation peaked at ~28 eligible this month).
- `<5` articles: existing per-source fallback path unchanged (including `recordSynthesisFallback` telemetry).
- `≥5` articles, routing:
  1. **Late arrivals** (see §3) are extracted first and excluded from all other sections.
  2. **Essays** (by `SOURCE_KINDS`) → Research Desk, rendered in code from existing per-article summaries (subject link via `source_url || website_url`, summary, themes line). No AI call.
  3. **Commentary** articles → existing `bucketByCompany` → macro bucket + symbol buckets → **one Sonnet call** (existing feature key `dailyDigestSynthesis`).
- Synthesis prompt (in `lib/digest/synthesize.ts`) gains:
  - Edition labels per article (`[VK · recap]`, `[TMTB · morning_wrap]`) and a supersedence rule: "When multiple editions of one source narrate the same session, tell the day ONCE chronologically; treat later editions as superseding earlier ones; note intraday reversals as reversals."
  - Output contract: `## The Session` (morning: `## Overnight & Setup`) first, then `## SYM (Name)` sections (held tickers mandatory — existing pinned rule), then `## Also covered`.
  - All three existing pinned rule blocks carry over verbatim (COVERAGE-CHARACTERIZATION, HELD-TICKER PRIORITIZATION, TIMEFRAME & THREAD COHERENCE), still pinned by `tests/digest/synthesize.test.ts`.
- **Cross-file pointers** are deterministic post-processing, not prompt instructions: for each essay whose `mentioned_symbols` (expanded via `issuerSiblings`) intersects held ∪ watchlist, find the matching `## SYM` section in the AI output and append a `📄 *Deep dive today: …*` line. No matching section → essay appears in Research Desk only.
- Final assembly order: title/count → late arrivals → alerts → anomalies (evening only) → AI sections → Research Desk.

### 3. Late-arrival rescue (pure code)

An article is **late** when `datetime(received_at)` falls within **60 minutes after the previous email's send time** (= the `sinceSnapshot` the composer already captures). Late articles render at the top with their per-article summary and an "arrived just after this morning's email" note, and are excluded from synthesis buckets / Research Desk to avoid duplication. Catches the 8:48 TMTB Morning Wrap (leads the evening email) and a 21:32 Friday EOD Wrap (leads Monday morning).

### 4. Stale-marker fix

- Worker: `cloud-sent-{type}-{date}` KV marker value becomes JSON `{ "sentAt": "<ISO>" }`; `/internal/marker` response includes it. Old-format markers ("1"/date string) tolerated.
- Mac: `lib/cron/marker-check.ts::checkCloudMarker` returns `sentAt` when present. In `app/api/cron/{digest,evening}/route.ts`, the `"cloud already sent"` skip path now also calls `setLastDigestSentAt(db, sentAt ?? now − 30min)`. The 30-minute fallback overlap risks a small duplication, which is acceptable ("complete record"); a dropped article is not.

### 5. Worker fallback mirror

`workers/cron/src/fallback-digest.ts` + `fallback-evening.ts` adopt the same section skeleton: editions copy, same prompt section rules (extending the existing `buildSynthesisPrompt` mirror), Research Desk rendered in code from the per-article analysis the Worker already produces. Constraints accepted and disclosed in the footer: ≤10 articles, no alerts/TWS-dependent blocks. Error-counter observability pattern unchanged.

### 6. Preview

`GET /api/digest/preview` returns `{ structuredHtml, bySourceHtml, byCompanyHtml, since, empty }`; `<DigestEmailViewer>` defaults to the structured view with the existing toggle extended. This is the eyeball-before-it-emails surface.

## Testing

- `tests/digest/editions.test.ts` — every edition regex pinned against real subject lines sampled from the 30-day window (subjects are public content, safe as fixtures); SOURCE_KINDS completeness check against the known source list; unknown-source default.
- Composer tests (mock `getModelForFeature` per the AI-mocking convention): section assembly order, essay → Research Desk routing, cross-file pointer insertion, late-arrival extraction + exclusion, `<5`-article fallback intact, alerts/anomalies blocks unchanged, 40-cap.
- `tests/digest/synthesize.test.ts` — extended to pin the new output contract + edition supersedence rule alongside the three existing pinned blocks.
- Worker: parity test that Mac and Worker edition tables are byte-identical; fallback composition tests updated.
- Marker fix: route tests for the skip path writing `last_digest_sent_at` (both routes), old-format marker tolerance.

## What does NOT change

Send times (8:45 / Mon–Thu 19:00 / Fri 17:30), per-article ingest summarization (`processUnprocessedArticles`), alerts + anomalies block internals, the cron/marker dedup dance, Resend plumbing, D-tier relevance filtering, Sunday briefing, earnings emails.

## Rollout

1. Mac path + tests + preview first; verify via `GET /api/digest/preview` against live data.
2. Worker mirror + parity tests; `wrangler deploy`.
3. Watch the next 3–4 real sends for prompt drift (model self-talk, edition collapsing quality) before declaring done.
