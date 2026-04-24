# Vanguard Skin — TODO

> **In-repo shortlist.** Updated 2026-04-25 (session-end reconciliation; Phase 2 + Phase 9b shipped, CLAUDE.md updated in `b40bb1d`, Yahoo provider swap in `8e22ebe`).
>
> - v2 build log (Mar–Apr 2026): [archive/TODO-v2-complete-2026-03-30.md](archive/TODO-v2-complete-2026-03-30.md)
> - Master roadmap (off-repo, session-driven): `~/.claude/plans/last-session-session-summary-eventual-ripple.md`
> - Live topic index: the Claude memory at `MEMORY.md` (per-project auto-memory)

---

## Shipped since v2 (2026-03-30 → 2026-04-22)

Headline features not reflected in the v2 archive:

- **Security Levels + Alerts + MA-based levels** (migrations 029-031, `94379f1`, `62f98bc`)
- **Newsletter level extraction + review gate** (migration 032)
- **Mobile Today view** — phone-first single-column summary (`ad79afd`)
- **Privacy toggle** — `<Money>`/`<Pct>`/`<Shares>` masking (`68a2409`)
- **Pushover mobile push** for level alerts (`90c6589`)
- **Weekly briefing overhaul** — Opus 4.7 + Finnhub + weekend deep-reads
- **Data Integrity Overhaul** — IBKR cashBalance (migration 028), two-tier account cards
- **Trade review FIFO fixes** — expired options, short-sale P&L (migration 023)
- **AI Gateway + model-agnostic routing** — FEATURE_MODELS policy plane (`8c82c1e`)
- **Cloudflare Workers AI downroute** — Llama 3.3 + Kimi K2.6 (`264bc73`)
- **R2 PDF archival** — 39 Vanguard PDFs backfilled (`264bc73`, migration 033)
- **Chat history delete** (2026-04-22) — sidebar trash icon + `deleteConversation` mutation + `DELETE /api/chat/conversations/[id]`. Completes Theme I.
- **EDGAR 10-K / 10-Q section extraction** (2026-04-22, migration 034) — new chat tool `query_filing_section` summarizes Item 1A Risk Factors and MD&A via Sonnet, cached per `(symbol, accession, section)`. Feature key `filingSectionExtraction` in FEATURE_MODELS.
- **Research PDF knowledge base** (2026-04-22, migration 035) — upload analyst reports / research notes as PDFs; Claude extracts metadata + full body; SQLite FTS5 powers lexical search; chat tool `query_research_documents`; Documents tab in Research view. `researchDocumentExtraction` → Sonnet via native `document` content block.
- **Terminal redesign Phase 2 — MarketDataPanel KPI row** (2026-04-24) — 5-cell quote-strip between chart and LevelsPanel: Open / Day Range / 52w Range / Volume / ATR(14). Hidden on securities with no daily bars. New `<KpiCell>` primitive in `TerminalSection.tsx`; new queries `getLatestDailyBar` + `get52WeekRange` + `getKpisForSecurity`. Shipped alongside a `bare` option on `<Money>` to fix a `$$` double-dollar bug in the hero and new cells.
- **Stability burndown** (2026-04-24) — +43 tests. Fixed flaky transcript test (mocked EDGAR/Motley Fool/API Ninjas fetchers). Added 7 auto-refresh pipeline integration tests. Added 19 Cloudflare Worker cron tests (dst gates, KV dedup, primary/fallback paths, `/internal/*` handlers). Added 7 API route contract tests (sync-status, levels/extract, research/sync SSE).
- **Levels & alerts polish — Sessions 4+** (2026-04-20 → 2026-04-22, discovered during reconciliation pass) — items from master roadmap Theme A/L that shipped without being reflected in this file: A2 chat tools `query_levels` + `query_alerts` (`lib/chat/tools.ts:726,755`), L1 alerts inbox grouping into "Triggered today" / "Older pending" (`app/dashboard/alerts/page.tsx:277`), L4 `AlertsBell` hover preview, L5 alert row price-source chip (SMA/EMA), L8 `RecentAlertsPanel` on Security Detail.
- **Q1 2026 Vanguard Taxable income gap — closed** (2026-04-23) — all 11 Vanguard brokerage PDFs imported via Claude Co-Work. 167 dividends ($8,941) + 19 interest ($3,219) landed. VMFXX sweep-sign bug (201 rows) SQL-repaired in place; canonical CSV prompt patched (`176a064`) across all 3 synced sources so future imports preserve signed amounts.

---

## Next up (unblocked)

- ✅ **useCallback render-loop audit** — complete 2026-04-21, 0 candidates found. Pattern documented in `memory/feedback_usecallback_pattern.md`.
- ✅ **Next.js 16 async-params migration** — no-op as of 2026-04-22.
- ✅ **`trade-roundtrips.test.ts` TS errors** — fixed 2026-04-21 (`458ad59`).
- ✅ **Sortable column headers** — shipped 2026-04-23 (`882e620`). Shared `<SortableHeader>` + `<SortPicker>` + `useSortParam` hook. Applied across 7 tables (Holdings, 2× Transactions, 2× Tax Lots, Alerts, LevelsPanel).
- ✅ **Research mention extraction quality** — shipped 2026-04-23 (`64bdc39`). Two-layer gate (word-boundary + Haiku) at extraction time; 250 articles re-verified via `scripts/backfill-research-mentions.ts`. New FeatureKey `researchMentionVerification` → Haiku 4.5.
- ✅ **IBKR options metadata backfill** — shipped 2026-04-23 (`8707181`). 393 of 394 options now have structured `underlying_symbol` / `option_type` / `strike_price` / `expiration_date`; CALL/PUT chips now render on Security Detail.
- ✅ **Settings UI fallback for localhost** — shipped 2026-04-22 (`8ce0099`).
- ✅ **Q1 2026 Vanguard Taxable income gap** — closed 2026-04-23. See "Shipped since v2" above.

---

## Open items

Closed this session (2026-04-24 evening — Calendar Living Record Tier-3 sprint):

- ✅ **Phantom alert after full inbox clear** — closed 2026-04-24 afternoon (`c363e6d`). CustomEvent `alerts-updated` dispatch from inbox → AlertsBell listener. Sibling fix for ReviewBell via `reviews-updated`.
- ✅ **Global / in-page search** — closed 2026-04-24 afternoon (`e3085d6`). Cmd+K palette expanded to 7 source types (added research_article, research_document via FTS5, level, alert); AllHoldingsTable gained text filter.
- ✅ **Calendar / macro event post-release enrichment** — closed 2026-04-24 evening (migration 041, commits `58eef66` through `e353a79`). Full pipeline: scheduler + FRED/Finnhub actuals + TWS reaction capture + UI chips + briefing context block. Every-15-min Workers cron trigger covers off-Mac windows (primary-only for now). Plan: `docs/plans/2026-04-24-calendar-living-record.md`.
- ✅ **L9 — Calendar × Levels cross-reference** — verified shipped in earlier session (already in `CalendarView.tsx:276-281` via `getActiveLevelCountsForSecurityIds`).

Theme D capstone:

- ✅ **Theme D — Level source performance attribution v1** — shipped 2026-04-24 evening (`f906284`). New query `getSourcePerformance` + `/dashboard/levels/performance` page (empty-state tolerant) + chat tool `query_release_reactions` + Data Health "Unmapped sector ETFs" admin section.

Still open:

User-reported (2026-04-24):

_(All three user-reported items closed this session.)_

From master roadmap — reconciled 2026-04-24 evening after drift audit:

- ✅ **A3 — Daily-digest "Yesterday's triggered alerts"** — already shipped (`formatTriggeredAlertsSection` in `lib/digest/daily-digest.ts:22`); two bugs in it were also fixed this session (`6cb2cac`).
- ✅ **A5 — `expires_at` field in LevelsPanel form** — already shipped (`LevelsPanel.tsx:484 expiresAt state + :816 Field "Expires (auto-deactivate)"`).
- ✅ **L2 — LevelsPanel mobile quick-add form** — already shipped (`LevelsPanel.tsx:488 showAdvanced state, :778 "More options ↓" disclosure`).
- ✅ **L3 — Provenance filter in LevelsPanel** — already shipped (`LevelsPanel.tsx:861 authorFilter set + :898 filter application`).
- ✅ **L6 — Chart crosshair legend mobile density** — already shipped (`SecurityChart.tsx:736 hidden md:inline-flex for O/H/L + :757 mobile-only delta-from-open`).
- ✅ **H3 — Vanguard PDF direct import** — already shipped (`vanguard-pdf.ts:735 extractTransactionsFromPdf + :770 Promise.allSettled parallel holdings + transactions extraction`).
- ✅ **A13 — Cross-form validation audit** — completed 2026-04-25. Full walkthrough of 11 submit forms (LevelsPanel, SendDigestPanel, ManageSourcesModal, NotesView, TradeReviewView, ReconciliationTable, CorporateActionsSection, AnalysisView, ChatInterface, AddLevelPopover). Every `disabled={loading || !field}` guard is either correctly mode-aware (`disabled={loading || (priceSource === "static" && !price)}`) or a legitimate required-field gate with no mode-switching. No bugs found.

UX — tab navigation (flagged 2026-04-24):

- ✅ **Tab dropdowns for subviews** — shipped 2026-04-25 (`e6559d6`, follow-up `418bf21`). Research tab now shows a caret-dropdown with Notes / Trade Reviews / Feeds / Documents; Analysis shows Classification / Factor Exposure. Desktop-only — mobile keeps the in-page pill toggle. New `TabDropdown.tsx`; `nav-tabs.ts` extended with `subviews` + `matchParam`; `ResearchViewToggle` + `AnalysisView` mode-toggle gated to `md:hidden`. Keyboard: ArrowDown opens, Arrow keys/Home/End cycle, Enter selects, Escape/outside-click closes. **Non-obvious CSS fix:** the parent `<nav>` has `overflow-x-auto` which clips `position: absolute` descendants (overflow on one axis forces the other to clip too). Fix: menu uses `position: fixed` with `top`/`left` from `getBoundingClientRect()` so it escapes all ancestor clipping, plus scroll+resize listeners to keep the menu glued to the tab. Calendar has no subview toggle — the dropdown slots in if one is ever added. **Follow-up build fix (`418bf21`):** `TabDropdown` calls `useSearchParams()`, which blocks static pre-rendering for any dashboard page eligible for it (e.g., `/dashboard/levels/review`, `/alerts`, `/notes`). Wrapping the render in `<Suspense>` with a plain-`<Link>` fallback in `TabNav.tsx` isolates the CSR bailout to the dropdown itself.

New from Phase 9 (calendar-enrich Worker):

- ✅ **Phase 9b — Calendar-enrich cloud-fallback parity** — shipped 2026-04-25, code-only (flag-gated). Worker now reads the nightly R2 state snapshot (extended to cover trailing-24h events), filters in-window candidates, fetches actuals from FRED + Finnhub and reaction bars from **Yahoo Finance** (1-min chart endpoint, no auth, 10+ day retention), and writes per-event `cloud-enriched-{id}` payloads to KV (7d TTL). Mac's new `/api/calendar/reconcile-cloud-enrich` route reads those payloads on every wake (piggy-backed on every `/api/calendar/enrich` call), upserts into calendar_events with TWS-always-wins precedence on reaction_snapshot, and DELETEs the KV key. New `POST /api/calendar/enrich { upgradeReactionToTws: true }` body flag lets the UI re-capture TWS bars over a cloud-enriched row. Claude `nonfred` path is deferred on cloud (Worker writes `deferred: true` payload; Mac's next wake runs Claude itself). Gated by `CLOUD_ENRICH_ENABLED=true`; ship is safe at flag=false. **User actions before flip (3 secrets, $0):** `cd workers/cron && npx wrangler secret put FRED_API_KEY / FINNHUB_API_KEY / CLOUD_ENRICH_ENABLED` then `npx wrangler deploy`. **Provider choice:** Polygon Starter ($29/mo) rejected because its 15-min data delay creates a timing hole — events tick out of the 2h candidate window before Polygon's bars catch up. Polygon Advanced ($199/mo) is real-time but overpriced for our 10-20 candidate/day volume. Finnhub `/stock/candle` is paid-only since 2024 (verified 2026-04-25: 40-char free-tier key returns "You don't have access to this resource."). Yahoo's unofficial `query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1m&period1&period2` endpoint is the free + real-time winner; verified returns 113+ 1-min bars 10 days back for SPY. Risk: unofficial, Yahoo could break; mitigation: graceful null fallback. New files: `workers/cron/src/yahoo.ts`, `workers/cron/src/enrich-actuals.ts`, `workers/cron/src/reaction-matcher.ts` (mirror of `lib/calendar/reaction-snapshot.ts` helpers), `app/api/calendar/reconcile-cloud-enrich/route.ts`. Test deltas: +7 cloud-enrich Worker tests, +7 Mac reconcile tests = +14, 1227 → 1241.

Other open (from MEMORY, not previously in this file):

- [ ] **IBKR April 2026 transactions gap** — waiting on April statement to arrive; will import normally when it lands. (Phase 5 plan note.)

Closed this session (follow-up):

- ✅ **UMich Consumer Sentiment calendar gap** — closed 2026-04-25 (`01bf248`). User flagged today's 04-24 Final release wasn't captured. Two bugs: hardcoded schedule only had prelim dates (2nd Friday, no 4th Friday finals), AND non-FRED events were inserted with null `event_time` → `resolveReleaseTime` had nothing to resolve → `release_time` stayed null → enrichment runner filtered them out (Consumer Confidence row id 67 was silently broken the same way). Fix: `NonFredEvent.releaseTime` required field, UMich split into prelim/final arrays with distinct shortNames, push site emits `event_time: src.releaseTime`. 2026 UMich dates cross-checked against `data.sca.isr.umich.edu/schedule.php`. Ran sync for weekOf 2026-04-20 → 2026-07-27 to upsert new rows. Today's 04-24 Final retroactively enriched via `/api/calendar/enrich {eventId:97}` (actual="49.8" via Claude+web_search; reaction absent because TWS is disconnected right now — acceptable for this one-off).

New from Phase 4 E2E scenario sweep (2026-04-25):

- [ ] **Security Detail Transactions table sort doesn't write URL params** (Scenario 2 #9). Clicking the DATE header (which shows a ↓ arrow) does not update `location.search` — other tables with the `useSortParam` pattern (Holdings, LevelsPanel) persist sort state to the URL. Likely the Security Detail Transactions section doesn't wrap its header in `<SortableHeader>` or isn't scope-keyed. 10-min fix.
- [ ] **Research Documents search may miss tag matches** (Scenario 6 #4). FTS5 search is body-only; a document tagged `ai risk / agentic ai` doesn't surface for query "ai". Design choice or gap? If the FTS index should include tags/title, extend the `INSERT INTO research_documents_fts` trigger. ~30 min.
- [ ] **Chat delete uses `window.confirm` instead of toast-confirm** (Scenario 8 #7). `ChatInterface.tsx:418` — swap for the `ToastProvider` confirm pattern used elsewhere in the app. Testable + consistent. ~15 min.
- [ ] **Today's data-quality chip is page-level, not per-row** (Scenario 1 #5). Spec-vs-code divergence: scenario expected per-row chips but `today/page.tsx` renders one `qualityChip` at the H1. Either update the SCENARIOS.md checklist OR ship per-row chips if the UX reads better. Defer unless user asks.

User-reported (2026-04-25 evening — all closed in this session):

- ✅ **Research document upload — "Metadata response was not valid JSON"** (JaguarAnalytics "Hidden Angles" PDF). Closed 2026-04-25. Root cause: `lib/research-documents/extract.ts:160` had `maxOutputTokens: 4000` ("metadata response is tiny") but the prompt allowed multi-paragraph `summary` with no length cap. Long-form research digests overflowed mid-string in `summary`. Fix: bumped to 8000 + added explicit "max 1500 chars" cap in `METADATA_PROMPT` summary section.
- ✅ **First BMO earnings (NSC) didn't enrich post-release** — closed 2026-04-25. Two pieces: (a) earnings window widened from 2h to 12h for `source='finnhub' OR event_type='earnings'` in `lib/calendar/enrichment-runner.ts` (markets don't open till 09:30 ET — pre-fix a 08:00 BMO earnings was useless to enrich); (b) "one-event-per-pass" theory disproved — runner correctly processes ALL in-window candidates per pass. NSC (id 102) wasn't picked at 08:13 because Finnhub sync didn't insert it until 12:00 ET (DB created_at confirmed). NSC retroactively enriched today via `/api/calendar/enrich {eventId:102}` — actual EPS 2.65, Rev $2.998B (reaction absent because TWS disconnected, acceptable). Regression test added.
- ✅ **Nightly QA cron now actually running** — closed 2026-04-25. Wrote `~/Library/LaunchAgents/com.vanguard-skin.nightly-qa.plist` (StartCalendarInterval Hour=2 Minute=0, daily) + `launchctl load`. Wrote the missing `memory/project_nightly_qa.md` topic file documenting what runs, what it tests, files, manual-run command, and add-new-check workflow.
- ✅ **Daily digest auto-send "skipped: No processed articles in selected range" (3-day silent failure)** — closed 2026-04-25. Real bug discovered after user's clarification about manual catch-up at 7 PM yesterday. Race condition: `sendDigestEmail` read `getLastDigestSentAt(db)` AFTER 60-90s of fetch+process awaits. A concurrent manual trigger (e.g., 8:46 phone-tap while 8:45 cron mid-process) updated `last_digest_sent_at` to "now"; cron then read poisoned timestamp → zero matches → skip. Fix: capture `sinceSnapshot` BEFORE any await in `lib/digest/send-digest.ts`. Regression test in `tests/digest/send-digest-race.test.ts` uses `vi.hoisted` to inject the timestamp update during the await.
- ✅ **DigestCatchup banner: "wasn't sent at 9 AM" + shows pre-trigger** — closed 2026-04-25. `app/dashboard/components/DigestCatchup.tsx` now uses `DIGEST_TIME_LABEL = "8:45 AM"` constant + only shows banner if `now >= 8:45 AM local` AND `lastSent < scheduled-trigger-today`. Pre-8:45 weekdays the banner is hidden ("expected, not late"). CLAUDE.md updated from "9 AM" to "8:45 AM".

Phase 4 E2E sweep cleanup (also closed this session):

- ✅ **E2E #1 — Security Detail Transactions sort URL params** — closed 2026-04-25. Real bug in `lib/hooks/useSortParam.ts`: `setSort` compared against URL params (always null on first click of default-sorted column) instead of the displayed sort, so first click on the DATE column wrote redundant `?...Sort=trade_date&Dir=desc` with no visual change ("feels broken"). Fix: compare against `sort.field`/`sort.dir` (which include defaults). Tri-state cycle now visibly engages from click 1.
- ✅ **E2E #2 — Research Documents FTS5 tag matches** — closed 2026-04-25 as verified-non-bug. Migration 036 already extends FTS5 to include `tags` column + triggers wire it correctly. Live DB confirms FTS5 query "ai" returns the doc tagged "agentic ai" / "ai risk". Added explicit regression test in `tests/queries/research-documents.test.ts::"FTS5 query 'ai' surfaces a doc tagged 'agentic ai' / 'ai risk'"`.
- ✅ **E2E #3 — Chat delete + Research doc delete swap window.confirm for ConfirmDialog** — closed 2026-04-25. `ChatInterface.tsx` and `ResearchDocumentsView.tsx` both swapped to the project's `ConfirmDialog` component (the same pattern `NotesView` uses). `deletePending` / `confirmingDelete` state holds the target; `<ConfirmDialog variant="danger">` renders the modal.
- ✅ **E2E #4 — Today data-quality chip placement** — closed 2026-04-25 as spec correction. Updated `tests/e2e/SCENARIOS.md` Scenario 1 #5 to reflect the page-level qualityChip currently shipped (per-row chips would add row-clutter for marginal info — user opted close).

User-reported (2026-04-25 late night — open):

- [ ] **Mobile dropdown menu has clear/transparent background** — hard to see and navigate. Need to identify which menu (likely `MobileBottomNav` overflow or a tab-subview menu that somehow surfaces on mobile despite the `md:`-only `TabDropdown` gate — worth confirming first). Fix: solid `bg-raised` (or `bg-panel` with a 1px `border-edge`) + proper backdrop, same surface treatment as the mobile chat overlay.
- [ ] **Desktop tab-subview dropdown visibility + tab/subview rethink** — the caret-dropdowns shipped in `e6559d6` work but are low-contrast / easy to miss. Two-part: (a) visual pass on `TabDropdown` (stronger caret affordance, maybe hover underline, better menu chrome), and (b) a collaborative walk through the full tab + subview tree (Today / Overview / Accounts / Holdings / Analysis / Charts / Calendar / Research / Import, plus all subviews) to decide what actually belongs as a top-level tab vs a subview vs a settings-only surface. Brainstorm session before any code.
- [ ] **Research Feeds horizontal scroll is messy** — two parts: (1) find a better UI for the source chip / filter row that currently scrolls horizontally (wrap-to-lines? vertical list? dropdown? combobox?); (2) regardless of which alternative we pick, the horizontal scrollbar itself should be hidden (`scrollbar-hide` utility or `::-webkit-scrollbar { display: none }` on that container). Quick fix for (2), deeper brainstorm for (1).

---

## Roadmap / future (flagged 2026-04-25 late night)

Larger multi-session items the user wants captured:

- [ ] **iPad parity** — can the app be used on iPad the same way as on iPhone? Unknown effort. Likely small if the mobile breakpoints already hold at ~1024px and Cloudflare Mesh routes the iPad, but there might be layout regressions at the in-between tablet width (768-1024px) where `md:` kicks in but the screen isn't desktop-sized. First step: load the app on an iPad via Mesh and identify what breaks before scoping work.
- [ ] **Design overhaul — light mode default, keep "Midnight Portfolio" as dark mode** — multi-session redesign. User has said repeatedly they don't love the midnight-blue dark palette. Plan: preserve the current dark palette under a `dark` class and introduce a new "light but not white" default palette (the `MarketDataPanel` + `TerminalSection` primitives are already scoped to stay dark regardless of outer theme, so the embedded data-module pattern becomes the anchor — see `memory/project_market_data_panel.md`). Requires: Tailwind v4 `@theme` duplication for both modes, `prefers-color-scheme` + settings toggle, a full audit of every hardcoded hex (chart colors, chip tones, Recharts palettes, PDF/email templates) to survive the mode flip. Scope in a design doc before any code.
- [ ] **OpenAI voice API integration** — scaffolding started in Claude Co-Work. Two directions: (a) **output/read-aloud** — weekly briefing email read aloud, per-company deep dives narrated on Security Detail, maybe alert triage by voice; (b) **input/voice bug reporting** — in-app record button that captures the user describing a bug or UI gripe, transcribes via Whisper/Realtime, and files the result somewhere structured (GitHub issue? `docs/plans/BUGS.md` append? a new `bug_reports` table?). Decide capture destination + whether to also capture a screenshot at the moment of recording (likely yes — bug reports without visual context are weak). Scope: design doc + capture flow + first surface (probably Today view "speak the briefing" button as the lowest-risk first shot).
- [ ] **Privacy mode as default + Face ID / biometric unlock** — currently `vgs:privacyMode` defaults off and the eye-icon toggle flips freely. Want: default ON everywhere (mobile first, possibly desktop Electron too), and unlocking real numbers requires Face ID (iOS WebAuthn `navigator.credentials` or native Electron biometric prompt). Pieces: (1) flip `PrivacyProvider` default to `true` + migrate existing localStorage to opt-in masking; (2) gate the toggle behind a WebAuthn challenge on mobile (iOS Safari supports platform authenticators); (3) Electron side uses `Touch ID` via `node-mac-auth` or equivalent; (4) decide the auto-lock policy (re-mask after N minutes idle? on every app focus?). Potential cross-cut with the voice-API "deep dive" feature — voice output reading real numbers aloud should respect the same unlock state. Scope in a design doc; biometric plumbing on both iOS-Safari-over-Mesh and Electron-on-macOS is the risk surface.

---

## AI Gateway phases

- ✅ **Phase 1** — AI Gateway routing (commit `8c82c1e`)
- ✅ **Phase 2** — Workers AI downroute: alertSuggestion → Llama 3.3, newsletterLevelExtraction → Kimi K2.6 (`264bc73`)
- ✅ **Phase 3** — R2 PDF archival (`264bc73`, migration 033)
- ✅ **Phase 4** — Workers Cron hybrid shipped 2026-04-21 (`16ba5a7` Sessions A+B, `3e2c7af` Session C). Live at vanguard-skin-cron.isaac-3d1.workers.dev. Design doc: [2026-04-21-workers-cron-hybrid.md](2026-04-21-workers-cron-hybrid.md).

---

## Backlog themes (from off-repo roadmap)

- **Theme D — Level source performance attribution** (blocked on data): hit-rate + P&L by `source_author`. Wait until ~30+ alerts have fired.
- ✅ **Theme E — Chat broader company data** complete: E1 press releases (`272566d`), E2 full 8-K body (`6328a99`), E3 EDGAR 10-K/10-Q, E4 analyst coverage (`1bf65d3`) all shipped 2026-04-22.
- ✅ **Theme F1 — Research PDF knowledge base** shipped 2026-04-22 (migration 035, commit `6624382`).
- ✅ **Theme G — Chart entry/exit signals v1 + narrative layer** complete: pivot S/R shipped 2026-04-22 (`51fcc51`), Haiku one-sentence narratives shipped 2026-04-23 (`25016cf`, migration 040).
- ✅ **Theme I — Chat history persistence**: shipped across 2026-04-21 + 2026-04-22.
- **Theme J — Cleanup track** (partial): J1 ✅ + J3 ✅ shipped 2026-04-21. J2 (E2E browser tests, ~15 hr) deferred.
- **Theme K — Options Phase 2 end-to-end verification**: blocked on the user holding more than 1 option position at once.

---

## Deferred

- **E2E browser tests** (Theme J2, ~15 hr) — dedicated session.
- **Electron code signing** — `xattr -cr` workaround accepted for local-only distribution.
- **Finnhub surprise history** — free tier returns `[]`; revisit only if briefings feel thin.

---

## Known issues

- **WSH API error 10276** — "News feed is not allowed" (2026-04-07). May need TWS subscription time.
- **Holdings cost basis column "–" in Accounts tab** — data gap, not a code bug (tooltip explains).
- **`next build` data collection** fails with an existing `data/vanguard.db` on disk. TypeScript compilation still succeeds. All 10 DB-loading pages are `force-dynamic`, so this only affects build-time collection, not runtime.

---

## Active design docs

- [2026-04-15-cloudflare-saas-rewrite.md](2026-04-15-cloudflare-saas-rewrite.md) — SaaS v3 scoping (D1, TWS bridge, multi-tenant, ~7 months)
- [2026-04-21-mobile-today-view-decision.md](2026-04-21-mobile-today-view-decision.md) — shipped
- [2026-04-21-workers-cron-hybrid.md](2026-04-21-workers-cron-hybrid.md) — Phase 4, shipped 2026-04-21
