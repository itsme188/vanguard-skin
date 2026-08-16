import type Database from "better-sqlite3";
import { jsonSchema } from "ai";
import { generateObjectForFeature } from "@/lib/ai/generate";
import { guardNarrative } from "@/lib/levels/narrative-guard";
import type { SuggestedLevel } from "./suggested-levels";
import type { OhlcBar } from "./indicators";

/**
 * Claude-written one-sentence context for each suggested S/R level.
 *
 * Cache key: (security_id, level_price, direction, YYYY-MM-DD). Daily
 * granularity balances freshness (new touches shift the story) against
 * cost (single Haiku call amortizes across a day of same-level views).
 */

const NARRATIVE_SCHEMA = jsonSchema<{ narrative: string }>({
  type: "object",
  additionalProperties: false,
  properties: {
    narrative: {
      type: "string",
      description:
        "ONE sentence, max 25 words, describing why this price level matters. No boilerplate. No hedging. Lead with the concrete reason (e.g., 'Tested as support 4 times since December, coinciding with the 50-day SMA').",
    },
  },
  required: ["narrative"],
});

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface LevelNarrativeInput {
  symbol: string;
  currentPrice: number;
  level: SuggestedLevel;
  recentBars: OhlcBar[];
}

function buildPrompt(input: LevelNarrativeInput): string {
  const { symbol, currentPrice, level, recentBars } = input;
  const tail = recentBars.slice(-20).map((b) => `${b.date}: close ${b.close}`).join("\n");
  return `You are narrating a single price level for a stock chart. Keep it concrete.

Symbol: ${symbol}
Current price: ${currentPrice}
Level: ${level.price} (${level.type})
Distance from current: ${(level.distancePct * 100).toFixed(1)}%
Touches detected: ${level.touches}
First touch: ${level.firstTouchDate}
Last touch: ${level.lastTouchDate}
Confidence: ${level.confidence}

Recent price action (last 20 sessions):
${tail}

Write exactly one sentence — max 25 words — that explains why this level is worth watching. Focus on what the pivot data shows. No generic advice, no caveats.`;
}

export async function getOrGenerateNarrative(
  db: Database.Database,
  input: LevelNarrativeInput & { securityId: number },
): Promise<string | null> {
  const day = today();
  const direction = input.level.type;

  const cached = db
    .prepare(
      `SELECT narrative FROM suggested_level_narratives
       WHERE security_id = ? AND level_price = ? AND direction = ? AND computed_at_day = ?`,
    )
    .get(input.securityId, input.level.price, direction, day) as
    | { narrative: string }
    | undefined;
  if (cached) return cached.narrative;

  try {
    const { object: _rawObject } = await generateObjectForFeature("suggestedLevelNarrative", {
      maxOutputTokens: 256,
      schema: NARRATIVE_SCHEMA,
      prompt: buildPrompt(input),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const object = _rawObject as any as { narrative: string };
    const rawNarrative = (object.narrative ?? "").trim();
    if (!rawNarrative) return null;

    // Numeric-plausibility gate (QA regression #6, 2026-08-16): a model
    // narrative sometimes states a distance figure ("N% above/below") that
    // contradicts the level's own price/currentPrice. Never store the raw
    // sentence when that happens — swap in a computed-template sentence
    // built from real data instead. See lib/levels/narrative-guard.ts.
    const narrative = guardNarrative(rawNarrative, input.currentPrice, input.level) ?? rawNarrative;

    db.prepare(
      `INSERT OR IGNORE INTO suggested_level_narratives
       (security_id, level_price, direction, narrative, computed_at_day)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(input.securityId, input.level.price, direction, narrative, day);

    return narrative;
  } catch (err) {
    console.error(
      "[narrate-levels] Haiku call failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
