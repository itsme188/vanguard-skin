# Vanguard Skin — Project TODO

> Last updated: 2026-03-27

## Status Overview

v2 core rebuild is complete. 18 merged PRs, 476 tests (all passing).
Post-v2 work has added IBKR TWS integration, TWR/XIRR engines, agentic chat with 14 tools,
thematic factor analysis, notes/journaling, chat scope selector, per-security candlestick charting,
and IBKR calendar integration with weekly AI briefings. This document tracks remaining work.

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

#### 1A. Daily Equity Curves
**Status:** Per-account `EquityCurveChart` (Accounts tab) now has daily data, split toggle,
date range selector, and crosshair. Overview `CombinedPortfolioChart` still uses monthly only.

- [x] Daily-resolution equity curves using `daily_valuations` table (per-account)
- [x] Split: Total Value, Holdings Value, Cash Balance (three lines)
- [x] Date range selector (1M, 3M, 6M, YTD, 1Y, All)
- [ ] Daily data on Overview combined chart (stacked area with date range pills)
- [x] Hover crosshair showing exact date + values

#### 1B. TWS Live Portfolio Sync + Streaming Prices
**Status:** Portfolio sync done — fetches live positions + NLV + cash from TWS in ~2s.
Filtered to personal account (U13643679), excluding managed advisor account.
Price fetch still uses historical/snapshot modes (~2-40 min).

- [x] Sync Portfolio button: fetches positions, NLV, cash balance from TWS
- [x] Account filtering (personal vs. managed advisor)
- [x] Auto-recompute daily valuations after sync
- [ ] Stream live quotes for current holdings (real-time market data)
- [ ] Faster bulk fetch strategy (parallel where IBKR allows)
- [ ] Use `getAccountUpdates()` for live prices alongside positions (replaces separate price fetch)

#### 1C. Performance Metrics — Period Selectors
**Status:** TWR/XIRR engines work. UI shows periods but lacks user-selectable date ranges.

- [ ] Period selectors: YTD, 1Y, 3Y, 5Y, Since Inception, custom range
- [ ] Portfolio-wide combined TWR/XIRR across all accounts

### Phase 2: Analytics

#### 2A. Benchmark Comparison
- [ ] Benchmark selection: S&P 500, Total Market, 60/40, custom blend
- [ ] Fetch benchmark daily returns via IBKR TWS API historical data
- [ ] Overlay benchmark on equity curve chart
- [ ] Relative performance: alpha, tracking error, information ratio
- [ ] Period comparison table: portfolio vs. benchmark by period

#### 2B. Quantitative Factor Analysis
**Status:** Thematic factor exposure is done (macro themes like AI, energy, rates). This is
about quantitative factor decomposition — different from the thematic system.

- [ ] Market beta (vs S&P 500, total market)
- [ ] Size factor (large/mid/small cap tilt)
- [ ] Value/growth factor
- [ ] Duration/credit exposure (fixed income)
- [ ] Options Greeks (delta, gamma, theta, vega) if positions exist

#### 2C. Risk Decomposition
- [ ] Contribution to portfolio volatility by position
- [ ] Correlation matrix between positions
- [ ] Concentration risk metrics (Herfindahl index)
- [ ] Max drawdown analysis

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
- [ ] FOMC meeting date filtering (hardcoded schedule)
- [ ] Vital Knowledge market commentary integration
- [ ] Automated Sunday email briefing (nodemailer + launchd)

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
| Benchmark comparison | Incomplete | Not built | High |
| Security enrichment | Incomplete | **Partial (TWS enrich route)** | Medium |
| Risk decomposition | Incomplete | Not built | Medium |
| Scenario modeling | Incomplete | Not built | Medium |
| Confidence scoring | Working | Dropped (Claude API is accurate enough) | — |
| Options support | None | Phase 1 done (16 tests) | Medium |
| IBKR TWS API | None | **Phase 1 done (historical + contracts)** | Done |
| Live/streaming prices | None | Not built | **High** |
| Tax report export | None | Not built | Medium |
| Desktop packaging | In progress | AppleScript launcher (dev mode) | Low |
| Notes/journaling | None | **Working** | Done |
| External data (FRED/EDGAR) | None | **Working (chat tools)** | Done |
| Insider trading (SEC Form 4) | None | **Working (chat tool)** | Done |
| Earnings transcripts | None | **Working (multi-source)** | Done |
| Chat scope selector | None | **Working (account filtering)** | Done |

---

## Suggested Build Order (Updated)

### Next Up: Data Gaps + Calendar Polish
1. Daily equity curves on Overview combined chart (date range pills + daily data)
2. Performance period selectors (3Y, 5Y)
3. FOMC meeting dates in calendar
4. Vital Knowledge market commentary in briefings
5. Automated Sunday email briefing (nodemailer + launchd)

### Then: Streaming + Analytics
6. Faster TWS price fetch / streaming prices
7. Benchmark comparison (requires historical benchmark prices from TWS)
8. Quantitative factor analysis (beta, size, value/growth)
9. Risk decomposition
10. Scenario modeling

### Then: Advanced
11. Options Phase 2 (verify with real data first, then Greeks + strategies)
12. Tax report export (8949, wash sales)

### Finally: Polish
13. Desktop packaging (Electron or Tauri)
14. E2E browser tests

---

## Known Bugs

1. Vanguard Taxable at 87% coverage — Retry threshold raised to 95% but 87% slipped through before the fix
2. Holdings cost basis column all "–" in Accounts tab — Data gap, not a code bug (tooltip explains)
3. Earnings transcript timeline empty — Fetch UI wired to EarningsView but may need data
4. ~~`tests/tws/historical.test.ts` — 1 failing test~~ — Fixed (all 476 tests passing)

## Known Gaps (Not Bugs)

- No benchmark comparison
- Wash sale warnings in chat system prompt but no auto-detection
- `next build` fails in worktrees with existing `data/vanguard.db`
- TWS price fetch takes ~40 min due to IBKR rate limits
