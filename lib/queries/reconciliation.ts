import type Database from "better-sqlite3";
import { todayET } from "@/lib/calendar/date-utils";

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

/** What a refused or confirmed replace shows the user about the saved row. */
export interface ExistingCheckpointSummary {
  id: number;
  account_name: string;
  checkpoint_date: string;
  statement_value: number;
  notes: string | null;
}

/**
 * A checkpoint is the owner's audit record, one per (account, date). A second
 * save on a taken date is refused (`exists`) and the saved row is left as it
 * was; it is replaced only when the caller names that exact row
 * (`replaceCheckpointId`), i.e. the user was shown it and chose to replace it.
 */
export type SaveCheckpointResult =
  | { status: "saved"; checkpoint: ReconciliationCheckpoint }
  | {
      status: "replaced";
      checkpoint: ReconciliationCheckpoint;
      previous: ExistingCheckpointSummary;
    }
  | { status: "exists"; existing: ExistingCheckpointSummary };

/** A checkpoint input the caller must fix (the route answers 400 with the message). */
export class CheckpointInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointInputError";
  }
}

/** A statement cannot be dated after today; "today" is the Eastern day. */
export const CHECKPOINT_FUTURE_DATE_MESSAGE = "Statement date cannot be in the future.";

/** True for a `YYYY-MM-DD` string that names a real calendar day. */
function isRealIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Why a checkpoint cannot be saved, in plain words, or null when it can.
 * The form blocks the same inputs (`checkpointFormBlocker`); this is the
 * check for a request that did not come through the form. Inputs are typed
 * `unknown` because the route passes the parsed JSON body straight in.
 */
export function checkpointInputProblem(
  db: Database.Database,
  accountId: unknown,
  checkpointDate: unknown,
  statementValue: unknown,
  notes?: unknown
): string | null {
  if (typeof accountId !== "number" || !Number.isInteger(accountId) || accountId <= 0) {
    return "Account must be the id of an existing account";
  }
  if (!isRealIsoDate(checkpointDate)) {
    return "Statement date must be a real date in YYYY-MM-DD form";
  }
  // Both sides are YYYY-MM-DD, so the string compare is a date compare.
  if (checkpointDate > todayET()) {
    return CHECKPOINT_FUTURE_DATE_MESSAGE;
  }
  if (typeof statementValue !== "number" || !Number.isFinite(statementValue)) {
    return "Statement value must be a number";
  }
  if (statementValue <= 0) {
    return "Statement value must be greater than 0";
  }
  if (notes !== undefined && notes !== null && typeof notes !== "string") {
    return "Notes must be text";
  }
  const account = db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(accountId);
  if (!account) return "Account not found";
  return null;
}

export function addReconciliationCheckpoint(
  db: Database.Database,
  accountId: number,
  checkpointDate: string,
  statementValue: number,
  notes?: string,
  options: { replaceCheckpointId?: number } = {}
): SaveCheckpointResult {
  const problem = checkpointInputProblem(db, accountId, checkpointDate, statementValue, notes);
  if (problem) throw new CheckpointInputError(problem);

  const save = db.transaction((): SaveCheckpointResult => {
    const existing = db
      .prepare(
        `SELECT rc.id, a.name AS account_name, rc.checkpoint_date,
                rc.statement_value, rc.notes
         FROM reconciliation_checkpoints rc
         JOIN accounts a ON a.id = rc.account_id
         WHERE rc.account_id = ? AND rc.checkpoint_date = ?`
      )
      .get(accountId, checkpointDate) as ExistingCheckpointSummary | undefined;

    if (existing && options.replaceCheckpointId !== existing.id) {
      return { status: "exists", existing };
    }

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

    let id: number | bigint;
    if (existing) {
      db.prepare(
        `UPDATE reconciliation_checkpoints
         SET statement_value = ?, computed_value = ?, difference = ?, notes = ?
         WHERE id = ?`
      ).run(statementValue, computedValue, difference, notes ?? null, existing.id);
      id = existing.id;
    } else {
      // Plain INSERT: the UNIQUE(account_id, checkpoint_date) rule throws
      // rather than replacing if a row appears that the read above missed.
      id = db
        .prepare(
          `INSERT INTO reconciliation_checkpoints
           (account_id, checkpoint_date, statement_value, computed_value, difference, notes)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(accountId, checkpointDate, statementValue, computedValue, difference, notes ?? null)
        .lastInsertRowid;
    }

    const checkpoint = db
      .prepare(
        `SELECT rc.*, a.name AS account_name
         FROM reconciliation_checkpoints rc
         JOIN accounts a ON a.id = rc.account_id
         WHERE rc.id = ?`
      )
      .get(id) as ReconciliationCheckpoint;

    return existing
      ? { status: "replaced", checkpoint, previous: existing }
      : { status: "saved", checkpoint };
  });
  return save();
}

/** The existing checkpoint carried by a 409 `checkpoint_exists` body, or null. */
export function parseCheckpointConflict(body: unknown): ExistingCheckpointSummary | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { code?: unknown; existing?: unknown };
  if (b.code !== "checkpoint_exists" || !b.existing || typeof b.existing !== "object") return null;
  const e = b.existing as Record<string, unknown>;
  if (
    typeof e.id !== "number" ||
    !Number.isInteger(e.id) ||
    typeof e.account_name !== "string" ||
    typeof e.checkpoint_date !== "string" ||
    typeof e.statement_value !== "number"
  ) {
    return null;
  }
  return {
    id: e.id,
    account_name: e.account_name,
    checkpoint_date: e.checkpoint_date,
    statement_value: e.statement_value,
    notes: typeof e.notes === "string" ? e.notes : null,
  };
}

/**
 * Why the Add Checkpoint form cannot be saved yet, or null when it can.
 * `today` is the Eastern day the date input's `max` is set to.
 */
export function checkpointFormBlocker(
  form: {
    accountId: string;
    checkpointDate: string;
    statementValue: string;
  },
  today: string = todayET()
): string | null {
  if (form.accountId === "") return "Choose an account";
  if (form.checkpointDate === "") return "Enter the statement date";
  if (form.checkpointDate > today) return CHECKPOINT_FUTURE_DATE_MESSAGE;
  if (form.statementValue.trim() === "") return "Enter the statement value";
  const value = parseFloat(form.statementValue);
  if (isNaN(value)) return "Statement value must be a number";
  if (value <= 0) return "Statement value must be greater than 0";
  return null;
}

/** Statement vs computed: under one cent is a match, under $100 is close. */
export const CHECKPOINT_MATCH_TOLERANCE = 0.01;
export const CHECKPOINT_CLOSE_TOLERANCE = 100;

export interface CheckpointDifferenceBand {
  band: "match" | "close" | "off";
  glyph: string;
  label: string;
}

const DIFFERENCE_BANDS: Record<CheckpointDifferenceBand["band"], CheckpointDifferenceBand> = {
  match: {
    band: "match",
    glyph: "\u2713",
    label: "Matches the computed value to the cent",
  },
  close: {
    band: "close",
    glyph: "~",
    label: `Close: within $${CHECKPOINT_CLOSE_TOLERANCE} of the computed value`,
  },
  off: {
    band: "off",
    glyph: "!",
    label: `Off: $${CHECKPOINT_CLOSE_TOLERANCE} or more from the computed value`,
  },
};

/** The Difference chip's band, glyph and plain-words meaning (null = no computed value). */
export function checkpointDifferenceBand(
  difference: number | null
): CheckpointDifferenceBand | null {
  if (difference === null) return null;
  const abs = Math.abs(difference);
  if (abs < CHECKPOINT_MATCH_TOLERANCE) return DIFFERENCE_BANDS.match;
  if (abs < CHECKPOINT_CLOSE_TOLERANCE) return DIFFERENCE_BANDS.close;
  return DIFFERENCE_BANDS.off;
}

/** One line under the table explaining the three Difference glyphs. */
export const CHECKPOINT_DIFFERENCE_LEGEND = (["match", "close", "off"] as const)
  .map((b) => `${DIFFERENCE_BANDS[b].glyph} ${DIFFERENCE_BANDS[b].label}`)
  .join(" \u00b7 ");

export function deleteReconciliationCheckpoint(
  db: Database.Database,
  id: number
): void {
  db.prepare("DELETE FROM reconciliation_checkpoints WHERE id = ?").run(id);
}
