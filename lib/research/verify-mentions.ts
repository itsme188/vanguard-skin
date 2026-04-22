import { generateObject, jsonSchema } from "ai";
import { getModelForFeature } from "@/lib/ai/provider";

/**
 * Two-layer verification of ticker symbols extracted from newsletter articles.
 *
 * Layer 1 — deterministic word-boundary gate. Drops "HOOD" inside "likelihood",
 * "NET" inside "net income", URL fragments. Cheap; runs on every symbol.
 *
 * Layer 2 — Haiku verification pass. Claude gets the article excerpts
 * mentioning each surviving symbol and confirms the mention refers to the
 * publicly traded security. Drops homonyms ("Robin Hood" the outlaw, "web
 * app" acronym, "net income" accounting term) that word-boundary can't
 * distinguish. Graceful degradation: if Haiku fails, returns the
 * word-boundary-only set (still better than the current state).
 */

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True if `symbol` appears as a whole word in `text` (case-insensitive).
 * Example: hasWordBoundaryMatch("likelihood involved", "HOOD") === false
 *          hasWordBoundaryMatch("Robinhood (HOOD) reported", "HOOD") === true
 */
export function hasWordBoundaryMatch(text: string, symbol: string): boolean {
  if (!text || !symbol) return false;
  const re = new RegExp(`\\b${escapeRegex(symbol)}\\b`, "i");
  return re.test(text);
}

/**
 * Apply the deterministic word-boundary gate across subject + body. Returns
 * the surviving symbols paired with the context snippet Claude will verify.
 */
export function applyWordBoundaryGate(
  symbols: string[],
  subject: string,
  body: string,
): Array<{ symbol: string; context: string }> {
  const survivors: Array<{ symbol: string; context: string }> = [];
  for (const raw of symbols) {
    const symbol = raw.trim().toUpperCase();
    if (!symbol) continue;
    const inSubject = hasWordBoundaryMatch(subject, symbol);
    const inBody = hasWordBoundaryMatch(body, symbol);
    if (!inSubject && !inBody) continue;
    const context = extractContext(body, symbol) || extractContext(subject, symbol);
    survivors.push({ symbol, context });
  }
  return survivors;
}

function extractContext(text: string, symbol: string): string {
  if (!text) return "";
  const re = new RegExp(`[^.]{0,200}\\b${escapeRegex(symbol)}\\b[^.]{0,200}\\.?`, "i");
  const match = text.match(re);
  if (!match) return "";
  return match[0].trim().slice(0, 400);
}

// ── Haiku verification pass ────────────────────────────────────────────

interface HaikuVerdict {
  symbol: string;
  keep: boolean;
  reason: string;
}

const VERIFICATION_SCHEMA = jsonSchema<{ verdicts: HaikuVerdict[] }>({
  type: "object",
  additionalProperties: false,
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          symbol: { type: "string" },
          keep: {
            type: "boolean",
            description:
              "True only if the symbol refers to a publicly traded security actually being discussed (price, position, thesis, news). False for homonyms, URL fragments, acronyms, or generic words that happen to share letters with a ticker.",
          },
          reason: {
            type: "string",
            description: "Brief explanation — why keep or drop.",
          },
        },
        required: ["symbol", "keep", "reason"],
      },
    },
  },
  required: ["verdicts"],
});

/**
 * Ask Haiku to confirm each candidate symbol is actually referring to the
 * publicly traded security. Returns the verdict list keyed by symbol.
 *
 * On failure, returns null — caller should fall back to keeping all
 * candidates (word-boundary-gated already, so still cleaner than the
 * no-gate baseline).
 */
export async function verifyMentionsWithHaiku(
  subject: string,
  candidates: Array<{ symbol: string; context: string }>,
): Promise<Map<string, HaikuVerdict> | null> {
  if (candidates.length === 0) return new Map();

  const contextBlock = candidates
    .map(
      (c) =>
        `Symbol: ${c.symbol}\nContext: ${c.context || "(no surrounding sentence — matched only in subject line)"}`,
    )
    .join("\n\n---\n\n");

  try {
    const { object } = await generateObject({
      model: getModelForFeature("researchMentionVerification"),
      maxOutputTokens: 1024,
      schema: VERIFICATION_SCHEMA,
      prompt: `You are verifying that ticker symbols extracted from a financial newsletter actually refer to publicly traded securities being discussed, not homonyms or coincidental substring matches.

Article subject: ${subject}

For each candidate symbol below, read the surrounding context and decide whether to KEEP or DROP:
- KEEP if the symbol clearly refers to the publicly traded security (price, position, earnings, analyst rating, thesis, news about the company).
- DROP if the match is coincidental: "HOOD" in "likelihood", "NET" in "net income", "AI" as the concept not the ticker, "Robin Hood" the folk outlaw, URL fragments, etc.

Candidates:

${contextBlock}

Return one verdict per candidate in the same order. For each, set keep=true|false and give a brief reason.`,
    });

    const map = new Map<string, HaikuVerdict>();
    for (const v of object.verdicts) {
      if (v.symbol) map.set(v.symbol.toUpperCase().trim(), v);
    }
    return map;
  } catch (err) {
    console.error(
      "[verify-mentions] Haiku verification failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Full two-layer gate. Given Claude's raw extracted symbols + the article,
 * returns the subset that survives both word-boundary AND Haiku verification.
 * Falls back to word-boundary-only if Haiku errors.
 */
export async function verifyMentions(
  symbols: string[],
  subject: string,
  body: string,
): Promise<Array<{ symbol: string; context: string; reason?: string }>> {
  const gated = applyWordBoundaryGate(symbols, subject, body);
  if (gated.length === 0) return [];

  const verdicts = await verifyMentionsWithHaiku(subject, gated);
  if (!verdicts) {
    return gated.map((g) => ({
      ...g,
      reason: "word-boundary only (Haiku pass failed)",
    }));
  }

  return gated
    .map((g) => {
      const v = verdicts.get(g.symbol);
      if (!v) {
        return { ...g, reason: "no verdict; kept by default" };
      }
      if (!v.keep) return null;
      return { ...g, reason: v.reason };
    })
    .filter((g): g is { symbol: string; context: string; reason: string } => g !== null);
}
