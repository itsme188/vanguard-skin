import type Database from "better-sqlite3";
import { computeExerciseLinks } from "@/lib/compute/tax-lots";
import type { IntegrityHit } from "@/lib/queries/integrity-checks";

/**
 * EXERCISE LINK GAPS — two ledger-only Data Health warnings for the cases
 * where an option exercise or assignment does NOT move its premium onto the
 * stock leg, and the engine says nothing (plan
 * docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md §0
 * item 4, rulings R5, R14, R15).
 *
 *  - `exercise-price-missing`: an EXERCISED / ASSIGNED row on an option with
 *    a null or zero price. The engine's link lookup skips it on purpose (a
 *    price-less row is under-specified evidence), so the option close keeps
 *    its own realized result.
 *  - `exercise-leg-missing`: a PRICED EXERCISED / ASSIGNED row on an option
 *    that the engine's own lookup (`computeExerciseLinks`, exported for this
 *    reader only, R14) did not link: either the option has no underlying or
 *    call/put recorded (the lookup never reads it), or no matching stock
 *    trade was found. The link lookup is never re-implemented here; the
 *    metadata test only chooses the wording.
 *
 * A price-less row gets only the price warning, never both. Both warnings
 * read the ledger only, so they run outside the tax-lot convention gate,
 * and both are always "warning": they never cap the score.
 */

interface ExerciseRow {
  id: number;
  tradeDate: string;
  type: string;
  price: number | null;
  symbol: string;
  accountName: string;
  underlying: string | null;
  optionType: string | null;
}

function readExerciseRows(db: Database.Database): ExerciseRow[] {
  return db
    .prepare(
      `SELECT t.id AS id, t.trade_date AS tradeDate, UPPER(TRIM(t.type)) AS type,
              t.price_per_share AS price, s.symbol AS symbol,
              COALESCE(a.name, 'account ' || t.account_id) AS accountName,
              s.underlying_symbol AS underlying, s.option_type AS optionType
         FROM transactions t
         JOIN securities s ON s.id = t.security_id
         LEFT JOIN accounts a ON a.id = t.account_id
        WHERE LOWER(t.type) IN ('exercised', 'assigned')
          AND LOWER(s.security_type) = 'option'
        ORDER BY t.trade_date, t.id`
    )
    .all() as ExerciseRow[];
}

const isPriceless = (price: number | null): boolean => price == null || price === 0;

const actionWord = (type: string): string => (type === "ASSIGNED" ? "assignment" : "exercise");

/** Price-less exercise or assignment rows: one warning per row. */
export function scanExercisePriceMissingHits(db: Database.Database): IntegrityHit[] {
  return readExerciseRows(db)
    .filter((r) => isPriceless(r.price))
    .map((r) => ({
      key: `exercise-price-missing:${r.id}`,
      severity: "warning" as const,
      kind: "exercise-price-missing" as const,
      reason: `${r.symbol} (${r.accountName}), ${actionWord(r.type)} on ${r.tradeDate}: exercise or assignment with no price: its premium stays on the option and is not moved to the stock`,
    }));
}

/** Priced exercise or assignment rows the engine's lookup did not link: one warning per row. */
export function scanExerciseLegMissingHits(db: Database.Database): IntegrityHit[] {
  const rows = readExerciseRows(db).filter((r) => !isPriceless(r.price));
  if (rows.length === 0) return [];
  const { links } = computeExerciseLinks(db);
  return rows
    .filter((r) => !links.has(r.id))
    .map((r) => {
      const missingMetadata = r.underlying == null || r.optionType == null;
      return {
        key: `exercise-leg-missing:${r.id}`,
        severity: "warning" as const,
        kind: "exercise-leg-missing" as const,
        reason: missingMetadata
          ? `${r.symbol} (${r.accountName}), ${actionWord(r.type)} on ${r.tradeDate}: the option has no underlying or call/put recorded, so its premium stays on the option and is not moved to the stock`
          : `${r.symbol} (${r.accountName}), ${actionWord(r.type)} on ${r.tradeDate}: no matching stock trade was found: its premium stays on the option and is not moved to the stock`,
      };
    });
}
