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
          ],
          description:
            "Dimension to group by. 'fund_category' groups by investment category (e.g., 'US Large Cap Equity', 'International Equity'). 'geography' groups by region. 'market_cap_category' by cap size. 'style' by value/blend/growth.",
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
];

// ─── Account Name Resolution ─────────────────────────────────────

/**
 * Resolve a user-provided account name to the exact DB account name
 * using case-insensitive substring matching.
 * "roth" → "Vanguard Roth IRA", "ibkr" → "IBKR", etc.
 * Returns the original string if no match found (let downstream handle it).
 */
function resolveAccountName(
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
          input.group_by as "asset_class" | "security_type" | "sector" | "account" | "symbol"
            | "fund_category" | "geography" | "market_cap_category" | "style",
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
};
