/**
 * Auto-classify security factor exposures using Claude API.
 * Uses the user's CSV data as training examples, then asks Claude to
 * classify remaining individual stocks and ETFs using the same schema.
 */

import type Database from "better-sqlite3";
import { generateTextForFeature, AIRefusalError } from "@/lib/ai/generate";
import { FACTOR_COLUMNS, FACTOR_LABELS, type FactorColumn } from "@/lib/factors";
import { normalizeSector } from "@/lib/securities/normalize-sector";
import { extractJsonArray } from "@/lib/ai/extract-json";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";

export interface FactorClassifyResult {
  classified: number;
  skipped: number;
  errors: string[];
  /** Securities that actually needed Claude this run — 0 means "nothing to do", not "the run failed". */
  candidates: number;
  /** Securities rows created for option underlyings that didn't exist yet (options on non-held names). */
  underlyingsCreated: number;
}

/** A run is a failure only when it classified nothing AND hit errors. */
export function isFactorClassifySuccess(r: { classified: number; errors: string[] }): boolean {
  return !(r.classified === 0 && r.errors.length > 0);
}

// Training examples extracted from the user's CSV — representative spread
const TRAINING_EXAMPLES = [
  { symbol: "AAPL", sector: "Technology", industry: "Consumer Electronics", interest_rate_sensitive: "Low", growth_vs_value: "Growth", cyclical: "Moderate", international_exposure: "High", geopolitical_onshoring: "Moderate", tariff_exposure: "High", ai_exposure: "Moderate", crypto_adjacent: "No", regulatory_risk: "Low" },
  { symbol: "JPM", sector: "Financials", industry: "Banks", interest_rate_sensitive: "High", growth_vs_value: "Value", cyclical: "High", international_exposure: "High", geopolitical_onshoring: "Low", tariff_exposure: "Low", ai_exposure: "Moderate", crypto_adjacent: "Moderate", regulatory_risk: "High" },
  { symbol: "TSM", sector: "Technology", industry: "Semiconductors", interest_rate_sensitive: "Low", growth_vs_value: "Growth", cyclical: "High", international_exposure: "International", geopolitical_onshoring: "Low", tariff_exposure: "Very High", ai_exposure: "Very High", crypto_adjacent: "No", regulatory_risk: "Very High" },
  { symbol: "XOM", sector: "Energy", industry: "Oil & Gas", interest_rate_sensitive: "Moderate", growth_vs_value: "Value", cyclical: "High", international_exposure: "High", geopolitical_onshoring: "Low", tariff_exposure: "Moderate", ai_exposure: "Low", crypto_adjacent: "No", regulatory_risk: "Moderate" },
  { symbol: "UNH", sector: "Healthcare", industry: "Health Insurance", interest_rate_sensitive: "Low", growth_vs_value: "Value", cyclical: "Low", international_exposure: "Low", geopolitical_onshoring: "Low", tariff_exposure: "Low", ai_exposure: "Moderate", crypto_adjacent: "No", regulatory_risk: "High" },
  { symbol: "GOOG", sector: "Communication Services", industry: "Internet", interest_rate_sensitive: "Low", growth_vs_value: "Growth", cyclical: "Moderate", international_exposure: "Moderate", geopolitical_onshoring: "Low", tariff_exposure: "Moderate", ai_exposure: "Very High", crypto_adjacent: "No", regulatory_risk: "Very High" },
  { symbol: "HD", sector: "Consumer Discretionary", industry: "Home Improvement", interest_rate_sensitive: "High", growth_vs_value: "Value", cyclical: "High", international_exposure: "Low", geopolitical_onshoring: "Low", tariff_exposure: "High", ai_exposure: "Low", crypto_adjacent: "No", regulatory_risk: "Low" },
  { symbol: "MP", sector: "Materials", industry: "Mining", interest_rate_sensitive: "Moderate", growth_vs_value: "Value", cyclical: "High", international_exposure: "Low", geopolitical_onshoring: "Very High", tariff_exposure: "Low", ai_exposure: "Low", crypto_adjacent: "No", regulatory_risk: "Moderate" },
  { symbol: "VRT", sector: "Technology", industry: "Data Centers", interest_rate_sensitive: "Moderate", growth_vs_value: "Growth", cyclical: "High", international_exposure: "Moderate", geopolitical_onshoring: "Moderate", tariff_exposure: "Low", ai_exposure: "Very High", crypto_adjacent: "Moderate", regulatory_risk: "Low" },
  { symbol: "HOOD", sector: "Financials", industry: "Brokerage", interest_rate_sensitive: "Moderate", growth_vs_value: "Growth", cyclical: "High", international_exposure: "Low", geopolitical_onshoring: "Low", tariff_exposure: "Low", ai_exposure: "Moderate", crypto_adjacent: "Very High", regulatory_risk: "High" },
];

const SYSTEM_PROMPT = `You are a portfolio analyst classifying securities by thematic factor exposure.

For each security, assign values for these 9 factors:

${FACTOR_COLUMNS.map((col) => `- ${FACTOR_LABELS[col]} (${col})`).join("\n")}

Factor value scales:
- interest_rate_sensitive: Low / Moderate / High
- growth_vs_value: Growth / Value
- cyclical: Low / Moderate / High
- international_exposure: Low / Moderate / High / International (use "International" only for companies primarily based/operating outside the US)
- geopolitical_onshoring: Low / Moderate / High / Very High
- tariff_exposure: Low / Moderate / High / Very High
- ai_exposure: No / Low / Moderate / High / Very High
- crypto_adjacent: No / Moderate / Very High
- regulatory_risk: Low / Moderate / High / Very High

Also provide sector (GICS level 1) and industry (more specific).

Here are examples of how securities have been classified:

${TRAINING_EXAMPLES.map((ex) =>
  `${ex.symbol} (${ex.sector}/${ex.industry}): interest_rate_sensitive=${ex.interest_rate_sensitive}, growth_vs_value=${ex.growth_vs_value}, cyclical=${ex.cyclical}, international_exposure=${ex.international_exposure}, geopolitical_onshoring=${ex.geopolitical_onshoring}, tariff_exposure=${ex.tariff_exposure}, ai_exposure=${ex.ai_exposure}, crypto_adjacent=${ex.crypto_adjacent}, regulatory_risk=${ex.regulatory_risk}`
).join("\n")}

For ETFs, classify based on the fund's overall exposure profile (e.g., QQQ has Very High AI exposure, SPY has Moderate across most factors).

Return ONLY a JSON array. No markdown fences. Each element:
{"symbol":"...","sector":"...","industry":"...","interest_rate_sensitive":"...","growth_vs_value":"...","cyclical":"...","international_exposure":"...","geopolitical_onshoring":"...","tariff_exposure":"...","ai_exposure":"...","crypto_adjacent":"...","regulatory_risk":"..."}`;

// Security types to skip (they don't need factor classification)
const SKIP_TYPES = new Set([
  "bond", "money_market", "money market", "forex", "forecast contracts by forecastex",
]);

export async function classifyFactors(
  db: Database.Database
): Promise<FactorClassifyResult> {
  // Find securities that need factor classification:
  // - Have active holdings (quantity != 0 — shorts carry factor exposure too,
  //   and every read surface counts them; `> 0` left PINS/FEZ unclassifiable)
  // - Not already in security_factors
  // - Not an option (options inherit from underlying at query time)
  const unclassified = db
    .prepare(
      `SELECT DISTINCT s.id, s.symbol, s.name, s.security_type
       FROM securities s
       JOIN holdings h ON h.security_id = s.id AND h.quantity != 0
       LEFT JOIN security_factors sf ON sf.security_id = s.id
       WHERE sf.security_id IS NULL
         AND s.underlying_symbol IS NULL
         AND (s.maturity_date IS NULL OR s.maturity_date >= date('now'))
       ORDER BY s.symbol`
    )
    .all() as Array<{
      id: number;
      symbol: string;
      name: string | null;
      security_type: string | null;
    }>;

  // Underlyings of currently-held, unexpired options. Options never get their
  // own factor rows — they inherit from the underlying at query time (see
  // getFactorHeatmap) — but that only works when the underlying HAS a factor
  // row. Underlyings the user doesn't hold directly (covered by the option
  // alone) never enter the holdings-joined query above, so they're gathered
  // here; missing securities rows are created (symbol-only, enriched later by
  // TWS) so the factor row has somewhere to live.
  const optionUnderlyings = db
    .prepare(
      `SELECT DISTINCT s.underlying_symbol AS symbol,
              u.id AS existing_id, u.name, u.security_type
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       LEFT JOIN securities u ON u.symbol = s.underlying_symbol
       LEFT JOIN security_factors usf ON usf.security_id = u.id
       WHERE ${latestHoldingsPredicate({})}
         AND s.underlying_symbol IS NOT NULL
         AND (s.expiration_date IS NULL OR s.expiration_date >= date('now'))
         AND usf.security_id IS NULL
       ORDER BY s.underlying_symbol`
    )
    .all() as Array<{
      symbol: string;
      existing_id: number | null;
      name: string | null;
      security_type: string | null;
    }>;

  let underlyingsCreated = 0;
  const seenIds = new Set(unclassified.map((s) => s.id));
  const insertUnderlying = db.prepare(
    `INSERT INTO securities (symbol, source_key) VALUES (?, ?)`
  );
  for (const u of optionUnderlyings) {
    let id = u.existing_id;
    if (id === null) {
      id = Number(insertUnderlying.run(u.symbol, `underlying:${u.symbol}`).lastInsertRowid);
      underlyingsCreated++;
    }
    if (seenIds.has(id)) continue; // already a direct candidate (held stock that's also an underlying)
    seenIds.add(id);
    unclassified.push({ id, symbol: u.symbol, name: u.name, security_type: u.security_type });
  }

  // Set simple defaults for bonds, money market, etc.
  let skipped = 0;
  const toClassify: typeof unclassified = [];

  const upsertFactor = db.prepare(`
    INSERT INTO security_factors
      (security_id, interest_rate_sensitive, growth_vs_value, cyclical,
       international_exposure, geopolitical_onshoring, tariff_exposure,
       ai_exposure, crypto_adjacent, regulatory_risk,
       factor_source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(security_id) DO UPDATE SET
      interest_rate_sensitive = excluded.interest_rate_sensitive,
      growth_vs_value = excluded.growth_vs_value,
      cyclical = excluded.cyclical,
      international_exposure = excluded.international_exposure,
      geopolitical_onshoring = excluded.geopolitical_onshoring,
      tariff_exposure = excluded.tariff_exposure,
      ai_exposure = excluded.ai_exposure,
      crypto_adjacent = excluded.crypto_adjacent,
      regulatory_risk = excluded.regulatory_risk,
      factor_source = excluded.factor_source,
      updated_at = excluded.updated_at
  `);

  for (const sec of unclassified) {
    if (sec.security_type && SKIP_TYPES.has(sec.security_type.toLowerCase())) {
      // Set defaults for bonds, money market, etc.
      const isBond = sec.security_type?.toLowerCase() === "bond";
      upsertFactor.run(
        sec.id,
        isBond ? "High" : "Low",    // interest_rate_sensitive
        "Value",                      // growth_vs_value
        "Low",                        // cyclical
        "Low",                        // international_exposure
        "Low",                        // geopolitical_onshoring
        "Low",                        // tariff_exposure
        "No",                         // ai_exposure
        "No",                         // crypto_adjacent
        "Low",                        // regulatory_risk
        "auto_default"
      );
      skipped++;
    } else {
      toClassify.push(sec);
    }
  }

  if (toClassify.length === 0) {
    return { classified: 0, skipped, errors: [], candidates: 0, underlyingsCreated };
  }

  // Batch and classify with Claude
  const BATCH_SIZE = 25;
  let classified = 0;
  const errors: string[] = [];

  for (let i = 0; i < toClassify.length; i += BATCH_SIZE) {
    const batch = toClassify.slice(i, i + BATCH_SIZE);
    const prompt = `Classify these securities:\n\n${batch
      .map((s) => `- ${s.symbol}: ${s.name ?? "Unknown"} (type: ${s.security_type ?? "stock"})`)
      .join("\n")}`;

    try {
      const { text } = await generateTextForFeature("factorClassification", {
        maxOutputTokens: 8000,
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        prompt,
      });

      // Strip fences + isolate the JSON array (the model sometimes prepends a
      // prose preamble like "I need to ..." before the array).
      const jsonText = extractJsonArray(text);

      const results = JSON.parse(jsonText) as Array<Record<string, string>>;

      // Build symbol → security_id map for this batch
      const idMap = new Map(batch.map((s) => [s.symbol, s.id]));

      for (const result of results) {
        const secId = idMap.get(result.symbol);
        if (!secId) continue;

        upsertFactor.run(
          secId,
          result.interest_rate_sensitive ?? null,
          result.growth_vs_value ?? null,
          result.cyclical ?? null,
          result.international_exposure ?? null,
          result.geopolitical_onshoring ?? null,
          result.tariff_exposure ?? null,
          result.ai_exposure ?? null,
          result.crypto_adjacent ?? null,
          result.regulatory_risk ?? null,
          "auto"
        );

        // Also update sector/industry on the securities table
        if (result.sector || result.industry) {
          db.prepare(
            "UPDATE securities SET sector = COALESCE(?, sector), industry = COALESCE(NULLIF(industry,''), ?) WHERE id = ?"
          ).run(normalizeSector(result.sector ?? null), result.industry ?? result.sector ?? null, secId);
        }

        classified++;
      }
    } catch (err) {
      if (err instanceof AIRefusalError) {
        errors.push(`Batch ${i / BATCH_SIZE + 1}: AI refusal`);
        continue;
      }
      const msg = err instanceof Error ? err.message : "Unknown error";
      errors.push(`Batch ${i / BATCH_SIZE + 1}: ${msg}`);
    }
  }

  return { classified, skipped, errors, candidates: toClassify.length, underlyingsCreated };
}
