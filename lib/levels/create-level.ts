/**
 * Create one new level (POST /api/levels).
 *
 * A create lands armed (upsertLevel defaults `review_status` to
 * auto_approved), so it puts a new condition in front of the scanner — the
 * same event as approving, reactivating or an edit that changes the
 * condition. It therefore asks the same guard (evaluateArmGuard,
 * lib/alerts/arm-guard.ts) exactly the way editLevel does: a trial write
 * inside a transaction, the scanner's own armed-universe predicate, then the
 * guard. A refusal rolls the insert back, so nothing is saved; `force`
 * overrides it and `armed_crossed_at` is stamped by the shared rule.
 *
 * A level created outside the armed universe (pending review, or not active)
 * is not in front of the scanner, so the guard is not asked. A security with
 * no fresh price cannot be judged, and the guard lets it through (as it does
 * for every arming path).
 */
import type Database from "better-sqlite3";
import { isLevelInArmedUniverse } from "@/lib/queries/security-levels";
import { upsertLevel, type UpsertLevelInput } from "@/lib/mutations/security-levels";
import {
  ARMED_CROSSED_AT_SET_SQL,
  evaluateArmGuard,
  type ArmGuardRefusal,
} from "@/lib/alerts/arm-guard";

export type CreateLevelResult =
  | {
      ok: true;
      id: number;
      /** True when the scanner watches the new level. */
      armed: boolean;
    }
  // A brand-new row has never alerted, so alertedToday is always false; it is
  // carried so the refusal has the same shape as the edit refusal.
  | ({ ok: false; alertedToday: false } & ArmGuardRefusal);

/** Thrown inside the transaction to undo the trial insert. */
class CreateRefused extends Error {
  constructor(readonly refusal: ArmGuardRefusal) {
    super(refusal.code);
  }
}

export function createLevelGuarded(
  db: Database.Database,
  input: Omit<UpsertLevelInput, "id">,
  opts: { force?: boolean } = {},
): CreateLevelResult {
  const tx = db.transaction((): { id: number; armed: boolean } => {
    // Never an update: strip any id a caller passed through.
    const { id: _ignored, ...fields } = input as UpsertLevelInput;
    void _ignored;
    const id = upsertLevel(db, fields);
    const armed = isLevelInArmedUniverse(db, id);
    if (!armed) return { id, armed };

    const verdict = evaluateArmGuard(
      db,
      {
        id,
        security_id: fields.security_id,
        level_type: fields.level_type,
        price: fields.price,
        price_source: fields.price_source ?? "static",
      },
      { force: opts.force },
    );
    if (verdict.refusal) throw new CreateRefused(verdict.refusal);
    db.prepare(`UPDATE security_levels SET ${ARMED_CROSSED_AT_SET_SQL} WHERE id = ?`).run(
      verdict.stampCrossed ? 1 : 0,
      id,
    );
    return { id, armed };
  });

  try {
    return { ok: true, ...tx() };
  } catch (err) {
    if (err instanceof CreateRefused) return { ok: false, alertedToday: false, ...err.refusal };
    throw err;
  }
}
