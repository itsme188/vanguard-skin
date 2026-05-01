# Vanguard Skin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.1.0-blue)](https://github.com/itsme188/vanguard-skin/releases)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://typescriptlang.org)
[![Tests: 1100 passing](https://img.shields.io/badge/tests-1100_passing-brightgreen)](#testing)
[![Electron](https://img.shields.io/badge/Electron-Desktop-9B59B6)](https://www.electronjs.org/)

A local-first portfolio dashboard for tracking Vanguard and Interactive Brokers investments. Import brokerage statements, sync live positions via TWS, and run the whole thing through an AI-powered workspace — chat grounded in your real data, weekly Opus-4.7 research briefings, automatic support/resistance detection with Claude-written narratives, scenario modeling, and level alerts pushed to your phone. Available as a web app or native macOS desktop app. Your data never leaves your Mac except for the AI calls you choose to make.

![Vanguard Skin Dashboard](docs/screenshots/overview.png)

---

## Features

<table>
<tr>
<td width="33%" valign="top">
<h3>Portfolio Overview</h3>
Combined equity curves across all accounts with daily resolution. Performance metrics (TWR, XIRR) for YTD, 1Y, 3Y, 5Y, and custom date ranges. Benchmark comparison against SPY, QQQ, and VTI with dollar and percent toggle. Data confidence score across 5 dimensions (freshness, holdings recency, cash accuracy, enrichment, valuation coverage).
</td>
<td width="33%" valign="top">
<h3>Multi-Source Import</h3>
Nine format-specific parsers: Vanguard PDFs (Claude AI extraction), IBKR activity/holdings/cost-basis CSVs, monthly snapshots, factor CSVs, and a universal canonical CSV format. Deterministic deduplication, pre-commit validation (dates, quantities, signs, sanity checks), and automatic R2 archival of source PDFs for disaster recovery.
</td>
<td width="33%" valign="top">
<h3>Live TWS Integration</h3>
Sync positions, cash, and streaming quotes directly from IBKR Trader Workstation. Auto-refresh pipeline (positions → enrichment → snapshot prices → valuations → benchmarks → level-alert scan) runs on TWS connect and every 30 min while connected. Historical OHLCV bars for per-security charting with SMA/EMA overlays and BUY/SELL transaction markers.
</td>
</tr>
<tr>
<td width="33%" valign="top">
<h3>AI Chat (25 Tools)</h3>
Ask questions about your portfolio using Claude Opus 4.7 with 25 database-grounded tools. Agentic multi-step tool use with anti-hallucination guardrails. Per-scope personas (IBKR trading desk, Roth strategist, Taxable tax-aware). Chat history persists across sessions with inline delete. Queries press releases, 8-K bodies, 10-K Item 1A, analyst coverage, and uploaded research PDFs.
</td>
<td width="33%" valign="top">
<h3>Tax Lot Tracking</h3>
FIFO cost-lot matching with wash-sale detection (30-day window). Realized and unrealized gain/loss by year, account, and security. Form 8949 CSV export and TurboTax TXF format. Full support for stocks, options (with OCC symbol handling), and bonds (par-adjusted cost basis and market value).
</td>
<td width="33%" valign="top">
<h3>Trade Reviews</h3>
Monthly AI trade analysis. Round-trip reconstruction from tax lots, letter grades (A-F) per trade with entry thesis and exit assessment, pattern identification across the period, and actionable recommendations. Account-specific profiles (IBKR active trading, Vanguard buy-and-hold, Roth long-term). Auto-selects Sonnet for large batches, Opus for small ones.
</td>
</tr>
<tr>
<td width="33%" valign="top">
<h3>Risk & Factor Analysis</h3>
Max drawdown, portfolio volatility, Sharpe ratio, and Herfindahl concentration. Per-position risk contribution with correlation matrices. Quantitative factor exposure (size, style, value, growth, momentum, quality) via market-beta regression against SPY. Options Greeks (Black-Scholes delta, gamma, theta, vega, IV) and strategy detection (covered calls, spreads, collars).
</td>
<td width="33%" valign="top">
<h3>Scenario Modeling</h3>
Nine preset scenarios (market crash, rate shocks, rally, sector rotation, stagflation) plus custom what-if analysis. Position-level impact estimates based on factor exposures and historical sensitivities. Fixed-income stress testing by duration band and credit quality.
</td>
<td width="33%" valign="top">
<h3>Research Calendar</h3>
Earnings dates and company events via IBKR Wall Street Horizon. Macro events (FOMC, CPI, jobs, GDP, PCE) from FRED with Claude-verified reschedules. Per-held-stock earnings from Finnhub. Weekly Opus-4.7 briefings that read full-text from preferred sources and surface expiring options + macro + earnings, delivered by email Sunday afternoon.
</td>
</tr>
<tr>
<td width="33%" valign="top">
<h3>Security Levels & Alerts</h3>
Per-security price levels — static or resolved from moving averages (SMA/EMA 9/21/50/200). Alerts fire automatically during auto-refresh; Claude writes a one-sentence recommendation per alert. Newsletter ingestion auto-extracts ticker + price mentions and stages them for review. Auto-detected support/resistance from pivot clustering, each with a Haiku-written narrative explaining the level.
</td>
<td width="33%" valign="top">
<h3>Research Feeds + Documents</h3>
Gmail newsletter ingestion via OAuth 2.0 with per-source custom AI processing prompts. Sentiment analysis, ticker extraction, security linking, and two-layer mention verification (word-boundary gate + Haiku semantic pass). Upload analyst reports / research notes as PDFs — Claude extracts structured metadata, SQLite FTS5 powers lexical search, and the chat agent can query them via tool.
</td>
<td width="33%" valign="top">
<h3>Security Detail Hub</h3>
Per-security Bloomberg-style terminal page — candlestick chart with auto-suggested support/resistance, cross-account positions, tax lots, realized sales, AI trade grades, transactions (stock + option), notes, calendar events, factor exposure, earnings transcripts, corporate actions, and research mentions. Every symbol in the app links here. Click any chart price to add a level in-place.
</td>
</tr>
</table>

### Also includes

- **Privacy toggle** — one-click mask of all dollar / percent / share values (symbols + dates stay visible) for screen-sharing and photos
- **Mobile Today view** — phone-first single-column summary: pending alerts, nearby levels, chat launcher, holdings — delivered over Cloudflare Mesh to your iPhone
- **Pushover mobile push** — level alerts to your phone with deep-link back to the security
- **Global search** with Command Palette (Cmd+K) across securities, notes, and transactions
- **Watchlist** for tracking securities not yet owned, with price targets and investment thesis
- **Cost basis reconciliation** comparing broker-reported vs. computed cost basis
- **Corporate actions** (stock splits, reverse splits) with full historical adjustment across all tables
- **Data Health dashboard** showing price coverage, data freshness, gaps, and cross-source discrepancies
- **Sortable column headers** across Holdings, Transactions, Tax Lots, Alerts, Levels, and Watchlist — sort state lives in the URL per table
- **Daily research digest** emailed on weekdays at 8:45 AM ET summarizing overnight newsletter activity
- **Hybrid cron infrastructure** — Cloudflare Worker calls your Mac for daily digest / weekly briefing; on Mac failure it falls back to sending the email itself via Gmail REST and Claude through AI Gateway

---

## What's new in v2.1

- **Terminal-style Security Detail redesign** — Bloomberg-adjacent dark "market data module" (chart + levels + big amber price hero) that stays dark even when the surrounding app eventually flips to a light-paper theme. Solves the chart's current-price-vs-resistance color collision with an amber-only priceLine.
- **Auto-suggested support/resistance** on every chart — pivot clustering with confidence grading, each level accompanied by a Claude-written one-sentence narrative. Click Accept to add it as a tracked level.
- **AI Gateway routing** — every Claude call flows through Cloudflare AI Gateway with per-feature `cf-aig-metadata` for cost tracking. Swap models (Opus / Sonnet / Haiku / Llama 3.3 / Kimi K2.6) by changing one line in `FEATURE_MODELS`. Falls back transparently when Cloudflare env vars are missing.
- **Workers AI downroute** — alert-suggestion recommendations run on Llama 3.3 70B, newsletter level extraction on Kimi K2.6, both via Cloudflare Workers AI.
- **R2 disaster-recovery archival** — all imported Vanguard PDFs auto-upload to Cloudflare R2 via `aws4fetch` (S3-compatible). Parsed data still lives in SQLite; R2 is insurance.
- **Research PDF knowledge base** — upload analyst reports; Claude extracts structured metadata; FTS5 virtual table powers lexical search; `query_research_documents` chat tool surfaces them during Q&A.
- **EDGAR 10-K / 10-Q section extraction** — chat tool summarizes Item 1A Risk Factors and MD&A from the latest filing, cached per `(symbol, accession, section)`.
- **Analyst coverage** — recommendation-trend aggregated via Finnhub, surfaced in the chat tool palette.
- **Chat history persistence** — conversations stored in SQLite with inline delete from the sidebar.
- **Chart click-to-add-level** — tap any price on the candlestick to add a Support/Resistance level at that cursor position.

---

## Screenshots

<details>
<summary>Account Details</summary>

![Accounts](docs/screenshots/accounts.png)
</details>

<details>
<summary>Holdings</summary>

![Holdings](docs/screenshots/holdings.png)
</details>

<details>
<summary>Analysis</summary>

![Analysis](docs/screenshots/analysis.png)
</details>

<details>
<summary>Charts</summary>

![Charts](docs/screenshots/charts.png)
</details>

<details>
<summary>Calendar</summary>

![Calendar](docs/screenshots/calendar.png)
</details>

<details>
<summary>Trade Reviews</summary>

![Trade Reviews](docs/screenshots/trade-reviews.png)
</details>

<details>
<summary>Research Feeds</summary>

![Research Feeds](docs/screenshots/research-feeds.png)
</details>

<details>
<summary>Security Detail — Terminal aesthetic</summary>

![Security Detail](docs/screenshots/security-detail.png)
</details>

<details>
<summary>Data Health</summary>

![Data Health](docs/screenshots/data-health.png)
</details>

<details>
<summary>AI Chat</summary>

![Chat](docs/screenshots/chat.png)
</details>

<details>
<summary>Import</summary>

![Import](docs/screenshots/import.png)
</details>

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router), React 19 |
| Language | TypeScript 5 |
| Database | SQLite via better-sqlite3 (WAL mode, foreign keys ON, FTS5) |
| Styling | Tailwind CSS 4 |
| Charts | Recharts (portfolio), LightweightCharts v5 (candlestick) |
| AI | Claude via AI SDK v6 + Cloudflare AI Gateway (Opus 4.7 for heavy reasoning, Sonnet 4.6 for classification, Haiku 4.5 for gates) |
| Alternate models | Llama 3.3 70B + Kimi K2.6 via Cloudflare Workers AI |
| Broker API | IBKR TWS via `@stoqey/ib` (IBApiNext) |
| Email | Gmail API (OAuth 2.0) for research feeds + outbound briefings |
| Mobile push | Pushover |
| Object storage | Cloudflare R2 (via `aws4fetch`, S3-compatible) |
| Cloud cron | Cloudflare Workers with KV-based dedup markers |
| Desktop | Electron 41 + electron-builder (code-signed + notarized macOS DMG) |
| Testing | Vitest (1100 tests across 86 files, in-memory SQLite) |

---

## Quick Start

### Prerequisites

- **Node.js 20+** (via Homebrew: `brew install node`)
- **npm 10+**
- **Anthropic API key** ([get one here](https://console.anthropic.com/)) — required for PDF parsing, chat, and AI-generated content
- **IBKR Trader Workstation** (optional) — for live-data features

### Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/itsme188/vanguard-skin.git
   cd vanguard-skin
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.local.example .env.local
   ```
   Edit `.env.local` and add your Anthropic API key at minimum. See [Configuration](#configuration) for all available options.

4. **Start the development server**
   ```bash
   npm run dev
   ```

5. **Open http://localhost:3000** in your browser

The SQLite database is created automatically on first run with all 40 migrations applied.

### Demo Data

To explore the dashboard with sample data before importing your own:

```bash
npx tsx scripts/seed-demo.ts --replace
```

This populates the database with six months of fictional portfolio data across three accounts.

### Desktop App

A macOS desktop app (DMG, ~229 MB, arm64) is available from [GitHub Releases](https://github.com/itsme188/vanguard-skin/releases). Includes all the same features plus a native system tray with portfolio summary, TWS auto-connect, background auto-refresh every 30 min, and first-run onboarding. To build locally:

```bash
npm run electron:pack
```

Or build + auto-install to `/Applications/` + relaunch in one step:

```bash
npm run electron:deploy
```

---

## Configuration

<details>
<summary>Environment Variables</summary>

Copy `.env.local.example` to `.env.local` and configure:

**Required:**
| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key for PDF parsing, chat, trade reviews, classification, briefings |

**Required for TWS features:**
| Variable | Description |
|----------|-------------|
| `IBKR_ACCOUNT_CODE` | Your personal IBKR account ID (e.g., `U12345678`) |

**Optional — Calendar & Research:**
| Variable | Description |
|----------|-------------|
| `FRED_API_KEY` | FRED economic calendar data ([free registration](https://fred.stlouisfed.org/docs/api/api_key.html)) |
| `FINNHUB_API_KEY` | Per-held-stock earnings + analyst coverage ([finnhub.io](https://finnhub.io/)) |
| `EDGAR_CONTACT_EMAIL` | SEC EDGAR API fair-access email |
| `API_NINJAS_API_KEY` | Earnings transcripts ([api-ninjas.com](https://api-ninjas.com/)) |

**Optional — Email Briefings:**
| Variable | Description |
|----------|-------------|
| `GMAIL_ADDRESS` | Gmail address for sending weekly briefings and daily digests |
| `GMAIL_APP_PASSWORD` | Gmail App Password ([setup guide](https://support.google.com/accounts/answer/185833)) |
| `BRIEFING_EMAIL_TO` | Briefing email recipient |

**Optional — Research Feeds (Gmail newsletter ingestion):**
| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | Google Cloud OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Generated via `npx tsx scripts/gmail-oauth-setup.ts` |

**Optional — Cloudflare AI Gateway (per-feature cost tracking + model swapping):**
| Variable | Description |
|----------|-------------|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID — routes all Claude calls through AI Gateway when set |
| `CLOUDFLARE_GATEWAY_ID` | Gateway ID within your Cloudflare account |

**Optional — R2 PDF archival:**
| Variable | Description |
|----------|-------------|
| `R2_BUCKET_NAME` | R2 bucket for imported-PDF backup |
| `R2_ACCESS_KEY_ID` | R2 S3-compatible access key |
| `R2_SECRET_ACCESS_KEY` | R2 S3-compatible secret key |
| `R2_ACCOUNT_ID` | R2 account ID (falls back to `CLOUDFLARE_ACCOUNT_ID`) |

**Optional — Mobile push (Pushover):**
| Variable | Description |
|----------|-------------|
| `PUSHOVER_APP_TOKEN` | Pushover application token |
| `PUSHOVER_USER_KEY` | Your Pushover user key |

**Optional — Cron hybrid (Cloudflare Worker → Mac):**
| Variable | Description |
|----------|-------------|
| `CRON_SHARED_SECRET` | Shared secret between Worker and Mac for authenticated cron calls |
| `WORKER_MARKER_URL` | Mac pre-flights this URL on each cron to avoid duplicate sends |

</details>

<details>
<summary>IBKR TWS Setup</summary>

To use live-data features (position sync, streaming quotes, charting):

1. Open TWS and log in
2. Go to **Edit > Global Configuration > API > Settings**
3. Enable **"ActiveX and Socket Clients"**
4. Set Socket Port to **7496**
5. Add **127.0.0.1** to Trusted IPs
6. Set `IBKR_ACCOUNT_CODE` in your `.env.local`

The dashboard header shows a TWS connection indicator. Features that require TWS (position sync, streaming quotes, OHLCV charts) show connection prompts when TWS is not running. All other features (import, analysis, chat, research) work without TWS.

</details>

<details>
<summary>Importing Data</summary>

The Import tab supports these file formats:

| Format | Source | Notes |
|--------|--------|-------|
| PDF statements | Vanguard | Monthly/quarterly brokerage statements, parsed via Claude |
| Activity CSVs | IBKR | Flex Query or Activity Statement exports |
| Holdings CSVs | IBKR | Current holdings snapshot |
| Cost Basis CSVs | Vanguard | Cost basis export |
| Monthly Values CSV | Manual | Manual entry of monthly account totals |
| Factor CSV | Manual | Security factor exposures (AI, tariff, cyclical, etc.) |
| Canonical CSV | Any broker | Standardized 4-type format (transactions, holdings, prices, snapshots) |

Drag and drop files onto the Import tab. The app auto-detects the format, validates records (dates, quantities, prices, sign conventions, sanity filters), shows a preview with record counts and sample data, and asks for confirmation before writing to the database. Re-importing the same file is safe — duplicate records dedup via deterministic source keys.

For unsupported brokers or messy exports, use the **Canonical CSV** format. A Claude Co-Work prompt builder is built into the Import tab that converts arbitrary statements into canonical CSV with a single paste.

</details>

<details>
<summary>Desktop App Build</summary>

Build a macOS DMG locally:

```bash
npm run electron:pack
```

This runs `next build` → TypeScript compile → symlink deref → `electron-builder --mac`. The output is a code-signed `.dmg` in `dist/` (~229 MB, arm64). For immediate install + launch:

```bash
npm run electron:deploy
```

**Requirements for code signing:**
- Apple Developer ID Application certificate
- Notarization credentials: `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` environment variables (must be exported to the shell that runs the build — `.zshrc` exports don't reach `npm run` subprocesses)

Without these, the app builds unsigned (works locally but triggers Gatekeeper warnings on other machines).

</details>

---

## Architecture

```
app/                        Next.js App Router pages + API routes
  dashboard/                Main dashboard (8 tabs + Security Detail hub + Data Health)
    components/             85 React components
    security/[id]/          Per-security detail hub with Terminal-style market-data panel
    today/                  Mobile-first single-column summary view
  api/                      68 API endpoints across ~25 domains
lib/
  db.ts                     SQLite singleton (WAL mode, foreign keys ON)
  db/migrations/            40 numbered SQL migrations
  queries/                  33 read-only query modules (all take `db` parameter for DI)
  mutations/                Write modules (imports, updates, deletes, batch undo)
  compute/                  16 engines (TWR, XIRR, tax lots, risk, scenarios, Greeks, reconciliation)
  import/parsers/           9 format-specific parsers + validation
  tws/                      IBKR TWS API (positions, streaming, charts, WSH events, benchmarks)
  calendar/                 Event sourcing (WSH, FRED, Finnhub), briefings, email delivery
  gmail/                    Gmail OAuth + newsletter fetch, process, sanitize
  trade-review/             AI trade grading (round-trips, Q&A, account profiles)
  chat/                     AI chat — 25 tools, system prompts, per-scope personas
  ai/                       FEATURE_MODELS routing layer (Claude / Workers AI swapping)
  alerts/                   Level detection, alert firing, Pushover push, suggestion generation
  research-documents/       PDF upload + Claude extraction + FTS5 search
  storage/                  R2 S3-compatible disaster-recovery archival
electron/                   Electron main process, tray, IPC, settings store
workers/cron/               Cloudflare Worker — primary daily-digest + weekly-briefing trigger with cloud fallback
tests/                      1100 tests across 86 files (Vitest, in-memory SQLite)
scripts/                    Utility scripts (seed, import, OAuth setup, backfills, Co-Work preprocessing)
```

All database functions accept a `db` parameter for dependency injection, enabling fast in-memory testing without touching disk. All imports follow the pipeline: **Detect format → Parse → Validate → Preview → Confirm → Commit**, with deterministic source keys for safe re-imports.

---

## Testing

```bash
# Run all tests
npx vitest run

# Run tests in watch mode
npx vitest

# Run a specific test file
npx vitest run tests/compute/tax-lots.test.ts
```

1100 tests across 86 test files covering the import pipeline, tax-lot computation, TWR/XIRR calculations, daily valuations, risk metrics, benchmark analytics, trade round-trips, options Greeks, scenario modeling, factor analysis, chat tools, research document extraction, level detection, alert firing, Pushover integration, corporate-action adjustments, and API-component contract shapes.

---

## License

[MIT](LICENSE)
