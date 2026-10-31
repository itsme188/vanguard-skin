import type Database from "better-sqlite3";
import { IMPORT_SPLIT_ACTION_TYPES_SQL } from "@/lib/compute/synthetic-close-guards";

// Shared split-basis helpers for every per-security return series built from
// the `prices` table (the security page's regression and Position-Level
// Risk). Must not import from lib/compute/risk.ts or
// lib/compute/security-regression.ts: both import this module.

export interface ImportSplit {
  effective_date: string;
  ratio: number; // new shares per old share
}

/**
 * Import-mode (replay) split rows for one security, the same row set the lot
 * engine replays. 'manual' rows are legacy rewrite-mode and are excluded.
 * A minimal DB without the table has no splits.
 */
export function importSplitsFor(db: Database.Database, securityId: number): ImportSplit[] {
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'corporate_actions'")
    .get();
  if (!hasTable) return [];
  const rows = db
    .prepare(
      `SELECT effective_date,
              CAST(ratio_numerator AS REAL) / ratio_denominator AS ratio
         FROM corporate_actions
        WHERE security_id = ?
          AND source = 'import'
          AND UPPER(action_type) IN (${IMPORT_SPLIT_ACTION_TYPES_SQL})
        ORDER BY effective_date`
    )
    .all(securityId) as ImportSplit[];
  // One adjustment per effective date, and only a usable ratio.
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (!(r.ratio > 0) || !Number.isFinite(r.ratio) || r.ratio === 1) return false;
    if (seen.has(r.effective_date)) return false;
    seen.add(r.effective_date);
    return true;
  });
}

/**
 * Put every close on today's share basis: a close dated ON OR BEFORE a
 * split's effective date is divided by that split's ratio (4:1 -> a quarter).
 * This is the basis TWS historical bars already use.
 *
 * On or before, not before: the close stamped on the effective date is still
 * a pre-split print. The lot engine encodes the same end-of-day rule — it
 * replays a split AFTER every same-date sell (kind rank 2, `computeTaxLots`
 * replay stream in lib/compute/tax-lots.ts), because a same-date trade was
 * executed in pre-split units. Stored data agrees: a 4:1 split dated D has a
 * pre-split close on D and the post-split level on the next session.
 */
export function splitAdjustedClose(date: string, close: number, splits: ImportSplit[]): number {
  let adjusted = close;
  for (const s of splits) if (date <= s.effective_date) adjusted /= s.ratio;
  return adjusted;
}

/**
 * Keep only the splits the stored series has NOT already absorbed.
 *
 * Some series are stored on the post-split basis throughout (TWS bars fetched
 * after the split are back-adjusted). Dividing their earlier closes by the
 * ratio would plant a fake jump at the split. The evidence is the raw step
 * across the split: the last close on or before the effective date against
 * the first close after it. A step closer (in log terms) to the split factor
 * than to 1 means the series is unadjusted there and the split applies; a
 * step near 1 means it is already adjusted and the split is skipped. With no
 * close on one side of the split inside the window, the adjustment scales
 * every row alike and cannot create a return, so the split is kept.
 *
 * KNOWN LIMIT: one decision per split for the whole window. A series that
 * mixes both bases on the same side of a split is not repaired here; the
 * split-signature guard in each caller still drops the jump pair.
 */
export function splitsNotYetAbsorbed(
  rows: { date: string; close_price: number }[],
  splits: ImportSplit[]
): ImportSplit[] {
  return splits.filter((s) => {
    let before: number | undefined;
    let after: number | undefined;
    for (const r of rows) {
      if (!(r.close_price > 0)) continue;
      if (r.date <= s.effective_date) before = r.close_price;
      else if (after === undefined) after = r.close_price;
    }
    if (before === undefined || after === undefined) return true;
    const step = Math.log(before / after);
    const factor = Math.log(s.ratio);
    return Math.abs(step - factor) < Math.abs(step);
  });
}
