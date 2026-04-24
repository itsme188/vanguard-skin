# Vanguard Skin — TODO

> **In-repo shortlist.** Updated 2026-04-24 (reconciled pass — added open items from master roadmap that code-grep confirmed unshipped, plus 3 user-reported bugs/asks).
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

- ✅ **Tab dropdowns for subviews** — shipped 2026-04-25. Research tab now shows a caret-dropdown with Notes / Trade Reviews / Feeds / Documents; Analysis shows Classification / Factor Exposure. Desktop-only — mobile keeps the in-page pill toggle. New `TabDropdown.tsx`; `nav-tabs.ts` extended with `subviews` + `matchParam`; `ResearchViewToggle` + `AnalysisView` mode-toggle gated to `md:hidden`. Keyboard: ArrowDown opens, Arrow keys/Home/End cycle, Enter selects, Escape/outside-click closes. **Non-obvious CSS fix:** the parent `<nav>` has `overflow-x-auto` which clips `position: absolute` descendants (overflow on one axis forces the other to clip too). Fix: menu uses `position: fixed` with `top`/`left` from `getBoundingClientRect()` so it escapes all ancestor clipping, plus scroll+resize listeners to keep the menu glued to the tab. Calendar has no subview toggle — the dropdown slots in if one is ever added.

New from Phase 9 (calendar-enrich Worker):

- ✅ **Phase 9b — Calendar-enrich cloud-fallback parity** — shipped 2026-04-25, code-only (flag-gated). Worker now reads the nightly R2 state snapshot (extended to cover trailing-24h events), filters in-window candidates, fetches actuals from FRED + Finnhub and reaction bars from Polygon, and writes per-event `cloud-enriched-{id}` payloads to KV (7d TTL). Mac's new `/api/calendar/reconcile-cloud-enrich` route reads those payloads on every wake (piggy-backed on every `/api/calendar/enrich` call), upserts into calendar_events with TWS-always-wins precedence on reaction_snapshot, and DELETEs the KV key. New `POST /api/calendar/enrich { upgradeReactionToTws: true }` body flag lets the UI re-capture TWS bars over a cloud-enriched row. Claude `nonfred` path is deferred on cloud (Worker writes `deferred: true` payload; Mac's next wake runs Claude itself). Gated by `CLOUD_ENRICH_ENABLED=true`; ship is safe at flag=false. **User actions before flip:** (1) Polygon Starter signup ($29/mo), (2) `wrangler secret put FRED_API_KEY / FINNHUB_API_KEY / POLYGON_API_KEY / CLOUD_ENRICH_ENABLED`. New files: `workers/cron/src/polygon.ts`, `workers/cron/src/enrich-actuals.ts`, `workers/cron/src/reaction-matcher.ts` (mirror of `lib/calendar/reaction-snapshot.ts` helpers), `app/api/calendar/reconcile-cloud-enrich/route.ts`. Test deltas: +7 cloud-enrich Worker tests, +7 Mac reconcile tests = +14, 1227 → 1241.

Other open (from MEMORY, not previously in this file):

- [ ] **IBKR April 2026 transactions gap** — waiting on April statement to arrive; will import normally when it lands. (Phase 5 plan note.)

New from Phase 4 E2E scenario sweep (2026-04-25):

- [ ] **Security Detail Transactions table sort doesn't write URL params** (Scenario 2 #9). Clicking the DATE header (which shows a ↓ arrow) does not update `location.search` — other tables with the `useSortParam` pattern (Holdings, LevelsPanel) persist sort state to the URL. Likely the Security Detail Transactions section doesn't wrap its header in `<SortableHeader>` or isn't scope-keyed. 10-min fix.
- [ ] **Research Documents search may miss tag matches** (Scenario 6 #4). FTS5 search is body-only; a document tagged `ai risk / agentic ai` doesn't surface for query "ai". Design choice or gap? If the FTS index should include tags/title, extend the `INSERT INTO research_documents_fts` trigger. ~30 min.
- [ ] **Chat delete uses `window.confirm` instead of toast-confirm** (Scenario 8 #7). `ChatInterface.tsx:418` — swap for the `ToastProvider` confirm pattern used elsewhere in the app. Testable + consistent. ~15 min.
- [ ] **Today's data-quality chip is page-level, not per-row** (Scenario 1 #5). Spec-vs-code divergence: scenario expected per-row chips but `today/page.tsx` renders one `qualityChip` at the H1. Either update the SCENARIOS.md checklist OR ship per-row chips if the UX reads better. Defer unless user asks.

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
