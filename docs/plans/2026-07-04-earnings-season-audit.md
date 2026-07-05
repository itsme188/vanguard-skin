# Earnings Tools — Pre-Season Audit (2026-07-04)

Earnings season starts ~2026-07-14 (big banks). This audit covers: (1) inventory of existing earnings tooling, (2) verified bugs, (3) real data health from last season (Apr–Jun 2026), (4) improvement survey for supporting multiple calls/day at peak.

Produced by 4 parallel agents: inventory sweep, Mac-pipeline bug hunt, Worker/UI bug hunt, DB data audit. All bug findings cite file:line and were verified by reading code; data findings are real queries against `data/vanguard.db`.

---

## 1. Inventory (what exists today)

**Ingest** — `lib/calendar/finnhub.ts` (per-held-stock earnings scan), `lib/calendar/nasdaq.ts` (cross-check source), `lib/calendar/reconcile-earnings-dates.ts` (date conflict resolution + supersession), `lib/calendar/sync.ts` (orchestrator), `app/api/calendar/events` (manual CRUD). Migrations 041 (enrichment cols), 057 (date cross-check).

**Enrich** — `lib/calendar/enrichment-runner.ts` (windows, candidates, `findEmailCandidates`), `enrich-actuals.ts` (Finnhub actuals), `reaction-snapshot.ts` (T−5m vs T+120m vs SPY/QQQ/TLT + sector ETF), `release-times.ts`. Cron: launchd every 15 min → `/api/calendar/enrich`.

**Email** — `lib/digest/send-earnings-email.ts` (64KB composer: scoreboard, bogeys block, read-throughs, notes-first prompt, web_search), `/api/cron/earnings-sweep` (the production trigger), `/api/cron/earnings-{preview,recap}` (per-event routes with marker dance — **dead code, nothing calls them**), `earnings_emails` (042) + `earnings_email_skips` (045) + settings.

**Bogeys** — `lib/earnings/extract-bogeys.ts` (PDF → Claude), `earnings_bogeys` (043), upload + CRUD routes, `BogeysEditModal`.

**UI** — `EarningsHub.tsx` (Today-page terminal grid), `EarningsRowChips`, `EarningsEmailViewer`, `EarningsDateChip`/`EarningsDeleteButton`/add-form, `TodayReleases`, briefing sections, `EarningsEmailsSection` settings.

**Cloud fallback** — `workers/cron/src/fallback-earnings.ts` (compact email from 2am R2 snapshot + live IBKR), `earnings-markers.ts` (KV), `calendar-enrich.ts` (Yahoo bars, actuals).

**Scripts** — `fire-earnings-emails.ts`, `sweep-earnings-emails.ts`, `preflight-earnings-data.ts`, `backfill-symbol-release-times.ts`, `check-held-earnings.ts`, `audit-finnhub-actuals.ts`.

**Test-coverage gaps noted**: no direct unit tests for `send-earnings-email.ts` core renders (`renderHeadlineTable`, `composeEarningsEmail`), none for `finnhub-figure.ts`, none for the Mac-side marker dance or cron routes (Worker side is tested — asymmetric), no shared type pinning Mac/Yahoo reaction JSON parity. `app/api/earnings/actuals/route.ts` re-declares a local `parseFinnhubFigure` (drift risk).

---

## 2. Bugs (verified, ranked)

### P0 — will produce wrong or duplicate emails during season

**B1. Double-send: the marker dance is dead code.** The production path (`scripts/enrich-calendar-events.sh` → `/api/cron/earnings-sweep` → `sendEarningsPreview/Recap` in-process, `app/api/cron/earnings-sweep/route.ts:42-49`) never checks `cloud-sent-*`, never writes `mac-sent-*`/`mac-running-*`. The marker logic exists only in `/api/cron/earnings-{preview,recap}` which nothing calls (`runEmailSweep` in `enrichment-runner.ts:567-607` is dead code). Meanwhile the Worker `runEarningsFallback` fires every 15-min tick Mon–Fri 05:00–20:00 ET with **no Mac-alive check and no Mac-primary attempt** — its only dedup is the 2am snapshot's audit rows (can never contain same-day sends) + the KV markers the Mac never writes. Both sides compute the same [T−135m, T−105m] window → **every held-name preview double-sends whenever the Mac is awake** (rich Mac + lean cloud). Masked last season only because most prints coincided with Mac-asleep travel. *Found independently by both bug agents.*

**B2. Single-shot enrichment permanently kills recaps + reactions.** `updateEnrichment` (`enrichment-runner.ts:182-190`) stamps `enriched_at` unconditionally on the first attempt; `findCandidates` requires `enriched_at IS NULL` → exactly one try, 5–20 min after release. If Finnhub hasn't posted actuals yet (common at T+15 for AMC), `actual_value` stays NULL forever → recap gate never passes → **no recap, no error surfaced**. Reactions can *never* exist at the first tick (post bar is T+120, in the future) so the 12h earnings window is defeated; the Worker cloud-enrich accidentally backfills some (it sees the stale snapshot as unenriched) but its gate closes 17:59 ET — before AMC T+125 ≈ 18:20 — so **AMC reactions are structurally unrecoverable on both paths**. When Finnhub *does* have actuals at T+15, the recap fires mid-conference-call with a "—" reaction row. **Season data confirms**: 9 of the 10 preview-without-recap names (UUUU, XMTR, MP, NET, PURR, REAL, SPHR, PL, RBRK) have `enriched_at` set + `actual_value` NULL; all 20 captured reactions are `source='yahoo'`, zero TWS; reactions stopped entirely after 5/5 (NVDA recap had no reaction).

**B3. Sweep concurrency dupes.** `enrich-calendar-events.sh` gives the sweep POST 240s, then falls back to :3000, then `npx tsx sweep-earnings-emails.ts`. Each Claude compose with web_search takes 60–180s, so 2-3 candidates in one tick exceed 240s → curl times out while the server keeps composing → the fallback tier re-runs `findEmailCandidates` and re-sends everything in flight (audit rows are written only *after* each send). Up to 3 concurrent sweeps on the same candidates. Same shape as the 2026-04-27 digest race, unpatched here.

**B4. Mid-week calendar sync cascade-deletes user-curated earnings data.** `syncCalendarForWeek` calls `deleteUnenrichedEventsForWeek` (`lib/mutations/calendar.ts:352-367`) every run; every pre-release earnings row is by definition unenriched, and `earnings_emails`, `earnings_email_skips`, `earnings_bogeys` all CASCADE on delete. One "Refresh from Finnhub" mid-week: muted skips vanish (muted email fires anyway), uploaded bogeys vanish, preview-sent audit rows vanish (chips reset, possible re-send), and rows reinsert with new autoincrement ids orphaning every KV marker/snapshot reference. The 2026-07-02 `repointChildren` fix covered supersession but not this hard-delete path.

**B5. Recap prompt inflates reaction percentages 100×.** `formatReactionSnapshot`'s `pctSign` (`send-earnings-email.ts:844-847`) does `(v*100).toFixed(2)` on a value already in percent → the Claude prompt says "SPY: +41.00%" for a 0.41% move, while the deterministic scoreboard in the same email shows the correct number. One-line fix.

### P1 — coverage and correctness gaps

**B6. Finnhub foreign-suffix actuals miss.** `enrich-actuals.ts:329` exact-matches `e.symbol === symbol`, but Finnhub returns `GFL.TO` for a `GFL` query (the exact bug already fixed on the sync side, `finnhub.ts:97-105`). Combined with B2: actuals permanently null, recap never fires for foreign-listed names.

**B7. Shorts invisible/wrong in earnings emails.** Mac composer `getCrossAccountPositions` filters `h.quantity > 0` (`send-earnings-email.ts:596`) making the short-exposure branches unreachable — a short position into a print gets "does NOT currently hold X". Worker side: snapshot excludes shorts AND the live-IBKR summary sums signed quantities then `Math.abs` (long 500 + short 300 prints "200 shares"). `formatCombinedExposurePresence` exists on the Mac but is missing from the Worker mirror.

**B8. Cloud recap path is dead exactly when traveling.** Worker recap candidates need `enriched_at` from the 2am snapshot; same-day AMC enrichment can't be in it → no cloud recaps when the Mac is asleep (the stated purpose). When it does fire: it renders `actual_value ?? consensus_value` in the **Actual** column (the "estimates dressed up as actuals" failure 921d552 eliminated on the Mac), reads only `consensus_estimate` for cons, has no `isPlausibleEarnings` guard and no actual-required gate — and a dashes-only cloud recap would write a `cloud-sent` marker suppressing the real one.

**B9. Cloud-enrich reconcile clobbers actuals with NULL** (only if `CLOUD_ENRICH_ENABLED=true`). `lib/calendar/cloud-reconcile.ts:90-104` does unconditional `SET actual_value = ?` and never checks `payload.deferred` — a deferred/failed cloud payload overwrites a real Mac-captured actual with NULL, and the row never retries. Violates the "sync may only ADD data" invariant.

**B10. Option-only exposure isn't "held"; watchlist never gets events.** `getSymbolStatus` matches only stock symbols — a name held purely via options (OCC symbol) resolves "neither" → sweep drops it, no emails, even for manually-added events. And the Finnhub sync scans held stocks + read-through reporters only — watchlist symbols are never scanned, so the sweep's "watchlist" arm only ever fires for manual events.

**B11. Manual actuals override doesn't reopen the recap window.** `POST /api/earnings/actuals` keeps the old `enriched_at`; if the user fills a missed actual the next morning, the [enriched_at, +4h] window already expired → no recap, contradicting the code comment promising one.

**B12. Manual + Finnhub duplicate rows double-email until next sync.** `findEmailCandidates` has no symbol/date dedup (only `superseded=0`), and supersession runs only inside sync. Add-ticker over an existing Finnhub row → 2 previews + 2 recaps. Season evidence: NKE had finnhub 6/24 + nasdaq 6/30 rows for the same report; preview fired on the wrong one, no recap ever went out. UI corollary: the Hub's ROW_NUMBER prefers finnhub while reconcile prefers manual → pre-sync, the manual row is hidden and its delete button unreachable.

**B13. Worker subrequest blowout on clustered AMC nights.** `findCandidatesFromSnapshot` has no per-run cap (calendar-enrich caps at 10); every AMC name lands in the same preview tick at 5 subrequests each, sharing the invocation's 50-subrequest budget with calendar-enrich's Yahoo fetches → sends die mid-loop.

**B14. Cloud sends are invisible in the UI.** No Mac audit row is created for a cloud send → chips show "pending" for a delivered email, viewer 404s, user may re-fire manually.

### P2 — minor

- **B15.** `EnrichmentChips.tsx:144` parses SQLite `datetime('now')` with `new Date()` → "Invalid Date" on Safari (the user's browser), UTC-as-local elsewhere. `EarningsEmailViewer.formatSentAt` does it right — reuse.
- **B16.** `EarningsHub` wraps public consensus/actual EPS in `PrivateText` (violates "public market data stays visible" rule).
- **B17.** `callClaude` ignores `stop_reason === "max_tokens"` (4096 cap + big table + citations can truncate mid-table and send as-is).
- **B18.** `POST /api/earnings/actuals` replaces the whole `actual_value` — sending only EPS wipes stored revenue; route also re-declares a local `parseFinnhubFigure`.
- **B19.** Sign-flip actuals pass plausibility: U (+0.23 vs cons −0.24) and LAND (+0.08 vs −0.23) last season — GAAP-vs-adjusted / FFO basis mismatches; the ratio guard can't catch sign flips.
- **B20.** Worker held-check is symbol-string-equal — GOOGL event with GOOG held is dropped by the cloud fallback (no issuerSiblings walk).

---

## 3. Data health (last season + upcoming)

**Last season (Apr 1–Jun 30): 52 earnings events.** 100% had release_time; 58% got actuals; 38% got reactions; 87% enriched. 40 held-symbol events → 60% previewed, 57.5% recapped. All 62 sent emails had content (composer itself healthy). 2 skips used. Bogeys used exactly once (4/28 PDF: AMZN/GOOGL/META/MSFT).

**Failure funnel confirmed the bug analysis**: 10 preview-then-silence names (Finnhub actuals never arrived + single-shot enrichment); reactions all-yahoo/zero-TWS and dead after 5/5; NVDA recap shipped with no reaction.

**⚠ URGENT: July coverage hole.** Zero earnings events between 7/5 and 7/19 — the Finnhub sweep (last run 6/28) only populated weeks of 7/20 + 7/27. JPM, GS, BAC, NFLX, TSM report in the missing window. Run `syncCalendarForWeek` for weeks 2026-07-06 and 2026-07-13 within the next week (the 7/5 Sunday briefing sync covers 7/6's week; 7/13 needs its own pass).

**Held stocks with no upcoming event in 60 days (genuine gaps)**: AMD, BAC, BRK/B, CRWD, DIS, ET, FDS, GS, HD, IBKR, JPM, MELI, NFLX, SHOP, TSM, UBER, V, VRTX, XOM (plus ETFs mistyped as stocks: MAGS, QQQ, RSP, SPCX).

**Other**: `earnings_emails_enabled` key absent → default enabled (will fire); muted list empty; `sector_etf_gaps` backlog of 29 rows never reprocessed post-GICS-normalizer.

---

## 4. Improvement survey (for multiple calls/day at peak)

### A. Season-proof the pipeline (extends the bug fixes)
1. **Retry-based enrichment**: separate `attempted_at` from `enriched_at`; re-candidate while `actual_value IS NULL` inside the 12h window; schedule the reaction capture at ~T+125m instead of first-tick. (Direct fix for B2 — the single biggest recap killer.)
2. **Blocked-recap alerting**: when a previewed event sits >2h post-release with NULL actual, fire a Pushover + inbox alert with a one-tap link to the manual-actuals modal. Turns last season's 10 silent losses into 2-minute manual saves.
3. **Actuals source redundancy**: on Finnhub miss, fall back to Claude + web_search (already used in the composer) or the Nasdaq scrape; add a sign-flip/basis guard (B19) that flags rather than blanks.
4. **Recap timing discipline**: hold recaps until T+2h (after the call + reaction bars exist) rather than the moment actuals land.

### B. Day-of command center
5. **Earnings-day cockpit**: a time-ordered view of today's reporters (BMO/AMC lanes) with per-stage status chips (preview ✓ → released → actual ✓ → reaction ✓ → recap ✓), countdown to next release, and inline links to bogeys/notes/email viewer. EarningsHub is week-oriented; peak season needs a day view. Fits naturally on `/dashboard/today` above the Hub.
6. **Push at print** (likely highest value-per-effort): Pushover notification the moment an actual lands — "TER: EPS 1.42 vs 1.35 est · Rev 775M vs 762M · +4.1% vs SPY +0.2% (T+30m)". Infra exists (`sendPushover`); this is a hook in the enrichment runner. During a 3-call evening you learn each print without checking anything.
7. **Priority ranking**: order same-day reporters by delta-adjusted exposure (`lib/compute/exposure.ts` exists) so the cockpit answers "which of tonight's five calls actually matters to my book".
8. **Post-call quick capture**: a per-event structured note (guidance, tone, surprises, follow-ups) launched from the cockpit; feeds the recap email prompt (notes already render first) and next quarter's preview.

### C. Intelligence upgrades
9. **Implied vs historical move**: straddle-implied move (option chain API + `security_quotes.iv_underlying` exist) vs the name's average past-8-quarter post-print move, in the preview scoreboard. Classic single-manager prep line.
10. **Per-symbol earnings history block**: past 4-8 quarters of surprise % + next-day reaction (surprise history is already fetched from Finnhub; reactions accumulate in `reaction_snapshot`) — "how does this name trade post-print".
11. **Bogey automation**: auto-extract bogeys from newsletters mentioning upcoming reporters (mirror the levels-extraction pattern) + a weekly reminder to upload the TMT Breakout PDF. The feature was used once last season because it's pull-only.
12. **Same-day transcript pull + summary**: fetch and summarize transcripts same-day for held reporters; `findPriorTranscript` and TranscriptCard exist as foundations.
13. **Read-through alerts**: when a `read_through_pairs` reporter prints, push/notify the read-through to the held target (currently surfaced only in emails).

### D. Coverage guarantees
14. **Coverage guard**: weekly check (piggyback the Sunday briefing) that every held + watchlist name has a scheduled earnings event within its expected window; alert on holes. Would have caught the July 5–19 gap automatically.
15. **Watchlist earnings sync** (closes B10's second half) + option-underlying held status (first half).
16. **Cross-source event dedup** on (issuer-family, ±7d) at candidate time, not just sync time (closes B12/NKE).

### E. Volume management
17. **End-of-day earnings wrap**: on days with ≥3 recaps, consolidate into one evening summary email (or a section of the existing evening email) instead of N separate sends.
18. **Morning digest "today's reporters" block**: the daily digest already exists; add today's earnings schedule with times + consensus at the top during season.

---

## 5. Recommended sequencing

**This week (before 7/14 banks):**
1. Run calendar sync for weeks 2026-07-06 + 2026-07-13 (data, 5 minutes).
2. B1 + B3 (dedup: wire marker dance into the sweep route, sentinel-before-send) — else double emails all season.
3. B2 (retry enrichment) + B6 (symbol match) + improvement #2 (blocked-recap alert) — else recaps silently vanish again.
4. B5 (100× reaction fix, one line) + B4 (sync cascade-delete guard).

**Week 2 (nice before peak):** #6 push-at-print, #14 coverage guard, B7 shorts, B8 cloud recap gates, #5 cockpit.

**During season (iterate):** #9 implied move, #10 history block, #17 EOD wrap, #11 bogey automation, P2 cleanups.
