/**
 * Failing pending sections from outside the runner (a disarm, a filing
 * rejected on revalidation) and the run-status rule that must follow.
 *
 * The status rule is the store's (`recomputeRunStatus` in store.ts, applied on
 * every finalize): all sections done → done; any failed with nothing pending
 * or running → failed; otherwise running. `finished_at` is stamped on the
 * first terminal state. Callers run these inside their own transaction.
 */
import type Database from "better-sqlite3";

/** Recomputes each run's status (and first finish time) from its sections. */
export function recomputeRunStatuses(db: Database.Database, runIds: readonly number[]): void {
  const recompute = db.prepare(
    `UPDATE filing_summary_runs
        SET status = CASE
              WHEN (SELECT COUNT(*) FROM filing_summary_sections WHERE run_id = :id) > 0
               AND (SELECT COUNT(*) FROM filing_summary_sections WHERE run_id = :id AND status <> 'done') = 0
                THEN 'done'
              WHEN (SELECT COUNT(*) FROM filing_summary_sections WHERE run_id = :id AND status = 'failed') > 0
               AND (SELECT COUNT(*) FROM filing_summary_sections WHERE run_id = :id AND status IN ('pending','running')) = 0
                THEN 'failed'
              ELSE 'running' END,
            finished_at = CASE
              WHEN (SELECT COUNT(*) FROM filing_summary_sections WHERE run_id = :id AND status IN ('pending','running')) = 0
               AND (SELECT COUNT(*) FROM filing_summary_sections WHERE run_id = :id) > 0
                THEN COALESCE(finished_at, datetime('now'))
              ELSE NULL END
      WHERE id = :id`,
  );
  for (const id of runIds) recompute.run({ id });
}

/**
 * Fails every PENDING section of the event (`scope: "event"`) or of one filing
 * (`scope: "filing"`) with error class `cancelled`, then recomputes the
 * affected runs. A running section is left to finish. Returns the count.
 */
export function failPendingSections(
  db: Database.Database,
  scope: "event" | "filing",
  id: number,
  errorText: string,
): number {
  const where =
    scope === "event"
      ? `status = 'pending' AND run_id IN (SELECT id FROM filing_summary_runs WHERE event_id = ?)`
      : `status = 'pending' AND filing_id = ?`;
  const runIds = (
    db.prepare(`SELECT DISTINCT run_id FROM filing_summary_sections WHERE ${where}`).all(id) as Array<{
      run_id: number;
    }>
  ).map((r) => r.run_id);
  const changes = db
    .prepare(
      `UPDATE filing_summary_sections
          SET status = 'failed', error_class = 'cancelled', error_text = ?,
              claim_token = NULL, claimed_at = NULL, heartbeat_at = NULL,
              finished_at = datetime('now')
        WHERE ${where}`,
    )
    .run(errorText, id).changes;
  recomputeRunStatuses(db, runIds);
  return changes;
}
