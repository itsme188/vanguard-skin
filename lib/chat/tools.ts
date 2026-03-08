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

// ─── Tool Definitions ─────────────────────────────────────────────

export const CHAT_TOOLS: Anthropic.Tool[] = [
  {
    name: "query_holdings",
    description:
      "Query current holdings with optional filters. Returns detailed position data including cost basis, market value, unrealized gain/loss, position weight, sector, and asset class. Use when the user asks about specific positions, accounts, asset classes, sectors, or portfolio composition.",
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
          enum: ["asset_class", "security_type", "sector", "account", "symbol"],
          description: "Dimension to group by",
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
      "Query tax lot details for open or closed positions. Returns acquisition date, cost basis, current value, unrealized/realized gain/loss, holding period, long-term/short-term status, and projected long-term date. Use for tax-loss harvesting analysis, capital gains questions, wash sale evaluation, lot-level drill-down, or identifying lots approaching the 1-year long-term threshold.",
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
      "Get account performance over time from monthly snapshots. Returns monthly total values, month-over-month changes, dividends, interest, fees, and time-weighted return (TWR) where available. Use for performance trend questions, income analysis over time, fee tracking, or comparing account growth.",
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
      "Summarize investment income (dividends, interest) and fees over a period. Returns per-symbol or per-account breakdowns. Use for income analysis, yield calculations, fee drag assessment, dividend tracking by quarter/month, or identifying which securities generate the most income.",
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
      },
    },
  },
];

// ─── Tool Dispatcher ──────────────────────────────────────────────

/**
 * Execute a chat tool by name with the given input parameters.
 * Returns the query result as a JSON-serializable object.
 * On error, returns { error: "..." } instead of throwing.
 */
export function executeTool(
  db: Database.Database,
  toolName: string,
  input: Record<string, unknown>
): unknown {
  try {
    switch (toolName) {
      case "query_holdings":
        return getHoldingsForChat(db, {
          account_name: input.account_name as string | undefined,
          symbol: input.symbol as string | undefined,
          security_type: input.security_type as string | undefined,
          sector: input.sector as string | undefined,
          sort_by: input.sort_by as "market_value" | "unrealized_gain" | "position_weight" | "symbol" | undefined,
          limit: input.limit as number | undefined,
        });

      case "query_price_history":
        return getPriceHistory(
          db,
          input.symbol as string,
          input.start_date as string | undefined,
          input.end_date as string | undefined
        );

      case "query_allocation":
        return getAllocationBreakdown(
          db,
          input.group_by as "asset_class" | "security_type" | "sector" | "account" | "symbol",
          input.account_name as string | undefined
        );

      case "query_tax_lots":
        return getTaxLotsForChat(db, {
          status: input.status as "open" | "closed" | "all" | undefined,
          symbol: input.symbol as string | undefined,
          account_name: input.account_name as string | undefined,
          year: input.year as number | undefined,
          sort_by: input.sort_by as "unrealized_gain" | "acquisition_date" | "holding_period_days" | "cost_basis" | undefined,
          limit: input.limit as number | undefined,
        });

      case "query_transactions":
        return getTransactionsForChat(db, {
          account_name: input.account_name as string | undefined,
          symbol: input.symbol as string | undefined,
          type: input.type as string | undefined,
          start_date: input.start_date as string | undefined,
          end_date: input.end_date as string | undefined,
          limit: input.limit as number | undefined,
        });

      case "query_performance":
        return getPerformanceForChat(db, {
          account_name: input.account_name as string | undefined,
          start_date: input.start_date as string | undefined,
          end_date: input.end_date as string | undefined,
        });

      case "query_income_summary":
        return getIncomeSummaryForChat(db, {
          period: input.period as "ytd" | "trailing_12m" | "last_year" | "all_time" | undefined,
          group_by: input.group_by as "symbol" | "account" | "month" | "type" | undefined,
        });

      default:
        return { error: `Unknown tool: ${toolName}` };
    }
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
};
