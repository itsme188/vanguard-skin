/**
 * Which newsletter articles may be bogey-scanned (owner ruling, 2026-11-02:
 * "as a rule, let's only look for bogeys in TMT Breakout").
 *
 * ONE gate for every scan path (the global scan in extract-newsletter-bogeys.ts
 * and the per-event rescan prepare step). It decides WHICH ARTICLES are
 * eligible; it never changes how many events an eligible article is scanned
 * against (one TMT email often batches several companies' bogeys).
 *
 * Identity is the article's SOURCE RECORD (`research_sources.name`), not the
 * raw sender string, which varies. The registry carries the publication under
 * two seeded spellings: 'TMT Breakouts' (migration 019) and 'TMT Breakout'
 * (migration 024, the id-8 row migration 068 ranks). Both are the same
 * publication, so both pass. Enrichment/summarization is NOT gated by this.
 */
export const BOGEY_SCAN_SOURCE_NAMES = ["tmt breakout", "tmt breakouts"] as const;

/** JS twin of {@link BOGEY_SCAN_SOURCE_SQL} (parity-pinned in tests). */
export function isBogeyScanSource(sourceName: string | null | undefined): boolean {
  if (!sourceName) return false;
  return (BOGEY_SCAN_SOURCE_NAMES as readonly string[]).includes(sourceName.trim().toLowerCase());
}

/**
 * SQL predicate over a `research_sources` row aliased `rs`. AND it into any
 * query that selects articles for a bogey scan.
 */
export const BOGEY_SCAN_SOURCE_SQL = `lower(trim(rs.name)) IN (${BOGEY_SCAN_SOURCE_NAMES.map((n) => `'${n}'`).join(", ")})`;
