import type Database from "better-sqlite3";
import { todayET } from "@/lib/calendar/date-utils";
import {
  RECON_FLOOR_DOLLARS,
  RECON_MATCH_TOLERANCE,
  RECON_NEUTRAL_PCT,
  RECON_RED_PCT,
  reconciliationBand,
  type ReconciliationBand,
} from "@/lib/compute/reconciliation-tolerance";

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
  /** Date of the prior valuation used when the exact date had none; null when the stored value was used. */
  computed_from_date: string | null;
  /** Why Computed is empty (no valuation within the fallback window); null when there is a value. */
  computed_missing_reason: string | null;
}

/** How far back a checkpoint looks for a valuation when its own date has none. */
export const CHECKPOINT_FALLBACK_DAYS = 7;
export const CHECKPOINT_NO_VALUATION_REASON = `No valuation on or within ${CHECKPOINT_FALLBACK_DAYS} days before this date`;

type StoredCheckpoint = Omit<ReconciliationCheckpoint, "computed_from_date" | "computed_missing_reason">;

/**
 * Read-time fallback: a row with no stored Computed value (weekend or holiday
 * date) takes the nearest PRIOR daily valuation of the same account, at most
 * CHECKPOINT_FALLBACK_DAYS earlier. Nothing is written back.
 */
function withComputedFallback(db: Database.Database, rows: StoredCheckpoint[]): ReconciliationCheckpoint[] {
  const lookup = db.prepare(
    `SELECT valuation_date, total_value FROM daily_valuations
     WHERE account_id = ? AND valuation_date <= ? AND valuation_date >= date(?, ?)
     ORDER BY valuation_date DESC LIMIT 1`
  );
  return rows.map((row) => {
    if (row.computed_value !== null) {
      return { ...row, computed_from_date: null, computed_missing_reason: null };
    }
    const prior = lookup.get(
      row.account_id,
      row.checkpoint_date,
      row.checkpoint_date,
      `-${CHECKPOINT_FALLBACK_DAYS} days`
    ) as { valuation_date: string; total_value: number } | undefined;
    if (!prior) {
      return {
        ...row,
        difference: null,
        computed_from_date: null,
        computed_missing_reason: CHECKPOINT_NO_VALUATION_REASON,
      };
    }
    return {
      ...row,
      computed_value: prior.total_value,
      difference: row.statement_value - prior.total_value,
      computed_from_date: prior.valuation_date === row.checkpoint_date ? null : prior.valuation_date,
      computed_missing_reason: null,
    };
  });
}

export function getReconciliationCheckpoints(
  db: Database.Database,
  accountId?: number
): ReconciliationCheckpoint[] {
  return withComputedFallback(db, selectStoredCheckpoints(db, accountId));
}

function selectStoredCheckpoints(db: Database.Database, accountId?: number): StoredCheckpoint[] {
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
      .all(accountId) as StoredCheckpoint[];
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
    .all() as StoredCheckpoint[];
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

    const stored = db
      .prepare(
        `SELECT rc.*, a.name AS account_name
         FROM reconciliation_checkpoints rc
         JOIN accounts a ON a.id = rc.account_id
         WHERE rc.id = ?`
      )
      .get(id) as StoredCheckpoint;
    const [checkpoint] = withComputedFallback(db, [stored]);

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

/** Kept for importers; the bands themselves live in lib/compute/reconciliation-tolerance.ts. */
export const CHECKPOINT_MATCH_TOLERANCE = RECON_MATCH_TOLERANCE;
export const CHECKPOINT_CLOSE_TOLERANCE = RECON_FLOOR_DOLLARS;

export interface CheckpointDifferenceBand {
  band: ReconciliationBand;
  glyph: string;
  label: string;
}

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

const DIFFERENCE_BANDS: Record<ReconciliationBand, CheckpointDifferenceBand> = {
  match: {
    band: "match",
    glyph: "\u2713",
    label: "Matches the computed value to the cent",
  },
  within: {
    band: "within",
    glyph: "\u2248",
    label: `Within tolerance: under ${pct(RECON_NEUTRAL_PCT)} of the statement value`,
  },
  close: {
    band: "close",
    glyph: "~",
    label: `Close: ${pct(RECON_NEUTRAL_PCT)} to ${pct(RECON_RED_PCT)} of the statement value, or $${RECON_FLOOR_DOLLARS} or less`,
  },
  off: {
    band: "off",
    glyph: "!",
    label: `Off: more than $${RECON_FLOOR_DOLLARS} and more than ${pct(RECON_RED_PCT)} of the statement value`,
  },
};

/** The Difference chip's band, glyph and plain-words meaning (null = no computed value). */
export function checkpointDifferenceBand(
  difference: number | null,
  statementValue: number,
): CheckpointDifferenceBand | null {
  const band = reconciliationBand(difference, statementValue);
  return band === null ? null : DIFFERENCE_BANDS[band];
}

/** One line under the table explaining the Difference glyphs. */
export const CHECKPOINT_DIFFERENCE_LEGEND = (["match", "within", "close", "off"] as const)
  .map((b) => `${DIFFERENCE_BANDS[b].glyph} ${DIFFERENCE_BANDS[b].label}`)
  .join(" \u00b7 ");

export function deleteReconciliationCheckpoint(
  db: Database.Database,
  id: number
): void {
  db.prepare("DELETE FROM reconciliation_checkpoints WHERE id = ?").run(id);
}
