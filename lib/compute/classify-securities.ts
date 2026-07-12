/**
 * Security classification engine.
 *
 * Runs through all securities and applies classification data from multiple
 * sources in priority order:
 * 1. Skip already-classified (manual or tws source — don't overwrite)
 * 2. Static lookup by symbol (ETFs, funds, well-known stocks)
 * 3. Auto-classify by security_type (bonds → Fixed Income, options → inherit from underlying)
 * 4. Fix known misclassifications (e.g., VMFXX as "stock" → "money_market")
 *
 * Idempotent — safe to run repeatedly. Respects manual overrides.
 */

import type Database from "better-sqlite3";
import { SECURITY_CLASSIFICATIONS } from "@/lib/data/security-classifications";
import { generateTextForFeature, AIRefusalError } from "@/lib/ai/generate";
import { extractJsonArray } from "@/lib/ai/extract-json";
import { normalizeFundCategory } from "@/lib/securities/normalize-fund-category";

export interface ClassificationResult {
  /** Total securities processed */
  total: number;
  /** Newly classified this run */
  classified: number;
  /** Already had classification (skipped) */
  skipped: number;
  /** Could not classify (no lookup, no rule) */
  unresolved: Array<{ id: number; symbol: string; security_type: string | null }>;
}

export function classifySecurities(db: Database.Database): ClassificationResult {
  const securities = db
    .prepare(
      `SELECT id, symbol, name, security_type, asset_class,
              fund_category, classification_source
       FROM securities`
    )
    .all() as Array<{
      id: number;
      symbol: string;
      name: string | null;
      security_type: string | null;
      asset_class: string | null;
      fund_category: string | null;
      classification_source: string | null;
    }>;

  const updateStmt = db.prepare(`
    UPDATE securities SET
      fund_category = ?,
      geography = ?,
      market_cap_category = ?,
      style = ?,
      classification_source = ?
    WHERE id = ?
  `);

  const fixTypeStmt = db.prepare(`
    UPDATE securities SET security_type = ? WHERE id = ?
  `);

  let classified = 0;
  let skipped = 0;
  const unresolved: ClassificationResult["unresolved"] = [];

  const classify = db.transaction(() => {
    for (const sec of securities) {
      // Skip already-classified securities
      if (sec.classification_source) {
        skipped++;
        continue;
      }

      // 1. Try static lookup by symbol
      const lookup = SECURITY_CLASSIFICATIONS[sec.symbol];
      if (lookup) {
        updateStmt.run(
          normalizeFundCategory(lookup.fund_category),
          lookup.geography,
          lookup.market_cap_category ?? null,
          lookup.style ?? null,
          "static_lookup",
          sec.id
        );
        // Fix misclassified security_type if specified
        if (lookup.fix_security_type) {
          fixTypeStmt.run(lookup.fix_security_type, sec.id);
        }
        classified++;
        continue;
      }

      // 2. Auto-classify by security_type
      if (sec.security_type?.toLowerCase() === "bond") {
        updateStmt.run("US Treasury", "US", null, null, "auto", sec.id);
        classified++;
        continue;
      }

      if (sec.security_type?.toLowerCase() === "money_market" || sec.security_type?.toLowerCase() === "money market") {
        updateStmt.run("Cash Equivalent", "US", null, null, "auto", sec.id);
        classified++;
        continue;
      }

      // 3. Options — extract underlying symbol and inherit
      if (
        sec.security_type?.toLowerCase() === "option" ||
        sec.security_type?.toLowerCase() === "equity and index options"
      ) {
        const underlying = extractUnderlyingSymbol(sec.symbol, sec.name);
        if (underlying) {
          const parentLookup = SECURITY_CLASSIFICATIONS[underlying];
          if (parentLookup) {
            updateStmt.run(
              normalizeFundCategory(parentLookup.fund_category),
              parentLookup.geography,
              parentLookup.market_cap_category ?? null,
              parentLookup.style ?? null,
              "auto_option",
              sec.id
            );
            classified++;
            continue;
          }
        }
        // Options on unknown underlyings — mark as auto with generic category
        updateStmt.run("Options", "US", null, null, "auto_option", sec.id);
        classified++;
        continue;
      }

      // 4. Forex
      if (sec.security_type?.toLowerCase() === "forex") {
        updateStmt.run("Currency", "Global", null, null, "auto", sec.id);
        classified++;
        continue;
      }

      // 5. Forecast/prediction contracts (stored in security_type or asset_class)
      if (
        sec.security_type?.toLowerCase() === "forecast contracts by forecastex" ||
        sec.asset_class === "Forecast Contracts by ForecastEx"
      ) {
        updateStmt.run("Prediction Market", "US", null, null, "auto", sec.id);
        classified++;
        continue;
      }

      // 6. Vanguard-imported options (security_type = "stock"/null but name starts with CALL/PUT)
      if (sec.name && /^(CALL|PUT)\s/.test(sec.name)) {
        const parentLookup = SECURITY_CLASSIFICATIONS[sec.symbol];
        if (parentLookup) {
          updateStmt.run(
            normalizeFundCategory(parentLookup.fund_category),
            parentLookup.geography,
            parentLookup.market_cap_category ?? null,
            parentLookup.style ?? null,
            "auto_option",
            sec.id
          );
        } else {
          updateStmt.run("Options", "US", null, null, "auto_option", sec.id);
        }
        classified++;
        continue;
      }

      // Unresolved — couldn't classify
      unresolved.push({
        id: sec.id,
        symbol: sec.symbol,
        security_type: sec.security_type,
      });
    }
  });

  classify();

  return {
    total: securities.length,
    classified,
    skipped,
    unresolved,
  };
}

const AI_CLASSIFY_SYSTEM = `You classify securities. Return ONLY a JSON array, one object per input symbol, each:
{"symbol":"...","fund_category":"...","geography":"US|International|Global|Emerging","market_cap_category":"Large|Mid|Small|null","style":"Growth|Value|Blend|null"}
fund_category: for US single-name stocks and US sector funds use the scheme "US Sector Equity (<Sector>)" — e.g. "US Sector Equity (Technology)", "US Sector Equity (Semiconductors)", "US Sector Equity (Health Care)", "US Sector Equity (Financial)". Never emit a bare sector name like "Technology". Other valid examples: "US Large Cap Equity", "US Small Cap Equity", "International Equity", "Diversified Bond", "US Treasury". No prose, no code fences.`;

export interface AiFallbackResult { classified: number; errors: string[]; }

/**
 * The classify prompt's enums include a literal `null` token ("Large|Mid|Small|null"),
 * so the model sometimes returns the STRING "null" — truthy, so `|| null` passes it
 * through and it renders as a category row literally labeled "null". Normalize any
 * null-ish string to a real null at the write boundary.
 */
function cleanEnumValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === "" || /^(null|none|n\/a)$/i.test(trimmed)) return null;
  return trimmed;
}

export async function classifyUnresolvedWithClaude(
  db: Database.Database,
  unresolved: Array<{ id: number; symbol: string; security_type: string | null }>
): Promise<AiFallbackResult> {
  if (unresolved.length === 0) return { classified: 0, errors: [] };
  const update = db.prepare(`
    UPDATE securities SET fund_category = ?, geography = ?, market_cap_category = ?, style = ?, classification_source = 'auto_ai'
    WHERE id = ?`);
  let classified = 0;
  const errors: string[] = [];
  const BATCH = 25;
  for (let i = 0; i < unresolved.length; i += BATCH) {
    const batch = unresolved.slice(i, i + BATCH);
    const prompt = `Classify:\n${batch.map((s) => `- ${s.symbol} (type: ${s.security_type ?? "stock"})`).join("\n")}`;
    try {
      // No `temperature` — tier-resolved models can reject it as deprecated (QA 2026-07-07).
      const { text } = await generateTextForFeature("securityClassification", { maxOutputTokens: 4000, system: AI_CLASSIFY_SYSTEM, prompt });
      const json = extractJsonArray(text);
      const results = JSON.parse(json) as Array<Record<string, string>>;
      const idMap = new Map(batch.map((s) => [s.symbol, s.id]));
      for (const r of results) {
        const id = idMap.get(r.symbol);
        if (!id) continue;
        update.run(normalizeFundCategory(r.fund_category), cleanEnumValue(r.geography), cleanEnumValue(r.market_cap_category), cleanEnumValue(r.style), id);
        classified++;
      }
    } catch (err) {
      if (err instanceof AIRefusalError) {
        errors.push(`Batch ${i / BATCH + 1}: AI refusal`);
        continue;
      }
      errors.push(`Batch ${i / BATCH + 1}: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }
  return { classified, errors };
}

/**
 * Extract the underlying stock symbol from an option symbol.
 *
 * Handles two formats:
 * - IBKR style: "AAPL 12SEP25 235 P" → "AAPL"
 * - Vanguard style (in the securities.name field): "CALL APPLOVIN CORP $700 EXP 02/20/26"
 *   The symbol itself is the underlying: "APP"
 */
function extractUnderlyingSymbol(
  symbol: string,
  name: string | null
): string | null {
  // IBKR option format: "AAPL 12SEP25 235 P" — underlying is the first token
  const ibkrMatch = symbol.match(/^([A-Z]+)\s+\d{2}[A-Z]{3}\d{2}/);
  if (ibkrMatch) {
    return ibkrMatch[1];
  }

  // For Vanguard-imported options, the symbol field IS the underlying ticker
  // (e.g., symbol="APP", name="CALL APPLOVIN CORP $700 EXP 02/20/26 CL A")
  // These are stored with security_type not matching "Equity and Index Options"
  // but we still handle them by returning the symbol directly if the name suggests
  // it's a CALL or PUT
  if (name && /^(CALL|PUT)\s/.test(name)) {
    return symbol;
  }

  return null;
}
