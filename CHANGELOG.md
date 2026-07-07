# Changelog

All notable releases of Vanguard Skin / Portfolio Desk.

The repo name remains `vanguard-skin`; the user-facing app was renamed **Portfolio Desk** in v2.2.

---

## v2.3 — Earnings Season & Away-From-Home — 2026-07-07

Consolidated release covering May–July 2026 work on `main`.
Tests: 3213 passing (plus a separate Cloudflare Worker suite).

### New analysis surfaces

- **Defense/Hedging tab** (`/dashboard/analysis?view=defense`) — finds your hedges (puts, shorts, inverse positions), matches them against what they protect (same-name pairs first, then proxy attribution through sector/geography/beta), and scores each hedge's protection vs. its cost. Income-generating hedges (short options collecting premium) are scored as income, not cost.
- **Foreign-currency holdings** — prices and cost basis stored in the security's native currency, converted to USD at real broker exchange rates at display time. Every dollar surface in the app carries the conversion; nothing is ever guessed.
- **Delta-adjusted exposure** — allocation views now show *net exposure* alongside market value, so a hedged bucket (stock + puts) correctly reads as less exposed than its dollar size suggests.
- **ETF sector look-through** — ETFs split into their underlying sector weights instead of sitting in one bucket; options classify under their underlying company.
- **Levels performance scoring** (`/dashboard/levels/performance`) — every newsletter author who suggests price levels gets scored on hit rate and 30/60/90-day forward P&L, so you learn whose calls are worth acting on.
- **Armed levels tab** — see every live price level sorted by distance to trigger.

### Earnings coverage, hardened for the season

- **Push-at-print** — the moment actual numbers land for a company you own, your phone gets the headline (EPS/revenue vs. consensus), from whichever side (Mac or cloud) captures it first, de-duplicated.
- **Retry-until-complete enrichment** — earnings rows keep retrying until both actuals and the market reaction are captured; recap emails only fire once real numbers exist. A previewed report stuck 2+ hours without actuals raises a phone alert instead of failing silently.
- **Same-day cloud recaps** — recap emails now go out the same day even when the Mac is asleep, composed in the cloud from independently captured data.
- **Coverage guard** — the Sunday briefing warns when a held name's next earnings date hasn't been scheduled yet (last report >75 days ago, nothing on the calendar).
- **Bogeys upload** — drop a multi-symbol analyst-expectations PDF and the numbers fan out to each company's upcoming event; recaps anchor beat/miss on the whisper numbers when present.
- **Plausibility guards** — implausible reported actuals (vendor data drift, GAAP/FFO mismatches, sign flips vs. consensus) are flagged and blanked rather than displayed as truth.
- **Any exposure counts** — shorts and option positions on a name now trigger earnings coverage, not just long stock.

### Email & research pipeline

- **Evening email** (Mon–Thu 7 PM, Fri 5:30 PM ET) — session recap with cross-source synthesis plus an anomaly block flagging holdings that moved unusually hard relative to the market (beta-adjusted, two-gate).
- **Structured digest composer** — morning/evening digests synthesize per company across sources ("The Session" / "Overnight & Setup"), with essays kept separate in a Research Desk section and late-arriving newsletters rescued into the next send.
- **Forward-to-research** — forward any email (PDF attachment, image, link, or long read) to your personal research address and it becomes a searchable research document.
- **Off-topic filtering** — Substack admin mail short-circuits at fetch; the AI votes on portfolio relevance per article (biased to keep, per-source opt-out, one-click unfilter audit list).
- **Long-newsletter fix** — full newsletter bodies are stored and summarized (previous caps silently truncated long weeklies to their opening sections).

### Works away from home

- **Full cloud fallback suite** — a single Cloudflare Worker cron now mirrors every scheduled job when the Mac is unreachable: morning digest, evening email, Sunday briefing, earnings previews/recaps, newsletter fetching, price-level scanning (with phone push), and calendar enrichment. Everything reconciles back into the Mac's database on wake, and KV markers guarantee nothing sends twice.
- **IBKR without TWS** — a headless OAuth connection to IBKR's Web API refreshes holdings, prices (including options and bonds), and fires price-level alerts even when Trader Workstation is closed — on the Mac and in the cloud.
- **Market-data quotes** — IV, HV, and 52-week ranges cached per security from IBKR snapshots; options Greeks use real implied volatility instead of a blanket assumption.
- **Model resilience** — AI features pick models by capability tier from a live catalog that probes what's actually callable, with automatic failover when a model is pulled — no more silent breakage when a model ID changes.

### Import & data integrity

- **Monthly statement workflow** — guided import for Vanguard PDF + IBKR CSV statement batches with penny-level reconciliation gates.
- **Canonical CSV hardening** — signed cash-effect amount convention locked and documented in all three synced places; strict numeric parsing (comma-bearing values can no longer silently truncate); cents-level dedup keys.
- **Closed-position hygiene** — expired options, matured bonds, and closed equities are swept automatically (with shrink guards so a partial sync can never wipe the book).
- **Flow-adjusted risk metrics** — withdrawals no longer read as crashes; daily totals anchor to broker-reported values.
- **FRED first-print vintages** — stored macro actuals are the release-day first print with per-series units verified against FRED, not whatever the API returns months later.

### UI & polish

- **Privacy sweep** — AI-generated prose (which embeds portfolio figures at generation time) is now masked as a block wherever it renders; outbound emails describe positions presence-only.
- **Touch fixes** — hover-only buttons no longer create invisible tap-traps on phones.
- **Honest feedback** — every mutating button explains no-ops and failures in domain language instead of failing silently.
- **Settings** — per-feature AI model overrides with live tier expansion display, per-email recipients, earnings mute lists — all editable in-app.

---

## v2.2 — Holistic Redesign — 2026-04-30

Branch: `redesign-rollout` → merged to `main` as `a800884` on 2026-04-30 night-end.
Tests: 1387/1387 passing.

### Visual + IA

- **Dual-theme palette** — Amber (Bloomberg-light) light mode + Bloomberg-pro soft-black dark mode. Header sun/moon toggle persists via `vgs:theme` localStorage.
- **IBM Plex font system** — Plex Sans (body) + Plex Mono (numbers + tickers). Replaces prior Inter + Instrument Serif stack.
- **9 → 6 tab IA** — Today | Accounts | Analysis | Research | Charts | Import.
  - Cut: Overview (absorbed into Today), Holdings (cross-account view at `/dashboard/accounts?id=all` + Cmd+K ticker-jump), Calendar (Today week-ahead block), Levels Review (merged into unified Alerts inbox).
  - Old routes redirect (5-line stubs) to cover external bookmarks.
- **App rename** — "Vanguard Skin" → "Portfolio Desk" in chrome (repo name preserved).
- **Today landing view** is the new default — Hero strip + week-ahead releases + Earnings Hub + alerts + nearby levels + IBKR holdings sorted by today's $-move.
- **Unified Alerts inbox** at `/dashboard/alerts` — single `<NotificationBell>` replaces split AlertsBell + ReviewBell. 6 filter pills (Pending / Review / Acted / Ignored / Dismissed / All) merge fired alerts and pending newsletter-extracted levels into one auto-promoted stream.
- **Cmd+K** repurposed as global ticker-jump (gold mono).
- **Persistent chat right rail** at viewport ≥1280px (always-visible 480px panel); slide-in drawer 768–1279px; full-screen overlay on mobile.
- **NotesAmbient overlay** — Cmd+; or floating FAB opens a quick-jot panel from any tab; drafts persist to localStorage; "Save to Notes" posts a journal note.
- **Mobile bottom nav** — Today / Research / Chat / Notes / Analysis. Notes maps to `/dashboard/research?view=notes` (Notes is a sub-view of Research, promoted to a first-class mobile destination).
- **EmptySection primitive** — replaces silent `return null` in Options / Fixed Income / no-data sections with a titled empty card + reason. Pages look intentional, not partially-broken.

### Earnings emails (2026-04-27 → 2026-04-28)

- **Pre- and post-earnings briefing emails** for held names. Migration 042 (`earnings_emails` audit table, UNIQUE on `(event_id, phase)`).
- **Composer** at `lib/digest/send-earnings-email.ts` — deterministic 6-row scoreboard table (EPS / Revenue / Guidance / stock @ T+2h / SPY / QQQ) drawn from `consensus_estimate` + `actual_value` + `reaction_snapshot`, then AI-generated line-by-line bogeys table + prose.
- **Issuer-family aware** via `lib/securities/issuer-family.ts::issuerSiblings` — dual-class symbols (GOOG/GOOGL, BRK A/B, FOX/FOXA, NWS/NWSA, UA/UAA, LBRDA/LBRDK, LSXMA/LSXMK, HEI/HEI.A) roll up correctly.
- **Earnings Hub** on `/dashboard/today` — deduped earnings (Finnhub preferred over manual via ROW_NUMBER) with held/watchlist/no-position chips + preview-sent/recap-sent chips. Inline "+ Add ticker" form, multi-symbol bogeys PDF upload with fan-out.
- **Cron sweep** every 15 min via launchd `enrich-calendar-events.sh`. Settings UI section with master toggle + per-symbol mute list.
- **Worker cloud fallback** (Phase 4) — lean compact email when Mac unreachable; KV-keyed (phase, eventId) markers prevent duplicate sends.
- **Two new feature keys** `earningsPreview` + `earningsRecap` → Sonnet 4.6 with `web_search_20250305`.

### Calendar Living Record (2026-04-24)

- Migration 041 — post-release enrichment pipeline.
- `calendar_events` gains `release_time` (HH:MM ET), `actual_value`, `consensus_value`, `reaction_snapshot` (JSON: SPY/QQQ/TLT + sector ETF), `enriched_at`.
- **Mac launchd** `com.vanguard-skin.calendar-enrich.plist` runs every 15 min, gates Mon-Fri 09:30–18:00 ET.
- **Worker cron** mirror `*/15 * * * *` with cloud-fallback when `CLOUD_ENRICH_ENABLED=true`.
- **Yahoo Finance** as the free real-time bar source for cloud reaction snapshots (Polygon Starter rejected for 15-min delay).
- TWS-always-wins precedence on reconciliation; chips on Calendar rows ("actual 3.2% · SPY −0.41%").

### Email infrastructure

- **Outbound migrated to Resend** from `myportfoliodesk.com` (briefing, digest, earnings preview, earnings recap). DKIM + SPF + DMARC aligned. Subdomain isolation: bounce/return-path on `send.myportfoliodesk.com`, DKIM signs apex.
- **Gmail kept inbound-only** for Vital Knowledge IMAP and OAuth REST newsletter listing.
- **Hybrid Worker cron** for daily digest (8:45 ET weekdays), weekly briefing (Sun 3pm ET), earnings preview/recap, calendar enrichment. Primary path: Worker calls Mac `/api/cron/*` with `X-Cron-Secret`. Fallback: Worker reads R2 state snapshot (schemaVersion 2) and sends via Resend REST.
- **KV-keyed dedup markers** (`mac-sent-*` / `cloud-sent-*` / `mac-running-*`) prevent duplicate sends in the race window when primary is slow.

### Analysis page (Phase 5)

- **Performance sub-view** at `/dashboard/analysis?view=performance` — TWR + XIRR + period selector (YTD/1Y/3Y/5Y/All) + scope picker + per-account breakdown.
- **Trade Reviews relocated** to `/dashboard/analysis?view=trade-reviews`. Old `/dashboard/research?view=reviews` redirects.
- **Momentum Pulse** Today tile — MTUM / SPMO / USMV vs SPY rolling 30/60/90 spread.
- **FRED DGS3MO risk-free rate** plumbing replaces hardcoded 0.045 in Sharpe + Black-Scholes drift. 48h cache in `settings`.
- **Per-scope benchmark default + dropdown picker** on FactorAnalysis card (Vanguard→VTI, IBKR→QQQ, Roth→SPY, ALL→SPY).
- **Bond duration backfill** script (`scripts/backfill-bond-durations.ts`).
- **Sector beta multipliers** exposed via tooltipped details panel on Scenarios card.
- **IncomeYieldSection** — TTM dividends + interest + fees + net income + top 10 payers + per-account breakdown.

### Privacy + accessibility

- **Privacy toggle** masks portfolio-derived $ / % / share counts app-wide. Public market data (benchmark prices, public stock prices on chart axes, ETF returns) stays visible.
- **Privacy-aware formatters** (`<Money>` / `<Pct>` / `<Shares>` / `<Count>` / `usePrivateFormatter`) baked into Recharts tick + tooltip formatters.

### Other

- **Newsletter level extraction** reverted from Kimi K2.6 → Sonnet 4.6 after 30 days / 40 articles produced 0 visible content (Kimi reasoning consumed full 2048 token budget on extraction-style prompts).
- **Resend swap** — outbound now goes through `myportfoliodesk.com` (domain purchased + verified 2026-04-29). Cloudflare Email Routing catch-all handles inbound replies.
- **iPhone polish** — mobile header trim, performance table overflow contained, mobile nav drawer portaled to `document.body` (escapes header `backdrop-filter` stacking context), swipe-left-to-close gesture.

---

## v2.1 — Terminal-style Security Detail — 2026-04-23

Headline: `b099ba7` (initial Terminal aesthetic), Phase 2 KPI row 2026-04-24.

- **MarketDataPanel** — dark Bloomberg-adjacent "data module" pattern containing the chart, levels, and big amber price hero. Stays dark even when the surrounding app eventually flips to a light theme. Solves the chart's current-price-vs-resistance color collision with an amber-only priceLine.
- **TerminalSection / TerminalTH / TerminalTD / TerminalTag / KpiCell** primitives — uppercase mono header styling, hex-spec colors, no rounded pills.
- **KPI strip** between chart and LevelsPanel — Open / Day Range / 52w Range / Volume / ATR(14).
- **Auto-suggested support/resistance** via pivot clustering, each level accompanied by a Claude-written one-sentence narrative (Haiku 4.5).
- **Click-to-add-level** — tap any price on the candlestick to add a level at that cursor position.
- **AI Gateway routing** — every Claude call flows through Cloudflare AI Gateway; `FEATURE_MODELS` map enables one-line model swaps.
- **Workers AI downroute** — alert suggestions on Llama 3.3 70B.
- **R2 disaster-recovery archival** — imported Vanguard PDFs auto-upload via `aws4fetch` (S3-compatible Sigv4).
- **Research PDF knowledge base** — upload analyst reports; Claude extracts metadata + body; SQLite FTS5 powers lexical search; new `query_research_documents` chat tool.
- **EDGAR 10-K / 10-Q section extraction** — chat tool summarizes Item 1A Risk Factors and MD&A.
- **Analyst coverage** via Finnhub recommendation-trend.
- **Chat history persistence** with inline delete.
- **Sortable column headers** — shared `<SortableHeader>` + `<SortPicker>` + `useSortParam` hook across 7 tables; sort state in URL.
- **Two-layer research mention verification** — word-boundary gate + Haiku semantic pass.

---

## v2.0 — V2 Rebuild Complete — 2026-03-30

Full v2 build log archived at [`docs/plans/archive/TODO-v2-complete-2026-03-30.md`](docs/plans/archive/TODO-v2-complete-2026-03-30.md).

Key milestones:

- Multi-source import pipeline (Vanguard PDF via Claude, IBKR CSVs, canonical CSV).
- Live TWS integration with auto-refresh pipeline (positions → enrichment → snapshot prices → valuations → benchmarks → level scan).
- AI chat with 25 database-grounded tools, per-scope personas, agentic multi-step tool use.
- Tax lot tracking with FIFO matching, wash-sale detection, Form 8949 / TXF export.
- Trade Reviews — round-trip reconstruction, letter grades, account-specific profiles.
- Risk + Factor Analysis — drawdown, volatility, Sharpe, Herfindahl, options Greeks, scenario modeling.
- Security Levels & Alerts — static + MA-based levels with Claude-written narratives.
- Newsletter ingestion via Gmail OAuth with per-source AI processing prompts.
- Watchlist, cost-basis reconciliation, corporate actions adjustment.
- Mobile Today view + Cloudflare Mesh remote access + Pushover push.
- Electron desktop app — code-signed, notarized macOS DMG with system tray.
