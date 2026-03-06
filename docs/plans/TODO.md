# Vanguard Skin — Project TODO

> Last updated: 2026-03-06

## Status Overview

v2 core rebuild is complete (16 tasks, 6 PRs merged, 160+ tests). This document tracks
everything still needed: features carried forward from v1, improvements over v1, and
net-new capabilities.

---

## 1. Uncommitted Work (This Session)

- [x] Tax lot year filtering (calendar year cutoff for short-term gains)
- [x] Per-account tax lot breakdown with account picker pills
- [x] Case-insensitive transaction type matching in compute engine (Vanguard + IBKR)
- [x] Null safety for money market reinvestments (VMFXX)

**Status:** Working, needs commit + PR.

---

## 2. v1 Features to Rebuild (Better)

These features existed in v1 and need to be rebuilt in v2. The goal is not to replicate
them — it's to improve on them using v2's architecture.

### 2A. Performance Metrics — TWR & XIRR

**v1 had:** `lib/compute/twr.ts`, `lib/compute/xirr.ts`, `/api/performance` route,
`PerformanceMetrics.tsx` with 4 cards (YTD, Since Inception, TWR, XIRR).

**v2 currently has:** Simplified `PerformanceMetrics.tsx` showing only total portfolio
value + month-over-month change. No TWR or XIRR computation.

**What to build:**
- [ ] `lib/compute/twr.ts` — Time-Weighted Return (chain-linked sub-period returns,
  split at external cash flows). Annualized via `(1+TWR)^(365/days) - 1`.
- [ ] `lib/compute/xirr.ts` — Extended IRR via Newton-Raphson. Initial investment
  negative, external flows inverted, final value positive.
- [ ] Performance computation per account and combined
- [ ] Period selectors: YTD, 1Y, 3Y, 5Y, Since Inception, custom range
- [ ] Enhanced `PerformanceMetrics.tsx` with TWR, XIRR, simple return, and period comparison
- [ ] Consider: compute on-demand vs. pre-computed (v1 was on-demand API call)

**Improvement over v1:** v1 only had account-level metrics. v2 should also compute
portfolio-wide TWR/XIRR across all accounts, and support arbitrary date range selection.

### 2B. Equity Curve — Daily Resolution

**v1 had:** `EquityCurveChart.tsx` with three lines (Total Value, Holdings Value, Cash
Balance) from `daily_valuations` table. Per-account, 400px, with compute button.

**v2 currently has:** `EquityCurveChart.tsx` using monthly snapshots (one data point per
month). Single area chart per account, no cash/holdings split.

**What to build:**
- [ ] Daily-resolution equity curves using `daily_valuations` table
- [ ] Split: Total Value, Holdings Value, Cash Balance (three lines like v1)
- [ ] Date range selector (1M, 3M, 6M, YTD, 1Y, All)
- [ ] Multi-account overlay option on combined chart
- [ ] Hover crosshair showing exact date + values

**Improvement over v1:** v1 was per-account only. v2 should support combined view with
account toggles and more flexible date ranges.

### 2C. Factor Analysis & Portfolio Composition

**v1 had (incomplete, lost with worktree):**
- `FactorAnalysis.tsx` — UI component
- `lib/compute/factor-analysis.ts` — factor exposure computation
- `lib/compute/risk-decomposition.ts` — risk decomposition engine
- `lib/compute/scenario-modeling.ts` — scenario modeling ("what-if")
- `lib/compute/holdings-analysis.ts` — holdings breakdown
- `lib/import/security-enrichment.ts` — sector/asset class metadata
- API routes: `/api/factor-analysis`, `/api/factor-analysis/scenario`,
  `/api/factor-analysis/risk`, `/api/holdings-breakdown`, `/api/securities/enrich`
- Test files for scenario modeling and risk decomposition

Source code was never recovered — only file names and descriptions survived.

**What to build:**
- [ ] Security enrichment: sector, asset class, geography, market cap, duration (bonds)
  - Source: IBKR TWS API (see §3A) or static mapping + manual overrides
- [ ] Holdings breakdown: pie/treemap by sector, asset class, geography, account
- [ ] Factor exposure analysis:
  - Market beta (vs S&P 500, total market)
  - Size factor (large/mid/small cap tilt)
  - Value/growth factor
  - Sector concentration
  - Duration/credit exposure (fixed income)
  - Options Greeks (delta, gamma, theta, vega) if positions exist
- [ ] Risk decomposition:
  - Contribution to portfolio volatility by position
  - Correlation matrix between positions
  - Concentration risk metrics (Herfindahl index)
  - Max drawdown analysis
- [ ] Scenario modeling:
  - Market crash scenarios (-10%, -20%, -40%)
  - Interest rate shock (+100bp, +200bp)
  - Sector rotation scenarios
  - Custom "what-if" with user-defined assumptions
- [ ] New dashboard tab or section for Factor Analysis

**Improvement over v1:** v1 never finished this. v2 should ship a complete, working
implementation. Use IBKR TWS API for live factor data where possible.

### 2D. Benchmark Comparison

**v1 had (incomplete, lost with worktree):**
- `BenchmarkSettings.tsx` — benchmark configuration UI

Source code was never recovered.

**What to build:**
- [ ] Benchmark selection: S&P 500, Total Market, 60/40, custom blend
- [ ] Fetch benchmark daily returns (via IBKR TWS API historical data)
- [ ] Overlay benchmark on equity curve chart
- [ ] Relative performance: alpha, tracking error, information ratio
- [ ] Period comparison table: portfolio vs. benchmark by period

**Improvement over v1:** v1 only started a settings UI. v2 should ship the full
comparison with automated benchmark data fetch via TWS API.

### 2E. Confidence Scoring (Statement Pipeline)

**v1 had:** 3-stage pipeline (parse → validate → reconcile) with confidence scores on
every extracted value from PDFs.

**v2 currently has:** Simpler pipeline (detect → parse → preview → commit) using Claude
API for PDF parsing. No confidence scores.

**What to build:**
- [ ] Consider: is confidence scoring still needed with Claude API parsing?
  - Claude API is far more reliable than OCR (puppeteer + tesseract)
  - May still be useful for flagging anomalies in extracted data
- [ ] If yes: add confidence metadata to preview response, show warnings in import UI

**Decision needed:** This may not be worth rebuilding. Claude API parsing is
significantly more accurate than v1's OCR pipeline. Flag for review.

---

## 3. New Features (Not in v1)

### 3A. IBKR TWS API Integration — Live & Historical Data

**Priority: HIGH — this is the price data engine for everything not in statements.**

The Interactive Brokers Trader Workstation (TWS) API provides:
- Real-time streaming quotes
- Historical daily/weekly/monthly bars (OHLCV)
- Option chains with Greeks
- Contract details (security metadata)
- Account summary and positions

**What to build:**
- [ ] TWS API client library (`lib/ibkr/tws-client.ts`)
  - Connection management (TWS must be running locally on port 7496/7497)
  - Request/response handling with IBKR's event-driven protocol
  - Rate limiting and throttling (IBKR has strict limits)
- [ ] Historical price fetcher (`lib/ibkr/historical-prices.ts`)
  - Fetch daily OHLCV for any security
  - Backfill `prices` table with historical data
  - Incremental updates (only fetch missing dates)
- [ ] Real-time price updater (`lib/ibkr/live-quotes.ts`)
  - Stream live quotes for current holdings
  - Update `prices` table with latest close
  - Refresh daily valuations on demand
- [ ] Option chain fetcher (`lib/ibkr/option-chains.ts`)
  - Fetch option chains by underlying + expiry
  - Greeks (delta, gamma, theta, vega, implied vol)
  - Update options positions with current market data
- [ ] Contract details enrichment (`lib/ibkr/contract-details.ts`)
  - Look up sector, industry, asset class for any security
  - Populate security enrichment data (feeds into Factor Analysis)
- [ ] API routes:
  - `POST /api/ibkr/connect` — establish TWS connection
  - `POST /api/ibkr/fetch-prices` — backfill historical prices
  - `GET /api/ibkr/status` — connection status
  - `POST /api/ibkr/refresh` — refresh current prices for all holdings
- [ ] UI: connection status indicator, manual refresh button, auto-refresh toggle
- [ ] Fallback: graceful degradation when TWS is not running

**Architecture notes:**
- TWS API is a socket-based protocol (not REST). Need `ib-tws-api` or similar npm package.
- TWS must be running on the local machine — this is a desktop-only feature.
- Consider: WebSocket bridge from Next.js API route to TWS socket.
- Rate limits: max 60 historical data requests per 10 minutes.
- This replaces manual CSV price imports as the primary price data source.

### 3B. Options Analytics (Phase 2)

**v2 currently has (PR #6):** Options Phase 1 — schema, parsers, valuation, display.
Needs real option data to verify.

**What to build:**
- [ ] Verify Phase 1 with real IBKR option data
- [ ] Options P&L tracking: open/closed positions, realized/unrealized by strategy
- [ ] Options Greeks dashboard: portfolio-level delta, gamma, theta, vega
- [ ] Strategy detection: covered calls, spreads, straddles, etc.
- [ ] Options-specific tax lot handling (assignment, exercise, expiration)
- [ ] Expiration calendar view

### 3C. Tax Report Export

**What to build:**
- [ ] IRS Form 8949 data export (CSV or PDF)
- [ ] Short-term vs. long-term gain/loss summary by year
- [ ] Wash sale detection and adjustment
- [ ] Cost basis reconciliation report (compare computed vs. broker-reported)
- [ ] Export for TurboTax or tax preparer

### 3D. Desktop Packaging

**v1 had:** Electron 40, standalone Next.js build on port 3847. Was being worked on when
the project was lost.

**What to build:**
- [ ] Decide: Electron vs. Tauri (Tauri is lighter, Rust-based)
- [ ] Standalone build configuration
- [ ] Auto-launch TWS connection on startup
- [ ] System tray with portfolio summary
- [ ] Auto-update mechanism

**Deferred until:** Web app is feature-complete with TWS integration.

---

## 4. Feature Comparison: v1 vs. v2

| Feature | v1 Status | v2 Status | Priority |
|---------|-----------|-----------|----------|
| CSV import (IBKR + Vanguard) | Working | Working + improved | Done |
| PDF import (Vanguard) | Working (OCR) | Working (Claude API) | Done |
| Monthly snapshots | Working | Working | Done |
| Combined portfolio chart | Working | Working (new theme) | Done |
| Per-account equity curves | Working (daily) | Working (monthly only) | Medium |
| Tax lot tracking (FIFO) | Working | Working + year/account filter | Done |
| Reconciliation | Working | Working | Done |
| Portfolio Chat (Claude Q&A) | Incomplete | Working | Done |
| TWR / XIRR performance | Working | Not built | High |
| Factor analysis | Incomplete | Not built | **High** |
| Benchmark comparison | Incomplete | Not built | High |
| Security enrichment | Incomplete | Not built | High |
| Risk decomposition | Incomplete | Not built | Medium |
| Scenario modeling | Incomplete | Not built | Medium |
| Confidence scoring | Working | Not needed? | Low |
| Options support | None | Phase 1 done | Medium |
| IBKR TWS API | None | Not built | **High** |
| Tax report export | None | Not built | Medium |
| Desktop packaging | In progress | Not built | Low |
| Live/streaming prices | None | Not built | **High** |

---

## 5. Suggested Build Order

### Phase 1: Data Foundation
1. IBKR TWS API client + historical price fetcher
2. Security enrichment via contract details
3. Daily equity curve upgrade (use price data)

### Phase 2: Analytics
4. TWR & XIRR performance metrics
5. Benchmark comparison (requires historical benchmark prices from TWS)
6. Factor analysis — holdings breakdown + factor exposure
7. Risk decomposition

### Phase 3: Advanced
8. Scenario modeling
9. Options Phase 2 (Greeks, strategies, P&L)
10. Tax report export (8949, wash sales)

### Phase 4: Polish
11. Desktop packaging (Electron or Tauri)
12. Auto-refresh and real-time updates

---

## 6. Technical Debt & Improvements

- [ ] SQL injection risk: some queries use string interpolation for year parameter
  (e.g., `WHERE sale_date >= '${year}-01-01'`). Should use parameterized queries.
- [ ] `PerformanceMetrics.tsx` is a thin shell — needs full rebuild (§2A)
- [ ] `EquityCurveChart.tsx` only uses monthly snapshots — needs daily resolution (§2B)
- [ ] Options Phase 1 is unverified with real data
- [ ] No automated E2E tests (only unit + integration)
- [ ] `toLocaleDateString()` SSR hydration risk in some components
