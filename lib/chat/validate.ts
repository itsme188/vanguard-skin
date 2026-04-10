/**
 * Data quality annotation layer for chat tool results.
 *
 * Every tool result gets wrapped with quality annotations (freshness, completeness,
 * warnings) before Claude sees it. This ensures the chat model can incorporate
 * data quality caveats naturally into responses.
 */
import type Database from "better-sqlite3";
import type { HoldingResult, DataFreshness } from "@/lib/queries/chat-tools";
import { getDataFreshness } from "@/lib/queries/chat-tools";

export interface QualityAnnotation {
  quality_warnings: string[];
  data_freshness: DataFreshness;
}

/**
 * Annotate a tool result with data quality warnings and freshness info.
 * Called by executeTool() after each query function returns.
 */
export function annotateToolResult(
  db: Database.Database,
  toolName: string,
  rawResult: unknown
): QualityAnnotation {
  const warnings: string[] = [];
  const freshness = getDataFreshness(db);

  // ─── Price staleness (applies to most tools) ────────────────────
  if (
    freshness.price_age_days !== null &&
    freshness.price_age_days > 7 &&
    ["query_holdings", "query_allocation", "query_tax_lots"].includes(toolName)
  ) {
    warnings.push(
      `Price data is ${freshness.price_age_days} days old (latest: ${freshness.latest_price_date}). Market values may not reflect current prices.`
    );
  }

  // ─── Tool-specific annotations ──────────────────────────────────
  if (toolName === "query_holdings" && Array.isArray(rawResult)) {
    annotateHoldings(rawResult as HoldingResult[], warnings);
  }

  if (toolName === "query_allocation") {
    warnings.push(
      "Positions without price data use cost basis for allocation. Cash balances are not included."
    );
  }

  if (toolName === "query_tax_lots") {
    warnings.push(
      "Tax lots use FIFO (First-In, First-Out) matching. Your broker may use a different method (e.g., specific identification)."
    );
    // Warn about closed lots in the results
    if (Array.isArray(rawResult)) {
      const closedCount = (rawResult as Array<Record<string, unknown>>).filter(
        (lot) => lot.sale_date != null
      ).length;
      if (closedCount > 0) {
        warnings.push(
          `${closedCount} lot(s) in these results are CLOSED (already sold). Closed lots represent past positions — they are NOT current holdings and cannot be harvested for tax losses.`
        );
      }
    }
  }

  if (toolName === "query_performance") {
    warnings.push(
      "Monthly change includes deposits/withdrawals. Use investment_change for actual portfolio performance excluding cash flows."
    );
  }

  if (toolName === "query_income_summary") {
    warnings.push(
      "REINVESTMENT transactions are counted as dividend income. Return of capital (if any) is not distinguished."
    );
  }

  if (toolName === "query_transactions") {
    warnings.push(
      "IMPORTANT: Transaction history shows past activity only. A BUY transaction does NOT mean the position is currently held — always verify current positions with query_holdings before claiming ownership."
    );
  }

  if (toolName === "query_fred") {
    warnings.push(
      "FRED data is sourced from the Federal Reserve Bank of St. Louis. Some series have publication lags (e.g., GDP is quarterly with ~1 month delay)."
    );
  }

  if (toolName === "query_company_fundamentals") {
    warnings.push(
      "Financial data is from SEC EDGAR XBRL filings. There may be a lag between the fiscal period end and the filing date. ETFs and mutual funds have limited fundamental data."
    );
  }

  if (toolName === "query_insider_trades") {
    warnings.push(
      "Insider trading data is from SEC Form 4 filings (real-time from EDGAR). Only non-derivative stock transactions are shown — options exercises, RSU vesting, and warrants are excluded. Many insider sales are pre-scheduled via 10b5-1 plans and are not necessarily bearish signals. Insiders must file Form 4 within 2 business days of the transaction."
    );
  }

  if (toolName === "query_notes") {
    if (Array.isArray(rawResult) && rawResult.length === 0) {
      warnings.push("No notes found matching the search criteria.");
    }
  }

  if (toolName === "create_note") {
    warnings.push("Note saved to the investment journal.");
  }

  if (toolName === "query_earnings_transcript") {
    const result = rawResult as Record<string, unknown> | null;
    if (result && !result.error) {
      const source = result.source as string;
      if (source === "edgar_8k") {
        warnings.push(
          "This is an SEC EDGAR 8-K earnings press release, not a full earnings call transcript. It contains financial results and may include guidance, but lacks the Q&A discussion from the actual conference call."
        );
      } else if (source === "motley_fool") {
        warnings.push(
          "Transcript sourced from Motley Fool (scraped). Content is typically accurate but formatting may vary."
        );
      } else if (source === "api_ninjas") {
        warnings.push(
          "Transcript from API Ninjas with AI-generated analysis (summary, guidance, sentiment)."
        );
      }
      if (!result.has_full_transcript) {
        warnings.push("Only a summary is available — full transcript text was not retrieved.");
      }
    }
  }

  return {
    quality_warnings: warnings,
    data_freshness: freshness,
  };
}

function annotateHoldings(holdings: HoldingResult[], warnings: string[]): void {
  // Missing prices
  const noPrice = holdings.filter((h) => h.latest_price == null);
  if (noPrice.length > 0) {
    const symbols = noPrice.map((h) => h.symbol).join(", ");
    warnings.push(
      `${noPrice.length} position(s) have no price data: ${symbols}`
    );
  }

  // Missing cost basis
  const noCost = holdings.filter(
    (h) => h.cost_basis == null && h.market_value != null
  );
  if (noCost.length > 0) {
    const symbols = noCost.map((h) => h.symbol).join(", ");
    warnings.push(
      `${noCost.length} position(s) have no cost basis (unrealized gain unavailable): ${symbols}`
    );
  }

  // Approaching maturity
  const maturing = holdings.filter((h) => h.maturity_note != null);
  if (maturing.length > 0) {
    const notes = maturing
      .map((h) => `${h.symbol}: ${h.maturity_note}`)
      .join("; ");
    warnings.push(`Bond(s) approaching maturity: ${notes}`);
  }

  // Options with multiplier=1 (likely data error)
  const suspectOptions = holdings.filter(
    (h) => h.security_type?.toLowerCase() === "option" && h.quantity !== 0
  );
  // We can't check multiplier from the result — but if market_value seems too low
  // relative to quantity for options, that's a signal. Skip this for now.

  // Cash estimate note
  warnings.push(
    "Cash balances are estimated (snapshot total minus holdings value). Actual cash may differ from estimates."
  );
}
