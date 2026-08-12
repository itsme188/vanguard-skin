import type Database from "better-sqlite3";
import { computeTaxLots } from "./tax-lots";
import { computeDailyValuations } from "./daily-valuation";

// ── Types ────────────────────────────────────────────────────────────

export interface CorporateAction {
  id: number;
  securityId: number;
  actionType: string;
  effectiveDate: string;
  ratioNumerator: number;
  ratioDenominator: number;
  newSecurityId: number | null;
  cashPerShare: number | null;
  notes: string | null;
  applied: number;
  source: string;
  createdAt: string;
  sourceKey: string | null;
  reconcileDelta: number | null;
  quantityDelta: number | null;
}

export interface AddCorporateActionParams {
  securityId: number;
  actionType: "SPLIT" | "REVERSE_SPLIT";
  effectiveDate: string;
  ratioNumerator: number;
  ratioDenominator?: number;
  notes?: string;
}

// ── Guards ───────────────────────────────────────────────────────────

/**
 * Thrown by `undoCorporateAction` when asked to undo a row that came from
 * the IBKR import pipeline (source === 'import'). Those rows are only
 * removable by undoing their import batch — undoing them individually
 * would desync them from the replay-mode ledger.
 */
export class ImportedActionError extends Error {}

/**
 * Shared validation for both the manual add path (`addCorporateAction`)
 * and the future import path (Task 5). Returns an error message string
 * when invalid, or null when valid.
 */
export function validateCorporateActionInput(params: {
  actionType: string;
  effectiveDate: string;
  ratioNumerator: number;
  ratioDenominator: number;
}): string | null {
  if (!["SPLIT", "REVERSE_SPLIT"].includes(params.actionType)) {
    return "actionType must be SPLIT or REVERSE_SPLIT";
  }
  const d = params.effectiveDate;
  const isRealDate =
    /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    !isNaN(new Date(d + "T00:00:00Z").getTime()) &&
    new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d;
  if (!isRealDate) {
    return "effectiveDate must be a real YYYY-MM-DD date";
  }
  for (const [name, v] of [
    ["ratioNumerator", params.ratioNumerator],
    ["ratioDenominator", params.ratioDenominator],
  ] as const) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return `${name} must be a finite ratio component > 0`;
    }
  }
  return null;
}

// ── Queries ──────────────────────────────────────────────────────────

export function listCorporateActions(
  db: Database.Database,
  securityId?: number,
): CorporateAction[] {
  if (securityId != null) {
    return db
      .prepare(
        `SELECT id, security_id AS securityId, action_type AS actionType,
                effective_date AS effectiveDate, ratio_numerator AS ratioNumerator,
                ratio_denominator AS ratioDenominator, new_security_id AS newSecurityId,
                cash_per_share AS cashPerShare, notes, applied, source, created_at AS createdAt,
                source_key AS sourceKey, reconcile_delta AS reconcileDelta, quantity_delta AS quantityDelta
         FROM corporate_actions WHERE security_id = ? ORDER BY effective_date DESC`,
      )
      .all(securityId) as CorporateAction[];
  }
  return db
    .prepare(
      `SELECT id, security_id AS securityId, action_type AS actionType,
              effective_date AS effectiveDate, ratio_numerator AS ratioNumerator,
              ratio_denominator AS ratioDenominator, new_security_id AS newSecurityId,
              cash_per_share AS cashPerShare, notes, applied, source, created_at AS createdAt,
              source_key AS sourceKey, reconcile_delta AS reconcileDelta, quantity_delta AS quantityDelta
       FROM corporate_actions ORDER BY effective_date DESC`,
    )
    .all() as CorporateAction[];
}

// ── Mutations ────────────────────────────────────────────────────────

/**
 * Add a corporate action and apply adjustments to pre-action historical data.
 *
 * For SPLIT (e.g., 2:1):
 *   - Holdings: quantity *= ratio (for dates before effective_date)
 *   - Prices: close_price /= ratio (for dates before effective_date)
 *   - OHLCV bars: open/high/low/close /= ratio, volume *= ratio
 *   - Tax lots: quantity_acquired *= ratio, quantity_remaining *= ratio,
 *               acquisition_price /= ratio (cost_basis stays the same — total cost unchanged)
 *
 * For REVERSE_SPLIT (e.g., 1:10):
 *   - Same logic but inverted ratio
 *
 * After adjustments, recomputes tax lots and daily valuations.
 */
export function addCorporateAction(
  db: Database.Database,
  params: AddCorporateActionParams,
): CorporateAction {
  const validationError = validateCorporateActionInput({
    ...params,
    ratioDenominator: params.ratioDenominator ?? 1,
  });
  if (validationError) throw new Error(validationError);

  const ratio = params.ratioNumerator / (params.ratioDenominator ?? 1);

  const result = db.transaction(() => {
    // Insert the action record
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO corporate_actions
          (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, notes, applied, source)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'manual')`,
      )
      .run(
        params.securityId,
        params.actionType,
        params.effectiveDate,
        params.ratioNumerator,
        params.ratioDenominator ?? 1,
        params.notes ?? null,
      );

    const actionId = Number(lastInsertRowid);

    // Apply adjustments
    applyAdjustments(db, params.securityId, params.effectiveDate, ratio);

    // Mark as applied
    db.prepare("UPDATE corporate_actions SET applied = 1 WHERE id = ?").run(
      actionId,
    );

    return actionId;
  })();

  // Recompute derived data outside the transaction (non-blocking if they fail)
  try {
    computeTaxLots(db);
  } catch {
    // Tax lot recomputation failure shouldn't block
  }
  try {
    computeDailyValuations(db);
  } catch {
    // Valuation recomputation failure shouldn't block
  }

  return listCorporateActions(db, params.securityId).find(
    (a) => a.id === result,
  )!;
}

/**
 * Apply split/reverse-split adjustments to historical data before the effective date.
 */
function applyAdjustments(
  db: Database.Database,
  securityId: number,
  effectiveDate: string,
  ratio: number,
): void {
  // 1. Adjust holdings quantities (pre-split records)
  db.prepare(
    `UPDATE holdings
     SET quantity = quantity * ?
     WHERE security_id = ? AND as_of_date < ?`,
  ).run(ratio, securityId, effectiveDate);

  // 2. Adjust prices (pre-split records)
  db.prepare(
    `UPDATE prices
     SET close_price = close_price / ?
     WHERE security_id = ? AND date < ?`,
  ).run(ratio, securityId, effectiveDate);

  // 3. Adjust OHLCV bars (pre-split records)
  db.prepare(
    `UPDATE ohlcv_bars
     SET open = open / ?,
         high = high / ?,
         low = low / ?,
         close = close / ?,
         volume = CAST(volume * ? AS INTEGER)
     WHERE security_id = ? AND bar_date < ?`,
  ).run(ratio, ratio, ratio, ratio, ratio, securityId, effectiveDate);

  // 4. Adjust tax lots — quantity changes, per-share price changes, total cost stays same
  db.prepare(
    `UPDATE tax_lots
     SET quantity_acquired = quantity_acquired * ?,
         quantity_remaining = quantity_remaining * ?,
         acquisition_price = acquisition_price / ?
     WHERE security_id = ? AND acquisition_date < ?`,
  ).run(ratio, ratio, ratio, securityId, effectiveDate);

  // 5. Adjust tax lot sales — quantity and per-share fields change, totals preserved
  db.prepare(
    `UPDATE tax_lot_sales
     SET quantity_sold = quantity_sold * ?,
         sale_price = sale_price / ?
     WHERE tax_lot_id IN (
       SELECT id FROM tax_lots WHERE security_id = ?
     ) AND sale_date < ?`,
  ).run(ratio, ratio, securityId, effectiveDate);

  // 6. Adjust transaction quantities and per-share prices (pre-split)
  db.prepare(
    `UPDATE transactions
     SET quantity = quantity * ?,
         price_per_share = CASE WHEN price_per_share IS NOT NULL
           THEN price_per_share / ? ELSE NULL END
     WHERE security_id = ? AND trade_date < ?`,
  ).run(ratio, ratio, securityId, effectiveDate);
}

/**
 * Undo a corporate action — reverse the adjustments and delete the record.
 */
export function undoCorporateAction(
  db: Database.Database,
  actionId: number,
): void {
  const action = db
    .prepare(
      `SELECT security_id, effective_date, ratio_numerator, ratio_denominator, applied, source
       FROM corporate_actions WHERE id = ?`,
    )
    .get(actionId) as {
      security_id: number;
      effective_date: string;
      ratio_numerator: number;
      ratio_denominator: number;
      applied: number;
      source: string;
    } | undefined;

  if (!action) throw new Error(`Corporate action ${actionId} not found`);

  if (action.source === "import") {
    throw new ImportedActionError(
      "This action was imported from a broker statement — undo its import batch instead",
    );
  }

  db.transaction(() => {
    if (action.applied) {
      // Reverse: apply inverse ratio
      const ratio = action.ratio_numerator / action.ratio_denominator;
      const inverseRatio = 1 / ratio;
      applyAdjustments(
        db,
        action.security_id,
        action.effective_date,
        inverseRatio,
      );
    }

    db.prepare("DELETE FROM corporate_actions WHERE id = ?").run(actionId);
  })();

  try {
    computeTaxLots(db);
  } catch { /* non-blocking */ }
  try {
    computeDailyValuations(db);
  } catch { /* non-blocking */ }
}
