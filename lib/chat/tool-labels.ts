/**
 * Friendly chat tool labels for the UI (Portfolio Assistant plan, Contract F).
 *
 * Client-safe: no imports. `lib/chat/tools.ts` re-exports this map as
 * TOOL_LABELS; every CHAT_TOOLS name must have an entry here.
 */

export const CHAT_TOOL_LABELS: Record<string, string> = {
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
  query_market_snapshot: "Checking today's market moves...",
};

/** The label for a tool name, or "Using <name>" for an unknown tool. */
export function toolLabel(name: string): string {
  return CHAT_TOOL_LABELS[name] ?? `Using ${name}`;
}
