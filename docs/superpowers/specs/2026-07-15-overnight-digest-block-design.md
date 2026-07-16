# Overnight block in the morning digest — design

**Date:** 2026-07-15
**Status:** Approved (brainstorm session 2026-07-15 evening)

## What

A deterministic `## Overnight` block in the **morning digest email only** (`edition === "morning"`), showing the overnight Asia/crypto session as scannable percentage moves, optionally followed by 1–2 sentences of overnight commentary extracted from Vital Knowledge's Dawn edition.

```
## Overnight

KOSPI +0.8% · Bitcoin −2.1% · Nikkei +1.2% · Hang Seng −0.3%

> Asia traded firm overnight with chips leading Korea higher; crypto
> faded after the ETF-flows print. — Vital Knowledge
```

## Why

The user's morning read starts with "what happened while I slept": Korea → bitcoin → Japan → China. Today that context lives only inside VK's prose deep in the digest. This block puts the numbers at the top, deterministically, on both the Mac and cloud delivery paths.

## Decisions (locked with user)

- **Instruments, fixed order:** KOSPI (`^KS11`), Bitcoin (`BTC-USD`), Nikkei (`^N225`), Hang Seng (`^HSI`). No US futures, no Europe, no macro complex (offered, declined).
- **China proxy:** Hang Seng only.
- **Commentary:** targeted AI extract from VK Dawn (NOT the stored general summary, NOT synthesis-woven). New feature key `overnightCommentary` → `anthropic/$cheap` tier. Missing Dawn or AI failure → numbers-only block.
- **Surfaces:** Mac morning email + Worker cloud fallback digest (numbers-only — no AI extract in the Worker, to avoid cost/divergence; VK Dawn's summary already appears in the cloud digest body). No Today-view surface. No evening email.
- **BTC window:** latest print vs prior UTC daily close (Yahoo's native convention), not "since 4pm ET".
- **Holiday guard:** a market whose latest close is >3 calendar days old renders `<Label> closed` instead of presenting a stale move as fresh.

## Architecture

### Mac — `lib/digest/overnight.ts` (new)

- `OVERNIGHT_INSTRUMENTS`: the four `{symbol, label}` pairs in display order.
- `fetchOvernightMoves(opts?)`: per instrument, reuse `lib/quotes/yahoo-daily.ts::fetchYahooDailyCloses` over a trailing ~10-day window; move = last close vs prior close. Returns `OvernightMove[]` where each is `{label, pct}` or `{label, closed: true}` (holiday guard vs `todayET()`, injectable `now` for tests). A symbol with <2 closes (fetch failure) is dropped from the array. Injectable fetcher for tests.
- `renderOvernightBlock(moves, commentary)`: pure renderer. Empty `moves` → `null` (block omitted entirely). Signed one-decimal percents joined with `·`; commentary as a `>` blockquote with an em-dash `— Vital Knowledge` attribution rendered **in code** (never by the model).
- `extractOvernightCommentary(db)`: find today-ET's processed VK article whose subject classifies as the `dawn` edition (`lib/digest/editions.ts::classifyEdition`); send capped `raw_text` (~12k chars) through `generateTextForFeature("overnightCommentary", …)`; prompt: extract ONLY what the note says about the overnight Asia / crypto / futures session, ≤2 sentences, plain text, no preamble. Any failure → `null` (numbers-only). Never throws.
- `composeOvernightBlock(db)`: orchestrator used by the digest — fetch + extract in parallel, render. Never throws; total failure logs one line and returns `null`.

### Wiring — `lib/digest/daily-digest.ts::generateDigestSinceAdaptive`

New deterministic block for `edition === "morning"` only, positioned after the alerts block and before essay/synthesis composition (the morning mirror of the evening-only anomalies slot). The digest never fails or blocks on this section.

### Worker — `workers/cron/src/overnight.ts` (new, numbers-only)

- `fetchOvernightMovesWorker()`: ONE Yahoo `spark` request for all four symbols (`range=7d&interval=1d`) — parses `timestamp` + `close` arrays itself (the existing `fallback-evening.ts::fetchLast2ClosesBatch` drops timestamps, which the holiday guard needs; that helper stays untouched). Same move/holiday semantics as the Mac. Never throws; failure → `[]`.
- `renderOvernightLines(moves)`: pure; byte-compatible block shape with the Mac renderer minus the commentary quote.
- Wired into `runFallbackDigest`: fetch before compose, pass into `composeDigestMarkdown` as a new optional param rendered above the article sections. **Subrequest budget: 48 → 49 of 50** (one spark call). Graceful null keeps the 5/20 lesson: a Yahoo outage degrades to "no overnight block", never a failed email.

### AI plumbing

- `lib/ai/feature-keys.ts`: add `"overnightCommentary"`.
- `lib/ai/models.ts::FEATURE_MODELS`: `overnightCommentary: "anthropic/$cheap"`.

## Failure modes

| Failure | Behavior |
|---|---|
| One symbol's Yahoo fetch fails | That line dropped; others render |
| All four fail | Block omitted, one warn log; digest unaffected |
| Asian market holiday | `<Label> closed` line |
| VK Dawn not yet arrived / no dawn match today | Numbers-only block |
| Claude extract fails/refuses | Numbers-only block |
| Worker Yahoo outage | Cloud digest without the block |

## Testing

- `tests/digest/overnight.test.ts`: pct math + sign formatting, holiday staleness boundary (3 calendar days), per-symbol drop on missing closes, empty-moves → null render, blockquote + attribution rendering, extract with mocked `generateTextForFeature` (AI-mocking memory pattern), dawn-edition selection (ignores midday/recap and other sources), never-throws orchestrator.
- Composer test: morning edition includes the block when the composer succeeds; evening edition never calls it.
- Worker `test/overnight.test.ts`: spark parse (timestamps + closes), holiday guard, single-request batching, graceful `[]` on non-ok/throw; fallback-digest wiring test pins block placement + that a `[]` result leaves the digest identical to today's output.

## Out of scope

Today-view surface, evening email, US futures / Europe / FX / rates lines, storing moves in the DB, Worker-side commentary.
