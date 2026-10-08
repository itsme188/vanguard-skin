import { jsonSchema } from "ai";
import { generateObjectForFeature } from "@/lib/ai/generate";
import type { GroupedTrade, RoundTripSummary } from "@/lib/compute/trade-roundtrips";
import type { TradeMarketContext } from "./market-context";

export interface TradeQuestion {
  tradeNumber: number;
  symbol: string;
  question: string;
}

export interface TradeAnswer {
  tradeNumber: number;
  answer: string;
}

/**
 * Account-specific trading profile based on account name.
 */
export interface AccountProfile {
  style: string;
  description: string;
}

/**
 * Determine the trading profile for an account based on its name.
 */
export function getAccountProfile(accountName: string): AccountProfile {
  const name = accountName.toLowerCase();

  if (name.includes("ibkr") || name.includes("interactive")) {
    return {
      style: "short-term",
      description:
        "Short-term trader — typical holding period is days to weeks. Evaluate on timing, entry/exit signals, and stop discipline.",
    };
  }

  if (name.includes("roth") || name.includes("ira")) {
    return {
      style: "long-term",
      description:
        "Long-term holder in a Roth IRA — typically holds positions for at least a year. Evaluate on thesis validity, patience, and long-term conviction. Tax-free growth environment, so no wash sale concerns.",
    };
  }

  if (name.includes("vanguard") || name.includes("brokerage")) {
    return {
      style: "mixed",
      description:
        "Mixed-style brokerage account — positions range from tactical trades to buy-and-hold to portfolio construction. Some positions are short-term, others are intentionally long-term. Evaluate each trade based on its apparent intent, which may vary.",
    };
  }

  // Default: neutral
  return {
    style: "unknown",
    description:
      "Trading style for this account is not known. Evaluate each trade based on its apparent intent from the data.",
  };
}

interface QuestionsResult {
  questions: Array<{
    trade_number: number;
    symbol: string;
    question: string;
  }>;
}

export const QUESTIONS_SCHEMA = jsonSchema<QuestionsResult>({
  type: "object",
  additionalProperties: false,
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          trade_number: {
            type: "number",
            description: "Matches the # column in the trade table",
          },
          symbol: { type: "string" },
          question: {
            type: "string",
            description:
              "A specific, concise question about this trade. Focus on intent, thesis, or circumstances that would affect grading.",
          },
        },
        required: ["trade_number", "symbol", "question"],
      },
    },
  },
  required: ["questions"],
});

function formatQty(qty: number): string {
  return qty >= 1 ? qty.toFixed(0) : qty.toPrecision(3);
}

/**
 * One line per trade for the question step. It carries the same facts the
 * full review prompt gets — direction, entry date(s), FIFO holding period and
 * whether the close was a trim or a full exit — so a question can never call
 * a trim "sold all" or say the holding period is not shown
 * (qa:analysis-trade-reviews--context-question-says-sold-all-of-position-still-held).
 * Direction comes from the lots' broker evidence (`isShort`), never inferred.
 * Pure function — no DB access.
 */
export function buildQuestionTradeTable(
  groupedTrades: GroupedTrade[],
  marketContexts: TradeMarketContext[]
): string {
  return groupedTrades
    .map((t, i) => {
      const sign = t.realizedPnl >= 0 ? "+" : "";
      const ctx = marketContexts[i];
      const hasMarketData = ctx?.stockContext !== null;
      const opened =
        t.earliestEntryDate === t.latestEntryDate
          ? t.earliestEntryDate
          : `${t.earliestEntryDate} to ${t.latestEntryDate}`;
      const action = t.isShort
        ? `short — sold to open ${opened}, bought to cover ${t.exitDate}`
        : `long — bought ${opened}, sold ${t.exitDate}`;
      const hold =
        t.lots.length > 1 && t.minHoldingDays !== t.maxHoldingDays
          ? `FIFO holding period ${t.minHoldingDays}–${t.maxHoldingDays} days`
          : `FIFO holding period ${t.maxHoldingDays} days`;
      const rp = ctx?.remainingPosition ?? null;
      const position = !rp
        ? "remaining position not known"
        : rp.isTrim
          ? `TRIM — closed ${formatQty(rp.soldShares)}, ${formatQty(rp.remainingShares)} still held (${(rp.retainedPct * 100).toFixed(0)}% of position kept)`
          : "FULL EXIT — nothing left";
      return `${i + 1}. ${t.symbol} (${action}): ${sign}$${t.realizedPnl.toFixed(0)} (${sign}${t.returnPct.toFixed(1)}%), ${formatQty(t.totalQuantity)} shares, ${t.lots.length} lot(s), ${hold}, ${position}${hasMarketData ? "" : " [no price history]"}`;
    })
    .join("\n");
}

/**
 * Generate clarifying questions about trades where context is unclear.
 * Uses Sonnet for cost efficiency (~$0.01 per call).
 * Returns empty array if all trades have sufficient context.
 */
export async function generateQuestions(
  groupedTrades: GroupedTrade[],
  summary: RoundTripSummary,
  marketContexts: TradeMarketContext[],
  accountProfile: AccountProfile
): Promise<TradeQuestion[]> {
  if (groupedTrades.length === 0) return [];

  const tradeTable = buildQuestionTradeTable(groupedTrades, marketContexts);

  const prompt = `You are reviewing ${summary.totalTrades} trade(s) for a monthly review.

ACCOUNT PROFILE: ${accountProfile.description}

TRADES:
${tradeTable}

For each trade, consider whether you have enough context to assess it fairly given the account profile. Ask a question ONLY if:
1. The holding period doesn't match the account's typical style AND the reason isn't obvious
2. The trade's intent is genuinely ambiguous (could be a deliberate strategy OR a mistake)
3. There are multiple plausible explanations that would lead to materially different grades

Do NOT ask about trades where:
- The account profile already explains the behavior (e.g., long holds in a Roth IRA)
- The outcome is so clear-cut that intent doesn't change the assessment
- You'd be asking a generic question like "what was your thesis?" for every trade

Use only the facts on each trade's line:
- The holding period and entry date(s) are shown. Never say they are missing. The holding period is FIFO (oldest matched lot to the close), so for an actively traded name it can be longer than the trader's own sense of the position.
- A trade marked TRIM closed part of a position that is still held. Never describe it as selling all of the position. Only a trade marked FULL EXIT closed the whole position.
- A short trade was sold to open and bought to cover.

Keep questions concise and specific. One question per trade maximum.`;

  const { object } = await generateObjectForFeature("tradeReviewQA", {
    maxOutputTokens: 2000,
    schema: QUESTIONS_SCHEMA,
    prompt,
  }) as unknown as { object: QuestionsResult };

  return (object.questions ?? []).map((q) => ({
    tradeNumber: q.trade_number,
    symbol: q.symbol,
    question: q.question,
  }));
}
