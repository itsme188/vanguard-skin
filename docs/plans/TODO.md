# Vanguard Skin — Project TODO

> Last updated: 2026-03-27

## Status Overview

v2 core rebuild is complete. 18 merged PRs, 492 tests (all passing).
Post-v2 work has added IBKR TWS integration, TWR/XIRR engines, agentic chat with 14 tools,
thematic factor analysis, notes/journaling, chat scope selector, per-security candlestick charting,
IBKR calendar integration with weekly AI briefings, benchmark comparison with percent-change charts,
risk decomposition (drawdown, volatility, Sharpe, Herfindahl), streaming live quotes via TWS,
and custom date range performance analysis. This document tracks remaining work.

---

## Completed Since v2 Launch

Everything below was built between 2026-03-06 and 2026-03-27.

### IBKR TWS API — Phase 1 (PR #8)
- [x] TWS API client library (`lib/tws/client.ts`) — singleton on `globalThis`, `@stoqey/ib`
- [x] Historical price fetcher (`lib/tws/historical.ts`) — backfill + incremental
- [x] Contract resolution (`lib/tws/contracts.ts`) — symbol → IBKR contract
- [x] Rate limiter (`lib/tws/rate-limiter.ts`) — respects IBKR throttling
- [x] API routes: `/api/tws/connect`, `/api/tws/disconnect`, `/api/tws/status`, `/api/tws/prices`, `/api/tws/enrich`
- [x] UI: `TwsStatus.tsx` connection indicator with streaming progress during price fetch
- [x] Fallback: graceful degradation when TWS is not running

### Performance Metrics — TWR & XIRR (PRs #10, #13)
- [x] `lib/compute/twr.ts` — Chain-linked Modified Dietz method, annualized
- [x] `lib/compute/xirr.ts` — Newton-Raphson extended IRR
- [x] `PerformanceMetrics.tsx` rebuilt with TWR periods, XIRR display
- [x] Per-account and combined computation

### Agentic Chat (PRs #9, #10, #12, recent commits)
- [x] Hybrid architecture: static context (~2,500 tokens) + 14 dynamic DB tools
- [x] Agentic loop: stream → detect tool_use → execute server-side → re-stream (max 8 iterations)
- [x] Upgraded to Opus 4.6 with adaptive thinking and prompt caching
- [x] Markdown rendering (`react-markdown` + `remark-gfm`)
- [x] Chat scope selector — account filtering with chip bar, badge, dynamic system prompt
- [x] Data quality pass — bond maturity, annotations, account matching

### External Data APIs (PRs #13, #14)
- [x] FRED API (`lib/apis/fred.ts`) — 800K+ economic data series as chat tool
- [x] SEC EDGAR API (`lib/apis/edgar.ts`) — company financials, filings, insider trades
- [x] SEC Form 4 insider trading tool — recent trades by ticker
- [x] Earnings transcript pipeline — EDGAR 8-K → Motley Fool → API Ninjas (layered sources)

### Thematic Factor Exposure (analysis tab)
- [x] `security_factors` table with query-time inheritance for options
- [x] `lib/factors.ts` — constants, labels, colors
- [x] Auto-classify with Sonnet 4 + training examples
- [x] `FactorHeatmap.tsx` + `AnalysisView.tsx` in Analysis tab
- [x] Security classification UI

### Notes & Journaling (PR #15)
- [x] Notes tab with create/edit/delete
- [x] `NotesView.tsx` component

### Desktop Launcher (PR #11)
- [x] `scripts/launch-dashboard.sh` lifecycle manager
- [x] `scripts/VanguardDashboard.applescript` stay-open applet (port 3099)
- [x] Non-blocking idle polling, PATH export for node discovery

### Per-Security Candlestick Charts (recent commits)
- [x] LightweightCharts v5 integration (`SecurityChart.tsx`)
- [x] OHLCV bars table with TWS historical data fetch
- [x] Technical indicators: EMA 9/21, SMA 50/200
- [x] Daily bars cached in SQLite, intraday (1m/5m) live from TWS
- [x] Transaction markers (BUY/SELL) on chart
- [x] Duration selector (1M–2Y–All) + timeframe selector (Daily/5m/1m)

### IBKR Calendar Integration (recent commits)
- [x] WSH company events (earnings, analyst meetings) via TWS API
- [x] FRED macro events (authoritative dates from BLS, Census, Fed, ISM)
- [x] Claude enrichment (descriptions, consensus estimates, impact ratings)
- [x] Calendar tab with week grid + agenda/briefing side-by-side layout
- [x] Weekly briefing generation via Claude Sonnet
- [x] Overview tab Upcoming Events card
- [x] 13 database migrations, `calendar_events` + `calendar_briefings` tables

### Custom Date Range & Benchmark Comparison (2026-03-27)
- [x] Custom date range picker for TWR/XIRR (client-side fetch via API)
- [x] XIRR API route (`/api/compute/xirr`)
- [x] Benchmark price table (`benchmark_prices`, migration 014)
- [x] Benchmark fetch from TWS (`lib/tws/benchmark.ts`) — SPY/QQQ/DIA/VTI
- [x] Benchmark analytics: alpha, tracking error, information ratio, correlation
- [x] Percent-change chart mode ($ / % toggle) on Overview combined chart
- [x] Benchmark overlay as dashed line with stats bar

### Risk Decomposition (2026-03-27)
- [x] `lib/compute/risk.ts` — max drawdown, volatility, Sharpe, Herfindahl
- [x] Risk API route (`/api/compute/risk`)
- [x] Risk metrics card in Analysis tab with concentration bar chart
- [x] 9 risk tests + 7 benchmark tests (all passing)

### Streaming Live Quotes (2026-03-27)
- [x] `lib/tws/streaming.ts` — TWS market data subscriptions via Observable
- [x] SSE streaming API (`/api/tws/stream`) with client management
- [x] `useStreamingQuotes` hook with auto-reconnect
- [x] Stream Live / Stop / Save buttons in TWS panel
- [x] Pulsing indicator in TWS status bar

### Tech Debt Closed
- [x] SQL injection — parameterized queries across portfolio-summary.ts and other files
- [x] `toLocaleDateString()` SSR hydration — confirmed safe (all in `"use client"` components)
- [x] OCC symbol enforcement — `ensureOCCSymbol()` + type conflict guard in `upsertSecurity()`
- [x] Bond cost basis 100x display — uses `adjusted_cost_basis` from SQL
- [x] Tax lots not auto-computed after import — `computeTaxLots(db)` in import route
- [x] Tax lot summary ignoring account filter — fallback calculations from filtered data
- [x] Stale "as of" dates — `getAccountSummaries()` prefers daily_valuations over monthly_snapshots
- [x] Recharts tooltip warnings — suppressed with proper props
- [x] API key env shadowing + chat streaming text concatenation
- [x] Turbopack cache corruption recovery

---

## Remaining Work

### Phase 1: Data Gaps

#### 1A. Daily Equity Curves ✓
**Status:** Complete — both per-account and Overview charts have daily data with date range pills.

- [x] Daily-resolution equity curves using `daily_valuations` table (per-account)
- [x] Split: Total Value, Holdings Value, Cash Balance (three lines)
- [x] Date range selector (1M, 3M, 6M, YTD, 1Y, All)
- [x] Daily data on Overview combined chart (stacked area with date range pills)
- [x] Hover crosshair showing exact date + values

#### 1B. TWS Live Portfolio Sync + Streaming Prices
**Status:** Portfolio sync done + streaming live quotes implemented.
Uses delayed/frozen quotes (no exchange subscription needed). SSE-based with auto-reconnect.

- [x] Sync Portfolio button: fetches positions, NLV, cash balance from TWS
- [x] Account filtering (personal vs. managed advisor)
- [x] Auto-recompute daily valuations after sync
- [x] Stream live quotes for current holdings (delayed market data via TWS)
- [ ] Faster bulk fetch strategy (parallel where IBKR allows)
- [ ] Use `getAccountUpdates()` for live prices alongside positions (replaces separate price fetch)

#### 1C. Performance Metrics — Period Selectors ✓
**Status:** Complete — YTD/1Y/3Y/5Y/All preset + custom date range picker with client-side fetch.

- [x] Period selectors: YTD, 1Y, 3Y, 5Y, Since Inception (All), custom date range
- [x] Portfolio-wide combined TWR/XIRR across all accounts

### Phase 2: Analytics

#### 2A. Benchmark Comparison ✓
- [x] Benchmark selection: S&P 500, Nasdaq 100, Dow Jones, Total Market (SPY/QQQ/DIA/VTI)
- [x] Fetch benchmark daily returns via IBKR TWS API historical data
- [x] Overlay benchmark on equity curve chart (percent-change mode)
- [x] Relative performance: alpha, tracking error, information ratio, correlation
- [x] Period comparison table: portfolio vs. benchmark by period (YTD/1Y/3Y/5Y/All with alpha)

#### 2B. Quantitative Factor Analysis
**Status:** Thematic factor exposure is done (macro themes like AI, energy, rates). This is
about quantitative factor decomposition — different from the thematic system.

- [ ] Market beta (vs S&P 500, total market)
- [ ] Size factor (large/mid/small cap tilt)
- [ ] Value/growth factor
- [ ] Duration/credit exposure (fixed income)
- [ ] Options Greeks (delta, gamma, theta, vega) if positions exist

#### 2C. Risk Decomposition (Partial ✓)
- [x] Contribution to portfolio volatility by position
- [x] Correlation matrix between positions
- [x] Concentration risk metrics (Herfindahl index, top-5 concentration)
- [x] Max drawdown analysis (max + current, with dates)
- [x] Portfolio volatility (annualized) and Sharpe ratio
- [x] Risk metrics UI card in Analysis tab

#### 2D. Scenario Modeling
- [ ] Market crash scenarios (-10%, -20%, -40%)
- [ ] Interest rate shock (+100bp, +200bp)
- [ ] Sector rotation scenarios
- [ ] Custom "what-if" with user-defined assumptions

### Phase 3: Advanced Features

#### 3A. Options Analytics (Phase 2)
**Status:** Phase 1 done (schema, parsers, valuation, display). 16 tests passing.
Pending real option data import to verify end-to-end.

- [ ] Verify Phase 1 with real IBKR option data
- [ ] Options P&L tracking: open/closed positions, realized/unrealized by strategy
- [ ] Options Greeks dashboard: portfolio-level delta, gamma, theta, vega
- [ ] Strategy detection: covered calls, spreads, straddles, etc.
- [ ] Options-specific tax lot handling (assignment, exercise, expiration)
- [ ] Expiration calendar view
- [ ] Option chain fetcher via TWS API (chains by underlying + expiry)

#### 3B. Tax Report Export
- [ ] IRS Form 8949 data export (CSV or PDF)
- [ ] Short-term vs. long-term gain/loss summary by year
- [ ] Wash sale detection and adjustment
- [ ] Cost basis reconciliation report (compare computed vs. broker-reported)
- [ ] Export for TurboTax or tax preparer

#### 3C. IBKR Calendar Integration ✓
- [x] Economic events calendar (FRED data, Fed meetings, CPI releases)
- [x] Earnings calendar for held securities (WSH via TWS API)
- [x] Weekly automated briefing (Claude Sonnet summary)
- [x] FOMC meeting date filtering (hardcoded 2026 schedule from federalreserve.gov)
- [x] Vital Knowledge market commentary integration (IMAP-based)
- [x] Automated Sunday email briefing (nodemailer + launchd)

### Phase 4: Polish

#### 4A. Desktop Packaging
**Status:** AppleScript launcher works for dev mode. Full packaging would be a standalone app.

- [ ] Decide: Electron vs. Tauri (Tauri is lighter, Rust-based)
- [ ] Standalone build configuration (production Next.js, not dev server)
- [ ] Auto-launch TWS connection on startup
- [ ] System tray with portfolio summary
- [ ] Auto-update mechanism

**Deferred until:** Web app is feature-complete with TWS integration.

#### 4B. Testing
- [ ] E2E browser tests (~15 hours estimated, deferred to dedicated session)

---

## Feature Comparison: v1 vs. v2

| Feature | v1 Status | v2 Status | Priority |
|---------|-----------|-----------|----------|
| CSV import (IBKR + Vanguard) | Working | Working + improved | Done |
| PDF import (Vanguard) | Working (OCR) | Working (Claude API) | Done |
| Monthly snapshots | Working | Working | Done |
| Combined portfolio chart | Working | Working (new theme) | Done |
| Per-account equity curves | Working (daily) | **Working (daily + split + date ranges)** | Done |
| Tax lot tracking (FIFO) | Working | Working + year/account filter | Done |
| Reconciliation | Working | Working | Done |
| Portfolio Chat (Claude Q&A) | Incomplete | **Agentic, 14 tools, Opus 4.6** | Done |
| TWR / XIRR performance | Working | **Working** | Done |
| Thematic factor analysis | None | **Working (auto-classify + heatmap)** | Done |
| Quantitative factor analysis | Incomplete | Not built | High |
| Benchmark comparison | Incomplete | **Working (SPY overlay + period table)** | Done |
| Security enrichment | Incomplete | **Partial (TWS enrich route)** | Medium |
| Risk decomposition | Incomplete | **Working (drawdown, vol, Sharpe, Herfindahl)** | Done |
| Scenario modeling | Incomplete | Not built | Medium |
| Confidence scoring | Working | Dropped (Claude API is accurate enough) | — |
| Options support | None | Phase 1 done (16 tests) | Medium |
| IBKR TWS API | None | **Phase 1 done (historical + contracts)** | Done |
| Live/streaming prices | None | **Working (SSE + TWS delayed quotes)** | Done |
| Tax report export | None | Not built | Medium |
| Desktop packaging | In progress | AppleScript launcher (dev mode) | Low |
| Notes/journaling | None | **Working** | Done |
| External data (FRED/EDGAR) | None | **Working (chat tools)** | Done |
| Insider trading (SEC Form 4) | None | **Working (chat tool)** | Done |
| Earnings transcripts | None | **Working (multi-source)** | Done |
| Chat scope selector | None | **Working (account filtering)** | Done |

---

## Suggested Build Order (Updated)

### ~~Data Gaps + Calendar Polish~~ — DONE (2026-03-27)
~~1-5. Daily charts, performance periods, FOMC, VK, email~~ ✓

### ~~Streaming + Analytics~~ — MOSTLY DONE (2026-03-27)
~~6. Streaming live quotes~~ ✓
~~7. Benchmark comparison~~ ✓
~~9. Risk decomposition~~ ✓ (portfolio-level; position-level deferred)
8. Quantitative factor analysis (beta, size, value/growth)
10. Scenario modeling

### ~~UX Overhaul~~ — DONE (2026-03-29)
~~Security Detail page, tab reorganization (10→8), chat drawer, Holdings tab,
Research tab, reconciliation merge, universal SymbolLinks, DataFreshness,
Watchlist feature~~ ✓

### UX & Analytics Polish — DONE (2026-03-29)
~~1. Income tracking~~ ✓ (IncomeCard on Overview)
~~2. Global search (Cmd+K)~~ ✓ (CommandPalette — securities, notes, transactions)
~~3. Morning briefing widget~~ ✓ (MorningBriefing — today's events, market status, weekly brief)
~~4. Period comparison table~~ ✓ (portfolio vs SPY: YTD/1Y/3Y/5Y/All with alpha)

### Next Up
1. Quantitative factor analysis (market beta, size, value/growth)
~~2. Position-level risk~~ ✓ (per-position vol, risk contribution, correlation matrix)

### Then: Advanced
7. Scenario modeling (crash, rate shock, custom what-ifs)
8. Options Phase 2 (verify with real data first, then Greeks + strategies)
9. Tax report export (8949, wash sales)

### Finally: Polish
10. Desktop packaging (Electron or Tauri)
11. E2E browser tests

---

## Known Bugs

1. Vanguard Taxable at 87% coverage — Retry threshold raised to 95% but 87% slipped through before the fix
2. Holdings cost basis column all "–" in Accounts tab — Data gap, not a code bug (tooltip explains)
3. Earnings transcript timeline empty — Fetch UI wired to EarningsView but may need data
4. ~~`tests/tws/historical.test.ts` — 1 failing test~~ — Fixed (all 476 tests passing)

## Known Gaps (Not Bugs)

- ~~No benchmark comparison~~ — Implemented (commit efccfa5)
- Wash sale warnings in chat system prompt but no auto-detection
- `next build` data collection fails with existing `data/vanguard.db` (TypeScript compilation succeeds)
- TWS price fetch takes ~40 min due to IBKR rate limits
- Stale SHM/WAL files can cause SQLite corruption — remove `.db-shm` and `.db-wal` to fix
