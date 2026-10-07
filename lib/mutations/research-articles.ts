import type Database from "better-sqlite3";

/** The `excluded_category` the enrichment pass writes at its retry cap. */
const ENRICHMENT_FAILED = "enrichment_failed";

/**
 * Put an article back in the enrichment queue: relevant again, no exclusion,
 * `processed_at` cleared and a fresh set of attempts. The queue
 * (processUnprocessedArticles) selects on exactly these columns:
 * `processed_at IS NULL AND is_relevant = 1 AND enrich_attempts < cap`.
 * Clearing only some of them leaves the article stranded, which is the bug
 * this replaced (Unfilter flipped is_relevant and nothing else).
 *
 * Any enrichment fields already on the row are left alone; a successful pass
 * overwrites them.
 */
const REQUEUE_SQL = `
  UPDATE research_articles
     SET is_relevant = 1,
         excluded_category = NULL,
         excluded_reason = NULL,
         processed_at = NULL,
         enrich_attempts = 0
   WHERE id = ?`;

/**
 * D5: un-filter an article the Filtered tab lists (is_relevant = 0). Flips
 * is_relevant back to 1 and clears the excluded_category / excluded_reason
 * audit fields.
 *
 * What happens next depends on why it was filtered:
 *   - 'enrichment_failed' (the AI never produced an enrichment): the article
 *     is RE-QUEUED (processed_at cleared, attempts reset), so the next
 *     enrichment pass actually analyses it. `requeued: true`.
 *   - D1/D2 short-circuited rows (processed_at IS NULL): the next call to
 *     processUnprocessedArticles picks them up and runs full AI analysis,
 *     then they enter the digest stream.
 *   - D3 gate rows (processed_at populated, AI fields filled): content flows
 *     into the next digest read because all consumers re-query with the
 *     is_relevant predicate. They are deliberately NOT re-queued: a second
 *     pass would spend a model call and could vote the article off-topic
 *     again, undoing the Unfilter.
 */
export function unfilterArticle(
  db: Database.Database,
  articleId: number,
): { changed: boolean; requeued: boolean } {
  return db.transaction((): { changed: boolean; requeued: boolean } => {
    const row = db
      .prepare(`SELECT is_relevant, excluded_category FROM research_articles WHERE id = ?`)
      .get(articleId) as { is_relevant: number; excluded_category: string | null } | undefined;
    if (!row || row.is_relevant !== 0) return { changed: false, requeued: false };

    if (row.excluded_category === ENRICHMENT_FAILED) {
      db.prepare(REQUEUE_SQL).run(articleId);
      return { changed: true, requeued: true };
    }

    db.prepare(
      `UPDATE research_articles
          SET is_relevant = 1,
              excluded_category = NULL,
              excluded_reason = NULL
        WHERE id = ?`,
    ).run(articleId);
    return { changed: true, requeued: false };
  })();
}

export type RetryEnrichmentStatus = "requeued" | "not_found" | "not_failed";

/**
 * The Filtered tab's "Retry enrichment" action: re-queue an article that was
 * excluded as 'enrichment_failed'. Refuses anything else, so it can never
 * spend a model call re-analysing an article that was already enriched.
 */
export function retryArticleEnrichment(
  db: Database.Database,
  articleId: number,
): { status: RetryEnrichmentStatus } {
  return db.transaction((): { status: RetryEnrichmentStatus } => {
    const row = db
      .prepare(`SELECT is_relevant, excluded_category FROM research_articles WHERE id = ?`)
      .get(articleId) as { is_relevant: number; excluded_category: string | null } | undefined;
    if (!row) return { status: "not_found" };
    if (row.is_relevant !== 0 || row.excluded_category !== ENRICHMENT_FAILED) {
      return { status: "not_failed" };
    }
    db.prepare(REQUEUE_SQL).run(articleId);
    return { status: "requeued" };
  })();
}

/**
 * Re-queue a set of articles in ONE transaction (the repair script's write).
 * No eligibility check here: the caller has already selected the rows.
 * Returns how many rows were written.
 */
export function requeueArticlesForEnrichment(db: Database.Database, articleIds: number[]): number {
  const stmt = db.prepare(REQUEUE_SQL);
  return db.transaction((ids: number[]): number => {
    let written = 0;
    for (const id of ids) written += stmt.run(id).changes;
    return written;
  })(articleIds);
}
