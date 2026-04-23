import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";
import {
  getHoldingsForChat,
  getPriceHistory,
  getAllocationBreakdown,
  getTaxLotsForChat,
  getTransactionsForChat,
  getPerformanceForChat,
  getIncomeSummaryForChat,
} from "@/lib/queries/chat-tools";
import { getNotesFiltered, getSecurityIdBySymbol } from "@/lib/queries/notes";
import { createNote } from "@/lib/mutations/notes";
import type { NoteType, NoteSentiment } from "@/lib/types";
import { computeTwr } from "@/lib/compute/twr";
import { computeXirr } from "@/lib/compute/xirr";
import { annotateToolResult } from "@/lib/chat/validate";
import { getSeriesData, searchSeries, getLatestValue, FRED_SERIES } from "@/lib/apis/fred";
import { getCompanyFinancials, getCompanyInfo, getRecentFilings, getInsiderTransactions } from "@/lib/apis/edgar";
import { getTranscriptForChat } from "@/lib/transcripts/fetch";
import { getTradeReviews, getTradeReviewByPeriod, getTradeRoundtrips } from "@/lib/queries/trade-reviews";
import { computePortfolioGreeks } from "@/lib/compute/options-greeks";
import { getOptionPositions } from "@/lib/queries/options";
import { detectStrategies, type PositionLeg } from "@/lib/compute/options-strategy";
import { getActiveLevels, getAlerts, getLevelsForSecurity } from "@/lib/queries/security-levels";
import { resolveLevelPrice } from "@/lib/alerts/resolve-level-price";
import { getFilingSection } from "@/lib/apis/filing-extract";
import {
  searchResearchDocuments,
  type ResearchDocumentType,
} from "@/lib/queries/research-documents";
import { listPressReleases } from "@/lib/queries/press-releases";
import { fetchAndCachePressReleases } from "@/lib/apis/press-releases";
import {
  getRecommendationHistory,
  getPriceTarget,
  getRatingChanges,
} from "@/lib/queries/analyst-estimates";
import { syncAnalystCoverage } from "@/lib/apis/analyst-estimates";
import { getRecentReleaseReactions } from "@/lib/queries/level-performance";

// ─── Tool Definitions ─────────────────────────────────────────────

export const CHAT_TOOLS: Anthropic.Tool[] = [
  {
    name: "query_holdings",
    description:
      "Query current holdings with optional filters. Returns detailed position data including cost basis, market value, unrealized gain/loss, position weight, sector, asset class, and maturity info for bonds. Automatically excludes matured bonds and zero-quantity positions. Use when the user asks about specific positions, accounts, asset classes, sectors, or portfolio composition.",
    input_schema: {
      type: "object" as const,
      properties: {
        account_name: {
          type: "string",
          description:
            "Filter by account name (e.g., 'Vanguard Brokerage', 'Roth IRA', 'Interactive Brokers'). Omit for all accounts.",
        },
        symbol: {
          type: "string",
          description: "Filter by security symbol (e.g., 'AAPL', 'VOO'). Omit for all positions.",
        },
        security_type: {
          type: "string",
          enum: ["stock", "etf", "bond", "mutual_fund", "option", "money_market"],
          description: "Filter by security type. Omit for all types.",
        },
        sector: {
          type: "string",
          description:
            "Filter by sector (e.g., 'Technology', 'Financial', 'Health Care'). Omit for all sectors.",
        },
        sort_by: {
          type: "string",
          enum: ["market_value", "unrealized_gain", "position_weight", "symbol"],
          description: "Sort results. Defaults to market_value descending.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of results. Defaults to 50.",
        },
      },
    },
  },
  {
    name: "query_price_history",
    description:
      "Get historical price data for a security. Returns daily close prices over a date range. Use for price trend analysis, volatility assessment, drawdown calculation, or performance comparison between securities.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: "Security symbol (e.g., 'AAPL', 'VOO')",
        },
        start_date: {
          type: "string",
          description: "Start date in YYYY-MM-DD format. Defaults to 90 days ago.",
        },
        end_date: {
          type: "string",
          description: "End date in YYYY-MM-DD format. Defaults to today.",
        },
      },
      required: ["symbol"],
    },
  },
  {
    name: "query_allocation",
    description:
      "Compute portfolio allocation breakdown by a grouping dimension. Returns each group's total market value, percentage, and position count. Use for concentration analysis, diversification assessment, sector exposure, or account-level allocation questions.",
    input_schema: {
      type: "object" as const,
      properties: {
        group_by: {
          type: "string",
          enum: [
            "asset_class", "security_type", "sector", "account", "symbol",
            "fund_category", "geography", "market_cap_category", "style",
            "interest_rate_sensitive", "growth_vs_value", "cyclical",
            "international_exposure", "geopolitical_onshoring", "tariff_exposure",
            "ai_exposure", "crypto_adjacent", "regulatory_risk",
          ],
          description:
            "Dimension to group by. Standard: 'fund_category' (investment category), 'geography' (region), 'market_cap_category' (cap size), 'style' (value/growth). Thematic factors: 'tariff_exposure', 'ai_exposure', 'interest_rate_sensitive', 'cyclical', 'geopolitical_onshoring', 'international_exposure', 'crypto_adjacent', 'regulatory_risk', 'growth_vs_value'. Factor dimensions show Low/Moderate/High/Very High breakdown weighted by market value.",
        },
        account_name: {
          type: "string",
          description: "Optional: restrict to a single account",
        },
      },
      required: ["group_by"],
    },
  },
  {
    name: "query_tax_lots",
    description:
      "Query tax lot details for open or closed positions. Returns acquisition date, cost basis, current value, unrealized/realized gain/loss, holding period, long-term/short-term status, and projected long-term date. Uses FIFO (First-In, First-Out) lot matching — the user's broker may use a different method. Use for tax-loss harvesting analysis, capital gains questions, wash sale evaluation, lot-level drill-down, or identifying lots approaching the 1-year long-term threshold.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["open", "closed", "all"],
          description: "Filter by lot status. Defaults to 'open'.",
        },
        symbol: {
          type: "string",
          description: "Filter by security symbol",
        },
        account_name: {
          type: "string",
          description: "Filter by account name",
        },
        year: {
          type: "integer",
          description: "For closed lots: filter sales by calendar year",
        },
        sort_by: {
          type: "string",
          enum: ["unrealized_gain", "acquisition_date", "holding_period_days", "cost_basis"],
          description: "Sort field. Defaults to unrealized_gain (losses first, most useful for harvesting).",
        },
        limit: {
          type: "integer",
          description: "Maximum results. Defaults to 50.",
        },
      },
    },
  },
  {
    name: "query_transactions",
    description:
      "Search transaction history with filters. Returns trade date, type, symbol, quantity, price, amount, and fees. Use for activity analysis, cash flow tracking, dividend history, fee analysis, or trade reconstruction.",
    input_schema: {
      type: "object" as const,
      properties: {
        account_name: {
          type: "string",
          description: "Filter by account name",
        },
        symbol: {
          type: "string",
          description: "Filter by security symbol",
        },
        type: {
          type: "string",
          enum: [
            "BUY", "SELL", "DIVIDEND", "INTEREST", "FEE", "TRANSFER",
            "REINVESTMENT", "BUY_TO_OPEN", "SELL_TO_CLOSE", "EXPIRED",
            "EXERCISED", "ASSIGNED",
          ],
          description: "Filter by transaction type",
        },
        start_date: {
          type: "string",
          description: "Start date filter (YYYY-MM-DD)",
        },
        end_date: {
          type: "string",
          description: "End date filter (YYYY-MM-DD)",
        },
        limit: {
          type: "integer",
          description: "Maximum results. Defaults to 50.",
        },
      },
    },
  },
  {
    name: "query_performance",
    description:
      "Get account performance over time from monthly snapshots. Returns monthly total values, month-over-month changes, investment_change (excluding deposits/withdrawals), dividends, interest, fees, and time-weighted return (TWR) where available. Use investment_change instead of monthly_change for actual portfolio performance. Use for performance trend questions, income analysis over time, fee tracking, or comparing account growth.",
    input_schema: {
      type: "object" as const,
      properties: {
        account_name: {
          type: "string",
          description: "Filter by account name. Omit for all accounts.",
        },
        start_date: {
          type: "string",
          description: "Start date (YYYY-MM-DD). Defaults to all available data.",
        },
        end_date: {
          type: "string",
          description: "End date (YYYY-MM-DD). Defaults to today.",
        },
      },
    },
  },
  {
    name: "query_income_summary",
    description:
      "Summarize investment income (dividends, interest) and fees over a period. Returns per-symbol or per-account breakdowns. REINVESTMENT transactions are counted as dividend income. Use for income analysis, yield calculations, fee drag assessment, dividend tracking by quarter/month, or identifying which securities generate the most income.",
    input_schema: {
      type: "object" as const,
      properties: {
        period: {
          type: "string",
          enum: ["ytd", "trailing_12m", "last_year", "all_time"],
          description: "Time period. Defaults to trailing_12m.",
        },
        group_by: {
          type: "string",
          enum: ["symbol", "account", "month", "type"],
          description: "How to group the results. Defaults to 'symbol'.",
        },
        account_name: {
          type: "string",
          description: "Filter by account name. Omit for all accounts.",
        },
      },
    },
  },
  {
    name: "query_twr",
    description:
      "Compute Time-Weighted Return (TWR) and XIRR for the portfolio or individual accounts over a specified period. TWR uses chain-linked Modified Dietz (measures portfolio manager skill). XIRR uses Newton-Raphson (measures investor's actual experience, accounting for timing of deposits/withdrawals). Returns both metrics, cumulative return, annualized return, and per-account breakdown. Account names are matched case-insensitively (e.g., 'roth' matches 'Vanguard Roth IRA'). Use when asked about portfolio performance, returns, how the portfolio has done, YTD/annual returns, investment performance comparison between accounts, or whether the portfolio is beating expectations.",
    input_schema: {
      type: "object" as const,
      properties: {
        period: {
          type: "string",
          enum: ["ytd", "1y", "3y", "5y", "inception"],
          description:
            "Time period for TWR computation. Defaults to 'ytd'.",
        },
        account_name: {
          type: "string",
          description:
            "Optional: restrict to a single account name. Omit for portfolio-wide TWR.",
        },
      },
    },
  },
  {
    name: "query_fred",
    description:
      "Query Federal Reserve Economic Data (FRED) for macroeconomic indicators, interest rates, inflation, GDP, unemployment, market indices, and more. Use when the user asks about the economic environment, interest rates, inflation trends, market conditions, risk-free rates, or any macro data point. Can fetch specific series by ID or search for series by keyword. Well-known series: FEDFUNDS (fed funds rate), DGS10 (10Y Treasury), SP500, CPIAUCSL (CPI), UNRATE (unemployment), GDP, VIXCLS (VIX), T10YIE (breakeven inflation), DTB3 (3-month T-bill).",
    input_schema: {
      type: "object" as const,
      properties: {
        series_id: {
          type: "string",
          description:
            "FRED series ID (e.g., 'DGS10' for 10Y Treasury, 'FEDFUNDS' for fed funds rate, 'SP500', 'CPIAUCSL' for CPI). If unsure of the ID, use search_query instead.",
        },
        search_query: {
          type: "string",
          description:
            "Search FRED for series by keyword (e.g., 'corporate bond spread', 'housing starts'). Use when you don't know the exact series ID.",
        },
        start_date: {
          type: "string",
          description: "Start date for observations (YYYY-MM-DD). Defaults to 1 year ago.",
        },
        end_date: {
          type: "string",
          description: "End date for observations (YYYY-MM-DD). Defaults to today.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of observations to return. Defaults to 30.",
        },
      },
    },
  },
  {
    name: "query_company_fundamentals",
    description:
      "Look up company fundamentals from SEC EDGAR filings (10-K/10-Q). Returns financial data including revenue, net income, EPS, total assets, liabilities, stockholders' equity, shares outstanding, and operating income. Use when the user asks about a company's financials, valuation metrics, earnings, revenue trends, or fundamental analysis of a holding. Also returns basic company info (SIC code, state of incorporation, fiscal year end).",
    input_schema: {
      type: "object" as const,
      properties: {
        ticker: {
          type: "string",
          description: "Stock ticker symbol (e.g., 'AAPL', 'MSFT', 'VOO'). ETFs and mutual funds may have limited data.",
        },
        include_filings: {
          type: "boolean",
          description: "Also return recent SEC filings list (10-K, 10-Q dates). Defaults to false.",
        },
        annual_only: {
          type: "boolean",
          description: "Only return annual (10-K) data, excluding quarterly. Defaults to false.",
        },
      },
      required: ["ticker"],
    },
  },
  {
    name: "query_insider_trades",
    description:
      "Look up recent insider trading activity (SEC Form 4 filings) for any publicly traded company. Returns who (name, title, relationship to company), what (buy/sell, number of shares, price per share), when (transaction and filing dates), and post-transaction ownership. Use when the user asks about insider buying/selling, executive stock purchases, insider activity, or Form 4 filings. Only covers non-derivative stock transactions — options exercises, RSU vesting, and warrants are excluded. Data comes from SEC EDGAR in real-time.",
    input_schema: {
      type: "object" as const,
      properties: {
        ticker: {
          type: "string",
          description:
            "Stock ticker symbol (e.g., 'AAPL', 'MSFT', 'TSLA')",
        },
        transaction_type: {
          type: "string",
          enum: ["buy", "sell", "all"],
          description:
            "Filter by transaction direction: 'buy' (insider purchases only), 'sell' (insider sales only), or 'all' (default). Insider buys are generally more significant as a signal.",
        },
        limit: {
          type: "integer",
          description:
            "Maximum number of Form 4 filings to fetch (default: 10, max: 20). Each filing may contain multiple transactions from one insider.",
        },
      },
      required: ["ticker"],
    },
  },
  {
    name: "query_notes",
    description:
      "Search the user's investment journal and notes. Returns notes matching the criteria with linked security and transaction context. Three types: 'journal' (general market thoughts), 'earnings' (per-security earnings call notes), 'trade_thesis' (rationale for buy/sell decisions). Use when the user asks about their past thoughts, trade rationale, earnings notes, journal entries, or investment thesis for any security.",
    input_schema: {
      type: "object" as const,
      properties: {
        note_type: {
          type: "string",
          enum: ["journal", "earnings", "trade_thesis"],
          description:
            "Filter by note type. Omit for all types.",
        },
        symbol: {
          type: "string",
          description:
            "Filter by security symbol (e.g., 'AAPL', 'GOOG'). Omit for all securities.",
        },
        search: {
          type: "string",
          description: "Search note content for a keyword or phrase.",
        },
        start_date: {
          type: "string",
          description: "Start date filter (YYYY-MM-DD)",
        },
        end_date: {
          type: "string",
          description: "End date filter (YYYY-MM-DD)",
        },
        limit: {
          type: "integer",
          description: "Maximum results. Defaults to 20.",
        },
      },
    },
  },
  {
    name: "create_note",
    description:
      "Save a note to the user's investment journal. IMPORTANT: Always confirm the content and type with the user before saving. Use when the user explicitly asks to save, record, or remember a thought, thesis, or observation. Do NOT create notes without explicit user approval.",
    input_schema: {
      type: "object" as const,
      properties: {
        note_type: {
          type: "string",
          enum: ["journal", "earnings", "trade_thesis"],
          description: "Type of note to create.",
        },
        content: {
          type: "string",
          description: "The note content to save.",
        },
        symbol: {
          type: "string",
          description:
            "Security symbol to link this note to (e.g., 'GOOG' for an earnings note). Optional for journal entries.",
        },
        event_date: {
          type: "string",
          description:
            "Date for the note (YYYY-MM-DD). Defaults to today.",
        },
        sentiment: {
          type: "string",
          enum: ["bullish", "bearish", "neutral", "cautious", "confident"],
          description: "Optional sentiment tag.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional tags (e.g., ['earnings', 'guidance', 'beat'])",
        },
      },
      required: ["note_type", "content"],
    },
  },
  {
    name: "query_analyst_coverage",
    description:
      "Fetch analyst coverage for a ticker: the latest buy/hold/sell consensus trend (monthly, last 6 months), current consensus price target (high / low / mean / median + analyst count), and recent upgrade/downgrade/initiation actions by firm. Use when the user asks what the Street thinks, wants a price-target check, asks about recent Wall Street rating changes, or needs to frame a position against consensus. Sync-then-query pattern via Finnhub free tier — first call per ticker caches everything; subsequent calls are free from local DB. Returns empty sections (not errors) when a given dataset is unavailable for the ticker (common for small-caps and non-US tickers).",
    input_schema: {
      type: "object" as const,
      properties: {
        ticker: {
          type: "string",
          description: "Stock ticker (e.g., 'AAPL', 'NVDA'). Case-insensitive.",
        },
        months_history: {
          type: "integer",
          description:
            "How many months of recommendation trend history to return. Default 6, cap 24. Finnhub provides monthly snapshots.",
        },
        rating_changes_limit: {
          type: "integer",
          description:
            "Max rating changes (upgrades/downgrades/inits) to return. Default 10, cap 50.",
        },
      },
      required: ["ticker"],
    },
  },
  {
    name: "query_press_releases",
    description:
      "Fetch recent press releases and company news for a ticker — Business Wire, PR Newswire, Reuters, SeekingAlpha, Yahoo Finance, and company IR feeds aggregated by Finnhub. Returns headline, summary (lead paragraph), source, URL, and publication date. Use when the user asks 'what did COMPANY announce today/this week?', references news coverage, wants recent announcements (M&A, product launches, executive changes, dividend declarations), or needs the latest news alongside fundamentals. Transparently sync-then-query: the first call per ticker+window hits Finnhub and caches; subsequent calls in the same window are free from the local DB. Free tier covers all common US tickers.",
    input_schema: {
      type: "object" as const,
      properties: {
        ticker: {
          type: "string",
          description: "Stock ticker (e.g., 'AAPL', 'NVDA'). Case-insensitive.",
        },
        days_back: {
          type: "integer",
          description:
            "Sliding window in days. Default 7. Max 365. Wider windows cost no more API calls but return more rows.",
        },
        keyword: {
          type: "string",
          description:
            "Optional keyword filter applied to headline + summary (case-insensitive LIKE). E.g., 'dividend', 'guidance', 'CEO'.",
        },
        limit: {
          type: "integer",
          description: "Max results to return. Default 15, cap 100.",
        },
      },
      required: ["ticker"],
    },
  },
  {
    name: "query_earnings_transcript",
    description:
      "Fetch an earnings call transcript or press release for a company. Returns summary, guidance, risk factors, sentiment, and an excerpt (first ~1000 words by default). Checks local cache first, then fetches from Motley Fool or SEC EDGAR 8-K filings. Use PROACTIVELY when discussing any company's earnings, quarterly results, forward guidance, management commentary, or business outlook. Also useful for comparing performance across quarters or validating financial trends. Set `include_full_text: true` when the user asks for specific quotes, detailed management commentary, segment revenue breakdowns, or to cite exact numbers — this returns the complete body (up to ~60K chars for EDGAR sources).",
    input_schema: {
      type: "object" as const,
      properties: {
        ticker: {
          type: "string",
          description: "Stock ticker symbol (e.g., 'AAPL', 'MSFT', 'GOOG')",
        },
        year: {
          type: "integer",
          description:
            "Earnings year (e.g., 2025). Omit for most recent available quarter.",
        },
        quarter: {
          type: "integer",
          description:
            "Quarter (1-4). Omit for most recent available quarter.",
        },
        include_full_text: {
          type: "boolean",
          description:
            "Return the complete transcript body instead of a 1000-word excerpt. Use when the user wants exact quotes, detailed commentary, or segment-level numbers. Default false (summary-only) keeps context small when a broad answer is enough.",
        },
      },
      required: ["ticker"],
    },
  },
  {
    name: "query_research_documents",
    description:
      "Search the user's uploaded research PDF knowledge base — analyst reports, bank research notes, investor letters, industry primers, earnings decks, long-form articles, book summaries, macro essays, and more. Returns matching documents with snippet highlights showing the term in context, plus summary, key points, mentioned tickers, tags, target prices, and sentiment. Use when the user asks what research they have on a topic/company/theme, references 'that Goldman note' or 'the Bernstein piece' or 'the Artemis essay', wants to synthesize a thesis from uploaded reports, or asks 'what does my research say about X?'. Combine filters: free-text query + ticker + document type + tag + recency. Documents are lexically searchable via FTS5 (keyword match, not semantic).",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Free-text search phrase matched across title, author, source, summary, mentioned tickers, tags, and raw body. Omit to list recent docs by filter only.",
        },
        symbol: {
          type: "string",
          description:
            "Ticker filter (e.g., 'NVDA'). Only returns docs where the symbol is in mentioned_symbols. Case-insensitive.",
        },
        document_type: {
          type: "string",
          enum: [
            "analyst_report",
            "research_note",
            "market_analysis",
            "industry_primer",
            "investor_letter",
            "earnings_presentation",
            "article",
            "book_summary_or_essay",
            "macro_note",
            "other",
          ],
          description:
            "Restrict to one document type. Omit to search across all types.",
        },
        tag: {
          type: "string",
          description:
            "Filter by a single tag (lowercase free-text — e.g. 'semiconductors', 'value-investing', 'q3 2024'). Matches any doc with that tag in its tags array. Combine with other filters. Use this when the user's phrasing suggests a theme or sector rather than a ticker.",
        },
        days_back: {
          type: "integer",
          description:
            "Only return docs published or uploaded within the last N days. Omit for no time filter.",
        },
        limit: {
          type: "integer",
          description: "Max results. Defaults to 10, cap 100.",
        },
      },
    },
  },
  {
    name: "query_filing_section",
    description:
      "Fetch and summarize a specific section of a company's latest 10-K or 10-Q filing from SEC EDGAR. Returns a structured summary (2-4 paragraphs), key bullet points, and a direct link to the filing. Sections: 'risk_factors' (Item 1A — the risks management believes are most material) and 'mda' (Management's Discussion and Analysis — financial results commentary, trends, outlook). Results are cached per filing — re-asking is free. Use when the user asks about a company's risks, material threats, business outlook, management commentary, or wants to go deeper than the press release. Prefer 10-K for annual / comprehensive; 10-Q for quarterly updates. Both are public SEC data.",
    input_schema: {
      type: "object" as const,
      properties: {
        ticker: {
          type: "string",
          description: "Stock ticker symbol (e.g., 'AAPL', 'MSFT', 'NVDA')",
        },
        filing_type: {
          type: "string",
          enum: ["10-K", "10-Q"],
          description:
            "'10-K' for the most recent annual report, '10-Q' for the most recent quarterly. Defaults to '10-K' when unsure.",
        },
        section: {
          type: "string",
          enum: ["risk_factors", "mda"],
          description:
            "'risk_factors' = Item 1A risk disclosures; 'mda' = Management's Discussion & Analysis (Item 7 in 10-K, Item 2 in 10-Q).",
        },
      },
      required: ["ticker", "filing_type", "section"],
    },
  },
  {
    name: "query_trade_reviews",
    description:
      "Query the user's monthly AI trade reviews and trading feedback. Returns review summaries, per-trade grades (A-F), identified behavioral patterns, strengths, weaknesses, and cumulative pattern analysis. Use when the user asks about their trading performance, patterns, improvement areas, trade grades, or wants to recall feedback from past months. Can return a list of reviews or a single detailed review with per-trade analysis.",
    input_schema: {
      type: "object" as const,
      properties: {
        account_name: {
          type: "string",
          description:
            "Account name to query (e.g., 'IBKR'). Defaults to IBKR if omitted.",
        },
        year: {
          type: "integer",
          description: "Filter by year. Omit to get all reviews.",
        },
        period_start: {
          type: "string",
          description:
            "Specific month (YYYY-MM-01). Returns detailed review with per-trade grades. Omit for list view.",
        },
        include_grades: {
          type: "boolean",
          description:
            "Include per-trade grade details in detail mode. Defaults to false.",
        },
      },
    },
  },
  {
    name: "query_options_greeks",
    description:
      "Query portfolio-level and per-position options Greeks (delta, gamma, theta, vega) with implied volatility. Also returns detected option strategies (covered calls, spreads, straddles, iron condors). Use when the user asks about options risk exposure, Greeks, time decay, volatility sensitivity, or option strategies.",
    input_schema: {
      type: "object" as const,
      properties: {
        account_name: {
          type: "string",
          description:
            "Account name to query (e.g., 'IBKR'). Omit for all accounts.",
        },
        underlying: {
          type: "string",
          description:
            "Filter by underlying symbol (e.g., 'AAPL'). Omit for all option positions.",
        },
      },
    },
  },
  {
    name: "query_research_feeds",
    description:
      "Search the user's ingested financial newsletter articles from Gmail. Returns AI-processed summaries, sentiment, mentioned tickers, and portfolio relevance. Sources include Vital Knowledge, TMT Breakouts, Stratechery, The Diff, Alliant Capital, and other subscribed newsletters. Use when the user asks about recent market research, newsletter insights, what analysts are saying, sentiment on a particular stock or theme, or what their research feeds have covered recently.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description:
            "Filter by ticker symbol mentioned in articles (e.g., 'AAPL'). Omit for all articles.",
        },
        source: {
          type: "string",
          description:
            "Filter by newsletter source name (e.g., 'Vital Knowledge', 'Stratechery'). Omit for all sources.",
        },
        days_back: {
          type: "number",
          description:
            "How many days back to search. Default 7. Use 1 for today's articles, 30 for monthly overview.",
        },
        search: {
          type: "string",
          description:
            "Free-text search across article subjects, summaries, and content. Use for topic-based queries.",
        },
      },
    },
  },
  {
    name: "query_calendar_events",
    description:
      "Query upcoming or past market events from the calendar — earnings dates, FOMC meetings, CPI releases, jobs reports, GDP, PMI, retail sales, analyst meetings, and other macro/company events. Use when the user asks about upcoming events, 'what's on the calendar', 'when is the next FOMC/CPI/earnings', or wants to understand what market-moving events are ahead.",
    input_schema: {
      type: "object" as const,
      properties: {
        days_ahead: {
          type: "number",
          description:
            "Number of days forward to look. Default 14. Use 7 for this week, 30 for this month.",
        },
        days_back: {
          type: "number",
          description:
            "Number of days backward to look. Default 0. Use 7 for last week, 30 for last month.",
        },
        event_type: {
          type: "string",
          description:
            "Filter by event type (e.g., 'earnings', 'fomc', 'cpi', 'jobs', 'gdp', 'pmi', 'retail_sales', 'analyst_meeting'). Omit for all types.",
        },
        symbol: {
          type: "string",
          description:
            "Filter by security symbol for company-specific events (e.g., 'AAPL' for Apple earnings). Omit for all events.",
        },
      },
    },
  },
  {
    name: "query_calendar_briefings",
    description:
      "Retrieve weekly market briefings — AI-generated narrative summaries of each week's key market events, including macro data releases, earnings, and portfolio-relevant developments. Each briefing includes Vital Knowledge market context when available. Use when the user asks 'what happened last week', 'give me a market summary', 'what was the narrative around [date]', or wants historical market context for a specific period.",
    input_schema: {
      type: "object" as const,
      properties: {
        week_of: {
          type: "string",
          description:
            "Monday date (YYYY-MM-DD) of the week to retrieve. Omit for most recent briefing.",
        },
        weeks_back: {
          type: "number",
          description:
            "Number of recent weekly briefings to retrieve. Default 1. Use 4 for last month, 12 for last quarter.",
        },
      },
    },
  },
  {
    name: "query_levels",
    description:
      "Query active price levels — support, resistance, entry, exit, stop, and scale-in prices set by the user or extracted from research newsletters. Each level includes its effective price (live-computed MA for EMA/SMA-based levels, or the static price) plus the author, thesis, and timeframe context. Use when the user asks 'what levels are closest to triggering?', 'show Eliant's levels', 'what support levels do I have on SPY?', or 'which levels should I watch this week?'.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: "Filter by security symbol (e.g., 'SPY', 'AAPL'). Omit for all securities.",
        },
        source_author: {
          type: "string",
          description:
            "Filter by who set the level — e.g., 'Me' for user-originated, 'Eliant Capital', 'Purple Drink', 'Helene Meisler'. Omit for all authors.",
        },
        level_type: {
          type: "string",
          enum: ["support", "resistance", "entry", "exit", "stop", "scale_in"],
          description: "Filter by level type. Omit for all types.",
        },
        include_inactive: {
          type: "boolean",
          description:
            "Include inactive (triggered or paused) levels. Default false — only armed levels.",
        },
      },
    },
  },
  {
    name: "query_alerts",
    description:
      "Query level alerts — events where a price has crossed an armed level. Each alert includes the level's author, thesis, triggered price, current position context (held/watchlist), Claude's suggested action, and the user's response state. Use when the user asks 'what alerts have fired recently?', 'show me pending alerts', 'which Eliant levels have hit?', or 'alerts I ignored last month'.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: "Filter by security symbol. Omit for all alerts.",
        },
        response: {
          type: "string",
          enum: ["pending", "acted", "ignored", "dismissed"],
          description: "Filter by the user's response state. Omit for all states.",
        },
        since_days: {
          type: "number",
          description:
            "Only alerts from the last N days. Default 30. Use 7 for this week, 90 for this quarter.",
        },
        limit: {
          type: "number",
          description: "Max results. Default 50.",
        },
      },
    },
  },
  {
    name: "query_release_reactions",
    description:
      "Look up how the market reacted to past macro releases or earnings. Each row includes the actual value, consensus at release time, and the 2-hour post-release price change for SPY, QQQ, TLT, and (when mapped) the sector ETF. Use when the user asks 'what did SPY do on the last three hot CPI prints?', 'how does NVDA typically trade after earnings?', or 'show me the last few FOMC reactions'. Pass event_type = 'cpi' / 'fomc' / 'jobs' / 'gdp' for macro, or 'earnings_NVDA' / 'earnings_SPY' for a specific ticker's earnings.",
    input_schema: {
      type: "object" as const,
      properties: {
        event_type: {
          type: "string",
          description:
            "Event type key: 'cpi' | 'fomc' | 'jobs' | 'gdp' | 'pmi' | 'retail_sales' | 'housing' for macro, or 'earnings_TICKER' (e.g. 'earnings_NVDA') for a specific company's earnings. Omit for all event types.",
        },
        symbol: {
          type: "string",
          description: "Filter by ticker symbol (alternative to earnings_TICKER shortcut). Omit for all.",
        },
        since_date: {
          type: "string",
          description: "YYYY-MM-DD. Limit to events on or after this date.",
        },
        limit: {
          type: "number",
          description: "Max results. Default 10.",
        },
      },
    },
  },
];

// ─── Account Name Resolution ─────────────────────────────────────

/**
 * Resolve a user-provided account name to the exact DB account name
 * using case-insensitive substring matching.
 * "roth" → "Vanguard Roth IRA", "ibkr" → "IBKR", etc.
 * Returns the original string if no match found (let downstream handle it).
 */
export function resolveAccountName(
  db: Database.Database,
  input: string | undefined
): string | undefined {
  if (!input) return undefined;

  // Try exact match first
  const exact = db
    .prepare("SELECT name FROM accounts WHERE name = ?")
    .get(input) as { name: string } | undefined;
  if (exact) return exact.name;

  // Fall back to case-insensitive substring match
  const fuzzy = db
    .prepare("SELECT name FROM accounts WHERE LOWER(name) LIKE '%' || LOWER(?) || '%'")
    .get(input) as { name: string } | undefined;
  return fuzzy?.name ?? input;
}

/**
 * Resolve a user-provided account name to the DB account ID
 * using case-insensitive substring matching.
 */
function resolveAccountId(
  db: Database.Database,
  input: string | undefined
): number | undefined {
  if (!input) return undefined;

  // Try exact match first
  const exact = db
    .prepare("SELECT id FROM accounts WHERE name = ?")
    .get(input) as { id: number } | undefined;
  if (exact) return exact.id;

  // Fall back to case-insensitive substring match
  const fuzzy = db
    .prepare("SELECT id FROM accounts WHERE LOWER(name) LIKE '%' || LOWER(?) || '%'")
    .get(input) as { id: number } | undefined;
  return fuzzy?.id;
}

// ─── Tool Dispatcher ──────────────────────────────────────────────

/**
 * Execute a chat tool by name with the given input parameters.
 * Returns the query result wrapped with data quality annotations.
 * On error, returns { error: "..." } instead of throwing.
 */
export async function executeTool(
  db: Database.Database,
  toolName: string,
  input: Record<string, unknown>
): Promise<unknown> {
  try {
    // Resolve account names case-insensitively for all tools that accept one
    const accountName = resolveAccountName(db, input.account_name as string | undefined);

    let rawResult: unknown;

    switch (toolName) {
      case "query_holdings":
        rawResult = getHoldingsForChat(db, {
          account_name: accountName,
          symbol: input.symbol as string | undefined,
          security_type: input.security_type as string | undefined,
          sector: input.sector as string | undefined,
          sort_by: input.sort_by as "market_value" | "unrealized_gain" | "position_weight" | "symbol" | undefined,
          limit: input.limit as number | undefined,
        });
        break;

      case "query_price_history":
        rawResult = getPriceHistory(
          db,
          input.symbol as string,
          input.start_date as string | undefined,
          input.end_date as string | undefined
        );
        break;

      case "query_allocation":
        rawResult = getAllocationBreakdown(
          db,
          input.group_by as string,
          accountName
        );
        break;

      case "query_tax_lots":
        rawResult = getTaxLotsForChat(db, {
          status: input.status as "open" | "closed" | "all" | undefined,
          symbol: input.symbol as string | undefined,
          account_name: accountName,
          year: input.year as number | undefined,
          sort_by: input.sort_by as "unrealized_gain" | "acquisition_date" | "holding_period_days" | "cost_basis" | undefined,
          limit: input.limit as number | undefined,
        });
        break;

      case "query_transactions":
        rawResult = getTransactionsForChat(db, {
          account_name: accountName,
          symbol: input.symbol as string | undefined,
          type: input.type as string | undefined,
          start_date: input.start_date as string | undefined,
          end_date: input.end_date as string | undefined,
          limit: input.limit as number | undefined,
        });
        break;

      case "query_performance":
        rawResult = getPerformanceForChat(db, {
          account_name: accountName,
          start_date: input.start_date as string | undefined,
          end_date: input.end_date as string | undefined,
        });
        break;

      case "query_income_summary":
        rawResult = getIncomeSummaryForChat(db, {
          period: input.period as "ytd" | "trailing_12m" | "last_year" | "all_time" | undefined,
          group_by: input.group_by as "symbol" | "account" | "month" | "type" | undefined,
          account_name: accountName,
        });
        break;

      case "query_twr": {
        const today = new Date().toISOString().slice(0, 10);
        const period = (input.period as string) || "ytd";
        let startDate: string | undefined;

        switch (period) {
          case "ytd":
            startDate = `${today.slice(0, 4)}-01-01`;
            break;
          case "1y":
            startDate = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
            break;
          case "3y":
            startDate = new Date(Date.now() - 3 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
            break;
          case "5y":
            startDate = new Date(Date.now() - 5 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
            break;
          case "inception":
          default:
            startDate = undefined;
            break;
        }

        const accountId = resolveAccountId(db, input.account_name as string | undefined);

        const twrResult = computeTwr(db, { startDate, endDate: today, accountId });
        const xirrResult = computeXirr(db, { startDate, endDate: today, accountId });

        rawResult = {
          twr: twrResult,
          xirr: xirrResult,
        };
        break;
      }

      case "query_fred": {
        // This is async — return a promise
        const seriesId = input.series_id as string | undefined;
        const searchQuery = input.search_query as string | undefined;
        const defaultStart = new Date(Date.now() - 365 * 24 * 3600 * 1000)
          .toISOString()
          .slice(0, 10);

        if (seriesId) {
          rawResult = await getSeriesData(seriesId, {
            startDate: (input.start_date as string) || defaultStart,
            endDate: (input.end_date as string) || undefined,
            limit: (input.limit as number) || 30,
            sort: "desc",
          });
        } else if (searchQuery) {
          rawResult = await searchSeries(searchQuery, { limit: (input.limit as number) || 10 });
        } else {
          return { error: "Provide either series_id or search_query" };
        }
        break;
      }

      case "query_company_fundamentals": {
        const ticker = input.ticker as string;
        const includeFilings = input.include_filings as boolean | undefined;
        const annualOnly = input.annual_only as boolean | undefined;

        const financials = await getCompanyFinancials(ticker, {
          annualOnly: annualOnly || false,
          limit: 8,
        });

        if (includeFilings) {
          const filings = await getRecentFilings(ticker, { limit: 5 });
          rawResult = { ...financials, recentFilings: filings };
        } else {
          rawResult = financials;
        }
        break;
      }

      case "query_insider_trades": {
        const ticker = input.ticker as string;
        rawResult = await getInsiderTransactions(ticker, {
          limit: (input.limit as number) || 10,
          transactionType:
            (input.transaction_type as "buy" | "sell" | "all") || "all",
        });
        break;
      }

      case "query_notes": {
        let securityId: number | undefined;
        if (input.symbol) {
          const id = getSecurityIdBySymbol(db, input.symbol as string);
          if (id) securityId = id;
        }
        rawResult = getNotesFiltered(db, {
          note_type: input.note_type as NoteType | undefined,
          security_id: securityId,
          search: input.search as string | undefined,
          start_date: input.start_date as string | undefined,
          end_date: input.end_date as string | undefined,
          limit: (input.limit as number) || 20,
        });
        break;
      }

      case "create_note": {
        const today = new Date().toISOString().slice(0, 10);
        let securityId: number | null = null;
        if (input.symbol) {
          securityId = getSecurityIdBySymbol(db, input.symbol as string);
        }
        const note = createNote(db, {
          note_type: input.note_type as NoteType,
          content: input.content as string,
          security_id: securityId,
          event_date: (input.event_date as string) || today,
          sentiment: (input.sentiment as NoteSentiment) || null,
          tags: (input.tags as string[]) || null,
        });
        rawResult = { saved: true, note };
        break;
      }

      case "query_filing_section": {
        const ticker = input.ticker as string;
        const filingType = input.filing_type as "10-K" | "10-Q";
        const section = input.section as "risk_factors" | "mda";
        rawResult = await getFilingSection(db, {
          symbol: ticker,
          filing_type: filingType,
          section,
        });
        break;
      }

      case "query_research_documents": {
        const results = searchResearchDocuments(db, {
          query: input.query as string | undefined,
          symbol: input.symbol as string | undefined,
          document_type: input.document_type as ResearchDocumentType | undefined,
          tag: input.tag as string | undefined,
          days_back: input.days_back as number | undefined,
          limit: (input.limit as number) || 10,
        });
        // Parse JSON fields for the model. Strip raw_text from the response —
        // returning the full body of every match would explode context for
        // minimal marginal value; the snippet carries the hit context.
        rawResult = {
          count: results.length,
          documents: results.map((r) => ({
            id: r.id,
            title: r.title,
            author: r.author,
            source: r.source,
            publication_date: r.publication_date,
            document_type: r.document_type,
            sentiment: r.sentiment,
            mentioned_symbols: r.mentioned_symbols
              ? JSON.parse(r.mentioned_symbols)
              : [],
            tags: r.tags ? JSON.parse(r.tags) : [],
            key_points: r.key_points ? JSON.parse(r.key_points) : [],
            summary: r.summary,
            snippet: r.snippet,
            uploaded_at: r.uploaded_at,
          })),
        };
        break;
      }

      case "query_analyst_coverage": {
        const ticker = (input.ticker as string).toUpperCase();
        const monthsHistory = Math.min((input.months_history as number) || 6, 24);
        const rcLimit = Math.min((input.rating_changes_limit as number) || 10, 50);

        const sync = await syncAnalystCoverage(db, ticker);
        const recommendations = getRecommendationHistory(db, ticker, monthsHistory);
        const priceTarget = getPriceTarget(db, ticker);
        const ratingChanges = getRatingChanges(db, ticker, rcLimit);

        rawResult = {
          ticker,
          warnings: sync.errors.length > 0 ? sync.errors : undefined,
          recommendation_trend: recommendations.map((r) => ({
            period: r.period,
            strong_buy: r.strong_buy,
            buy: r.buy,
            hold: r.hold,
            sell: r.sell,
            strong_sell: r.strong_sell,
            total: r.strong_buy + r.buy + r.hold + r.sell + r.strong_sell,
          })),
          price_target: priceTarget
            ? {
                high: priceTarget.target_high,
                low: priceTarget.target_low,
                mean: priceTarget.target_mean,
                median: priceTarget.target_median,
                number_of_analysts: priceTarget.number_of_analysts,
                last_updated: priceTarget.last_updated,
              }
            : null,
          rating_changes: ratingChanges.map((c) => ({
            date: c.rating_date,
            firm: c.firm,
            from: c.from_grade,
            to: c.to_grade,
            action: c.action,
          })),
        };
        break;
      }

      case "query_press_releases": {
        const ticker = (input.ticker as string).toUpperCase();
        const daysBack = (input.days_back as number) || 7;
        const keyword = input.keyword as string | undefined;
        const limit = (input.limit as number) || 15;

        // Sync + query pattern. Sync errors are surfaced as a warning
        // alongside any locally-cached rows so the user still gets
        // something actionable when Finnhub is down.
        const sync = await fetchAndCachePressReleases(db, ticker, daysBack);
        const rows = listPressReleases(db, {
          symbol: ticker,
          keyword,
          days_back: daysBack,
          limit,
        });

        rawResult = {
          ticker,
          days_back: daysBack,
          keyword: keyword ?? null,
          fetched: sync.upserted,
          warning: sync.error ?? undefined,
          count: rows.length,
          press_releases: rows.map((r) => ({
            headline: r.headline,
            summary: r.summary,
            source: r.source,
            category: r.category,
            url: r.url,
            published_at: r.published_at,
          })),
        };
        break;
      }

      case "query_earnings_transcript": {
        const ticker = input.ticker as string;
        const transcriptData = await getTranscriptForChat(
          db,
          ticker,
          input.year as number | undefined,
          input.quarter as number | undefined,
          { fullText: input.include_full_text === true },
        );

        if (!transcriptData) {
          rawResult = {
            error: `No earnings transcript found for ${ticker}. The company may not have reported recently, or external sources may be temporarily unavailable.`,
          };
        } else {
          // Also fetch user's earnings notes for this security
          const secId = getSecurityIdBySymbol(db, ticker);
          let userNotes: unknown[] = [];
          if (secId) {
            userNotes = getNotesFiltered(db, {
              note_type: "earnings",
              security_id: secId,
              limit: 5,
            });
          }
          rawResult = {
            ...transcriptData,
            user_notes: userNotes,
          };
        }
        break;
      }

      case "query_trade_reviews": {
        const accountName = resolveAccountName(
          db,
          (input.account_name as string) || "IBKR"
        );
        const account = db
          .prepare("SELECT id FROM accounts WHERE name = ?")
          .get(accountName) as { id: number } | undefined;

        if (!account) {
          rawResult = { error: `Account "${input.account_name ?? "IBKR"}" not found` };
          break;
        }

        if (input.period_start) {
          // Detail mode — single review with optional grades
          const review = getTradeReviewByPeriod(
            db,
            account.id,
            input.period_start as string
          );
          if (!review) {
            rawResult = {
              error: `No trade review found for ${input.period_start}. Generate one first via Research > Trade Reviews.`,
            };
            break;
          }
          const roundtrips = input.include_grades
            ? getTradeRoundtrips(db, review.id)
            : [];
          rawResult = { review, roundtrips };
        } else {
          // List mode
          const reviews = getTradeReviews(
            db,
            account.id,
            input.year as number | undefined
          );
          rawResult = {
            reviews: reviews.map((r) => ({
              period: r.period_start,
              trades: r.total_trades,
              winRate: `${(r.win_rate * 100).toFixed(0)}%`,
              pnl: r.total_realized_pnl,
              profitFactor: r.profit_factor,
              avgHoldingDays: r.avg_holding_days,
              bestTrade: r.best_trade_symbol
                ? `${r.best_trade_symbol} ($${r.best_trade_pnl?.toFixed(0)})`
                : null,
              worstTrade: r.worst_trade_symbol
                ? `${r.worst_trade_symbol} ($${r.worst_trade_pnl?.toFixed(0)})`
                : null,
            })),
            totalReviews: reviews.length,
          };
        }
        break;
      }

      case "query_options_greeks": {
        const accountName = resolveAccountName(db, input.account_name as string | undefined);
        const account = accountName
          ? (db
              .prepare("SELECT id FROM accounts WHERE name = ?")
              .get(accountName) as { id: number } | undefined)
          : undefined;
        const accountId = account?.id;

        // Compute Greeks
        const greeks = computePortfolioGreeks(db, { accountId });

        // Filter by underlying if specified
        let positions = greeks.positions;
        if (input.underlying) {
          const und = (input.underlying as string).toUpperCase();
          positions = positions.filter((p) => p.underlying === und);
        }

        // Detect strategies from option positions + stock holdings
        const optionPositions = getOptionPositions(db, accountId);
        const stockHoldings = db
          .prepare(
            `SELECT s.symbol, h.quantity, s.security_type,
                    (SELECT p.close_price FROM prices p WHERE p.security_id = s.id
                     ORDER BY p.date DESC LIMIT 1) AS current_price
             FROM holdings h
             JOIN securities s ON s.id = h.security_id
             WHERE LOWER(s.security_type) IN ('stock', 'etf')
               AND h.as_of_date = (SELECT MAX(h2.as_of_date) FROM holdings h2)
               ${accountId ? "AND h.account_id = ?" : ""}`
          )
          .all(...(accountId ? [accountId] : [])) as Array<{
          symbol: string;
          quantity: number;
          security_type: string;
          current_price: number | null;
        }>;

        const positionLegs: PositionLeg[] = [
          ...stockHoldings.map((s) => ({
            symbol: s.symbol,
            underlying: s.symbol,
            securityType: "stock" as const,
            quantity: s.quantity,
            multiplier: 1,
            currentPrice: s.current_price,
          })),
          ...optionPositions.map((o) => ({
            symbol: o.symbol,
            underlying: o.underlying,
            securityType: "option" as const,
            optionType: o.optionType,
            strike: o.strike,
            expiration: o.expiration,
            quantity: o.quantity,
            multiplier: o.multiplier,
            currentPrice: o.currentPrice,
          })),
        ];

        const strategies = detectStrategies(positionLegs);

        rawResult = {
          portfolio: {
            totalDelta: greeks.totalDelta,
            totalGamma: greeks.totalGamma,
            totalTheta: greeks.totalTheta,
            totalVega: greeks.totalVega,
          },
          positions: positions.map((p) => ({
            symbol: p.symbol,
            underlying: p.underlying,
            type: p.optionType,
            strike: p.strike,
            expiration: p.expiration,
            quantity: p.quantity,
            underlyingPrice: p.underlyingPrice,
            daysToExpiry: p.daysToExpiry,
            delta: p.greeks?.delta,
            gamma: p.greeks?.gamma,
            theta: p.greeks?.theta,
            vega: p.greeks?.vega,
            iv: p.greeks?.iv != null ? `${(p.greeks.iv * 100).toFixed(1)}%` : null,
          })),
          strategies: strategies.map((s) => ({
            type: s.type,
            name: s.name,
            underlying: s.underlying,
            expiration: s.expiration,
            maxProfit: s.maxProfit,
            maxLoss: s.maxLoss,
            breakevens: s.breakevens,
            description: s.description,
          })),
          positionCount: positions.length,
          strategyCount: strategies.length,
        };
        break;
      }

      case "query_research_feeds": {
        let researchArticles: import("@/lib/queries/research").ResearchArticle[] = [];
        try {
          const { getRecentArticles } = await import("@/lib/queries/research");
          const daysBack = (input.days_back as number) || 7;
          const startDate = new Date();
          startDate.setDate(startDate.getDate() - daysBack);

          // If filtering by symbol, find the security_id
          let securityId: number | undefined;
          if (input.symbol) {
            const sec = db
              .prepare("SELECT id FROM securities WHERE symbol = ? LIMIT 1")
              .get(String(input.symbol).toUpperCase()) as
              | { id: number }
              | undefined;
            securityId = sec?.id;
          }

          // If filtering by source name, find the source_id
          let sourceId: number | undefined;
          if (input.source) {
            const src = db
              .prepare(
                "SELECT id FROM research_sources WHERE LOWER(name) LIKE '%' || LOWER(?) || '%' LIMIT 1"
              )
              .get(String(input.source)) as { id: number } | undefined;
            sourceId = src?.id;
          }

          researchArticles = getRecentArticles(db, {
            sourceId,
            securityId,
            startDate: startDate.toISOString().slice(0, 10),
            search: input.search ? String(input.search) : undefined,
            processedOnly: true,
            limit: 15,
          });
        } catch {
          // Table may not exist yet
        }

        rawResult = {
          articles: researchArticles.map((a) => ({
            source: a.source_name,
            date: a.received_at.slice(0, 10),
            subject: a.subject,
            summary: a.summary,
            sentiment: a.sentiment,
            themes: a.key_themes ? JSON.parse(a.key_themes) : [],
            tickers: a.mentioned_symbols
              ? JSON.parse(a.mentioned_symbols)
              : [],
            portfolio_relevance: a.portfolio_relevance,
          })),
          count: researchArticles.length,
        };
        break;
      }

      case "query_calendar_events": {
        const daysAhead = (input.days_ahead as number) ?? 14;
        const daysBack = (input.days_back as number) ?? 0;
        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - daysBack);
        const endDate = new Date(now);
        endDate.setDate(endDate.getDate() + daysAhead);

        const evtParams: unknown[] = [
          startDate.toISOString().slice(0, 10),
          endDate.toISOString().slice(0, 10),
        ];

        let evtWhere = "event_date BETWEEN ? AND ?";
        if (input.event_type) {
          evtWhere += " AND LOWER(event_type) LIKE '%' || LOWER(?) || '%'";
          evtParams.push(String(input.event_type));
        }
        if (input.symbol) {
          evtWhere += " AND UPPER(symbol) = ?";
          evtParams.push(String(input.symbol).toUpperCase());
        }

        const events = db
          .prepare(
            `SELECT event_type, event_date, event_time, title, description, symbol,
             expected_impact, consensus_estimate, previous_value
             FROM calendar_events WHERE ${evtWhere}
             ORDER BY event_date ASC, event_time ASC LIMIT 50`
          )
          .all(...evtParams);
        rawResult = { events, count: events.length };
        break;
      }

      case "query_calendar_briefings": {
        const weeksBack = (input.weeks_back as number) ?? 1;

        let briefings;
        if (input.week_of) {
          briefings = db
            .prepare(
              "SELECT week_of, title, content, event_count, generated_at FROM calendar_briefings WHERE week_of = ?"
            )
            .all(String(input.week_of));
        } else {
          briefings = db
            .prepare(
              "SELECT week_of, title, content, event_count, generated_at FROM calendar_briefings ORDER BY week_of DESC LIMIT ?"
            )
            .all(weeksBack);
        }

        rawResult = { briefings, count: briefings.length };
        break;
      }

      case "query_levels": {
        const symbol = input.symbol ? String(input.symbol).toUpperCase() : undefined;
        const securityId = symbol ? getSecurityIdBySymbol(db, symbol) ?? undefined : undefined;
        const activeOnly = !input.include_inactive;
        const rawLevels = securityId
          ? getLevelsForSecurity(db, securityId, { activeOnly })
          : getActiveLevels(db);
        const sourceAuthor = input.source_author ? String(input.source_author) : undefined;
        const levelType = input.level_type ? String(input.level_type) : undefined;

        const filtered = rawLevels.filter((l) => {
          if (sourceAuthor && l.source_author?.toLowerCase() !== sourceAuthor.toLowerCase()) return false;
          if (levelType && l.level_type !== levelType) return false;
          return true;
        });

        // Join security symbol via a single lookup so the chat gets human-readable context.
        const symByIdStmt = db.prepare("SELECT symbol, name FROM securities WHERE id = ?");
        const enriched = filtered.map((l) => {
          const sec = symByIdStmt.get(l.security_id) as { symbol: string; name: string } | undefined;
          const effective =
            l.price_source === "static" ? l.price : resolveLevelPrice(db, l);
          return {
            id: l.id,
            symbol: sec?.symbol ?? null,
            security_name: sec?.name ?? null,
            level_type: l.level_type,
            price: l.price,
            price_source: l.price_source,
            effective_price: effective,
            direction: l.direction,
            action_hint: l.action_hint,
            source: l.source,
            source_author: l.source_author,
            thesis: l.thesis,
            timeframe: l.timeframe,
            expires_at: l.expires_at,
            is_active: l.is_active,
            triggered_at: l.triggered_at,
            triggered_price: l.triggered_price,
            set_date: l.set_date,
          };
        });

        rawResult = { levels: enriched, count: enriched.length };
        break;
      }

      case "query_alerts": {
        const symbol = input.symbol ? String(input.symbol).toUpperCase() : undefined;
        const securityId = symbol ? getSecurityIdBySymbol(db, symbol) ?? undefined : undefined;
        const sinceDays = (input.since_days as number) ?? 30;
        const response = input.response as
          | "pending"
          | "acted"
          | "ignored"
          | "dismissed"
          | undefined;
        const limit = (input.limit as number) ?? 50;
        const sinceIso = new Date(Date.now() - sinceDays * 86400000).toISOString();

        const rawAlerts = getAlerts(db, { securityId, response, limit });
        const recent = rawAlerts.filter((a) => a.triggered_at >= sinceIso);

        // Enrich with security symbol + level author/thesis for narrative context.
        const symByIdStmt = db.prepare("SELECT symbol, name FROM securities WHERE id = ?");
        const levelByIdStmt = db.prepare(
          "SELECT level_type, price, price_source, source_author, thesis, timeframe FROM security_levels WHERE id = ?"
        );
        const enriched = recent.map((a) => {
          const sec = symByIdStmt.get(a.security_id) as { symbol: string; name: string } | undefined;
          const lvl = levelByIdStmt.get(a.level_id) as
            | {
                level_type: string;
                price: number;
                price_source: string;
                source_author: string | null;
                thesis: string | null;
                timeframe: string | null;
              }
            | undefined;
          return {
            id: a.id,
            symbol: sec?.symbol ?? null,
            security_name: sec?.name ?? null,
            level_type: lvl?.level_type ?? null,
            level_price: lvl?.price ?? null,
            price_source: lvl?.price_source ?? null,
            source_author: lvl?.source_author ?? null,
            thesis: lvl?.thesis ?? null,
            timeframe: lvl?.timeframe ?? null,
            triggered_at: a.triggered_at,
            triggered_price: a.triggered_price,
            suggested_action: a.suggested_action,
            user_response: a.user_response,
            user_response_at: a.user_response_at,
            user_response_note: a.user_response_note,
          };
        });

        rawResult = { alerts: enriched, count: enriched.length };
        break;
      }

      case "query_release_reactions": {
        const rows = getRecentReleaseReactions(db, {
          eventType: input.event_type as string | undefined,
          symbol: input.symbol ? String(input.symbol).toUpperCase() : undefined,
          sinceDate: input.since_date as string | undefined,
          limit: (input.limit as number) ?? 10,
        });
        const decoded = rows.map((r) => {
          let reaction: unknown = null;
          if (r.reaction_snapshot) {
            try {
              reaction = JSON.parse(r.reaction_snapshot);
            } catch {
              reaction = null;
            }
          }
          return {
            event_id: r.event_id,
            title: r.title,
            event_date: r.event_date,
            event_type: r.event_type,
            symbol: r.symbol,
            actual_value: r.actual_value,
            consensus_value: r.consensus_value,
            reaction,
          };
        });
        rawResult = { releases: decoded, count: decoded.length };
        break;
      }

      default:
        return { error: `Unknown tool: ${toolName}` };
    }

    // Wrap result with data quality annotations
    const annotations = annotateToolResult(db, toolName, rawResult);
    return {
      data: rawResult,
      ...annotations,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool execution failed";
    return { error: message };
  }
}

// ─── Friendly tool name labels for the UI ─────────────────────────

export const TOOL_LABELS: Record<string, string> = {
  query_holdings: "Querying holdings...",
  query_price_history: "Fetching price history...",
  query_allocation: "Computing allocation...",
  query_tax_lots: "Analyzing tax lots...",
  query_transactions: "Searching transactions...",
  query_performance: "Loading performance data...",
  query_income_summary: "Summarizing income...",
  query_twr: "Computing time-weighted return...",
  query_fred: "Fetching economic data...",
  query_company_fundamentals: "Looking up company financials...",
  query_insider_trades: "Fetching insider trading data...",
  query_notes: "Searching notes...",
  create_note: "Saving note...",
  query_earnings_transcript: "Fetching earnings transcript...",
  query_press_releases: "Fetching press releases...",
  query_analyst_coverage: "Fetching analyst coverage...",
  query_filing_section: "Summarizing SEC filing...",
  query_research_documents: "Searching research documents...",
  query_trade_reviews: "Looking up trade reviews...",
  query_options_greeks: "Computing options Greeks...",
  query_research_feeds: "Searching research feeds...",
  query_calendar_events: "Checking calendar events...",
  query_calendar_briefings: "Retrieving market briefings...",
  query_levels: "Scanning price levels...",
  query_alerts: "Reviewing alert history...",
  query_release_reactions: "Looking up release reactions...",
};
