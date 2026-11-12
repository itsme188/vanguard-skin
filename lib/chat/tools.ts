import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "ai";
import {
  getHoldingsForChat,
  getPriceHistory,
  getAllocationBreakdown,
  getTaxLotsForChat,
  getTransactionsForChat,
  getReconcileGapNotesForChat,
  getClosedPerLiveDataForChat,
  getLedgerLastDateForChat,
  getLedgerEndByAccountForChat,
  getPerformanceForChat,
  getIncomeSummaryForChat,
  getTaxLotTotalsForChat,
  getHoldingsBySymbolForChat,
} from "@/lib/queries/chat-tools";
import { getNoteById, getNotesFiltered, getSecurityIdBySymbol, type NoteWithContext } from "@/lib/queries/notes";
import { createNote } from "@/lib/mutations/notes";
import { VALID_TRANSACTION_TYPES } from "@/lib/import/validate";
import {
  COMPOSITE_CHAT_TOOLS,
  COMPOSITE_SCOPE_LIST_TOOLS,
  isCompositeTool,
  runCompositeTool,
} from "./composite";
import { addDays, todayET, nowET, parseDbTimestamp } from "@/lib/calendar/date-utils";
import { NOTE_TYPES, NOTE_SENTIMENTS } from "@/lib/types";
import { coerceNoteType, coerceNoteSentiment } from "@/lib/notes/coerce";
import { computeTwr } from "@/lib/compute/twr";
import { computeXirr } from "@/lib/compute/xirr";
import { resolveChatAccounts, type ChatAccountResolution } from "@/lib/chat/account-scope";
import { getAllAccounts } from "@/lib/queries/accounts";
import { annotateToolResult } from "@/lib/chat/validate";
import { isPreReleaseActual } from "@/lib/calendar/pre-release-actual";
import { deriveEarningsSlot } from "@/lib/earnings/earnings-slot";
import { actualsAreImplausible } from "@/lib/earnings/actuals-display";
import { applyClusterManualActuals } from "@/lib/queries/manual-actuals-cluster";
import { getSeriesData, searchSeries, getLatestValue, FRED_SERIES } from "@/lib/apis/fred";
import { getCompanyFinancials, getCompanyInfo, getRecentFilings, getInsiderTransactions } from "@/lib/apis/edgar";
import { getTranscriptForChat } from "@/lib/transcripts/fetch";
import { getTradeReviews, getTradeReviewByPeriod, getTradeRoundtrips } from "@/lib/queries/trade-reviews";
import { computePortfolioGreeks } from "@/lib/compute/options-greeks";
import {
  detectStrategiesPerAccount,
  getOptionPositions,
  getStockLegsForStrategyDetection,
} from "@/lib/queries/options";
import { getActiveLevels, getAlerts, getLevelsForSecurity } from "@/lib/queries/security-levels";
import { resolveLevelPrice } from "@/lib/alerts/resolve-level-price";
import { getFilingSection } from "@/lib/apis/filing-extract";
import { sanitizeThemeList } from "@/lib/gmail/theme-sanitize";
import {
  getResearchDocument,
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
import type { ReactionSnapshot } from "@/lib/calendar/reaction-snapshot-core";
import {
  readReactionLegs,
  type ReactionEvidence,
  type ReactionLegKey,
  type StoredReactionLeg,
} from "@/lib/calendar/reaction-validity";
import { getMarketSnapshot, fetchYahooQuotes } from "@/lib/queries/market-snapshot";
import {
  resolvePerformanceWindow,
  latestStatementAnchor,
  type PerformancePeriod,
} from "@/lib/compute/performance-window";

// research_articles.key_themes is stored JSON, but a mangled row (the
// tag-remnant leak sanitizeThemeList/sanitizeModelSummary now guard against
// going forward) can be non-JSON. JSON.parse would throw and crash the tool
// call — fall back to the raw string, which sanitizeThemeList already knows
// how to comma-split.
function parseKeyThemesField(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Strip every leg that is not a real measurement out of a stored reaction
 * snapshot before the chat model ever sees it.
 *
 * Two classes are removed, both decided by lib/calendar/reaction-validity.ts
 * (the same rule the on-screen chips, the recap email and the weekly briefing
 * read; the chat tool must not fork it):
 *
 *   - ABSENT. Legacy rows (written before the write-side guard landed)
 *     zero-fill a leg whose bars never arrived: `{t_pre:0, t_post:0,
 *     delta_pct:0}`. Handed to the model as-is, that reads as a genuine FLAT
 *     market reaction. The leg is dropped.
 *   - PENDING (2026-10-08). A figure exists but is not a measurement: the
 *     snapshot was captured before its two-hour window elapsed, or the pre and
 *     post prices are identical. The leg is replaced by `{ state: "pending" }`
 *     with no price and no percent, so the model can say the reaction is not
 *     in yet and can never quote the number.
 *
 * A snapshot with no measured and no pending leg carries no reaction
 * information, so it collapses to null rather than shipping bare metadata.
 * When nothing is measured but something is pending, the result carries a
 * top-level `state: "pending"`.
 *
 * Pass the row's `enriched_at` as evidence so the legacy rule applies too: an
 * older snapshot's 0.00% leg on a row enriched before the window ended is
 * pending, not a flat move.
 */
type ChatReactionLeg = StoredReactionLeg | { state: "pending"; symbol?: string };
type ChatReactionSnapshot = Partial<
  Pick<ReactionSnapshot, "t0_utc" | "window_min" | "source" | "pre_anchor">
> &
  Partial<Record<ReactionLegKey, ChatReactionLeg>> & { state?: "pending" };

function sanitizeReactionSnapshotForChat(
  raw: string | null,
  evidence: ReactionEvidence = {},
): ChatReactionSnapshot | null {
  const read = readReactionLegs(raw, evidence);
  if (!read) return null;
  const { snapshot: snap, measured, pending } = read;

  const clean: ChatReactionSnapshot = {};
  for (const key of ["spy", "qqq", "tlt", "sector", "symbol"] as const) {
    const leg = measured[key];
    if (leg) {
      clean[key] = leg;
    } else if (pending.includes(key)) {
      const label = (snap[key] as StoredReactionLeg | undefined)?.symbol;
      clean[key] = typeof label === "string" ? { state: "pending", symbol: label } : { state: "pending" };
    }
  }
  if (Object.keys(clean).length === 0) return null;
  if (Object.keys(measured).length === 0) clean.state = "pending";

  // Metadata rides along only when at least one leg survived — it is
  // context for the deltas, never a substitute for them.
  if (snap.t0_utc) clean.t0_utc = snap.t0_utc;
  if (snap.window_min) clean.window_min = snap.window_min;
  if (snap.source) clean.source = snap.source;
  if (snap.pre_anchor) clean.pre_anchor = snap.pre_anchor;
  return clean;
}

// ─── Tool Definitions ─────────────────────────────────────────────

/**
 * A chat tool definition: the Anthropic-format tool plus the optional AI SDK
 * options the route passes through to `tool()` (plan Contracts C and H).
 */
export type ChatTool = Anthropic.Tool & {
  needsApproval?: true;
  toModelOutput?: Tool["toModelOutput"];
};

const BASE_CHAT_TOOLS: ChatTool[] = [
  {
    name: "query_holdings",
    description:
      "Query current holdings with optional filters. Returns detailed position data including cost basis, market value, unrealized gain/loss, position weight, sector, asset class, and maturity info for bonds. Includes SHORT positions: quantity and market_value are signed (negative = short), each row carries position_side ('long' or 'short'), and position_weight_pct is each position's share of GROSS exposure (always positive; longs and shorts together sum to 100%). Automatically excludes matured bonds, expired options and zero-quantity positions. When a symbol filter matches a position closed per LIVE broker data in some account (awaiting the broker statement for the closing trade), the result is an object instead of a list: holdings carries any current rows (another account may still hold it) and closed_per_live_data lists, per closed account, the last date and quantity the position was seen held, closed_as_of_date, and account_ledger_last_date (where that account's imported ledger ends, any symbol) (pending_statement: true, with a status_note). Such a position is not a current holding, but it WAS held until about that date: never describe it as flat since an earlier ledger sale. closed_per_live_data never lists a position the statement already shows closed with its closing trade missing, a position now held on the opposite side, an option past its expiration (an expired option awaits its closing entry, not the statement), or an option renamed to a new contract after a split (a re-symbolled option is still held under its new contract; never call it closed): query_tax_lots says why such lots are pending. When the result covers a security held in two or more positions in scope (two accounts, or long and short), a top-level by_symbol list sums it per security: total_quantity, total_cost_basis_usd, market_value and unrealized_gain (USD, the security page's POSITIONS totals) and cost_basis_per_share_usd (total cost basis / total quantity, USD a share, for a long stock, ETF or fund position with every basis known; otherwise null with cost_basis_per_share_reason). Quote these instead of adding rows or averaging per-share prices by hand. Use when the user asks about specific positions, accounts, asset classes, sectors, foreign or non-USD holdings (currency, non_usd), or portfolio composition.",
    input_schema: {
      type: "object" as const,
      properties: {
        account_name: {
          type: "string",
          description:
            "Optional. An exact account name, or a scope word: 'vanguard' (the Vanguard accounts EXCLUDING the Roth), 'roth', 'ibkr', or 'all'. This tool reads one account at a time: a scope word that names more than one account returns an error listing them. Omit for all accounts.",
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
            "Filter by sector (GICS-11 canonical spelling, e.g., 'Technology', 'Financials', 'Healthcare'). Omit for all sectors.",
        },
        currency: {
          type: "string",
          description:
            "Optional. Only holdings PRICED in this currency: a three-letter ISO code such as 'JPY' or 'EUR', case-insensitive. A code not held in scope returns an error listing the currencies held. Do not combine with non_usd.",
        },
        non_usd: {
          type: "boolean",
          description:
            "Optional. true: only holdings priced in a currency other than USD (foreign-listed stocks and funds). A USD-listed fund of foreign stocks is priced in USD and is not included.",
        },
        sort_by: {
          type: "string",
          enum: ["market_value", "unrealized_gain", "position_weight", "symbol"],
          description: "Sort results. Defaults to market_value descending.",
        },
        limit: {
          type: "integer",
          description:
            "Maximum number of positions to return: an integer, default 50, max 150. The result's list_info says whether more positions matched (truncated).",
        },
      },
    },
  },
  {
    name: "query_price_history",
    description:
      "Get historical price data for a security. Returns { symbol, currency, sampled, rows }: close prices over a date range, in the security's own currency (`currency`, never converted to USD; never put a dollar sign on a non-USD price). At most 260 rows: a range with more than 260 daily closes returns the last close of each week (sampled: 'weekly'), and a range of more than 260 weeks the last close of each month (sampled: 'monthly'); `note` says so. An unknown symbol returns an error. Use for price trend analysis, volatility assessment, drawdown calculation, or performance comparison between securities.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: "Security symbol (e.g., 'AAPL', 'VOO'); case-insensitive.",
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
          description:
            "Optional. An exact account name, or a scope word: 'vanguard' (the Vanguard accounts EXCLUDING the Roth), 'roth', 'ibkr', or 'all'. This tool reads one account at a time: a scope word that names more than one account returns an error listing them. Omit for all accounts.",
        },
        limit: {
          type: "integer",
          description:
            "Maximum groups to return, largest first: an integer, default 50, max 200. list_info says whether more groups matched (percentages are always of the whole total).",
        },
      },
      required: ["group_by"],
    },
  },
  {
    name: "query_tax_lots",
    description:
      "Query tax lot details for open or closed positions. Returns acquisition date, cost basis, current value, unrealized/realized gain/loss, holding period, long-term/short-term status, and projected long-term date. For an open lot cost_basis is the basis of the quantity still open (fees included, the figure unrealized_gain is measured against, so it pairs with current_value); original_lot_cost_basis is the whole lot as acquired and differs only when part of the lot has been closed. Uses FIFO (First-In, First-Out) lot matching — the user's broker may use a different method. Use for tax-loss harvesting analysis, capital gains questions, wash sale evaluation, lot-level drill-down, or identifying lots approaching the 1-year long-term threshold. An open lot with pending_statement=true (stocks, options, long or short) is pending and carries no current_value or unrealized_gain: describe it as pending (see its status_note), never as an unrealized holding or a harvesting candidate. pending_statement_reason says why: 'awaiting_statement' = closed per live broker data, the closing trade awaits the broker statement; 'closing_entry_missing' = the broker statement shows the position closed but the closing trade is not in the ledger, so its realized result is unknown until that entry is imported; 'resymbol_repair_pending' = the option was renamed to a new contract after a split and is still held under the new contract, so never call it closed. An expired option lot (its status_note says so) also carries no current_value or unrealized_gain: it is awaiting its closing entry. figure_kind says what cost_basis is: 'cost_basis' for a long lot, 'short_sale_proceeds' for a short lot (money received when it was sold short, never a cost). Open lots carry position_side ('long' or 'short'): for a short lot quantity_remaining, cost_basis (the opening proceeds) and current_value (the cost to cover) are positive and unrealized_gain is already signed for the short side (a gain when the price has fallen); a short lot is never long-term, closing it means buying to cover, and it must never be described as approaching long-term. A top-level totals block covers EVERY lot matching the filter (not only the rows returned): open_lots.long (count, cost_basis_usd, unrealized_gain_usd, unpriced_count), open_lots.short (count, short_sale_proceeds_usd, unrealized_gain_usd, unpriced_count), pending_lots (count and by_reason only: pending lots carry no value or gain, so never total a figure for them) and, for closed sales, closed_sales (count, realized_gain_usd_at_current_fx, left_out_no_fx_rate). Quote these totals; never add rows by hand, and never add long basis and short proceeds together.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["open", "closed", "all"],
          description: "Filter by lot status. Defaults to 'open'. 'all' returns open lots and closed sales (open first; the limit applies to each).",
        },
        symbol: {
          type: "string",
          description: "Filter by security symbol",
        },
        account_name: {
          type: "string",
          description:
            "Optional. An exact account name, or a scope word: 'vanguard' (the Vanguard accounts EXCLUDING the Roth), 'roth', 'ibkr', or 'all'. This tool reads one account at a time: a scope word that names more than one account returns an error listing them. Omit for all accounts.",
        },
        year: {
          type: "integer",
          description: "For closed sales: filter by calendar year (does not limit open lots)",
        },
        sort_by: {
          type: "string",
          enum: ["unrealized_gain", "acquisition_date", "holding_period_days", "cost_basis"],
          description: "Sort field. Defaults to unrealized_gain (losses first, most useful for harvesting).",
        },
        limit: {
          type: "integer",
          description:
            "Maximum results per list: an integer, default 50, max 150. With status 'all' the limit applies to open lots and to closed sales separately; list_info.open and list_info.closed say whether each was truncated.",
        },
      },
    },
  },
  {
    name: "query_transactions",
    description:
      "Search transaction history with filters. Returns { transactions, ledger_end_by_account, symbol_last_trade_date }: each transaction has trade date, type, symbol, quantity, price, amount, and fees; ledger_end_by_account lists, per account involved, ledger_last_date: the newest trade date in that account's imported ledger, any symbol (ignoring every filter). Each account's ledger ends there: later trades may not be imported yet and may only show in query_holdings (live broker data awaiting the statement), so never claim nothing was traded, or that a position has been flat, after that date without checking query_holdings. With a symbol filter, symbol_last_trade_date is that symbol's newest trade in the ledger: the last imported trade, NOT where the ledger ends. Use for activity analysis, cash flow tracking, dividend history, fee analysis, or trade reconstruction.",
    input_schema: {
      type: "object" as const,
      properties: {
        account_name: {
          type: "string",
          description:
            "Optional. An exact account name, or a scope word: 'vanguard' (the Vanguard accounts EXCLUDING the Roth), 'roth', 'ibkr', or 'all'. This tool reads one account at a time: a scope word that names more than one account returns an error listing them. Omit for all accounts.",
        },
        symbol: {
          type: "string",
          description: "Filter by security symbol",
        },
        type: {
          type: "string",
          // The import validator's list, so the two cannot drift. It never
          // holds the lot engine's own close type (pinned by
          // tests/chat/tools-review-fixes.test.ts).
          enum: [...VALID_TRANSACTION_TYPES],
          description: "Filter by transaction type (upper case).",
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
          description:
            "Maximum transactions to return: an integer, default 50, max 200. list_info says whether more matched.",
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
          description:
            "Optional. An exact account name, or a scope word: 'vanguard' (the Vanguard accounts EXCLUDING the Roth), 'roth', 'ibkr', or 'all'. This tool reads one account at a time: a scope word that names more than one account returns an error listing them. Omit for all accounts.",
        },
        start_date: {
          type: "string",
          description:
            "Start date (YYYY-MM-DD). When given it wins over months. Defaults to the start of the month `months` months ago.",
        },
        end_date: {
          type: "string",
          description: "End date (YYYY-MM-DD). Defaults to today.",
        },
        months: {
          type: "integer",
          description:
            "How many trailing months to return when start_date is omitted: an integer, default 24, max 120.",
        },
      },
    },
  },
  {
    name: "query_income_summary",
    description:
      "Summarize investment income (dividends, interest) and fees over a period. Returns per-symbol, per-account, per-month or per-type breakdowns. A reinvested dividend counts once, including when it was reinvested net of tax withheld: the REINVESTMENT that is the purchase leg of a DIVIDEND (same account, security and trade date) is not added again, and each DIVIDEND pairs with at most one REINVESTMENT. An unpaired positive REINVESTMENT counts as dividend income; an unpaired negative one is not income and is counted in unpaired_reinvestment_count. total_interest is interest EARNED (positive INTEREST rows); interest_paid is interest CHARGED (for example on a margin debit), a cost, never income. Fees include FEE and COMMISSION rows. net_income = dividends + interest earned - interest paid - fees. Use for income analysis, yield calculations, fee drag assessment, dividend tracking by quarter/month, or identifying which securities generate the most income.",
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
          description:
            "Optional. An exact account name, or a scope word: 'vanguard' (the Vanguard accounts EXCLUDING the Roth), 'roth', 'ibkr', or 'all'. This tool reads one account at a time: a scope word that names more than one account returns an error listing them. Omit for all accounts.",
        },
      },
    },
  },
  {
    name: "query_twr",
    description:
      "Compute Time-Weighted Return (TWR) and XIRR for the portfolio or individual accounts over a specified period. A fixed period (1y / 3y / 5y) is the FULL span ending at the last statement, not at today; ytd and inception run to today. The result's `window` gives the exact `start_date` and `end_date` measured: always state them with the figure (for example 'the year to Sep 30'), and never describe a fixed-period figure as running through today when `ends_at_last_statement` is true. TWR uses chain-linked Modified Dietz (measures portfolio manager skill). XIRR uses Newton-Raphson (measures investor's actual experience, accounting for timing of deposits/withdrawals). Returns both metrics, cumulative return, annualized return, and per-account breakdown. In the XIRR result, `totalInvested` is the sum of money the investor put IN during the window (cash deposits and in-kind transfers in); it does not include the opening portfolio value and is not net of withdrawals (those are `totalWithdrawn`). Never present it as the portfolio's cost basis or as a total amount invested over time; the result's `field_notes` repeats this. Account names are matched case-insensitively (e.g., 'roth' matches 'Vanguard Roth IRA'). Use when asked about portfolio performance, returns, how the portfolio has done, YTD/annual returns, investment performance comparison between accounts, or whether the portfolio is beating expectations.",
    input_schema: {
      type: "object" as const,
      properties: {
        period: {
          type: "string",
          enum: ["ytd", "1y", "3y", "5y", "inception"],
          description:
            "Time period for TWR computation. Defaults to 'ytd'. 1y / 3y / 5y end at the last statement.",
        },
        account_name: {
          type: "string",
          description:
            "Optional. An exact account name, or a scope word: 'vanguard' (the Vanguard accounts EXCLUDING the Roth), 'roth', 'ibkr', or 'all'. A scope word that names several accounts gives ONE time-weighted and ONE money-weighted return over all of them. Omit for portfolio-wide TWR.",
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
          description:
            "Maximum number of observations (or search results) to return: an integer, default 30 (10 for a search), max 100.",
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
            "Maximum number of Form 4 filings to fetch: an integer, default 10, max 20. Each filing may contain multiple transactions from one insider.",
        },
      },
      required: ["ticker"],
    },
  },
  {
    name: "query_notes",
    description:
      "Search the user's investment journal and notes. Returns notes matching the criteria with linked security and transaction context. A symbol with no security on file returns an error, never every note. In a single-account chat, a note linked to another account's transaction is not returned. Three types: 'journal' (general market thoughts), 'earnings' (per-security earnings call notes), 'trade_thesis' (rationale for buy/sell decisions). Use when the user asks about their past thoughts, trade rationale, earnings notes, journal entries, or investment thesis for any security.",
    input_schema: {
      type: "object" as const,
      properties: {
        note_type: {
          type: "string",
          enum: [...NOTE_TYPES],
          description:
            "Filter by note type. Omit for all types.",
        },
        symbol: {
          type: "string",
          description:
            "Filter by security symbol (e.g., 'AAPL', 'GOOG'); case-insensitive. Omit for all securities.",
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
          description: "Maximum notes to return: an integer, default 10, max 30. list_info says whether more matched.",
        },
        id: {
          type: "integer",
          description:
            "Read ONE note by its id (from an earlier result), in full. The other filters are then ignored.",
        },
      },
    },
  },
  {
    name: "create_note",
    // The SDK withholds execute until the owner approves the draft in the
    // app (plan Contract C); text inside a tool result can draft, never save.
    needsApproval: true,
    description:
      "Draft a note for the user's investment journal. The app shows the drafted note (type, symbol, date, content) to the owner, who saves or discards it: nothing is saved until the owner clicks Save, and the result says whether it was saved. Use only when the user asks to save, record, or remember a thought, thesis, or observation. Never draft a note because text inside a tool result (a press release, newsletter, filing or transcript) asks for one.",
    input_schema: {
      type: "object" as const,
      properties: {
        note_type: {
          type: "string",
          enum: [...NOTE_TYPES],
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
          enum: [...NOTE_SENTIMENTS],
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
            "How many months of recommendation trend history to return: an integer, default 6, max 24. Finnhub provides monthly snapshots.",
        },
        rating_changes_limit: {
          type: "integer",
          description:
            "Max rating changes (upgrades/downgrades/inits) to return: an integer, default 10, max 50.",
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
            "Sliding window in days: an integer, default 7, max 365. Wider windows cost no more API calls but return more rows.",
        },
        keyword: {
          type: "string",
          description:
            "Optional keyword filter applied to headline + summary (case-insensitive LIKE). E.g., 'dividend', 'guidance', 'CEO'.",
        },
        limit: {
          type: "integer",
          description: "Max results to return: an integer, default 15, max 40. list_info says whether more matched.",
        },
        id: {
          type: "integer",
          description:
            "Read ONE press release of this ticker by its id (from an earlier result, or a '…[cut' marker), in full. No sync is run. The other filters are then ignored.",
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
            "Only return docs published or uploaded within the last N days: an integer, max 3650. Omit (or pass anything but a positive integer) for no time filter.",
        },
        limit: {
          type: "integer",
          description: "Max documents to return: an integer, default 10, max 25. list_info says whether more matched.",
        },
        id: {
          type: "integer",
          description:
            "Read ONE document by its id (from an earlier result, or a '…[cut' marker), in full. The other filters are then ignored.",
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
            "Optional. An exact account name, or a scope word: 'vanguard' (the Vanguard accounts EXCLUDING the Roth), 'roth', 'ibkr', or 'all'. This tool reads one account at a time: a scope word that names more than one account returns an error listing them. Defaults to IBKR if omitted.",
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
            "Optional. An exact account name, or a scope word: 'vanguard' (the Vanguard accounts EXCLUDING the Roth), 'roth', 'ibkr', or 'all'. A scope word that names several accounts covers all of them. Omit for all accounts.",
        },
        underlying: {
          type: "string",
          description:
            "Filter by underlying symbol (e.g., 'AAPL'); case-insensitive. The portfolio totals, coverage counts and strategies then cover that underlying only. Omit for all option positions.",
        },
      },
    },
  },
  {
    name: "query_research_feeds",
    description:
      "Search the user's ingested financial newsletter articles from Gmail. Returns AI-processed summaries, sentiment, mentioned tickers, and portfolio relevance. Sources include Vital Knowledge, TMT Breakouts, Stratechery, The Diff, Eliant Capital, and other subscribed newsletters. A symbol with no security on file, or a source that matches no source name or several, returns an error naming the valid values. In a single-account chat portfolio_relevance is withheld (it was written against the whole portfolio). Use when the user asks about recent market research, newsletter insights, what analysts are saying, sentiment on a particular stock or theme, or what their research feeds have covered recently.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description:
            "Filter by ticker symbol mentioned in articles (e.g., 'AAPL'); case-insensitive. Omit for all articles.",
        },
        source: {
          type: "string",
          description:
            "Filter by newsletter source name (e.g., 'Vital Knowledge', 'Stratechery'): a case-insensitive part of the name that matches exactly one source. Omit for all sources.",
        },
        days_back: {
          type: "integer",
          description:
            "How many days back to search: an integer, default 7, max 365. Use 1 for today's articles, 30 for monthly overview.",
        },
        search: {
          type: "string",
          description:
            "Free-text search across article subjects, summaries, and content. Use for topic-based queries.",
        },
        limit: {
          type: "integer",
          description: "Maximum articles to return: an integer, default 15, max 25. list_info says whether more matched.",
        },
        id: {
          type: "integer",
          description:
            "Read ONE article by its id (from an earlier result, or a '…[cut' marker), in full. The same scope rules apply. The other filters are then ignored.",
        },
      },
    },
  },
  {
    name: "query_calendar_events",
    description:
      "Query upcoming or past market events from the calendar — earnings dates, FOMC meetings, CPI releases, jobs reports, GDP, PMI, retail sales, analyst meetings, and other macro/company events. Use when the user asks about upcoming events, 'what's on the calendar', 'when is the next FOMC/CPI/earnings', or wants to understand what market-moving events are ahead. Every row carries report_state: 'reported' (a result is on file in actual_value), 'reported, figure withheld' (a vendor figure failed the plausibility check: do not quote one), 'pre_release_figure' (a figure was saved ahead of the release window, shown in figure_saved_before_release: NOT a result, never say the company reported it), 'upcoming' (a later date), 'not yet reported' (dated today with no result on file), or 'print date passed, no result on file' (a date before today with no result: the figures were not captured, so neither reported nor not-reported can be asserted); the result carries now_et, the current Eastern date and clock. A company has reported ONLY when its report_state is 'reported', and a 'print date passed' row must not be described as not yet reported either — a pre-open or after-close slot on today's date is a scheduled time, not a result, so never say a print is out or react to it before then.",
    input_schema: {
      type: "object" as const,
      properties: {
        days_ahead: {
          type: "integer",
          description:
            "Number of days forward to look: an integer, default 14, max 365. Use 7 for this week, 30 for this month.",
        },
        days_back: {
          type: "integer",
          description:
            "Number of days backward to look: an integer, default 0, max 365. Use 7 for last week, 30 for last month.",
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
        limit: {
          type: "integer",
          description: "Maximum events to return: an integer, default 50, max 100. list_info says whether more matched.",
        },
        id: {
          type: "integer",
          description:
            "Read ONE event by its id (from an earlier result, or a '…[cut' marker), in full. Any date: the day window does not apply. The other filters are then ignored.",
        },
      },
    },
  },
  {
    name: "query_calendar_briefings",
    description:
      "Retrieve weekly market briefings — AI-generated narrative summaries of each week's key market events, including macro data releases, earnings, and portfolio-relevant developments. Each briefing includes Vital Knowledge market context when available. Use when the user asks 'what happened last week', 'give me a market summary', 'what was the narrative around [date]', or wants historical market context for a specific period. In a single-account chat the briefing text is withheld (it was written against the whole portfolio); titles and dates are returned.",
    input_schema: {
      type: "object" as const,
      properties: {
        week_of: {
          type: "string",
          description:
            "Monday date (YYYY-MM-DD) of the week to retrieve. Omit for most recent briefing.",
        },
        weeks_back: {
          type: "integer",
          description:
            "Number of recent weekly briefings to retrieve: an integer, default 1, max 4 (use 4 for the last month).",
        },
      },
    },
  },
  {
    name: "query_levels",
    description:
      "Query active price levels — support, resistance, entry, exit, stop, and scale-in prices set by the user or extracted from research newsletters. Each level includes its effective price (live-computed MA for EMA/SMA-based levels, or the static price) plus the author, thesis, and timeframe context. `is_active` (1 or 0) says whether the level is armed now; `last_fired_at` / `last_fired_price` record the most recent time it alerted and are history only — a level can be active again after it fired, so never call a level triggered just because `last_fired_at` is set. Prices (price, effective_price) are in the security's own currency, named in each row's `currency`, never converted. A symbol with no security on file returns an error. Use when the user asks 'what levels are closest to triggering?', 'show Eliant's levels', 'what support levels do I have on SPY?', or 'which levels should I watch this week?'.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: "Filter by security symbol (e.g., 'SPY', 'AAPL'); case-insensitive. Omit for all securities.",
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
        limit: {
          type: "integer",
          description: "Maximum levels to return: an integer, default 30, max 60. list_info says whether more matched.",
        },
        id: {
          type: "integer",
          description:
            "Read ONE level by its id (from an earlier result), in full, active or not. The other filters are then ignored.",
        },
      },
    },
  },
  {
    name: "query_alerts",
    description:
      "Query level alerts — events where a price has crossed an armed level. Each alert includes the level's author, thesis, triggered price, Claude's suggested action, and the user's response state. Prices (level_price, triggered_price) are in the security's own currency, named in each row's `currency`, never converted. A symbol with no security on file returns an error. In a single-account chat suggested_action is withheld (it was written against the whole portfolio). Use when the user asks 'what alerts have fired recently?', 'show me pending alerts', 'which Eliant levels have hit?', or 'alerts I ignored last month'.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: "Filter by security symbol; case-insensitive. Omit for all alerts.",
        },
        response: {
          type: "string",
          enum: ["pending", "acted", "ignored", "dismissed"],
          description: "Filter by the user's response state. Omit for all states.",
        },
        since_days: {
          type: "integer",
          description:
            "Only alerts that fired within the last N days (N x 24 hours before now): an integer, default 30, max 365. Use 7 for this week, 90 for this quarter.",
        },
        limit: {
          type: "integer",
          description: "Max alerts to return: an integer, default 20, max 40. list_info says whether more matched.",
        },
        id: {
          type: "integer",
          description:
            "Read ONE alert by its id (from an earlier result), in full, whatever its age. The other filters are then ignored.",
        },
      },
    },
  },
  {
    name: "query_release_reactions",
    description:
      "Look up how the market reacted to past macro releases or earnings. Each row includes the actual value, consensus at release time, and the 2-hour post-release price change for SPY, QQQ, TLT, and (when mapped) the sector ETF. A leg, or a whole reaction, may carry state: \"pending\": it has not been measured yet and no figure should be quoted for it. Use when the user asks 'what did SPY do on the last three hot CPI prints?', 'how does NVDA typically trade after earnings?', or 'show me the last few FOMC reactions'. Pass event_type = 'cpi' / 'fomc' / 'jobs' / 'gdp' for macro, or 'earnings_NVDA' / 'earnings_SPY' for a specific ticker's earnings.",
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
          description: "Max results: an integer, default 10, max 50.",
        },
      },
    },
  },
  {
    name: "query_market_snapshot",
    description:
      "Get the latest market move for the major benchmarks (SPY, QQQ, DIA) AND the user's held names. `pct` is always the security's PRICE move in percent versus the prior close; it is null on a held row whose name has no prior close in the local book (first bought during the session), and such a row still carries its `day_effect`. Held names come back as one row per symbol and side: `position` is 'long' or 'short', and a symbol held long in one account and short in another is TWO rows. Each held row carries `accounts`, signed `quantity`, signed `market_value` (USD) and `day_effect`: the session's dollar gain or loss on that row in USD, already signed for the position (a short LOSES when its price rises, so never call a rising short a winner). `day_effect` follows the Today page's rule: quantity held through the session is measured from the prior close, quantity opened or added during the session is measured from what it cost (`opened_today`, `added_today`, `day_effect_basis`: 'prior_close' | 'cost' | 'mixed' | 'excluded' | 'unpriced'). For dollar movers, biggest winners and losers, or what a move was worth, report the tool's `day_effect` and rank by it. NEVER multiply a percent move by a market value or a quantity yourself: that credits a position bought today with a move it did not earn. When `day_effect` is null, say it was not measured and give `day_effect_reason`; when `day_effect_partial` is true or `day_effect_reason` is set, state that caveat with the figure. Benchmarks and names not held carry the percent move only. Call this WHENEVER the user asks what the market is doing today, how indexes/stocks moved, why something is up or down, or wants a market overview — you have NO other way to observe live or recent market action, so do not answer such questions without calling this tool. Local-first (the last close from the synced book); falls back to a live Yahoo quote when the local book is behind (the fallback gives percent moves only, no dollar day effect). The result carries an `asOf` date, a `stale` flag, a `source` ('local' | 'yahoo' | 'none'), and a `note` describing freshness. ALWAYS relay the `asOf`/freshness to the user, NEVER state moves more current than `asOf`, and if `source` is 'none' tell the user current data is unavailable rather than estimating.",
    input_schema: {
      type: "object" as const,
      properties: {
        account_name: {
          type: "string",
          description:
            "Optional. An exact account name, or a scope word: 'vanguard' (the Vanguard accounts EXCLUDING the Roth), 'roth', 'ibkr', or 'all'. This tool reads one account at a time: a scope word that names more than one account returns an error listing them. Shows held names for that account only. Omit for every account. Benchmarks are always included.",
        },
        limit: {
          type: "integer",
          description:
            "Maximum held rows to return, largest absolute day_effect first: an integer, default 40, max 100. Benchmarks are always returned, and held_totals (the day_effect total and row counts) always covers EVERY held row, not only the rows returned. list_info says whether held rows were left out.",
        },
      },
      additionalProperties: false,
    },
  },
];

/**
 * Every chat tool, in a FIXED order: the base tools, then the six composite
 * read tools (plan Task 8). The route puts the prompt-cache mark on the LAST
 * tool by position, so this order is built once at module load and never
 * changes between requests. Every tool carries the compact model-facing
 * output (Contract H): the client still receives the full result.
 */
export const CHAT_TOOLS: ChatTool[] = [
  ...BASE_CHAT_TOOLS,
  ...(COMPOSITE_CHAT_TOOLS as ChatTool[]),
].map((t) => ({ ...t, toModelOutput: compactToolModelOutput(t.name) }));

// ─── Account Name Resolution ─────────────────────────────────────

/**
 * Resolve an account name or hint to the exact DB account name, for callers
 * that need ONE account (the scoped chat's clamp and context).
 *
 * Follows `resolveChatAccounts`: an exact name, a scope word ("vanguard"
 * excludes the Roth), or a fragment that matches exactly one account. It
 * never takes the first of several matches. A name that is ambiguous,
 * unknown, or a scope of two or more accounts comes back unchanged: it then
 * matches no account downstream, and a chat tool handed it answers with the
 * error that lists the valid names.
 */
export function resolveAccountName(
  db: Database.Database,
  input: string | undefined
): string | undefined {
  if (!input) return undefined;
  const resolved = resolveChatAccounts(db, input);
  if (resolved.kind === "all") return undefined;
  if (resolved.kind === "accounts" && resolved.accounts.length === 1) {
    return resolved.accounts[0].name;
  }
  return input;
}

/** Every tool whose schema declares `account_name`. */
const ACCOUNT_TOOL_NAMES: ReadonlySet<string> = new Set(
  CHAT_TOOLS.filter(
    (t) => (t.input_schema.properties as Record<string, unknown> | undefined)?.account_name
  ).map((t) => t.name)
);

/**
 * The account-taking tools whose engines accept an id LIST, so a scope of
 * several accounts is answered whole. Every other account-taking tool reads
 * one account by name and refuses a wider scope rather than pick one.
 */
const SCOPE_LIST_TOOLS: ReadonlySet<string> = new Set([
  "query_twr",
  "query_options_greeks",
  ...COMPOSITE_SCOPE_LIST_TOOLS,
]);

// ─── Tool Dispatcher ──────────────────────────────────────────────

/**
 * Execute a chat tool by name with the given input parameters.
 * Returns the query result wrapped with data quality annotations.
 * On error, returns { error: "..." } instead of throwing.
 */
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Default and maximum for each list tool's `limit` (plan Contract G and the
 * R4 caps). The maxima are enforced here, whatever the model asks for, and
 * each tool's description states both figures.
 */
const LIST_LIMITS = {
  query_holdings: { def: 50, max: 150 },
  query_tax_lots: { def: 50, max: 150 },
  query_transactions: { def: 50, max: 200 },
  query_calendar_events: { def: 50, max: 100 },
  query_research_feeds: { def: 15, max: 25 },
  // Lowered in Task 8 (R4): each row carries long text, and no question
  // needs more rows than this; list_info says when more matched.
  query_levels: { def: 30, max: 60 },
  query_alerts: { def: 20, max: 40 },
  query_notes: { def: 10, max: 30 },
  query_allocation: { def: 50, max: 200 },
  query_research_documents: { def: 10, max: 25 },
  query_press_releases: { def: 15, max: 40 },
  query_market_snapshot: { def: 40, max: 100 },
} as const;

/** query_price_history's row cap (sampling keeps it, see samplePriceRows). */
const PRICE_HISTORY_MAX_ROWS = 260;
/** query_alerts reads this many newest alerts before its time window. */
const ALERT_WINDOW_FETCH = 500;
/** A single-account chat's notes are filtered after the read; read this many. */
const SCOPED_NOTES_FETCH = 500;

/**
 * A model-supplied count: an integer from 1 up. Anything else (missing, zero,
 * negative, fractional, a string) is the default; above `max` is `max`.
 */
function readCount(raw: unknown, def: number, max: number, min = 1): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min) return def;
  return Math.min(raw, max);
}

/**
 * Counts and day windows: a bad value takes the default (readCount), never an
 * error, so the model's answer is not blocked on a count (Contract G).
 */
const LENIENT_COUNT_PARAMS: ReadonlySet<string> = new Set([
  "limit",
  "days_back",
  "days_ahead",
  "weeks_back",
  "since_days",
  "months_history",
  "rating_changes_limit",
]);

type SchemaProp = { type?: string; items?: { type?: string } };

/**
 * Check the model's input against the tool's declared types before any
 * engine sees it (review R5-8): a wrong type is an error that names the
 * parameter and what it must be, never a raw JavaScript or SQLite message.
 * A null is read as omitted. Enum values are left to each tool (several
 * coerce an unknown value to "no filter" on purpose).
 */
function validateToolInput(
  tool: ChatTool,
  input: Record<string, unknown>,
): { input: Record<string, unknown> } | { error: string } {
  const props = (tool.input_schema.properties ?? {}) as Record<string, SchemaProp>;
  const required = (tool.input_schema.required ?? []) as string[];
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (v !== null && v !== undefined) clean[k] = v;
  }
  for (const name of required) {
    const v = clean[name];
    if (v === undefined || (typeof v === "string" && v.trim() === "")) {
      const type = props[name]?.type === "string" ? "a string" : `a ${props[name]?.type ?? "value"}`;
      return { error: `Parameter "${name}" is required (${type}). Nothing was run.` };
    }
  }
  for (const [name, v] of Object.entries(clean)) {
    const prop = props[name];
    if (!prop) continue;
    const bad = (expected: string) => ({
      error: `Parameter "${name}" must be ${expected}; got ${Array.isArray(v) ? "a list" : typeof v}. Nothing was run.`,
    });
    switch (prop.type) {
      case "string":
        if (typeof v !== "string") return bad("a string");
        break;
      case "boolean":
        if (typeof v !== "boolean") return bad("true or false");
        break;
      case "integer":
      case "number":
        if (LENIENT_COUNT_PARAMS.has(name)) break;
        if (typeof v !== "number" || !Number.isInteger(v)) return bad("an integer");
        break;
      case "array":
        if (!Array.isArray(v) || (prop.items?.type === "string" && v.some((x) => typeof x !== "string"))) {
          return bad("a list of strings");
        }
        break;
    }
  }
  return { input: clean };
}

const TOOLS_BY_NAME: ReadonlyMap<string, ChatTool> = new Map(CHAT_TOOLS.map((t) => [t.name, t]));

/** A real calendar date in YYYY-MM-DD. */
function isRealDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T12:00:00Z`);
  return !isNaN(t.getTime()) && addDays(d, 0) === d && t.getUTCDate() === Number(d.slice(8, 10));
}

export interface ListInfo {
  returned: number;
  limit: number;
  truncated: boolean;
  note?: string;
}

/**
 * Cut a list fetched with `limit + 1` rows to `limit` and say whether the
 * extra row existed (plan P7: no second count query to keep in step).
 * `forceTruncated` marks a list whose read itself hit a fetch cap.
 */
function takeList<T>(rows: T[], limit: number, max: number, forceTruncated = false): { rows: T[]; info: ListInfo } {
  const truncated = forceTruncated || rows.length > limit;
  const kept = rows.length > limit ? rows.slice(0, limit) : rows;
  return {
    rows: kept,
    info: truncated
      ? {
          returned: kept.length,
          limit,
          truncated: true,
          note: `More rows match. Narrow the filter or raise limit (max ${max}).`,
        }
      : { returned: kept.length, limit, truncated: false },
  };
}

/** A stored JSON list column read tolerantly: a bad or non-list value is []. */
function parseJsonList(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

interface SecurityRef {
  id: number;
  symbol: string;
  currency: string | null;
}

/** A security by symbol, case-insensitive (an exact-case row wins a tie). */
function findSecurity(db: Database.Database, symbol: string): SecurityRef | null {
  const row = db
    .prepare(
      `SELECT id, symbol, currency FROM securities
       WHERE UPPER(symbol) = UPPER(?)
       ORDER BY (symbol = ?) DESC, id ASC LIMIT 1`,
    )
    .get(symbol, symbol) as SecurityRef | undefined;
  return row ?? null;
}

function noSecurityError(symbol: string): { error: string } {
  return { error: `No security '${symbol}' on file. Nothing was filtered or returned.` };
}

/** Said beside a whole-book field withheld from a single-account chat (OPEN-7). */
const WHOLE_BOOK_FIELD_NOTE =
  "was written against the whole portfolio and cannot be limited to this chat's account, so it is withheld here. Ask in the All Accounts scope to see it.";

/**
 * In a single-account chat (`scopeAccountIds` set), a note linked to another
 * account's transaction is withheld (plan P9). Unlinked notes are the
 * owner's journal, not account data, and are kept.
 */
function notesInScope(
  db: Database.Database,
  notes: NoteWithContext[],
  scopeAccountIds: number[] | undefined,
): NoteWithContext[] {
  if (scopeAccountIds === undefined) return notes;
  const inScope = new Set(scopeAccountIds);
  const accountOf = db.prepare("SELECT account_id FROM transactions WHERE id = ?");
  return notes.filter((n) => {
    if (n.transaction_id == null) return true;
    const row = accountOf.get(n.transaction_id) as { account_id: number } | undefined;
    return row != null && inScope.has(row.account_id);
  });
}

/** The Monday (YYYY-MM-DD) of a date's week. */
function weekStart(date: string): string {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

/**
 * Keep a price series at or under PRICE_HISTORY_MAX_ROWS: daily if it fits,
 * else the range's FIRST stored close followed by the last close of each
 * week, else the first close followed by the last close of each month; a
 * monthly series still too long keeps the first close and the newest months.
 * The last stored close is always kept (it ends the last bucket). Every kept
 * row is a real stored close, never an average.
 */
function samplePriceRows<T extends { date: string }>(
  rows: T[],
): { rows: T[]; sampled: "daily" | "weekly" | "monthly"; note?: string } {
  if (rows.length <= PRICE_HISTORY_MAX_ROWS) return { rows, sampled: "daily" };
  const first = rows[0];
  const firstPlusLastPer = (key: (d: string) => string): T[] => {
    const byKey = new Map<string, T>();
    for (const r of rows) byKey.set(key(r.date), r);
    const lasts = [...byKey.values()];
    return lasts[0] === first ? lasts : [first, ...lasts];
  };
  const warning =
    "Rows are sampled, not daily: do not compute daily statistics (volatility, drawdown, daily returns) from them; narrow the dates for daily closes.";
  const weekly = firstPlusLastPer(weekStart);
  if (weekly.length <= PRICE_HISTORY_MAX_ROWS) {
    return {
      rows: weekly,
      sampled: "weekly",
      note: `${rows.length} daily closes in range; returned the first close (${first.date}) and then the last close of each week (${weekly.length} rows). ${warning}`,
    };
  }
  let monthly = firstPlusLastPer((d) => d.slice(0, 7));
  let note = `${rows.length} daily closes in range; returned the first close (${first.date}) and then the last close of each month (${monthly.length} rows). ${warning}`;
  if (monthly.length > PRICE_HISTORY_MAX_ROWS) {
    const newest = monthly.slice(-(PRICE_HISTORY_MAX_ROWS - 1));
    monthly = [first, ...newest];
    note = `${rows.length} daily closes in range; returned the first close (${first.date}) and then the last close of each of the newest ${newest.length} months, from ${newest[0].date}; months between are left out. ${warning}`;
  }
  return { rows: monthly, sampled: "monthly", note };
}

const CANCELLED = { error: "Cancelled." } as const;

/** A tool's own refusal: an object whose only meaning is its `error`. */
function isErrorResult(v: unknown): v is { error: string } {
  return v != null && typeof v === "object" && !Array.isArray(v) && typeof (v as { error?: unknown }).error === "string";
}

export interface ExecuteToolOptions {
  /** The tool call's abort signal (Stop or a disconnect). */
  abortSignal?: AbortSignal;
  /**
   * In a single-account chat, the scope's account ids. Tools without an
   * `account_name` use it to withhold other accounts' private data (plan P9).
   * Undefined: the All Accounts chat.
   */
  scopeAccountIds?: number[];
}

export async function executeTool(
  db: Database.Database,
  toolName: string,
  input: Record<string, unknown>,
  opts?: ExecuteToolOptions
): Promise<unknown> {
  // Stop pressed before the call started: start nothing. Checked again
  // before each external call below (threading the signal into the fetches
  // themselves is follow-up F8).
  const cancelled = (): boolean => opts?.abortSignal?.aborted === true;
  if (cancelled()) return CANCELLED;
  const scopeAccountIds = opts?.scopeAccountIds;
  const singleAccountChat = scopeAccountIds !== undefined;
  const toolDef = TOOLS_BY_NAME.get(toolName);
  if (toolDef) {
    const checked = validateToolInput(toolDef, input);
    if ("error" in checked) return checked;
    input = checked.input;
  }
  try {
    // The model-supplied account_name, resolved ONCE for every tool that
    // declares one: an exact name, a scope word, or a fragment naming exactly
    // one account. Ambiguous or unknown is a plain error so the model asks
    // or retries; it never gets the first match or the whole book.
    // (query_trade_reviews has always defaulted to the IBKR account.)
    const takesAccount = ACCOUNT_TOOL_NAMES.has(toolName);
    const requestedAccount =
      asString(input.account_name) || (toolName === "query_trade_reviews" ? "IBKR" : undefined);
    const accountScope: ChatAccountResolution = takesAccount
      ? resolveChatAccounts(db, requestedAccount)
      : { kind: "all" };
    if (accountScope.kind === "error") return { error: accountScope.error };
    let scopeAccounts: Array<{ id: number; name: string }> | undefined =
      accountScope.kind === "accounts" ? accountScope.accounts : undefined;
    // Second line of the hard scope boundary (the route's clamp is the
    // first): in a single-account chat an account tool never reads past the
    // chat's own accounts, whatever account_name says.
    if (takesAccount && scopeAccountIds !== undefined) {
      if (scopeAccountIds.length === 0) return { error: "No account is in this chat's scope." };
      const inScope = new Set(scopeAccountIds);
      if (scopeAccounts === undefined) {
        scopeAccounts = getAllAccounts(db)
          .filter((a) => inScope.has(a.id))
          .map((a) => ({ id: a.id, name: a.name }));
      } else if (scopeAccounts.some((a) => !inScope.has(a.id))) {
        return {
          error: `"${requestedAccount}" is outside this chat's scope. Ask in the All Accounts scope to read another account.`,
        };
      }
    }
    if (scopeAccounts && scopeAccounts.length > 1 && !SCOPE_LIST_TOOLS.has(toolName)) {
      const names = scopeAccounts.map((a) => `"${a.name}"`).join(", ");
      // What leaving the name out does. For every tool but one it reads every
      // account. query_trade_reviews instead falls to its default account, so
      // it gets its own sentence, and only when that default really is one
      // account (otherwise the advice would loop back to this refusal).
      let omitAdvice = ", or omit account_name for every account";
      if (toolName === "query_trade_reviews") {
        const fallback = resolveChatAccounts(db, "IBKR");
        omitAdvice =
          fallback.kind === "accounts" && fallback.accounts.length === 1
            ? `, or omit account_name for the ${fallback.accounts[0].name} account`
            : "";
      }
      return {
        error: `"${requestedAccount}" names ${scopeAccounts.length} accounts (${names}) and this tool reads one account at a time. Call it once per account with the exact account name${omitAdvice}.`,
      };
    }
    /** Undefined = every account. */
    const accountIds = scopeAccounts?.map((a) => a.id);
    /** The one account's exact name, for the tools that read a single account. */
    const accountName = scopeAccounts?.length === 1 ? scopeAccounts[0].name : undefined;

    let rawResult: unknown;
    /** Contract G: set by the list tools, returned beside `data`. */
    let listInfo: ListInfo | { open?: ListInfo; closed?: ListInfo } | undefined;
    /** Top-level blocks beside `data` (tax lot totals, holdings by_symbol). */
    const extras: Record<string, unknown> = {};

    switch (toolName) {
      case "query_holdings": {
        // Stays an ARRAY: annotateToolResult only inspects holdings when the
        // raw result is one. Each row names its side so the sign of quantity
        // and market_value is never left to inference.
        const { def, max } = LIST_LIMITS.query_holdings;
        const holdingsLimit = readCount(input.limit, def, max);
        // Currency filter: a validated ISO code, or every non-USD holding.
        const currencyAsked = asString(input.currency)?.trim();
        if (currencyAsked !== undefined && input.non_usd === true) {
          return { error: 'Pass currency or non_usd, not both. Nothing was run.' };
        }
        if (currencyAsked !== undefined) {
          if (!/^[A-Za-z]{3}$/.test(currencyAsked)) {
            return { error: `Parameter "currency" must be a three-letter ISO code such as JPY; got "${currencyAsked}". Nothing was run.` };
          }
          const held = [
            ...new Set(
              getHoldingsForChat(db, { account_name: accountName, includeShorts: true, noLimit: true }).map((h) =>
                (h.currency ?? "USD").toUpperCase()
              )
            ),
          ].sort();
          if (!held.includes(currencyAsked.toUpperCase())) {
            return {
              error: `No holdings priced in ${currencyAsked.toUpperCase()} in this scope. Currencies held: ${held.join(", ") || "none"}.`,
            };
          }
        }
        const fetched = getHoldingsForChat(db, {
          currency: currencyAsked,
          non_usd: input.non_usd === true,
          account_name: accountName,
          symbol: input.symbol as string | undefined,
          security_type: input.security_type as string | undefined,
          sector: input.sector as string | undefined,
          sort_by: input.sort_by as "market_value" | "unrealized_gain" | "position_weight" | "symbol" | undefined,
          limit: holdingsLimit + 1,
          // Shorts are holdings. Without this the tool returned the long book
          // only and the model never saw a short position. Quantities and
          // values come back SIGNED (negative = short) — the tool description
          // says so.
          includeShorts: true,
        });
        const cut = takeList(fetched, holdingsLimit, max);
        listInfo = cut.info;
        const holdingRows = cut.rows.map((h) => ({
          ...h,
          position_side: h.quantity < 0 ? ("short" as const) : ("long" as const),
        }));
        rawResult = holdingRows;
        // Per-security sums from the security page's own reader and totals,
        // for every security on the returned rows held in 2+ positions.
        const bySymbol = getHoldingsBySymbolForChat(
          db,
          holdingRows.map((h) => h.symbol),
          accountIds,
        );
        if (bySymbol.length > 0) extras.by_symbol = bySymbol;
        // A symbol may also have been held until recently in an account
        // where it is now closed per live broker data, awaiting the
        // statement, whether or not another account still holds it. Only
        // then does the result become an object; the held rows are still
        // annotated (see the annotation step below).
        const symbolFilter = input.symbol as string | undefined;
        if (symbolFilter) {
          const closed = getClosedPerLiveDataForChat(db, { account_name: accountName, symbol: symbolFilter });
          if (closed.length > 0) rawResult = { holdings: holdingRows, closed_per_live_data: closed };
        }
        break;
      }

      case "query_price_history": {
        const asked = asString(input.symbol) ?? "";
        const sec = findSecurity(db, asked);
        if (!sec) return noSecurityError(asked);
        const sampled = samplePriceRows(
          getPriceHistory(
            db,
            sec.symbol,
            input.start_date as string | undefined,
            input.end_date as string | undefined
          )
        );
        // Closes are the security's NATIVE currency, named once and never
        // converted (QA-4).
        rawResult = {
          symbol: sec.symbol,
          currency: sec.currency ?? "USD",
          sampled: sampled.sampled,
          rows: sampled.rows,
          ...(sampled.note ? { note: sampled.note } : {}),
        };
        break;
      }

      case "query_allocation": {
        // Groups come largest first; percentages are of the whole total, so
        // a cut list never re-bases them.
        const { def, max } = LIST_LIMITS.query_allocation;
        const allocLimit = readCount(input.limit, def, max);
        const allocCut = takeList(getAllocationBreakdown(db, input.group_by as string, accountName), allocLimit, max);
        listInfo = allocCut.info;
        rawResult = allocCut.rows;
        break;
      }

      case "query_tax_lots": {
        // Open lots and closed sales are two lists, each with its own limit
        // and its own list_info (Contract G). "all" is open first, then closed.
        const { def, max } = LIST_LIMITS.query_tax_lots;
        const lotLimit = readCount(input.limit, def, max);
        const status = input.status === "closed" || input.status === "all" ? input.status : "open";
        const readLots = (which: "open" | "closed") =>
          takeList(
            getTaxLotsForChat(db, {
              status: which,
              symbol: input.symbol as string | undefined,
              account_name: accountName,
              year: input.year as number | undefined,
              sort_by: input.sort_by as "unrealized_gain" | "acquisition_date" | "holding_period_days" | "cost_basis" | undefined,
              limit: lotLimit + 1,
            }),
            lotLimit,
            max
          );
        const open = status === "closed" ? null : readLots("open");
        const closed = status === "open" ? null : readLots("closed");
        rawResult = [...(open?.rows ?? []), ...(closed?.rows ?? [])];
        listInfo = {
          ...(open ? { open: open.info } : {}),
          ...(closed ? { closed: closed.info } : {}),
        };
        // Totals over every matching lot, from the same reader with no limit.
        extras.totals = getTaxLotTotalsForChat(db, {
          status,
          symbol: input.symbol as string | undefined,
          account_name: accountName,
          year: input.year as number | undefined,
        });
        break;
      }

      case "query_transactions": {
        // ledger_end_by_account says where each account's imported ledger
        // ends (any symbol), so a gap after it is never read as "nothing
        // traded". A symbol's own last trade is a different, earlier date
        // and is named as such (review of d0a8321a).
        const { def, max } = LIST_LIMITS.query_transactions;
        const txLimit = readCount(input.limit, def, max);
        const txCut = takeList(
          getTransactionsForChat(db, {
            account_name: accountName,
            symbol: input.symbol as string | undefined,
            type: input.type as string | undefined,
            start_date: input.start_date as string | undefined,
            end_date: input.end_date as string | undefined,
            limit: txLimit + 1,
          }),
          txLimit,
          max
        );
        listInfo = txCut.info;
        rawResult = {
          transactions: txCut.rows,
          ledger_end_by_account: getLedgerEndByAccountForChat(db, {
            accountIds,
            symbol: input.symbol as string | undefined,
          }),
          ledger_gap_notes: getReconcileGapNotesForChat(db, {
            account_name: accountName,
            symbol: input.symbol as string | undefined,
            start_date: input.start_date as string | undefined,
            end_date: input.end_date as string | undefined,
          }),
          ...(input.symbol
            ? {
                symbol_last_trade_date: getLedgerLastDateForChat(db, {
                  account_name: accountName,
                  symbol: input.symbol as string,
                }),
              }
            : {}),
        };
        break;
      }

      case "query_performance": {
        // Trailing 24 months unless the model asks for more (max 120) or
        // names a start date: ten years of monthly rows per account is more
        // than any question needs at once.
        let perfStart = asString(input.start_date);
        if (!perfStart) {
          const months = readCount(input.months, 24, 120);
          const [y, m] = todayET().split("-").map(Number);
          // The first of the month `months` months before this Eastern month.
          const first = new Date(Date.UTC(y, m - 1 - months, 1));
          perfStart = `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, "0")}-01`;
        }
        rawResult = getPerformanceForChat(db, {
          account_name: accountName,
          start_date: perfStart,
          end_date: input.end_date as string | undefined,
        });
        break;
      }

      case "query_income_summary":
        rawResult = getIncomeSummaryForChat(db, {
          period: input.period as "ytd" | "trailing_12m" | "last_year" | "all_time" | undefined,
          group_by: input.group_by as "symbol" | "account" | "month" | "type" | undefined,
          account_name: accountName,
        });
        break;

      case "query_twr": {
        // Owner ruling 2026-10-08: ONE window rule, shared with the
        // Performance view (lib/compute/performance-window.ts). A fixed period
        // is the full span ending at the scope's last statement anchor; YTD
        // and inception run to today. Today is the Eastern day.
        const today = todayET();
        const requested = typeof input.period === "string" ? input.period : "ytd";
        const period: PerformancePeriod =
          requested === "ytd" || requested === "1y" || requested === "3y" || requested === "5y"
            ? requested
            : "all";

        // One scope for the whole answer: the window anchor, the
        // time-weighted return and the money-weighted return all read the
        // same account id list (a one-id list is that account, exactly as a
        // single id was; undefined is every account).
        const perfWindow = resolvePerformanceWindow(period, {
          today,
          lastStatementAnchor: latestStatementAnchor(db, accountIds, today),
        });
        // Exactly as the Performance view calls the engines: the chain starts
        // the day after the opening anchor, and the end is bounded only for a
        // statement-anchored period.
        const startDate = perfWindow.chainStartDate;
        const endDate = perfWindow.endsAtStatement ? perfWindow.endDate : undefined;

        const twrResult = computeTwr(db, { startDate, endDate, accountIds });
        const xirrResult = computeXirr(db, { startDate, endDate, accountIds });

        rawResult = {
          window: {
            period: period === "all" ? "inception" : period,
            start_date: perfWindow.startDate ?? null,
            end_date: perfWindow.endDate,
            ends_at_last_statement: perfWindow.endsAtStatement,
            note: perfWindow.endsAtStatement
              ? `Full ${period.toUpperCase()} span from ${perfWindow.startDate} to ${perfWindow.endDate}, the last statement. Activity after ${perfWindow.endDate} is not in this figure.`
              : period === "all"
                ? `Since inception, to ${perfWindow.endDate} (today). The return chain itself ends at the latest statement on record (see each result's endDate).`
                : period === "ytd"
                  ? `Year to date: ${perfWindow.startDate} to ${perfWindow.endDate} (today). The return chain itself ends at the latest statement on record (see each result's endDate).`
                  : `No statement on record for this scope, so the period rolls with today: ${perfWindow.startDate} to ${perfWindow.endDate}.`,
          },
          twr: twrResult,
          xirr: xirrResult,
          field_notes: {
            totalInvested:
              "Total deposits: the money the investor added during this window (cash deposits and in-kind transfers in). It is not the portfolio's opening value, not its cost basis, and not net of withdrawals (see totalWithdrawn).",
          },
        };
        break;
      }

      case "query_fred": {
        // This is async — return a promise
        const seriesId = input.series_id as string | undefined;
        const searchQuery = input.search_query as string | undefined;
        const defaultStart = addDays(todayET(), -365);

        if (seriesId) {
          if (cancelled()) return CANCELLED;
          rawResult = await getSeriesData(seriesId, {
            startDate: (input.start_date as string) || defaultStart,
            endDate: (input.end_date as string) || undefined,
            limit: readCount(input.limit, 30, 100),
            sort: "desc",
          });
        } else if (searchQuery) {
          if (cancelled()) return CANCELLED;
          rawResult = await searchSeries(searchQuery, { limit: readCount(input.limit, 10, 100) });
        } else {
          return { error: "Provide either series_id or search_query" };
        }
        break;
      }

      case "query_company_fundamentals": {
        const ticker = input.ticker as string;
        const includeFilings = input.include_filings as boolean | undefined;
        const annualOnly = input.annual_only as boolean | undefined;

        if (cancelled()) return CANCELLED;
        const financials = await getCompanyFinancials(ticker, {
          annualOnly: annualOnly || false,
          limit: 8,
        });

        if (includeFilings) {
          if (cancelled()) return CANCELLED;
          const filings = await getRecentFilings(ticker, { limit: 5 });
          rawResult = { ...financials, recentFilings: filings };
        } else {
          rawResult = financials;
        }
        break;
      }

      case "query_insider_trades": {
        const ticker = input.ticker as string;
        if (cancelled()) return CANCELLED;
        rawResult = await getInsiderTransactions(ticker, {
          limit: readCount(input.limit, 10, 20),
          transactionType:
            (input.transaction_type as "buy" | "sell" | "all") || "all",
        });
        break;
      }

      case "query_notes": {
        if (typeof input.id === "number") {
          // One note in full. The scope rule still applies (P9).
          const one = getNoteById(db, input.id);
          const kept = one ? notesInScope(db, [one], scopeAccountIds) : [];
          if (kept.length === 0) return { error: `No note with id ${input.id} in this chat's scope.` };
          rawResult = kept;
          break;
        }
        let securityId: number | undefined;
        const noteSymbol = asString(input.symbol);
        if (noteSymbol) {
          const sec = findSecurity(db, noteSymbol);
          if (!sec) return noSecurityError(noteSymbol);
          securityId = sec.id;
        }
        const { def, max } = LIST_LIMITS.query_notes;
        const noteLimit = readCount(input.limit, def, max);
        // A single-account chat filters after the read (P9), so it reads a
        // wider window; a read that fills that window counts as truncated.
        const fetchCount = singleAccountChat ? SCOPED_NOTES_FETCH : noteLimit + 1;
        const fetchedNotes = getNotesFiltered(db, {
          note_type: coerceNoteType(asString(input.note_type)),
          security_id: securityId,
          search: input.search as string | undefined,
          start_date: input.start_date as string | undefined,
          end_date: input.end_date as string | undefined,
          limit: fetchCount,
        });
        const noteCut = takeList(
          notesInScope(db, fetchedNotes, scopeAccountIds),
          noteLimit,
          max,
          singleAccountChat && fetchedNotes.length >= SCOPED_NOTES_FETCH
        );
        listInfo = noteCut.info;
        rawResult = noteCut.rows;
        break;
      }

      case "create_note": {
        const today = todayET();
        // Every refusal is a top-level error: no `data`, and so no "Note
        // saved" annotation beside it (review R5-3).
        const noteType = coerceNoteType(asString(input.note_type));
        if (!noteType) {
          return { error: `Unknown note type. Nothing was saved. Use one of: ${NOTE_TYPES.join(", ")}.` };
        }
        const rawSentiment = asString(input.sentiment);
        const sentiment = coerceNoteSentiment(rawSentiment);
        if (rawSentiment && !sentiment) {
          return {
            error: `Unknown sentiment. Nothing was saved. Use one of: ${NOTE_SENTIMENTS.join(", ")}, or leave it out.`,
          };
        }
        const content = asString(input.content)?.trim() ?? "";
        if (!content) return { error: 'Parameter "content" must be non-empty text. Nothing was saved.' };
        const eventDate = asString(input.event_date) ?? today;
        if (!isRealDate(eventDate)) {
          return { error: `Parameter "event_date" must be a real date in YYYY-MM-DD form; got "${eventDate}". Nothing was saved.` };
        }
        const tags = Array.isArray(input.tags) && input.tags.length > 0 ? (input.tags as string[]) : null;
        // The symbol resolves like every other tool's (any case); a symbol
        // with no security on file is refused, never saved unlinked (R5-2).
        let securityId: number | null = null;
        const noteSymbol = asString(input.symbol);
        if (noteSymbol) {
          const sec = findSecurity(db, noteSymbol);
          if (!sec) return { error: `No security '${noteSymbol}' on file. Nothing was saved.` };
          securityId = sec.id;
        }
        // Same refusal as POST /api/notes: the Earnings tab files notes under
        // per-security headers, so one with no security would be shown nowhere.
        if (noteType === "earnings" && !securityId) {
          return {
            error:
              "An earnings note needs a security. Nothing was saved. Pass the symbol of a security on file, then save.",
          };
        }
        const tagsJson = tags ? JSON.stringify(tags) : null;
        // Replay guard (plan P11): an approval continuation re-sent after a
        // lost response would run this again. An identical note (type,
        // security, event date, content, tags, sentiment) created in the last
        // 10 minutes is
        // returned instead of saved twice. Elapsed time is read on the UTC
        // clock from the stored instant, in JS (both stored forms parse).
        const recent = db
          .prepare(
            `SELECT id, created_at FROM notes
             WHERE note_type = ? AND security_id IS ? AND event_date = ? AND content = ?
               AND tags IS ? AND sentiment IS ?
             ORDER BY id DESC LIMIT 5`
          )
          .all(noteType, securityId, eventDate, content, tagsJson, sentiment ?? null) as Array<{ id: number; created_at: string }>;
        const replayCutoff = Date.now() - 10 * 60 * 1000;
        const replay = recent.find((r) => {
          const at = parseDbTimestamp(r.created_at);
          return at != null && at.getTime() >= replayCutoff;
        });
        if (replay) {
          const existing = db.prepare("SELECT * FROM notes WHERE id = ?").get(replay.id);
          rawResult = { saved: true, note: existing, duplicate_of_existing: true };
          break;
        }
        const note = createNote(db, {
          note_type: noteType,
          content,
          security_id: securityId,
          event_date: eventDate,
          sentiment: sentiment ?? null,
          tags,
        });
        rawResult = { saved: true, note };
        break;
      }

      case "query_filing_section": {
        const ticker = input.ticker as string;
        const filingType = input.filing_type as "10-K" | "10-Q";
        const section = input.section as "risk_factors" | "mda";
        if (cancelled()) return CANCELLED;
        rawResult = await getFilingSection(db, {
          symbol: ticker,
          filing_type: filingType,
          section,
        });
        break;
      }

      case "query_research_documents": {
        const { def, max } = LIST_LIMITS.query_research_documents;
        const docLimit = readCount(input.limit, def, max);
        let docById: ReturnType<typeof searchResearchDocuments> | null = null;
        if (typeof input.id === "number") {
          const one = getResearchDocument(db, input.id);
          if (!one) return { error: `No research document with id ${input.id}.` };
          docById = [{ ...one, snippet: null } as unknown as ReturnType<typeof searchResearchDocuments>[number]];
        }
        const docCut = takeList(
          docById ?? searchResearchDocuments(db, {
            query: input.query as string | undefined,
            symbol: input.symbol as string | undefined,
            document_type: input.document_type as ResearchDocumentType | undefined,
            tag: input.tag as string | undefined,
            days_back:
              typeof input.days_back === "number" && Number.isInteger(input.days_back) && input.days_back >= 1
                ? Math.min(input.days_back, 3650)
                : undefined,
            limit: docLimit + 1,
          }),
          docLimit,
          max
        );
        listInfo = docCut.info;
        const results = docCut.rows;
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
            // One mangled column empties that field on that row only (B26).
            mentioned_symbols: parseJsonList(r.mentioned_symbols),
            tags: parseJsonList(r.tags),
            key_points: parseJsonList(r.key_points),
            summary: r.summary,
            snippet: r.snippet,
            uploaded_at: r.uploaded_at,
          })),
        };
        break;
      }

      case "query_analyst_coverage": {
        const ticker = (input.ticker as string).toUpperCase();
        const monthsHistory = readCount(input.months_history, 6, 24);
        const rcLimit = readCount(input.rating_changes_limit, 10, 50);

        if (cancelled()) return CANCELLED;
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
        const daysBack = readCount(input.days_back, 7, 365);
        const keyword = input.keyword as string | undefined;
        const { def: prDef, max: prMax } = LIST_LIMITS.query_press_releases;
        const limit = readCount(input.limit, prDef, prMax);

        // Sync + query pattern. Sync errors are surfaced as a warning
        // alongside any locally-cached rows so the user still gets
        // something actionable when Finnhub is down.
        const prById =
          typeof input.id === "number"
            ? (db
                .prepare("SELECT * FROM press_releases WHERE id = ? AND UPPER(symbol) = ?")
                .all(input.id, ticker) as ReturnType<typeof listPressReleases>)
            : null;
        if (prById && prById.length === 0) return { error: `No press release with id ${input.id} for ${ticker}.` };
        if (cancelled()) return CANCELLED;
        const sync = prById ? { upserted: 0, error: undefined } : await fetchAndCachePressReleases(db, ticker, daysBack);
        const prCut = takeList(
          prById ??
            listPressReleases(db, {
              symbol: ticker,
              keyword,
              days_back: daysBack,
              limit: limit + 1,
            }),
          limit,
          prMax
        );
        listInfo = prCut.info;
        const rows = prCut.rows;

        rawResult = {
          ticker,
          days_back: daysBack,
          keyword: keyword ?? null,
          fetched: sync.upserted,
          warning: sync.error ?? undefined,
          count: rows.length,
          press_releases: rows.map((r) => ({
            id: r.id,
            symbol: r.symbol,
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
        if (cancelled()) return CANCELLED;
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
          // Same scope rule as query_notes (P9): in a single-account chat a
          // note on another account's transaction is withheld.
          const secId = findSecurity(db, ticker)?.id ?? getSecurityIdBySymbol(db, ticker);
          let userNotes: unknown[] = [];
          if (secId) {
            userNotes = notesInScope(
              db,
              getNotesFiltered(db, {
                note_type: "earnings",
                security_id: secId,
                limit: singleAccountChat ? SCOPED_NOTES_FETCH : 5,
              }),
              scopeAccountIds
            ).slice(0, 5);
          }
          rawResult = {
            ...transcriptData,
            user_notes: userNotes,
          };
        }
        break;
      }

      case "query_trade_reviews": {
        // Resolved above to exactly one account (default: IBKR).
        // A name that resolves to no single account ("all") is refused with
        // the same top-level error shape as every other account tool, naming
        // the accounts it may ask for; it is never wrapped inside `data`.
        const account = scopeAccounts?.[0];
        if (!account) {
          const names = getAllAccounts(db)
            .map((a) => `"${a.name}"`)
            .join(", ");
          return {
            error: `"${requestedAccount}" does not name one account and this tool reads one account at a time. Call it once per account with an exact account name (${names}), or omit account_name for the IBKR account.`,
          };
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
        // The whole named scope (a list of ids; undefined = every account).
        // An underlying filter is applied INSIDE the engine, before its own
        // aggregation and coverage counts, so the totals are that
        // underlying's (per-unit greek x signed quantity x multiplier over
        // priced positions), never the whole book's (B22).
        const underlyingFilter = asString(input.underlying)?.trim().toUpperCase() || undefined;
        const greeks = computePortfolioGreeks(db, { accountIds, underlying: underlyingFilter });
        const positions = greeks.positions;

        // Detect strategies from option positions + stock holdings.
        // Stock legs via the shared per-(account,security) helper — see lib/queries/options.ts.
        const optionPositions = getOptionPositions(db, accountIds);
        const stockHoldings = getStockLegsForStrategyDetection(db, accountIds);

        // Strategies are detected account by account (one shared helper with
        // /api/compute/options-strategies): legs are never paired across
        // accounts.
        const strategies = detectStrategiesPerAccount(stockHoldings, optionPositions).filter(
          (s) => !underlyingFilter || s.underlying.toUpperCase() === underlyingFilter
        );

        // Coverage gate, mirroring app/dashboard/components/OptionsGreeksCard.tsx:
        // computePortfolioGreeks initializes the four totals at 0 and only adds
        // to them for a position that actually SOLVED. When an option book
        // exists but nothing could be priced, those zeros are the untouched
        // initializers, not a flat exposure — handed to the model unqualified
        // they become an affirmative "the book is delta-neutral" claim over a
        // position whose risk is simply unknown. Report the counts always, and
        // null the totals out (with a note) when nothing priced. With no option
        // positions at all the zeros ARE the truth, so they stand.
        const noGreeksCoverage =
          greeks.totalPositions > 0 && greeks.computedPositions === 0;
        // totalPositions counts LIVE contracts only. A book holding nothing
        // but expired contracts therefore has totalPositions 0, and its four
        // zero totals are again untouched initializers, not a flat exposure:
        // null them and say why.
        const expiredOnly =
          greeks.totalPositions === 0 && greeks.expiredPositions > 0;
        const partialGreeksCoverage =
          !noGreeksCoverage && greeks.computedPositions < greeks.totalPositions;
        const greeksNoteParts: string[] = [];
        if (expiredOnly) {
          greeksNoteParts.push(
            `no live option positions: ${greeks.expiredPositions} expired contract${greeks.expiredPositions === 1 ? "" : "s"} excluded, so there are no Greeks to report`
          );
        } else if (noGreeksCoverage) {
          greeksNoteParts.push("no position could be priced");
        } else if (partialGreeksCoverage) {
          greeksNoteParts.push(
            `greeks solved for ${greeks.computedPositions} of ${greeks.totalPositions} positions`
          );
        }
        // An underlying with no contract in scope: the zeros are untouched
        // initializers, not a flat exposure on that name (review R5-11).
        const noneOnUnderlying =
          underlyingFilter !== undefined && greeks.totalPositions === 0 && greeks.expiredPositions === 0;
        if (noneOnUnderlying) {
          greeksNoteParts.push(`no option position on ${underlyingFilter} in this scope, so there are no Greeks to report`);
        }
        const greeksNote =
          greeksNoteParts.length > 0 ? greeksNoteParts.join("; ") : null;
        // Kept apart from `note` (which is about COVERAGE): a fallback-vol
        // position is priced, so the totals stand, but its Greeks rest on a
        // volatility that was not solved from the contract's own price.
        const volatilityNote =
          greeks.fallbackVolPositions > 0
            ? `${greeks.fallbackVolPositions} of the ${greeks.computedPositions} priced position${greeks.computedPositions === 1 ? "" : "s"} used a fallback volatility, not one solved from the contract's own price`
            : null;
        const withholdTotals = noGreeksCoverage || expiredOnly || noneOnUnderlying;

        rawResult = {
          portfolio: {
            totalDelta: withholdTotals ? null : greeks.totalDelta,
            totalGamma: withholdTotals ? null : greeks.totalGamma,
            totalTheta: withholdTotals ? null : greeks.totalTheta,
            totalVega: withholdTotals ? null : greeks.totalVega,
            computedPositions: greeks.computedPositions,
            totalPositions: greeks.totalPositions,
            fallbackVolPositions: greeks.fallbackVolPositions,
            expiredPositions: greeks.expiredPositions,
            note: greeksNote,
            volatilityNote,
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
            // null maxProfit/maxLoss means "unlimited" ONLY when this is false.
            pricingIncomplete: s.pricingIncomplete,
            // Why the figures are withheld: missing_price / zero_mark /
            // below_intrinsic (an option marked below its exercise value).
            pricingIncompleteReason: s.pricingIncompleteReason,
          })),
          positionCount: positions.length,
          strategyCount: strategies.length,
        };
        break;
      }

      case "query_research_feeds": {
        // An unresolved filter is an error naming the next step, never a
        // dropped filter (QA-10).
        let securityId: number | undefined;
        const feedSymbol = asString(input.symbol);
        if (feedSymbol) {
          const sec = findSecurity(db, feedSymbol);
          if (!sec) return noSecurityError(feedSymbol);
          securityId = sec.id;
        }
        // A source is a case-insensitive part of one source's name; none or
        // several matches is an error listing every source.
        let sourceId: number | undefined;
        const feedSource = asString(input.source);
        if (feedSource) {
          const sources = db.prepare("SELECT id, name FROM research_sources ORDER BY name").all() as Array<{
            id: number;
            name: string;
          }>;
          const needle = feedSource.trim().toLowerCase();
          // A case-insensitive exact name wins first (a name that is part of
          // another could otherwise never be chosen), then a unique part.
          const exact = sources.filter((src) => src.name.toLowerCase() === needle);
          const matches = exact.length > 0 ? exact : sources.filter((src) => src.name.toLowerCase().includes(needle));
          if (matches.length !== 1) {
            const all = sources.map((src) => `"${src.name}"`).join(", ");
            return {
              error:
                matches.length === 0
                  ? `No research source matches "${feedSource}". Nothing was filtered or returned. Sources: ${all}.`
                  : `"${feedSource}" matches ${matches.length} research sources (${matches.map((src) => `"${src.name}"`).join(", ")}). Pass a longer part of one name. Sources: ${all}.`,
            };
          }
          sourceId = matches[0].id;
        }
        const { def: feedDef, max: feedMax } = LIST_LIMITS.query_research_feeds;
        const feedLimit = readCount(input.limit, feedDef, feedMax);

        let researchArticles: import("@/lib/queries/research").ResearchArticle[] = [];
        try {
          const { getRecentArticles } = await import("@/lib/queries/research");
          const daysBack = readCount(input.days_back, 7, 365);

          researchArticles =
            typeof input.id === "number"
              ? (db
                  .prepare(
                    `SELECT a.*, s.name AS source_name FROM research_articles a
                     JOIN research_sources s ON a.source_id = s.id
                     WHERE a.id = ? AND a.processed_at IS NOT NULL`
                  )
                  .all(input.id) as typeof researchArticles)
              : getRecentArticles(db, {
            sourceId,
            securityId,
            // N days before the Eastern day (a UTC slice is tomorrow after
            // 20:00 Eastern and opened the window a day late).
            startDate: addDays(todayET(), -daysBack),
            search: input.search ? String(input.search) : undefined,
            processedOnly: true,
            limit: feedLimit + 1,
          });
        } catch {
          // Table may not exist yet
        }
        if (typeof input.id === "number" && researchArticles.length === 0) {
          return { error: `No research article with id ${input.id}.` };
        }
        const feedCut = takeList(researchArticles, feedLimit, feedMax);
        listInfo = feedCut.info;

        rawResult = {
          articles: feedCut.rows.map((a) => ({
            id: a.id,
            source: a.source_name,
            date: a.received_at.slice(0, 10),
            subject: a.subject,
            summary: a.summary,
            sentiment: a.sentiment,
            themes: a.key_themes ? sanitizeThemeList(parseKeyThemesField(a.key_themes)) : [],
            tickers: parseJsonList(a.mentioned_symbols),
            // Written against the whole held book: withheld from a
            // single-account chat (OPEN-7 default).
            portfolio_relevance: singleAccountChat ? null : a.portfolio_relevance,
          })),
          count: feedCut.rows.length,
          ...(singleAccountChat ? { scope_note: `portfolio_relevance ${WHOLE_BOOK_FIELD_NOTE}` } : {}),
        };
        break;
      }

      case "query_calendar_events": {
        const daysAhead = readCount(input.days_ahead, 14, 365, 0);
        const daysBack = readCount(input.days_back, 0, 365, 0);
        // Event dates are Eastern calendar days, so the window is anchored on
        // the Eastern day: a UTC slice dropped tonight's events after 20:00.
        const today = todayET();
        const evtParams: unknown[] = [
          addDays(today, -daysBack),
          addDays(today, daysAhead),
        ];

        // Same predicate the Earnings Hub reads: skip rows the reconciler hid.
        const { def: evtDef, max: evtMax } = LIST_LIMITS.query_calendar_events;
        const evtLimit = readCount(input.limit, evtDef, evtMax);
        let evtWhere = "event_date BETWEEN ? AND ? AND COALESCE(superseded, 0) = 0";
        if (typeof input.id === "number") {
          // One event by id, any date (a '…[cut' marker points here).
          evtWhere = "id = ? AND COALESCE(superseded, 0) = 0";
          evtParams.length = 0;
          evtParams.push(input.id);
        }
        if (input.event_type && typeof input.id !== "number") {
          evtWhere += " AND LOWER(event_type) LIKE '%' || LOWER(?) || '%'";
          evtParams.push(String(input.event_type));
        }
        if (input.symbol && typeof input.id !== "number") {
          evtWhere += " AND UPPER(symbol) = ?";
          evtParams.push(String(input.symbol).toUpperCase());
        }

        const fetchedEvents = db
          .prepare(
            `SELECT id, event_type, event_date, event_time, title, description, symbol,
             expected_impact, consensus_estimate, consensus_value, previous_value, actual_value,
             release_time, raw_json, manual_actuals_at
             FROM calendar_events WHERE ${evtWhere}
             ORDER BY event_date ASC, event_time ASC LIMIT ?`
          )
          .all(...evtParams, evtLimit + 1) as Array<{
            event_type: string | null;
            event_date: string;
            event_time: string | null;
            symbol: string | null;
            consensus_estimate: string | null;
            consensus_value: string | null;
            actual_value: string | null;
            release_time: string | null;
            raw_json: string | null;
            manual_actuals_at: string | null;
            [k: string]: unknown;
          }>;
        if (typeof input.id === "number" && fetchedEvents.length === 0) {
          return { error: `No calendar event with id ${input.id}.` };
        }
        const evtCut = takeList(fetchedEvents, evtLimit, evtMax);
        listInfo = evtCut.info;
        const rows = evtCut.rows;
        // A hand-accepted figure is stamped on one twin of the print; read
        // the stamp across the cluster, as every other actuals reader does.
        applyClusterManualActuals(db, rows);
        // One consensus figure per print, on the Earnings Hub's basis:
        // consensus_value, else the vendor estimate. Returned under the
        // existing consensus_estimate key; consensus_value itself is dropped.
        for (const r of rows) {
          const cv = r.consensus_value;
          if (cv != null && String(cv).trim() !== "") r.consensus_estimate = cv;
          delete (r as { consensus_value?: unknown }).consensus_value;
        }
        // Whether a result is on file, said in words: the model read a dated
        // pre-open row at 04:20 ET as "already reported" (QA 2026-10-13).
        // Only a stored actual means reported; a slot is a scheduled time.
        //
        // Two checks come BEFORE "reported" (review of 30c73e22):
        //  - a figure saved ahead of the print (the app allows it, Today shows
        //    it with a "pre-release" chip) is not a result. Same rule as that
        //    chip, isPreReleaseActual; chat attaches no usual-side estimate,
        //    so the row's own slot or stored time decides.
        //  - a vendor actual that fails the plausibility guard is withheld,
        //    as on every other surface; a hand-accepted figure is exempt.
        const clock = nowET();
        const events = rows.map((row) => {
          // raw_json / release_time feed the checks only; the model gets neither.
          const { raw_json, release_time, manual_actuals_at, ...e } = row;
          void raw_json;
          void release_time;
          const hasActual = e.actual_value != null && String(e.actual_value).trim() !== "";
          const enteredManually = manual_actuals_at ? { entered_manually: true } : {};
          // A VENDOR figure on a row with no real slot (only the stored 16:15
          // default) is itself evidence the print is out: Today clears its
          // chip by the usual side, which chat cannot see, so the default
          // must not hold the figure back until 16:15 (landing re-review).
          // A hand-entered figure keeps the stored time as its floor.
          const slotKnown = deriveEarningsSlot({ event_time: row.event_time, raw_json }) !== null;
          const preReleaseRow = !slotKnown && !manual_actuals_at ? { ...row, release_time: null } : row;
          if (hasActual && isPreReleaseActual(preReleaseRow)) {
            return {
              ...e,
              actual_value: null,
              figure_saved_before_release: e.actual_value,
              ...enteredManually,
              report_state: `pre_release_figure (a figure was saved before the release window opened; it is NOT a reported result. The print is ${e.event_date > today ? `scheduled for ${e.event_date}` : `scheduled today${e.event_time ? ` at ${e.event_time} ET` : ""}; it is now ${clock} ET`})`,
            };
          }
          if (hasActual && actualsAreImplausible(e.consensus_estimate, e.actual_value, manual_actuals_at)) {
            return {
              ...e,
              actual_value: null,
              report_state:
                "reported, figure withheld (the stored vendor figure failed the plausibility check against consensus; do not quote a result)",
            };
          }
          const report_state = hasActual
            ? "reported"
            : e.event_date > today
              ? "upcoming"
              : e.event_date === today
                ? `not yet reported (scheduled today${e.event_time ? ` at ${e.event_time} ET` : ""}; it is now ${clock} ET)`
                : "print date passed, no result on file (the figures were not captured; do not say the company has not reported, and do not quote a result)";
          return { ...e, ...enteredManually, report_state };
        });
        rawResult = { events, count: events.length, now_et: `${today} ${clock} ET` };
        break;
      }

      case "query_calendar_briefings": {
        const weeksBack = readCount(input.weeks_back, 1, 4);

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

        // generated_at is SQLite UTC; the model read it as Eastern (QA
        // 2026-10-18). Return a labelled Eastern time and the UTC instant.
        const etFormat = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/New_York",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        });
        const briefingsEt = (briefings as Array<{ generated_at: string; [k: string]: unknown }>).map(
          ({ generated_at, ...rest }) => {
            const d = parseDbTimestamp(generated_at);
            let generated_at_et: string | null = null;
            if (d) {
              const p = Object.fromEntries(etFormat.formatToParts(d).map((x) => [x.type, x.value]));
              generated_at_et = `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ET`;
            }
            // The narrative is written against the whole held book:
            // withheld from a single-account chat (OPEN-7 default).
            const scoped = singleAccountChat ? { content: null } : {};
            return { ...rest, ...scoped, generated_at_et, generated_at_utc: generated_at };
          },
        );
        rawResult = {
          briefings: briefingsEt,
          count: briefingsEt.length,
          now_et: `${todayET()} ${nowET()} ET`,
          ...(singleAccountChat ? { scope_note: `The briefing text ${WHOLE_BOOK_FIELD_NOTE}` } : {}),
        };
        break;
      }

      case "query_levels": {
        const levelSymbol = asString(input.symbol);
        let securityId: number | undefined;
        if (levelSymbol) {
          const sec = findSecurity(db, levelSymbol);
          if (!sec) return noSecurityError(levelSymbol);
          securityId = sec.id;
        }
        const { def: lvlDef, max: lvlMax } = LIST_LIMITS.query_levels;
        const lvlLimit = readCount(input.limit, lvlDef, lvlMax);
        const activeOnly = !input.include_inactive;
        // One rule with or without a symbol (review R5-7): the armed view is
        // is_active = 1 AND review_status 'auto_approved' (a rejected level
        // is never presented as live) and not expired on the Eastern day;
        // include_inactive returns every level. getLevelsForSecurity is that
        // view for one security; the all-securities read mirrors it.
        const levelToday = todayET();
        const levelById =
          typeof input.id === "number"
            ? (db.prepare("SELECT * FROM security_levels WHERE id = ?").all(input.id) as ReturnType<typeof getActiveLevels>)
            : null;
        if (levelById && levelById.length === 0) return { error: `No level with id ${input.id}.` };
        const rawLevels = levelById ?? (
          securityId
            ? getLevelsForSecurity(db, securityId, { activeOnly })
            : (db
                .prepare(
                  `SELECT * FROM security_levels
                   ${activeOnly ? "WHERE is_active = 1 AND review_status = 'auto_approved'" : ""}
                   ORDER BY set_date DESC, id DESC`
                )
                .all() as ReturnType<typeof getActiveLevels>)
        ).filter((l) => !activeOnly || l.expires_at == null || l.expires_at >= levelToday);
        const sourceAuthor = input.source_author ? String(input.source_author) : undefined;
        const levelType = input.level_type ? String(input.level_type) : undefined;

        const filtered = rawLevels.filter((l) => {
          if (levelById) return true;
          if (sourceAuthor && l.source_author?.toLowerCase() !== sourceAuthor.toLowerCase()) return false;
          if (levelType && l.level_type !== levelType) return false;
          return true;
        });

        const lvlCut = takeList(filtered, lvlLimit, lvlMax);
        listInfo = lvlCut.info;

        // Join security symbol via a single lookup so the chat gets human-readable context.
        const symByIdStmt = db.prepare("SELECT symbol, name, currency FROM securities WHERE id = ?");
        const enriched = lvlCut.rows.map((l) => {
          const sec = symByIdStmt.get(l.security_id) as
            | { symbol: string; name: string; currency: string | null }
            | undefined;
          const effective =
            l.price_source === "static" ? l.price : resolveLevelPrice(db, l);
          return {
            id: l.id,
            symbol: sec?.symbol ?? null,
            security_name: sec?.name ?? null,
            // Level prices are NATIVE currency: labelled, never converted (B23).
            currency: sec?.currency ?? "USD",
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
            // is_active says whether the level is armed NOW. The two fields
            // below are history only: a re-armed level keeps its last fire, so
            // they are named last_fired_* (not triggered_*) to stop a model
            // reading an active level as "triggered".
            is_active: l.is_active,
            last_fired_at: l.triggered_at,
            last_fired_price: l.triggered_price,
            set_date: l.set_date,
          };
        });

        rawResult = { levels: enriched, count: enriched.length };
        break;
      }

      case "query_alerts": {
        const alertSymbol = asString(input.symbol);
        let securityId: number | undefined;
        if (alertSymbol) {
          const sec = findSecurity(db, alertSymbol);
          if (!sec) return noSecurityError(alertSymbol);
          securityId = sec.id;
        }
        const sinceDays = readCount(input.since_days, 30, 365);
        const response = input.response as
          | "pending"
          | "acted"
          | "ignored"
          | "dismissed"
          | undefined;
        const { def: alertDef, max: alertMax } = LIST_LIMITS.query_alerts;
        const alertLimit = readCount(input.limit, alertDef, alertMax);
        // The window is an INSTANT compare, not a string compare: triggered_at
        // is stored in SQLite's space form or as ISO "T...Z", both UTC, and the
        // space form sorts below "T" on the same day (B24). Window first, then
        // the limit.
        const cutoff = Date.now() - sinceDays * 86400000;
        const alertById =
          typeof input.id === "number"
            ? (db.prepare("SELECT * FROM level_alerts WHERE id = ?").all(input.id) as ReturnType<typeof getAlerts>)
            : null;
        if (alertById && alertById.length === 0) return { error: `No alert with id ${input.id}.` };
        const rawAlerts = alertById ?? getAlerts(db, { securityId, response, limit: ALERT_WINDOW_FETCH });
        // Newest first by INSTANT (the stored strings do not sort across the
        // two forms), then the limit.
        const inWindow = rawAlerts
          .map((a) => ({ a, at: parseDbTimestamp(a.triggered_at)?.getTime() ?? null }))
          .filter((x): x is { a: (typeof rawAlerts)[number]; at: number } => x.at != null && (alertById != null || x.at >= cutoff))
          .sort((x, y) => y.at - x.at || y.a.id - x.a.id)
          .map((x) => x.a);
        const alertCut = takeList(inWindow, alertLimit, alertMax);
        listInfo = alertCut.info;
        const recent = alertCut.rows;

        // Enrich with security symbol + level author/thesis for narrative context.
        const symByIdStmt = db.prepare("SELECT symbol, name, currency FROM securities WHERE id = ?");
        const levelByIdStmt = db.prepare(
          "SELECT level_type, price, price_source, source_author, thesis, timeframe FROM security_levels WHERE id = ?"
        );
        const enriched = recent.map((a) => {
          const sec = symByIdStmt.get(a.security_id) as
            | { symbol: string; name: string; currency: string | null }
            | undefined;
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
            // level_price and triggered_price are NATIVE currency (B23).
            currency: sec?.currency ?? "USD",
            level_type: lvl?.level_type ?? null,
            level_price: lvl?.price ?? null,
            price_source: lvl?.price_source ?? null,
            source_author: lvl?.source_author ?? null,
            thesis: lvl?.thesis ?? null,
            timeframe: lvl?.timeframe ?? null,
            triggered_at: a.triggered_at,
            triggered_price: a.triggered_price,
            // Drafted from a whole-book position snapshot: withheld from a
            // single-account chat (OPEN-7 default).
            suggested_action: singleAccountChat ? null : a.suggested_action,
            user_response: a.user_response,
            user_response_at: a.user_response_at,
            user_response_note: a.user_response_note,
          };
        });

        rawResult = {
          alerts: enriched,
          count: enriched.length,
          ...(singleAccountChat ? { scope_note: `suggested_action ${WHOLE_BOOK_FIELD_NOTE}` } : {}),
        };
        break;
      }

      case "query_release_reactions": {
        const rows = getRecentReleaseReactions(db, {
          eventType: input.event_type as string | undefined,
          symbol: input.symbol ? String(input.symbol).toUpperCase() : undefined,
          sinceDate: input.since_date as string | undefined,
          limit: readCount(input.limit, 10, 50),
        });
        const decoded = rows.map((r) => {
          // Never hand the model a raw snapshot: a zero-filled legacy leg is
          // a fabricated flat move (see sanitizeReactionSnapshotForChat).
          // The row's enriched_at is evidence only; it is not returned.
          const reaction = sanitizeReactionSnapshotForChat(r.reaction_snapshot, {
            rowEnrichedAt: r.enriched_at,
            eventDate: r.event_date,
          });
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

      case "query_market_snapshot": {
        // `accountName` is set by the scope clamp in a single-account chat, so
        // such a chat sees only its own account's positions.
        if (cancelled()) return CANCELLED;
        const snap = await getMarketSnapshot(db, { fetchQuotes: fetchYahooQuotes, accountName });
        // Held rows are capped, ranked by |day_effect| (unmeasured last);
        // benchmarks and the totals are always whole: held_totals sums the
        // engine's own day_effect over EVERY held row, never the rows kept.
        const { def: snapDef, max: snapMax } = LIST_LIMITS.query_market_snapshot;
        const snapLimit = readCount(input.limit, snapDef, snapMax);
        const benchmarks = snap.moves.filter((m) => m.kind !== "holding");
        const held = snap.moves.filter((m) => m.kind === "holding");
        const measured = held.filter((m) => typeof m.day_effect === "number");
        const ranked = [...held].sort((a, b) => {
          const av = typeof a.day_effect === "number" ? Math.abs(a.day_effect) : -1;
          const bv = typeof b.day_effect === "number" ? Math.abs(b.day_effect) : -1;
          return bv - av;
        });
        const heldCut = takeList(ranked, snapLimit, snapMax);
        if (held.length > 0) listInfo = heldCut.info;
        rawResult = {
          ...snap,
          moves: [...benchmarks, ...heldCut.rows],
          ...(held.length > 0
            ? {
                held_totals: {
                  day_effect_total: measured.reduce((a, m) => a + (m.day_effect as number), 0),
                  held_rows: held.length,
                  measured_rows: measured.length,
                  unmeasured_rows: held.length - measured.length,
                  note: "day_effect_total is the sum of day_effect over every held row (USD), including rows not returned; rows with no measured day_effect are counted in unmeasured_rows and not in the total.",
                },
              }
            : {}),
        };
        break;
      }

      default: {
        // The six composite read tools share this whole path: input check,
        // account resolution and scope guard above, annotations below.
        if (!isCompositeTool(toolName)) return { error: `Unknown tool: ${toolName}` };
        const composite = runCompositeTool(toolName, db, input, { accountIds, accountName, today: todayET() });
        if (isErrorResult(composite)) return composite;
        rawResult = composite;
        break;
      }
    }

    // Wrap result with data quality annotations. A holdings result that
    // became an object (closures alongside) is annotated on its held rows.
    const annotated =
      toolName === "query_holdings" &&
      rawResult != null &&
      typeof rawResult === "object" &&
      !Array.isArray(rawResult) &&
      Array.isArray((rawResult as { holdings?: unknown }).holdings)
        ? (rawResult as { holdings: unknown[] }).holdings
        : rawResult;
    // Freshness is the scope's own (Codex 12): the tool's resolved accounts,
    // else the single-account chat's scope, else every account.
    const annotations = annotateToolResult(db, toolName, annotated, {
      accountIds: accountIds ?? scopeAccountIds,
    });
    return {
      data: rawResult,
      ...(listInfo ? { list_info: listInfo } : {}),
      ...extras,
      ...annotations,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool execution failed";
    return { error: message };
  }
}

// ─── Friendly tool name labels for the UI ─────────────────────────

// One map, in the client-safe lib/chat/tool-labels.ts (plan Contract F).
export { CHAT_TOOL_LABELS as TOOL_LABELS } from "./tool-labels";

// ─── Compact model-facing output (plan Task 8, Contract H) ────────

/**
 * Text fields shortened in a list of two or more rows, and the call that
 * reads one in full (its arguments as JSON, by the row's stable id, so the
 * call returns exactly that item). A single-row result is never shortened,
 * so following the pointer always gives the whole text.
 */
type TextCut = { chars: number; fetch: (row: Record<string, unknown>) => { tool: string; args: Record<string, unknown> } };
const byId = (tool: string): TextCut["fetch"] => (r) => ({ tool, args: { id: r.id } });
const COMPACT_TEXT_LIMITS: Record<string, TextCut> = {
  "query_notes.content": { chars: 400, fetch: byId("query_notes") },
  "query_earnings_transcript.content": { chars: 400, fetch: byId("query_notes") },
  "query_calendar_briefings.content": {
    chars: 1500,
    fetch: (r) => ({ tool: "query_calendar_briefings", args: { week_of: r.week_of } }),
  },
  "query_alerts.suggested_action": { chars: 160, fetch: byId("query_alerts") },
  "query_alerts.thesis": { chars: 120, fetch: byId("query_alerts") },
  "query_alerts.user_response_note": { chars: 200, fetch: byId("query_alerts") },
  "query_levels.thesis": { chars: 160, fetch: byId("query_levels") },
  "query_calendar_events.description": { chars: 60, fetch: byId("query_calendar_events") },
  "query_press_releases.summary": {
    chars: 200,
    fetch: (r) => ({ tool: "query_press_releases", args: { ticker: r.symbol, id: r.id } }),
  },
  "query_research_feeds.summary": { chars: 300, fetch: byId("query_research_feeds") },
  "query_research_documents.summary": { chars: 400, fetch: byId("query_research_documents") },
};

/**
 * Which numbers are rounded, per tool, by EXACT field name (review RF-1/RF-2:
 * a substring match on the key rounded return contributions and an FX value
 * to zero). A field not listed here is returned exactly as the engine gave
 * it. Each result names its rounded fields in `_rounded`, so the legend is
 * true for every tool.
 */
type Rounding = "cents" | "pct2" | "price4";
const ROUND_DP: Record<Rounding, number> = { cents: 2, pct2: 2, price4: 4 };
const COMPACT_ROUNDING: Record<string, Record<string, Rounding>> = {
  query_holdings: {
    cost_basis: "cents",
    market_value: "cents",
    unrealized_gain: "cents",
    latest_price: "price4",
    unrealized_gain_pct: "pct2",
    position_weight_pct: "pct2",
    // by_symbol (market_value and unrealized_gain above; the per-share basis
    // is a ratio and stays exact)
    total_cost_basis_usd: "cents",
  },
  query_tax_lots: {
    cost_basis: "cents",
    original_lot_cost_basis: "cents",
    current_value: "cents",
    unrealized_gain: "cents",
    proceeds: "cents",
    realized_gain_loss: "cents",
    proceeds_native: "cents",
    cost_basis_native: "cents",
    realized_gain_native: "cents",
    proceeds_usd_at_current_fx: "cents",
    cost_basis_usd_at_current_fx: "cents",
    realized_gain_usd_at_current_fx: "cents",
    acquisition_price: "price4",
    current_price: "price4",
    sale_price: "price4",
    // totals block
    cost_basis_usd: "cents",
    unrealized_gain_usd: "cents",
    short_sale_proceeds_usd: "cents",
  },
  query_transactions: { amount: "cents", fees: "cents", price_per_share: "price4" },
  query_allocation: { total_market_value: "cents", percentage: "pct2" },
  query_price_history: { close_price: "price4" },
  query_market_snapshot: { market_value: "cents", day_effect: "cents", day_effect_total: "cents", pct: "pct2" },
  query_income_summary: {
    total_dividends: "cents",
    total_interest: "cents",
    interest_paid: "cents",
    total_fees: "cents",
    net_income: "cents",
  },
  query_levels: { price: "price4", effective_price: "price4", last_fired_price: "price4" },
  query_alerts: { level_price: "price4", triggered_price: "price4" },
};

/** The rounding the compact form applies to one tool's field, or none. */
export function compactRoundingFor(toolName: string, field: string): { dp: number } | null {
  const r = COMPACT_ROUNDING[toolName]?.[field];
  return r ? { dp: ROUND_DP[r] } : null;
}

/** The one line that tells the model how to read a compact result. */
export const COMPACT_FORMAT_LEGEND =
  "Compact form. A list of 2+ records is {_cols, _rows}: each row is an array in _cols order; _same_in_rows_shown holds columns whose value is identical on every row SHOWN (when list_info says truncated, rows not shown may differ); a column in neither is null or empty on every row shown; a null cell is null. In an object, a missing key is null or empty. Only the fields named in _rounded are rounded (cents, percents to 2 decimals, prices to 4); every other number is exactly as computed. Text ending '…[cut' was shortened here; the marker names the call that reads it in full.";

function roundTo(n: number, dp: number): number {
  const f = 10 ** dp;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

interface CompactState {
  tool: string;
  changed: boolean;
}

function compactValue(v: unknown, key: string, st: CompactState): unknown {
  if (typeof v === "number") {
    const rule = compactRoundingFor(st.tool, key);
    if (!rule || !Number.isFinite(v) || Number.isInteger(v)) return v;
    const r = roundTo(v, rule.dp);
    if (r !== v) st.changed = true;
    return r;
  }
  if (Array.isArray(v)) return compactArray(v, key, st);
  if (v && typeof v === "object") return compactObject(v as Record<string, unknown>, st);
  return v;
}

function compactObject(o: Record<string, unknown>, st: CompactState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (isEmptyValue(v)) {
      st.changed = true;
      continue;
    }
    out[k] = compactValue(v, k, st);
  }
  return out;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function shortenText(text: string, limit: TextCut, row: Record<string, unknown>): string {
  if (text.length <= limit.chars) return text;
  const { tool, args } = limit.fetch(row);
  return `${text.slice(0, limit.chars)}…[cut: ${text.length - limit.chars} more chars; call ${tool} with ${JSON.stringify(args)} to read it in full]`;
}

function compactArray(arr: unknown[], key: string, st: CompactState): unknown {
  if (arr.length < 2 || !arr.every(isPlainRecord)) {
    return arr.map((x) => compactValue(x, key, st));
  }
  const rows = arr as Record<string, unknown>[];
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) (seen.add(k), cols.push(k));
  const kept: string[] = [];
  const same: Record<string, unknown> = {};
  const cells: unknown[][] = rows.map(() => []);
  for (const c of cols) {
    const limit = COMPACT_TEXT_LIMITS[`${st.tool}.${c}`];
    const values = rows.map((r) => {
      const v = r[c];
      if (isEmptyValue(v)) return null;
      if (limit && typeof v === "string") return shortenText(v, limit, r);
      return compactValue(v, c, st);
    });
    if (values.every((v) => v === null)) continue;
    const first = JSON.stringify(values[0]);
    if (values.every((v) => JSON.stringify(v) === first)) {
      same[c] = values[0];
      continue;
    }
    kept.push(c);
    values.forEach((v, i) => cells[i].push(v));
  }
  st.changed = true;
  return {
    _cols: kept,
    _rows: cells,
    ...(Object.keys(same).length > 0 ? { _same_in_rows_shown: same } : {}),
  };
}

/**
 * The compact form of a tool result, for the model only. An error result is
 * returned as it is. A result with nothing to compact is returned as it is,
 * with no legend.
 */
export function compactToolOutput(toolName: string, output: unknown): unknown {
  if (!isPlainRecord(output) || typeof output.error === "string") return output;
  const st: CompactState = { tool: toolName, changed: false };
  const compact = compactObject(output, st);
  if (!st.changed) return output;
  const rounded = COMPACT_ROUNDING[toolName];
  const roundedBlock = rounded
    ? {
        _rounded: Object.fromEntries(
          (["cents", "pct2", "price4"] as const)
            .map((kind) => [kind, Object.keys(rounded).filter((f) => rounded[f] === kind)] as const)
            .filter(([, fields]) => fields.length > 0),
        ),
      }
    : {};
  const result = { _format: COMPACT_FORMAT_LEGEND, ...roundedBlock, ...compact };
  // A small result gains nothing from the legend: keep the full form.
  return JSON.stringify(result).length < JSON.stringify(output).length ? result : output;
}

/** The `toModelOutput` every chat tool carries (Contract H). */
function compactToolModelOutput(toolName: string): NonNullable<ChatTool["toModelOutput"]> {
  return ({ output }: { output: unknown }) => ({
    type: "json" as const,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: compactToolOutput(toolName, output) as any,
  });
}
