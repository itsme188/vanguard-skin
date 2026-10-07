import type Database from "better-sqlite3";
import { generateTextForFeature, AIRefusalError } from "@/lib/ai/generate";
import { normalizeSector, GICS_SECTORS } from "@/lib/securities/normalize-sector";
import { parseJsonArrayLenient } from "@/lib/ai/extract-json";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { issuerSiblings } from "@/lib/securities/issuer-family";

export interface OptionSectorResult {
  /** Option rows given a sector this run (inherited + AI). */
  classified: number;
  /** Of `classified`, the rows that took their underlying's stored sector (no AI). */
  inherited: number;
  errors: string[];
}

/**
 * `securities.sector_source` values this module stamps on an OPTION row
 * (migration 071's provenance column).
 *  - `underlying_inherited` (new 2026-10-07): the sector was copied from the
 *    underlying's stored sector.
 *  - `ai_classify` (the existing value for an AI-assigned sector): the
 *    underlying was unknown or had no sector, so the AI was asked.
 * Both mean "derived, safe to re-derive". Any other non-null source on an
 * option row (`csv_import`, `gics_verified`, `tws_bloomberg`) was put there by
 * an import, the verification sweep or the broker and is never overwritten here.
 */
export const OPTION_SECTOR_SOURCE_INHERITED = "underlying_inherited";
export const OPTION_SECTOR_SOURCE_AI = "ai_classify";

/** Distinct underlying tickers of held options that still have a blank sector. */
export function getUnsectoredOptionUnderlyings(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT UPPER(TRIM(s.underlying_symbol)) AS u
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

export interface UnderlyingSector {
  /** The non-option security row the sector was read from. */
  securityId: number;
  /** That row's stored sector after `normalizeSector` (GICS-11, or the
   *  pass-through fund labels "Diversified" / "Fixed Income"). */
  sector: string;
}

/**
 * The stored sector of an option's underlying, or null when the option must
 * not inherit: the underlying symbol matches no non-option security row, or
 * every matching row's sector is blank or a spelling `normalizeSector` rejects.
 *
 * Matching is case-insensitive and share-class aware, the same way
 * `cascadeOptionSectors` (lib/securities/verify-sector-tags.ts) resolves an
 * option's underlying: the exactly named symbol is tried first, then its
 * `issuerSiblings` in family order, and the first row with a usable sector
 * wins. Another option row is never an underlying.
 */
export function resolveUnderlyingSector(
  db: Database.Database,
  underlyingSymbol: string | null | undefined
): UnderlyingSector | null {
  const wanted = (underlyingSymbol ?? "").trim().toUpperCase();
  if (wanted === "") return null;
  const candidates = [wanted];
  for (const sib of issuerSiblings(wanted)) {
    const s = sib.toUpperCase();
    if (!candidates.includes(s)) candidates.push(s);
  }
  const find = db.prepare(
    `SELECT id, sector FROM securities
     WHERE UPPER(symbol) = ? AND LOWER(COALESCE(security_type, '')) != 'option'
     ORDER BY id`
  );
  for (const symbol of candidates) {
    for (const row of find.all(symbol) as Array<{ id: number; sector: string | null }>) {
      const sector = normalizeSector(row.sector);
      if (sector) return { securityId: row.id, sector };
    }
  }
  return null;
}

const SYSTEM = `You assign a GICS sector to each ticker (a stock or a sector/thematic ETF).
Return ONLY a JSON array, one object per input ticker:
{"symbol":"TICKER","sector":"<exactly one of: Energy, Materials, Industrials, Consumer Discretionary, Consumer Staples, Healthcare, Financials, Technology, Communication Services, Utilities, Real Estate>"}
For sector/thematic ETFs use the dominant GICS sector (SMH/IGV/SOXX/HACK->Technology, KRE/XLF->Financials, XLE->Energy, XLU/VPU->Utilities, ARKK->Technology). No prose, no code fences.`;

/**
 * Give every held blank-sector option a sector, written onto the option row
 * (the sector breakdown, its drill-down, the factor tilts and cash-deploy all
 * read an option's OWN stored sector; none of them inherits at read time).
 *
 * Owner ruling 2026-10-06: an option takes its UNDERLYING's stored sector when
 * the underlying is a known security with one, so an index-fund option lands
 * in the fund's own bucket (e.g. "Diversified") instead of whatever single
 * GICS sector the AI picks for the fund. The AI is asked only for an
 * underlying that is unknown or has no usable sector; for those only a
 * canonical GICS-11 value is written and junk is dropped.
 *
 * Idempotent: it only ever fills a blank sector, so a sector already on an
 * option row (from an import, the verification sweep, the broker, or an
 * earlier run) is never overwritten. Rows stored wrong before this ruling are
 * the business of scripts/repair-option-sectors.ts.
 */
export async function classifyOptionSectors(db: Database.Database): Promise<OptionSectorResult> {
  const underlyings = getUnsectoredOptionUnderlyings(db);
  if (underlyings.length === 0) return { classified: 0, inherited: 0, errors: [] };

  const writeSector = db.prepare(
    `UPDATE securities SET sector = ?, sector_source = ?
     WHERE LOWER(security_type) = 'option' AND UPPER(TRIM(underlying_symbol)) = ?
       AND (sector IS NULL OR TRIM(sector) = '')`
  );

  // Known underlyings first: no AI call, and nothing the AI does later can
  // undo it (the write only fills blanks).
  let inherited = 0;
  const needAi: string[] = [];
  for (const underlying of underlyings) {
    const resolved = resolveUnderlyingSector(db, underlying);
    if (!resolved) {
      needAi.push(underlying);
      continue;
    }
    inherited += writeSector.run(resolved.sector, OPTION_SECTOR_SOURCE_INHERITED, underlying).changes;
  }

  let classified = inherited;
  const errors: string[] = [];
  const BATCH = 30;
  for (let i = 0; i < needAi.length; i += BATCH) {
    const batch = needAi.slice(i, i + BATCH);
    const asked = new Set(batch);
    const prompt = `Tickers:\n${batch.map((t) => `- ${t}`).join("\n")}`;
    try {
      // No `temperature` — tier-resolved models can reject it as deprecated (QA 2026-07-07).
      const { text } = await generateTextForFeature("securityClassification", { maxOutputTokens: 2000, system: SYSTEM, prompt });
      // Lenient parse: tolerates a prose preamble, a single bare object (common
      // for a one-ticker batch), a {results:[...]} wrapper, and raw C0 control
      // characters inside string literals. A reply that is none of those throws
      // a plain-English error instead of "results is not iterable".
      const results = parseJsonArrayLenient(text, "sector classifications");
      for (const raw of results) {
        if (typeof raw !== "object" || raw === null) continue;
        const r = raw as Record<string, unknown>;
        const gics = normalizeSector(typeof r.sector === "string" ? r.sector : null);
        // Strict: only write a canonical GICS-11 sector. normalizeSector also
        // passes through non-GICS labels ("Diversified"/"Fixed Income"); those
        // reach an option only by inheritance from a stored underlying sector,
        // never from an AI answer.
        if (!gics || !r.symbol || !GICS_SECTORS.includes(gics as (typeof GICS_SECTORS)[number])) continue;
        // Only a ticker this batch asked about: an answer for anything else
        // could land on an option whose underlying was never sent.
        const symbol = String(r.symbol).trim().toUpperCase();
        if (!asked.has(symbol)) continue;
        classified += writeSector.run(gics, OPTION_SECTOR_SOURCE_AI, symbol).changes;
      }
    } catch (err) {
      if (err instanceof AIRefusalError) {
        errors.push(`Batch ${i / BATCH + 1}: AI refusal`);
        continue;
      }
      errors.push(`Batch ${i / BATCH + 1}: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }
  return { classified, inherited, errors };
}
