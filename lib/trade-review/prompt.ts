import type { GroupedTrade, RoundTripSummary } from "@/lib/compute/trade-roundtrips";
import type { PriorReviewSummary } from "@/lib/queries/trade-reviews";
import type { AccountProfile, TradeAnswer } from "./questions";

/**
 * Build the system + user prompt for trade review generation.
 * Uses account-specific profiles and market context for grounded analysis.
 */
export function buildTradeReviewPrompt(
  groupedTrades: GroupedTrade[],
  summary: RoundTripSummary,
  priorReviews: PriorReviewSummary[],
  periodLabel: string,
  accountProfile: AccountProfile,
  marketContext?: string,
  answers?: TradeAnswer[]
): { system: string; user: string } {
  const system = buildSystemPrompt(priorReviews.length, accountProfile);
  const user = buildUserPrompt(
    groupedTrades,
    summary,
    priorReviews,
    periodLabel,
    marketContext,
    answers
  );
  return { system, user };
}

function buildSystemPrompt(
  priorReviewCount: number,
  accountProfile: AccountProfile
): string {
  let prompt = `You are an experienced portfolio analyst reviewing a trader's monthly activity.
You have access to their complete trading data for this month, price history, benchmark comparisons, and summaries of prior months.
Your job is to provide specific, evidence-based analysis using the actual data provided.

ACCOUNT PROFILE:
${accountProfile.description}

GRADING RUBRIC — Grade each trade A through F:
- A: Well-executed given the apparent intent. Good timing relative to price action, appropriate sizing, thesis (if stated) played out.
- B: Solid trade with minor improvements possible. Entry or exit could have been slightly better.
- C: Acceptable but with clear missed opportunities. Timing was off, or the trade drifted from its likely intent.
- D: Poor execution — significant money left on the table, or position management was lacking.
- F: Clear mistake — the data shows a materially bad decision regardless of intent.

ANALYSIS FRAMEWORK — For each trade, assess:
1. Outcome: What happened in terms of price movement and P&L?
2. Timing: How did entry/exit timing look relative to the stock's price range during the hold?
3. Context: If market data is available, how did the trade compare to SPY over the same period?
4. Sizing: Was position sizing appropriate relative to portfolio (if data available)?

MONTHLY SUMMARY MUST INCLUDE:
1. Win rate and expectancy analysis
2. Best and worst trades with specific observations from the data
3. Patterns observed this month (positive and negative)
4. Three specific recommendations grounded in what the data shows

REVIEW_MARKDOWN IS THE PRIMARY DELIVERABLE:
The review_markdown field is the most important output and MUST be a substantive markdown report (at least 1500 characters, typically 2000-5000) covering: monthly overview, per-trade analysis (one paragraph per trade with specific data), patterns, and three concrete recommendations. Do NOT return an empty or short review_markdown — that's a hard failure. Per-trade trade_grades are secondary; keep each grade's assessment / what_worked / what_didnt concise (1-2 sentences each).

CRITICAL RULES:
- Be analytical and constructive. Write as a knowledgeable colleague, not an authority figure.
- Never use emergency language, moralizing, or condescending framing.
- Never suggest paper trading, journaling homework, or trading boot camp exercises.
- If the trader provided notes about a trade, use them as the authoritative context — do not override their stated intent.
- If no notes were provided and intent is unclear, say "intent unclear from data" — do not fabricate an entry thesis.
- Reference actual prices, dates, and percentages from the data. "Exited at $35.98, 28% below the period high of $49.75" is better than "sold too early."
- Use market context when available to ground your analysis. "Underperformed SPY by 27% over the same period" adds real information.
- If market context shows benchmark or price data as "unavailable" or "insufficient", state that clearly. NEVER estimate, guess, or recall benchmark returns from your training data. Say "SPY data unavailable for this period" — do not write "SPY likely returned 30-50%" or similar.
- When a trade is marked as a TRIM (retained shares listed), analyze it as a position reduction — not a full exit. Consider why the trader kept the remaining shares.
- When concurrent buys are listed near a sale, analyze the capital rotation. What did the trader redeploy into? Is there a sector/thesis connection between the sell and the buys?
- ⚠️ When the market context shows "OPTION-DRIVEN ACTIVITY on <symbol>" near a stock trade, the shares almost certainly came from (or went to) an option exercise/assignment. Narrate the trade as the option play: opened option → exercised/assigned → share movement. Do NOT describe it as an isolated stock buy and stock sell — that misses the trader's intent. Example: "The 4/13 RSP sell at $196 isn't a stock-only trade — 5 long $190 calls were exercised on 4/10 (cost $1,755 in premium), assigning 500 shares at $190 strike, which the trader sold three days later for ~$3,000 net profit." FIFO tax-lot accounting may match the sale against earlier same-symbol lots, but the economic substance is the option flow.
- The trade count in the summary matches the number of trades in the table. Each row is one trade (which may have consumed multiple tax lots via FIFO).
- When there is only 1 trade this month, skip win rate, profit factor, and best/worst trade analysis — they are tautological with N=1. Focus the monthly summary entirely on that trade's execution, context, and patterns.
- IMPORTANT: The "Days" column shows FIFO holding periods — the time between the oldest matched tax lot's acquisition and the sale. For actively traded securities, this does NOT reflect how long the trader perceived holding the position. A trader who buys 100 shares on Monday and sells Tuesday may show "90 days" because FIFO matched against a lot from 3 months ago. Do NOT use holding days to judge discipline or intent. Focus on sale dates, P&L, and any trader-provided notes instead.`;

  if (priorReviewCount >= 3) {
    prompt += `

CUMULATIVE PATTERN ANALYSIS (${priorReviewCount} prior months available):
Look for multi-month patterns supported by evidence:
1. Holding period trends: are holds getting shorter/longer? Is that helping?
2. Win rate trajectory: improving, declining, or stable?
3. Sizing patterns: does position sizing correlate with outcomes?
4. Sector/style patterns: certain types of trades working better than others?
5. Recovery patterns: how does the next trade look after a loss?

Report ONLY patterns you actually observe with evidence from the data. Don't speculate.`;
  }

  return prompt;
}

function buildUserPrompt(
  groupedTrades: GroupedTrade[],
  summary: RoundTripSummary,
  priorReviews: PriorReviewSummary[],
  periodLabel: string,
  marketContext?: string,
  answers?: TradeAnswer[]
): string {
  const parts: string[] = [];

  parts.push(`# Trade Review Request: ${periodLabel}`);

  // Summary metrics — simplified for single-trade months
  if (summary.totalTrades === 1) {
    parts.push(`
## Summary
- Total trades: 1
- P&L: $${summary.totalRealizedPnl.toFixed(2)}
- Holding: ${summary.avgHoldingDays.toFixed(0)} days`);
  } else {
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
  }

  // Grouped trade table
  parts.push(`\n## This Month's Trades\n`);
  parts.push(
    "| # | Symbol | Entry Date(s) | Avg Entry | Exit Date | Exit Price | Qty | Days | P&L | Return |"
  );
  parts.push(
    "|---|--------|---------------|-----------|-----------|------------|-----|------|-----|--------|"
  );

  groupedTrades.forEach((trade, i) => {
    const pnlSign = trade.realizedPnl >= 0 ? "+" : "";
    const entryDates =
      trade.lots.length === 1
        ? trade.earliestEntryDate
        : `${trade.earliestEntryDate} – ${trade.latestEntryDate}`;

    parts.push(
      `| ${i + 1} | ${trade.symbol} | ${entryDates} | $${trade.avgEntryPrice.toFixed(2)} | ${trade.exitDate} | $${trade.exitPrice.toFixed(2)} | ${formatQty(trade.totalQuantity)} | ${trade.avgHoldingDays} | ${pnlSign}$${trade.realizedPnl.toFixed(2)} | ${pnlSign}${trade.returnPct.toFixed(1)}% |`
    );

    // Show lot breakdown for multi-lot trades
    if (trade.lots.length > 1) {
      const lotDetail = trade.lots
        .map(
          (lot) =>
            `  - Lot: ${lot.entryDate} @ $${lot.entryPrice.toFixed(2)}, ${lot.exitQuantity} shares, ${lot.holdingDays}d, ${lot.realizedPnl >= 0 ? "+" : ""}$${lot.realizedPnl.toFixed(2)}`
        )
        .join("\n");
      parts.push(`\n${lotDetail}\n`);
    }
  });

  // Market context (enriched from DB)
  if (marketContext) {
    parts.push(`\n## Market Context\n${marketContext}`);
  }

  // Trader's notes (from Q&A answers)
  if (answers && answers.length > 0) {
    parts.push(`\n## Trader's Notes\n`);
    for (const ans of answers) {
      const trade = groupedTrades[ans.tradeNumber - 1];
      if (trade) {
        parts.push(
          `**Trade ${ans.tradeNumber} (${trade.symbol}):** ${ans.answer}`
        );
      }
    }
  }

  // Prior month summaries
  if (priorReviews.length > 0) {
    parts.push(`\n## Prior Month Summaries (most recent first)\n`);
    for (const pr of priorReviews) {
      const monthLabel = formatMonthLabel(pr.periodStart);
      parts.push(
        `### ${monthLabel}: ${pr.totalTrades} trades, ${(pr.winRate * 100).toFixed(0)}% win rate, $${pr.totalRealizedPnl.toFixed(0)} P&L, ${pr.profitFactor?.toFixed(1) ?? "N/A"}x profit factor`
      );
      // Include more context than before (1000 chars vs 500)
      const truncated = pr.reviewMarkdown.slice(0, 1000);
      parts.push(truncated + (pr.reviewMarkdown.length > 1000 ? "..." : ""));
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

  if (summary.totalTrades === 1) {
    parts.push(
      `\nPlease analyze this single trade and produce the monthly review using the submit_trade_review tool. Focus on the trade's execution, timing, and context — skip win rate and profit factor analysis.`
    );
  } else {
    parts.push(
      `\nPlease analyze all ${summary.totalTrades} trade(s) and produce the monthly review using the submit_trade_review tool.`
    );
  }

  return parts.join("\n");
}

function formatQty(qty: number): string {
  return qty >= 1 ? qty.toFixed(0) : qty.toPrecision(3);
}

function formatMonthLabel(periodStart: string): string {
  const d = new Date(periodStart + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
