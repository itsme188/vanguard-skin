import type Database from "better-sqlite3";
import { generateTextForFeature, AIRefusalError } from "@/lib/ai/generate";
import { normalizeSector, GICS_SECTORS } from "@/lib/securities/normalize-sector";
import { extractJsonArray } from "@/lib/ai/extract-json";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";

export interface OptionSectorResult { classified: number; errors: string[]; }

/** Distinct underlying tickers of held options that still have a blank sector. */
export function getUnsectoredOptionUnderlyings(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT UPPER(s.underlying_symbol) AS u
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       WHERE ${latestHoldingsPredicate({})}
         AND LOWER(s.security_type) = 'option'
         AND (s.sector IS NULL OR TRIM(s.sector) = '')
         AND s.underlying_symbol IS NOT NULL AND TRIM(s.underlying_symbol) != ''`
    )
    .all() as Array<{ u: string }>;
  return rows.map((r) => r.u);
}

const SYSTEM = `You assign a GICS sector to each ticker (a stock or a sector/thematic ETF).
Return ONLY a JSON array, one object per input ticker:
{"symbol":"TICKER","sector":"<exactly one of: Energy, Materials, Industrials, Consumer Discretionary, Consumer Staples, Healthcare, Financials, Technology, Communication Services, Utilities, Real Estate>"}
For sector/thematic ETFs use the dominant GICS sector (SMH/IGV/SOXX/HACK->Technology, KRE/XLF->Financials, XLE->Energy, XLU/VPU->Utilities, ARKK->Technology). No prose, no code fences.`;

/**
 * Classify the GICS sector of each held blank-sector option's underlying ticker
 * (via Claude) and write it directly onto the option rows. The option's own
 * sector is what the cash-deploy allocation reads, so this clears them out of the
 * "Unknown" bucket. Only canonical GICS values (validated by normalizeSector) are
 * written; junk is dropped. Idempotent (only touches blank-sector options).
 */
export async function classifyOptionSectors(db: Database.Database): Promise<OptionSectorResult> {
  const underlyings = getUnsectoredOptionUnderlyings(db);
  if (underlyings.length === 0) return { classified: 0, errors: [] };

  const writeSector = db.prepare(
    `UPDATE securities SET sector = ?
     WHERE LOWER(security_type) = 'option' AND UPPER(underlying_symbol) = ?
       AND (sector IS NULL OR TRIM(sector) = '')`
  );

  let classified = 0;
  const errors: string[] = [];
  const BATCH = 30;
  for (let i = 0; i < underlyings.length; i += BATCH) {
    const batch = underlyings.slice(i, i + BATCH);
    const prompt = `Tickers:\n${batch.map((t) => `- ${t}`).join("\n")}`;
    try {
      const { text } = await generateTextForFeature("securityClassification", { maxOutputTokens: 2000, temperature: 0.1, system: SYSTEM, prompt });
      const results = JSON.parse(extractJsonArray(text)) as Array<Record<string, string>>;
      for (const r of results) {
        const gics = normalizeSector(r.sector);
        // Strict: only write a canonical GICS-11 sector. normalizeSector also
        // passes through non-GICS labels ("Diversified"/"Fixed Income") which must
        // never become an option's sector.
        if (!gics || !r.symbol || !GICS_SECTORS.includes(gics as (typeof GICS_SECTORS)[number])) continue;
        classified += writeSector.run(gics, String(r.symbol).toUpperCase()).changes;
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
