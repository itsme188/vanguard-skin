/**
 * Independent TWR cross-check — compares the statement-reported
 * `monthly_snapshots.twr` against the ledger-derived Modified Dietz return
 * (Task 12, `lib/compute/dietz.ts`), NOT against `computeTwr` (which just
 * echoes `snap.twr` back — see CLAUDE.md "TWR 'reconciliation' is
 * statement-self-referential"). Comparing a statement figure against an
 * echo of itself always reads ~0bp divergence regardless of whether the
 * statement TWR is actually right; this module severs that circularity by
 * recomputing the return from first principles (the account's ledger) and
 * comparing that INDEPENDENT figure against the statement.
 */

import type Database from "better-sqlite3";
import {
  computeMonthlyDietz,
  DIETZ_CONSISTENT_BP,
  type DietzBand,
} from "@/lib/compute/dietz";

export interface TwrReconcileResult {
  accountId: number;
  monthEndDate: string;
  statementTwr: number | null; // decimal, source-normalized (ibkr ÷100 as today)
  statementSource: string | null;
  dietzReturn: number | null;
  divergenceBp: number | null; // round((dietz - statement) * 10000)
  band: DietzBand;
  rule: string;
}

// Dietz rules that never reach "banded" — each maps to the band the
// dietz.ts docstring already assigns it (its precedence-list comment
// spells out "→ not_comparable / <rule>" and "→ insufficient / <rule>"
// for every non-banded rule; this table just carries that mapping).
const DIETZ_RULE_BAND: Record<string, DietzBand> = {
  "annual-summary-row": "not_comparable",
  "missing-v-start": "insufficient",
  "nonpositive-denominator": "insufficient",
  "flow-total-mismatch": "insufficient",
  "flow-total-unavailable": "insufficient",
  "seam-straddled": "not_comparable",
};

/**
 * Cross-checks the statement-reported monthly TWR against the independent
 * Modified Dietz return for the same account + month. Returns null only
 * when there is no statement row at all for (accountId, monthEndDate) —
 * a row that exists but carries a null `twr` still returns a result (band
 * "insufficient", rule "missing-statement-twr") because the Dietz side may
 * still be informative on its own.
 */
export function reconcileTwrAgainstStatements(
  db: Database.Database,
  accountId: number,
  monthEndDate: string,
): TwrReconcileResult | null {
  // Pull the preferred statement row — prefer ibkr-activity, fall back to
  // canonical or vanguard-pdf. Deliberately NOT filtered on `twr IS NOT
  // NULL` (Codex plan review #6): with that filter kept, the
  // "missing-statement-twr" rule below is unreachable — a row with a null
  // twr would just look like "no statement row at all" instead of being
  // distinguished from it.
  const stmt = db
    .prepare(
      `
    SELECT twr, source FROM monthly_snapshots
    WHERE account_id = ? AND month_end_date = ?
      AND source IN ('ibkr-activity', 'canonical', 'vanguard-pdf')
    ORDER BY (source = 'ibkr-activity') DESC
    LIMIT 1
  `,
    )
    .get(accountId, monthEndDate) as
    | { twr: number | null; source: string }
    | undefined;

  if (!stmt) return null;

  // Independent recompute — this NEVER touches monthly_snapshots.twr, so
  // it cannot circularly agree with the statement figure it's checking.
  const dietz = computeMonthlyDietz(db, accountId, monthEndDate);

  // ibkr-activity stores TWR as percentage (e.g. 5.21 means 5.21%);
  // canonical and vanguard-pdf store as decimal (e.g. 0.0521).
  // See CLAUDE.md: "ibkr-activity source stores TWR as percentage"
  // Computed before the null check below (and kept null-safe) so both
  // early-return branches can carry a normalized figure when one exists.
  const statementTwr =
    stmt.twr === null
      ? null
      : stmt.source === "ibkr-activity"
        ? stmt.twr / 100
        : stmt.twr;

  // Precedence fix (finding 2): the spec's edge-precedence list puts
  // "December annual-summary row" FIRST — a chain-preserving verdict
  // (not_comparable) that must win even when the statement's own `twr`
  // column happens to be null. Checking `stmt.twr === null` before this
  // would misclassify an annual-summary row as "insufficient"
  // (chain-breaking) instead of "not_comparable" (chain-preserving), so
  // this check runs BEFORE the missing-statement-twr branch below.
  if (dietz.rule === "annual-summary-row") {
    return {
      accountId,
      monthEndDate,
      statementTwr,
      statementSource: stmt.source,
      dietzReturn: dietz.dietzReturn,
      divergenceBp: null,
      band: "not_comparable",
      rule: dietz.rule,
    };
  }

  if (stmt.twr === null) {
    return {
      accountId,
      monthEndDate,
      statementTwr: null,
      statementSource: stmt.source,
      dietzReturn: dietz.dietzReturn,
      divergenceBp: null,
      band: "insufficient",
      rule: "missing-statement-twr",
    };
  }

  if (dietz.rule !== "banded") {
    return {
      accountId,
      monthEndDate,
      statementTwr,
      statementSource: stmt.source,
      dietzReturn: dietz.dietzReturn,
      divergenceBp: null,
      band: DIETZ_RULE_BAND[dietz.rule] ?? "insufficient",
      rule: dietz.rule,
    };
  }

  // Non-null: the `stmt.twr === null` branch above already returned, so
  // `statementTwr` (derived from `stmt.twr`) is guaranteed a number here —
  // TS can't correlate the two independently-computed consts itself.
  const divergenceBp = Math.round((dietz.dietzReturn! - statementTwr!) * 10000);
  const band: DietzBand =
    Math.abs(divergenceBp) <= DIETZ_CONSISTENT_BP ? "consistent" : "investigate";

  return {
    accountId,
    monthEndDate,
    statementTwr,
    statementSource: stmt.source,
    dietzReturn: dietz.dietzReturn,
    divergenceBp,
    band,
    rule: "banded",
  };
}
