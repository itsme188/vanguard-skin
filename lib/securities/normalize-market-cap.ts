/**
 * market_cap_category vocabulary normalization — single source of truth.
 *
 * The Claude classification fallback (classifyUnresolvedWithClaude) emits bare
 * cap-size labels per its prompt enum ("Large"/"Mid"/"Small"), while every
 * other classification source (static lookup, auto_option, manual) writes the
 * "X Cap" scheme ("Large Cap"/"Mid Cap"/"Small Cap"). Left unnormalized, one
 * cap-size exposure fragments into two parallel Allocation donut buckets
 * (Large 12% + Large Cap 34% were the same exposure). Normalize on the way in
 * at every market_cap_category write site sourced from AI output.
 *
 * Sibling of normalizeFundCategory / normalizeSector / mapSecurityType.
 */

/** lowercase-trimmed synonym → canonical market_cap_category label. */
const ALIASES: Record<string, string> = {
  large: "Large Cap",
  mid: "Mid Cap",
  medium: "Mid Cap",
  small: "Small Cap",
};

/**
 * Normalize a market_cap_category label. Maps known bare synonyms to the
 * canonical "X Cap" scheme; passes any other non-empty label through
 * unchanged; null/empty → null.
 */
export function normalizeMarketCapCategory(
  raw: string | null | undefined
): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * SQL twin of `normalizeMarketCapCategory`, generated FROM the same ALIASES
 * table above (single source — never hand-copy the synonyms into a second
 * SQL literal list). Returns a `CASE` expression that case-insensitively
 * (LOWER + TRIM, matching the JS function) maps a bare cap-size synonym to
 * the canonical "X Cap" label; any other value (including NULL and the
 * literal string "null") passes through `<column>` unchanged — callers keep
 * composing their own NULLIF/COALESCE guards around this expression, exactly
 * as they did around the raw column.
 */
export function marketCapCategoryBucketSql(column: string): string {
  const synonymsByCanonical = new Map<string, string[]>();
  for (const [synonym, canonical] of Object.entries(ALIASES)) {
    const list = synonymsByCanonical.get(canonical) ?? [];
    list.push(synonym);
    synonymsByCanonical.set(canonical, list);
  }

  const whenClauses = [...synonymsByCanonical.entries()]
    .map(([canonical, synonyms]) => {
      const inList = synonyms.map((s) => `'${escapeSqlLiteral(s)}'`).join(", ");
      return `WHEN LOWER(TRIM(${column})) IN (${inList}) THEN '${escapeSqlLiteral(canonical)}'`;
    })
    .join("\n    ");

  return `CASE\n    ${whenClauses}\n    ELSE ${column}\n  END`;
}
