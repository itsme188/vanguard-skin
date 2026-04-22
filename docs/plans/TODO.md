# Vanguard Skin — TODO

> **In-repo shortlist.** Updated 2026-04-22.
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

---

## Next up (unblocked)

- ✅ **useCallback render-loop audit** — complete 2026-04-21, 0 candidates found. Pattern documented in `memory/feedback_usecallback_pattern.md`.
- ✅ **Next.js 16 async-params migration** — no-op as of 2026-04-22: all `page.tsx` files that take `searchParams`/`params` already type them as `Promise<...>` and await. The hook flag is a false positive; it pattern-matches `params.foo` literally without distinguishing pre- vs post-await.
- ✅ **`trade-roundtrips.test.ts` TS errors** — fixed 2026-04-21 (`458ad59`). Repo-wide `tsc --noEmit` now 0 errors.
- [ ] **Q1 2026 Vanguard Taxable income gap** — dividends/interest not landing in the income card. Investigation first.
- ✅ **Settings UI fallback for localhost** — shipped 2026-04-22 (commit `8ce0099`). `/api/settings` dev-only route + SettingsSource abstraction in SettingsModal; Electron IPC still used in packaged app.

---

## AI Gateway phases

- ✅ **Phase 1** — AI Gateway routing (commit `8c82c1e`)
- ✅ **Phase 2** — Workers AI downroute: alertSuggestion → Llama 3.3, newsletterLevelExtraction → Kimi K2.6 (`264bc73`)
- ✅ **Phase 3** — R2 PDF archival (`264bc73`, migration 033)
- [ ] **Phase 4** — Workers Cron hybrid pattern. Design doc at [2026-04-21-workers-cron-hybrid.md](2026-04-21-workers-cron-hybrid.md). 4 open questions. Revisit after first missed briefing. ~1 day.

---

## Backlog themes (from off-repo roadmap)

- **Theme D — Level source performance attribution** (blocked on data): hit-rate + P&L by `source_author`. Wait until ~30+ alerts have fired.
- **Theme E — Chat broader company data**: E1 press releases (`272566d`), E2 full 8-K body (`6328a99`), E3 EDGAR 10-K/10-Q all shipped 2026-04-22. Remaining: E4 analyst estimates.
- ✅ **Theme F1 — Research PDF knowledge base** shipped 2026-04-22 (migration 035, commit `6624382`).
- ✅ **Theme G — Chart entry/exit signals v1** shipped 2026-04-22 (commit `51fcc51`). Pivot S/R detection + suggested-levels API + chart overlay + accept flow. Claude narrative layer still deferred.
- ✅ **Theme I — Chat history persistence**: shipped across 2026-04-21 + 2026-04-22. Schema (migration 025), route persistence, sidebar + delete.
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
- [2026-04-21-workers-cron-hybrid.md](2026-04-21-workers-cron-hybrid.md) — Phase 4, in progress
