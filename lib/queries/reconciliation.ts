import type Database from "better-sqlite3";

export interface ReconciliationCheckpoint {
  id: number;
  account_id: number;
  account_name: string;
  checkpoint_date: string;
  statement_value: number;
  computed_value: number | null;
  difference: number | null;
  notes: string | null;
  created_at: string;
}

export function getReconciliationCheckpoints(
  db: Database.Database,
  accountId?: number
): ReconciliationCheckpoint[] {
  if (accountId) {
    return db
      .prepare(
        `SELECT
          rc.id, rc.account_id, a.name AS account_name,
          rc.checkpoint_date, rc.statement_value,
          rc.computed_value, rc.difference,
          rc.notes, rc.created_at
        FROM reconciliation_checkpoints rc
        JOIN accounts a ON a.id = rc.account_id
        WHERE rc.account_id = ?
        ORDER BY rc.checkpoint_date DESC`
      )
      .all(accountId) as ReconciliationCheckpoint[];
  }
  return db
    .prepare(
      `SELECT
        rc.id, rc.account_id, a.name AS account_name,
        rc.checkpoint_date, rc.statement_value,
        rc.computed_value, rc.difference,
        rc.notes, rc.created_at
      FROM reconciliation_checkpoints rc
      JOIN accounts a ON a.id = rc.account_id
      ORDER BY rc.checkpoint_date DESC, a.name`
    )
    .all() as ReconciliationCheckpoint[];
}

export function addReconciliationCheckpoint(
  db: Database.Database,
  accountId: number,
  checkpointDate: string,
  statementValue: number,
  notes?: string
): ReconciliationCheckpoint {
  // Try to find a computed value for this date from daily_valuations or monthly_snapshots
  const valuation = db
    .prepare(
      `SELECT total_value FROM daily_valuations
       WHERE account_id = ? AND valuation_date = ?`
    )
    .get(accountId, checkpointDate) as { total_value: number } | undefined;

  const snapshot = !valuation
    ? (db
        .prepare(
          `SELECT total_value FROM monthly_snapshots
           WHERE account_id = ? AND month_end_date = ?`
        )
        .get(accountId, checkpointDate) as { total_value: number } | undefined)
    : undefined;

  const computedValue = valuation?.total_value ?? snapshot?.total_value ?? null;
  const difference = computedValue !== null ? statementValue - computedValue : null;

  const result = db
    .prepare(
      `INSERT OR REPLACE INTO reconciliation_checkpoints
       (account_id, checkpoint_date, statement_value, computed_value, difference, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(accountId, checkpointDate, statementValue, computedValue, difference, notes ?? null);

  return db
    .prepare(
      `SELECT rc.*, a.name AS account_name
       FROM reconciliation_checkpoints rc
       JOIN accounts a ON a.id = rc.account_id
       WHERE rc.id = ?`
    )
    .get(result.lastInsertRowid) as ReconciliationCheckpoint;
}

export function deleteReconciliationCheckpoint(
  db: Database.Database,
  id: number
): void {
  db.prepare("DELETE FROM reconciliation_checkpoints WHERE id = ?").run(id);
}
