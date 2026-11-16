/**
 * Per-ETF GICS sector-weight look-through.
 *
 * Finnhub's ETF sector-exposure endpoint is premium-gated (verified
 * unavailable on our tier), so weights are sourced via Claude with the
 * native web_search tool, validated to GICS-11, and cached in
 * `etf_sector_weights`. Last-good rows are the fallback — a failed or
 * implausible refresh leaves the previous quarter's rows in place.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import { normalizeSector } from "@/lib/securities/normalize-sector";
import { getRawAnthropicClient } from "@/lib/ai/provider";
import { resolveFeatureModel } from "@/lib/ai/models";
import { todayET } from "@/lib/calendar/date-utils";
import { parseJsonArrayLenient } from "@/lib/ai/extract-json";

export interface RawWeight { sector: string; weight_pct: number; }
export interface ValidatedWeights { ok: boolean; weights: RawWeight[]; reason?: string; }

const SUM_TOLERANCE = 8; // accept 92..108 before re-normalizing

export function validateSectorWeights(raw: RawWeight[]): ValidatedWeights {
  const mapped: RawWeight[] = [];
  for (const w of raw) {
    const sector = normalizeSector(w.sector);
    if (!sector || typeof w.weight_pct !== "number" || w.weight_pct < 0) continue;
    mapped.push({ sector, weight_pct: w.weight_pct });
  }
  const sum = mapped.reduce((a, w) => a + w.weight_pct, 0);
  if (mapped.length === 0 || Math.abs(sum - 100) > SUM_TOLERANCE) {
    return { ok: false, weights: mapped, reason: `sum=${sum.toFixed(1)}` };
  }
  const bySector = new Map<string, number>();
  for (const w of mapped) bySector.set(w.sector, (bySector.get(w.sector) ?? 0) + w.weight_pct);
  const weights = [...bySector.entries()].map(([sector, v]) => ({ sector, weight_pct: (v / sum) * 100 }));
  return { ok: true, weights };
}

// ── Claude + web_search fetch ──────────────────────────────────────
//
// Mirrors lib/digest/send-earnings-email.ts::callClaude — same client
// acquisition (getRawAnthropicClient), same native web_search tool block,
// same model-id derivation via resolveFeatureModel(featureKey). The model
// string is never hardcoded.

/**
 * Fetch an ETF's GICS sector breakdown via Claude + web_search.
 * Returns the raw `{sector, weight_pct}` array (unvalidated). Throws on any
 * provider / parse error — caller (refreshEtfWeights) catches and skips.
 */
export async function fetchEtfSectorWeights(symbol: string): Promise<RawWeight[]> {
  const featureKey = "etfSectorWeights";
  const { provider, modelId } = resolveFeatureModel(featureKey);
  if (provider !== "anthropic") {
    throw new Error(
      `ETF sector-weight fetch requires the Anthropic provider for native web_search; FEATURE_MODELS["${featureKey}"] resolves to ${provider}/${modelId}. Update lib/ai/models.ts.`,
    );
  }
  const client = getRawAnthropicClient(featureKey);
  const prompt = `Find the most recent published GICS sector breakdown (sector weightings) for the ETF "${symbol}". Use web_search against the fund issuer's fact sheet or a reputable data provider.

Return ONLY a JSON array of objects, each {"sector": "<GICS sector name>", "weight_pct": <number 0-100>}. The weights should sum to approximately 100. Use standard GICS-11 sector names (Energy, Materials, Industrials, Consumer Discretionary, Consumer Staples, Healthcare, Financials, Technology, Communication Services, Utilities, Real Estate). Do not include any prose, explanation, or markdown — output the raw JSON array and nothing else.`;

  const response = await client.messages.create({
    model: modelId,
    // Room for default-on thinking on the 5.5 generation (2026-11-12, was 2048).
    max_tokens: 16_000,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    messages: [{ role: "user", content: prompt }],
  });
  // A reply that stopped at the cap is not an answer, even when its text
  // parses: fail this ETF (the caller keeps its last good rows).
  if (response.stop_reason === "max_tokens") {
    throw new Error(`reply for ${symbol} was cut off at the output cap`);
  }
  const textBlocks = response.content.filter(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  // Joined with "" (house rule for web_search replies): a block boundary can
  // fall inside a token, and "\n" would split it.
  const text = textBlocks.map((b) => b.text).join("");
  // Shared lenient parse (fence-strip, whole text, then the first-[ .. last-]
  // slice, each with the C0-control-character retry); throws a plain-English
  // error for anything that is not a list.
  const items = parseJsonArrayLenient(text, `sector weights for ${symbol}`);
  return items
    .filter((w): w is Record<string, unknown> => w !== null && typeof w === "object" && typeof (w as Record<string, unknown>).sector === "string")
    .map((w) => ({ sector: w.sector as string, weight_pct: w.weight_pct as number }));
}

/**
 * Refresh cached sector weights for the given ETF symbols. Per symbol:
 * fetch → validate → on success replace the symbol's rows in a transaction;
 * on failure / implausible data, console.warn and skip (last-good rows
 * persist so look-through degrades gracefully rather than zeroing out).
 */
export async function refreshEtfWeights(
  db: Database.Database,
  symbols: string[],
): Promise<void> {
  const asOf = todayET();
  const del = db.prepare("DELETE FROM etf_sector_weights WHERE etf_symbol = ?");
  const ins = db.prepare(
    "INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES (?, ?, ?, ?, 'claude_web_search')",
  );
  const replace = db.transaction((sym: string, weights: RawWeight[]) => {
    del.run(sym);
    for (const w of weights) ins.run(sym, w.sector, w.weight_pct, asOf);
  });

  for (const symbol of symbols) {
    try {
      const raw = await fetchEtfSectorWeights(symbol);
      const validated = validateSectorWeights(raw);
      if (!validated.ok) {
        console.warn(
          `[etf-weights] ${symbol}: validation failed (${validated.reason}); keeping last-good rows`,
        );
        continue;
      }
      replace(symbol, validated.weights);
      console.log(
        `[etf-weights] ${symbol}: stored ${validated.weights.length} sector weights (as of ${asOf})`,
      );
    } catch (err) {
      console.warn(
        `[etf-weights] ${symbol}: fetch failed (${err instanceof Error ? err.message : String(err)}); keeping last-good rows`,
      );
    }
  }
}
