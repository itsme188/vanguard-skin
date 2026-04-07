import Anthropic from "@anthropic-ai/sdk";
import type { GroupedTrade, RoundTripSummary } from "@/lib/compute/trade-roundtrips";
import type { TradeMarketContext } from "./market-context";

const QUESTION_MODEL = "claude-sonnet-4-20250514";

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

/** Tool schema for question generation */
const QUESTIONS_TOOL: Anthropic.Tool = {
  name: "submit_questions",
  description:
    "Submit clarifying questions about trades where the intent or context is unclear. Only ask about trades where additional context would materially change the assessment. Return an empty array if all trades have sufficient context.",
  input_schema: {
    type: "object" as const,
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
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
  },
};

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

  const tradeTable = groupedTrades
    .map((t, i) => {
      const sign = t.realizedPnl >= 0 ? "+" : "";
      const hasMarketData = marketContexts[i]?.stockContext !== null;
      return `${i + 1}. ${t.symbol}: sold ${t.exitDate}, ${sign}$${t.realizedPnl.toFixed(0)} (${sign}${t.returnPct.toFixed(1)}%), ${t.totalQuantity >= 1 ? t.totalQuantity.toFixed(0) : t.totalQuantity.toPrecision(3)} shares, ${t.lots.length} lot(s)${hasMarketData ? "" : " [no price history]"}`;
    })
    .join("\n");

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

Keep questions concise and specific. One question per trade maximum.`;

  const client = new Anthropic();
  const response = await client.messages.create({
    model: QUESTION_MODEL,
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
    tools: [QUESTIONS_TOOL],
    tool_choice: { type: "tool", name: "submit_questions" },
  });

  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") return [];

  const result = toolBlock.input as {
    questions: Array<{
      trade_number: number;
      symbol: string;
      question: string;
    }>;
  };

  return result.questions.map((q) => ({
    tradeNumber: q.trade_number,
    symbol: q.symbol,
    question: q.question,
  }));
}
