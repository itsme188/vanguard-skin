/**
 * Which newsletter articles may be bogey-scanned.
 *
 * Two owner rulings:
 *   - 2026-11-02: "as a rule, let's only look for bogeys in TMT Breakout."
 *   - 2026-11-17: FundaAI's "Preview" posts are scanned too. Its other post
 *     types (Weekly, Deep, Research, Review, Column) are not.
 *
 * ONE gate for every path that reads an article for bogey figures: the global
 * scan (extract-newsletter-bogeys.ts), the per-event rescan prepare step and
 * the armed-event deep read. It decides WHICH ARTICLES are eligible; it never
 * changes how many events an eligible article is scanned against (one TMT
 * email often batches several companies' bogeys).
 *
 * Identity is the article's SOURCE RECORD (`research_sources.name`), not the
 * raw sender string, which varies. The registry carries TMT Breakout under
 * two seeded spellings: 'TMT Breakouts' (migration 019) and 'TMT Breakout'
 * (migration 024, the id-8 row migration 068 ranks). Both are the same
 * publication, so both pass. Enrichment/summarization is NOT gated by this.
 */
export const BOGEY_SCAN_SOURCE_NAMES = ["tmt breakout", "tmt breakouts"] as const;

/**
 * Sources that pass only for a post whose subject starts with "Preview" and a
 * bar, the way FundaAI titles a pre-print note ("Preview|NVDA FY27Q3: ...").
 * Spaces are ignored and case does not matter, so "Preview | X" passes too.
 */
export const BOGEY_SCAN_PREVIEW_ONLY_SOURCE_NAMES = ["fundaai"] as const;

const PREVIEW_SUBJECT_PREFIX = "preview|";

function normalizedName(sourceName: string | null | undefined): string {
  return (sourceName ?? "").trim().toLowerCase();
}

/** JS twin of {@link BOGEY_SCAN_SOURCE_SQL} (parity-pinned in tests). */
export function isBogeyScanArticle(
  sourceName: string | null | undefined,
  subject: string | null | undefined,
): boolean {
  const name = normalizedName(sourceName);
  if (name === "") return false;
  if ((BOGEY_SCAN_SOURCE_NAMES as readonly string[]).includes(name)) return true;
  if (!(BOGEY_SCAN_PREVIEW_ONLY_SOURCE_NAMES as readonly string[]).includes(name)) return false;
  // Only U+0020 is removed, to match SQLite's replace(..., ' ', '') exactly.
  return (subject ?? "").toLowerCase().split(" ").join("").startsWith(PREVIEW_SUBJECT_PREFIX);
}

const sqlList = (names: readonly string[]) => names.map((n) => `'${n}'`).join(", ");

/**
 * SQL predicate over a `research_sources` row aliased `rs` joined to its
 * `research_articles` row aliased `a`. AND it into any query that selects
 * articles for a bogey scan. `substr` (not LIKE) keeps the prefix test exact:
 * no wildcard characters, no case-folding setting to depend on.
 */
export const BOGEY_SCAN_SOURCE_SQL = `(lower(trim(rs.name)) IN (${sqlList(BOGEY_SCAN_SOURCE_NAMES)})
  OR (lower(trim(rs.name)) IN (${sqlList(BOGEY_SCAN_PREVIEW_ONLY_SOURCE_NAMES)})
      AND substr(replace(lower(COALESCE(a.subject, '')), ' ', ''), 1, ${PREVIEW_SUBJECT_PREFIX.length}) = '${PREVIEW_SUBJECT_PREFIX}'))`;
