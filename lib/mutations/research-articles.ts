import type Database from "better-sqlite3";

/**
 * D5 — Un-filter an article previously flagged by the D1/D2 short-circuit or
 * the D3 portfolio-relevance gate. Flips is_relevant back to 1 and clears
 * the excluded_category / excluded_reason audit fields.
 *
 * Side effects after un-filtering:
 *   - D1/D2 short-circuited rows (processed_at IS NULL) — next call to
 *     processUnprocessedArticles picks them up and runs full AI analysis,
 *     then enters the digest stream.
 *   - D3 gate rows (processed_at populated, AI fields filled) — content
 *     flows into the next digest read because all consumers re-query with
 *     the is_relevant predicate.
 */
export function unfilterArticle(
  db: Database.Database,
  articleId: number,
): { changed: boolean } {
  const info = db
    .prepare(
      `UPDATE research_articles
          SET is_relevant = 1,
              excluded_category = NULL,
              excluded_reason = NULL
        WHERE id = ?
          AND is_relevant = 0`,
    )
    .run(articleId);

  return { changed: info.changes > 0 };
}
