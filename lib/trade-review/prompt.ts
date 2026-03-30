import type { RoundTrip, RoundTripSummary } from "@/lib/compute/trade-roundtrips";
import type { PriorReviewSummary } from "@/lib/queries/trade-reviews";

/**
 * Build the system + user prompt for trade review generation.
 * Uses the design doc's grading rubric and analysis framework.
 */
export function buildTradeReviewPrompt(
  roundTrips: RoundTrip[],
  summary: RoundTripSummary,
  priorReviews: PriorReviewSummary[],
  periodLabel: string,
  marketContext?: string
): { system: string; user: string } {
  const system = buildSystemPrompt(priorReviews.length);
  const user = buildUserPrompt(
    roundTrips,
    summary,
    priorReviews,
    periodLabel,
    marketContext
  );
  return { system, user };
}

function buildSystemPrompt(priorReviewCount: number): string {
  let prompt = `You are an elite trading coach analyzing a short-term trader's monthly activity.
You have access to their complete trading history for this month and summaries of prior months.
Your job is to provide honest, specific, actionable feedback — not generic platitudes.

TRADER PROFILE:
- Short-term trader (holding periods: days to weeks)
- Primarily trades stocks in an IBKR brokerage account
- Uses FIFO cost basis for tax lot matching
- This review covers a single calendar month

GRADING RUBRIC — Grade each trade A through F:
- A: Excellent execution on both entry and exit. Well-timed, appropriately sized, thesis played out.
- B: Good trade with minor improvements possible. Solid execution, small optimizations available.
- C: Acceptable but with clear missed opportunities. Entry or exit timing was off, or sizing was wrong.
- D: Poor execution on entry, exit, or both. Held too long, sold too early, or lacked a clear thesis.
- F: Clear mistake — emotional, undisciplined, or thesis-free trade. Revenge trade, FOMO, or panic sell.

ANALYSIS FRAMEWORK — For each trade, assess:
1. Entry quality: Was the entry well-timed? What was the likely thesis?
2. Exit quality: Was the exit disciplined or emotional? Left money on the table?
3. Sizing: Was position sizing appropriate relative to conviction and risk?
4. Holding period: Was the duration appropriate for the thesis?

MONTHLY SUMMARY MUST INCLUDE:
1. Win rate and expectancy analysis (expectancy = avg_win × win_rate + avg_loss × loss_rate)
2. Best and worst trades with specific lessons
3. Behavioral patterns (positive and negative) observed this month
4. Three specific, actionable recommendations for next month

IMPORTANT: Be direct and specific. "You sold AAPL too early — it ran another 5% in the two days after your exit" is better than "consider holding longer." Reference actual trades by symbol and date.`;

  if (priorReviewCount >= 3) {
    prompt += `

CUMULATIVE PATTERN ANALYSIS (${priorReviewCount} prior months available):
You now have multiple months of trading history. Look for multi-month patterns:
1. Do they consistently cut winners short? (compare avg winner holding vs avg loser holding)
2. Do they overtrade after losses? (trade frequency changes after losing months)
3. Do earnings plays work? (win rate on trades around earnings dates)
4. Sizing patterns: do they size up on losers (averaging down) or winners?
5. Recovery patterns: how do they respond to a bad trade? Next trade quality?
6. Improvement trends: is win rate, profit factor, or expectancy improving over time?

Report ONLY patterns you actually observe with evidence from the data. Don't speculate.`;
  }

  return prompt;
}

function buildUserPrompt(
  roundTrips: RoundTrip[],
  summary: RoundTripSummary,
  priorReviews: PriorReviewSummary[],
  periodLabel: string,
  marketContext?: string
): string {
  const parts: string[] = [];

  parts.push(`# Trade Review Request: ${periodLabel}`);

  // Summary metrics
  parts.push(`
## Summary Metrics
- Total trades: ${summary.totalTrades}
- Winning: ${summary.winningTrades} | Losing: ${summary.losingTrades} | Win rate: ${(summary.winRate * 100).toFixed(1)}%
- Total P&L: $${summary.totalRealizedPnl.toFixed(2)}
- Avg holding: ${summary.avgHoldingDays.toFixed(1)} days
- Avg win: $${summary.avgWin.toFixed(2)} | Avg loss: $${summary.avgLoss.toFixed(2)}
- Profit factor: ${summary.profitFactor.toFixed(2)}x
- Best: ${summary.bestTradeSymbol} ($${summary.bestTradePnl.toFixed(2)})
- Worst: ${summary.worstTradeSymbol} ($${summary.worstTradePnl.toFixed(2)})`);

  // Round-trip table — group by sale transaction for multi-lot sells
  parts.push(`\n## This Month's Trades\n`);
  parts.push(
    "| # | Symbol | Entry Date | Entry Price | Exit Date | Exit Price | Qty | Days | P&L | Return |"
  );
  parts.push(
    "|---|--------|------------|-------------|-----------|------------|-----|------|-----|--------|"
  );

  // Group by sale transaction to aggregate multi-lot fills
  const grouped = groupBySaleTransaction(roundTrips);
  grouped.forEach((trade, i) => {
    const pnlSign = trade.realizedPnl >= 0 ? "+" : "";
    parts.push(
      `| ${i + 1} | ${trade.symbol} | ${trade.entryDate} | $${trade.entryPrice.toFixed(2)} | ${trade.exitDate} | $${trade.exitPrice.toFixed(2)} | ${trade.quantity.toFixed(0)} | ${trade.holdingDays} | ${pnlSign}$${trade.realizedPnl.toFixed(2)} | ${pnlSign}${trade.returnPct.toFixed(1)}% |`
    );
  });

  // Market context (if available)
  if (marketContext) {
    parts.push(`\n## Market Context\n${marketContext}`);
  }

  // Prior month summaries
  if (priorReviews.length > 0) {
    parts.push(`\n## Prior Month Summaries (most recent first)\n`);
    for (const pr of priorReviews) {
      const monthLabel = formatMonthLabel(pr.periodStart);
      parts.push(
        `### ${monthLabel}: ${pr.totalTrades} trades, ${(pr.winRate * 100).toFixed(0)}% win rate, $${pr.totalRealizedPnl.toFixed(0)} P&L, ${pr.profitFactor?.toFixed(1) ?? "N/A"}x profit factor`
      );
      // Truncate prior review markdown to key findings (first ~500 chars)
      const truncated = pr.reviewMarkdown.slice(0, 500);
      parts.push(truncated + (pr.reviewMarkdown.length > 500 ? "..." : ""));
    }

    // Include cumulative patterns from the most recent review
    const latestCumulative = priorReviews[0]?.cumulativePatterns;
    if (latestCumulative) {
      try {
        const patterns = JSON.parse(latestCumulative) as string[];
        if (patterns.length > 0) {
          parts.push(
            `\n## Previously Identified Cumulative Patterns\n${patterns.map((p) => `- ${p}`).join("\n")}`
          );
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  parts.push(
    `\nPlease analyze all ${summary.totalTrades} trades and produce the monthly review using the submit_trade_review tool.`
  );

  return parts.join("\n");
}

/** Group multi-lot fills from the same SELL transaction into a single prompt row */
interface GroupedTrade {
  symbol: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  quantity: number;
  holdingDays: number;
  realizedPnl: number;
  returnPct: number;
}

function groupBySaleTransaction(roundTrips: RoundTrip[]): GroupedTrade[] {
  const groups = new Map<string, RoundTrip[]>();

  for (const rt of roundTrips) {
    const key = `${rt.saleTransactionId}`;
    const group = groups.get(key) || [];
    group.push(rt);
    groups.set(key, group);
  }

  return Array.from(groups.values()).map((group) => {
    const totalQty = group.reduce((s, rt) => s + rt.exitQuantity, 0);
    const totalCost = group.reduce((s, rt) => s + rt.entryCost, 0);
    const totalProceeds = group.reduce((s, rt) => s + rt.exitProceeds, 0);
    const totalPnl = group.reduce((s, rt) => s + rt.realizedPnl, 0);
    // Weighted average entry price
    const avgEntryPrice = totalQty > 0 ? totalCost / totalQty : 0;
    // Use the longest holding period (most conservative)
    const maxHoldingDays = Math.max(...group.map((rt) => rt.holdingDays));

    return {
      symbol: group[0].symbol,
      entryDate: group[0].entryDate,
      entryPrice: avgEntryPrice,
      exitDate: group[0].exitDate,
      exitPrice: group[0].exitPrice,
      quantity: totalQty,
      holdingDays: maxHoldingDays,
      realizedPnl: totalPnl,
      returnPct: totalCost > 0 ? (totalPnl / totalCost) * 100 : 0,
    };
  });
}

function formatMonthLabel(periodStart: string): string {
  const d = new Date(periodStart + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
