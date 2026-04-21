# Vanguard Skin — TODO

> **In-repo shortlist.** Updated 2026-04-21.
>
> - v2 build log (Mar–Apr 2026): [archive/TODO-v2-complete-2026-03-30.md](archive/TODO-v2-complete-2026-03-30.md)
> - Master roadmap (off-repo, session-driven): `~/.claude/plans/last-session-session-summary-eventual-ripple.md`
> - Live topic index: the Claude memory at `MEMORY.md` (per-project auto-memory)

---

## Shipped since v2 (2026-03-30 → 2026-04-21)

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

---

## Next up (unblocked)

- ✅ **useCallback render-loop audit** — complete 2026-04-21, 0 candidates found. Pattern documented in `memory/feedback_usecallback_pattern.md`.
- [ ] **Next.js 16 async-params migration** — hook flagged ~10 files. Dedicated session.
- [ ] **`trade-roundtrips.test.ts` TS errors** — `sellTransactionQty` missing in fixtures. Vitest tolerates, `tsc --noEmit` flags. ~30 min.
- [ ] **Q1 2026 Vanguard Taxable income gap** — dividends/interest not landing in the income card. Investigation first.
- [ ] **Settings UI fallback for localhost** — optional `POST /api/settings` so `SettingsModal` works in plain-browser dev.

---

## AI Gateway phases

- ✅ **Phase 1** — AI Gateway routing (commit `8c82c1e`)
- ✅ **Phase 2** — Workers AI downroute: alertSuggestion → Llama 3.3, newsletterLevelExtraction → Kimi K2.6 (`264bc73`)
- ✅ **Phase 3** — R2 PDF archival (`264bc73`, migration 033)
- [ ] **Phase 4** — Workers Cron hybrid pattern. Design doc at [2026-04-21-workers-cron-hybrid.md](2026-04-21-workers-cron-hybrid.md). 4 open questions. Revisit after first missed briefing. ~1 day.

---

## Backlog themes (from off-repo roadmap)

- **Theme D — Level source performance attribution** (blocked on data): hit-rate + P&L by `source_author`. Wait until ~30+ alerts have fired.
- **Theme E — Chat broader company data**: press releases, 10-K/10-Q risk factors. Lowest-hanging: E3 EDGAR extraction (~4-5 hr).
- **Theme F1 — Research PDF knowledge base**: analyst reports, FTS5 search, new `research_documents` table. ~1 day. (New migration — coordinate with in-flight phases.)
- **Theme G — Chart entry/exit signals**: design pass first, then 1-2 implementation sessions.
- **Theme I — Chat history persistence**: migration + API + ChatDrawer sidebar. ~3-4 hr.
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
