import type Database from "better-sqlite3";
import type { IntegrityHit } from "@/lib/queries/integrity-checks";
import type { PendingStatementPair } from "@/lib/queries/pending-statement";
import { routeLedgerRow, type LedgerCertainty, type LedgerRole } from "@/lib/queries/ledger-side-routing";
import type { PendingSide } from "@/lib/queries/pending-statement-types";

/**
 * CLOSING ENTRY IN ANOTHER ACCOUNT — for a pending option or short side in
 * account A, is there a closing entry for the same security in another
 * account B, in the pending lots' window, that the engine could not match to
 * any lot in B? Plan docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * rulings R4, R13, OPEN-11.
 *
 * How it decides (never a second whole-ledger catalogue):
 *  - Pending sides considered: the "new" classes only (any option side, a
 *    short stock/ETF side). Long stock keeps its synthetic-close path.
 *  - Window, applied to the candidate row itself: [earliest acquisition date
 *    of A's open lots on that side, A's flat date], both ends included.
 *  - Candidates (R13): rows of the security in every OTHER account that
 *    COULD close side σ per the routing catalogue
 *    (lib/queries/ledger-side-routing.ts): a pure close on σ, a close of
 *    either side (EXPIRED / EXERCISED / ASSIGNED), or a mixed-evidence row
 *    whose possible closing side is σ. Role and certainty stay separate.
 *  - For a CERTAIN, engine-loaded PURE close only, the quantity the engine
 *    could not match is `|quantity| - Σ tax_lot_sales.quantity_sold` for
 *    that sale transaction. Both terms are in the close's own units, so a
 *    split between the opening and the close does not distort it. When it is
 *    above 1e-9 the hit is CRITICAL.
 *  - A mixed-evidence candidate, or one the engine does not load (no price on
 *    a type that needs one, no quantity), is UNDECIDABLE: a warning with its
 *    own label, never critical.
 *  Claim: the critical hit is exact for pure closes; mixed closes are
 *  disclosed, not judged. A hit is a POSSIBLE association ("may be booked to
 *  the wrong account"), never a proven one, and it never ends A's pending
 *  reason. When A has both sides pending and B's unmatched row closes either
 *  side, each side gets its own hit naming the same one row; the row's
 *  quantity is never split between the sides (OPEN-11).
 *
 * `tax_lot_sales` is trusted only while the tax-lot convention marker is
 * current, so the caller runs this inside the same gate as the lot-drift
 * scan. Read-only.
 */

export interface ClosingEntryCandidate {
  accountA: number;
  accountB: number;
  securityId: number;
  side: PendingSide;
  transactionId: number;
  tradeDate: string;
  type: string;
  role: LedgerRole;
  certainty: LedgerCertainty;
  engineLoads: boolean;
  /** Quantity the engine could not match, for a certain, loaded pure close; null otherwise (undecidable). */
  unabsorbed: number | null;
}

const UNABSORBED_EPSILON = 1e-9;

interface CandidateRow {
  id: number;
  accountId: number;
  tradeDate: string;
  type: string;
  quantity: number | null;
  price_per_share: number | null;
  amount: number | null;
  notes: string | null;
  security_type: string;
}

/** Every candidate row for every new-class pending side in `pairs`, oldest first per side. */
export function findClosingEntryAccountCandidates(
  db: Database.Database,
  pairs: readonly PendingStatementPair[]
): ClosingEntryCandidate[] {
  if (pairs.length === 0) return [];

  const securityTypeStmt = db.prepare(
    `SELECT LOWER(COALESCE(security_type, '')) AS t FROM securities WHERE id = ?`
  );
  const earliestLotStmt = db.prepare(
    `SELECT MIN(acquisition_date) AS d FROM tax_lots
      WHERE account_id = ? AND security_id = ? AND quantity_remaining > 0
        AND (CASE WHEN COALESCE(is_short, 0) != 0 THEN 1 ELSE 0 END) = ?`
  );
  const rowsStmt = db.prepare(
    `SELECT t.id AS id, t.account_id AS accountId, t.trade_date AS tradeDate,
            UPPER(TRIM(t.type)) AS type, t.quantity AS quantity,
            t.price_per_share AS price_per_share, t.amount AS amount, t.notes AS notes,
            LOWER(COALESCE(s.security_type, '')) AS security_type
       FROM transactions t JOIN securities s ON s.id = t.security_id
      WHERE t.security_id = ? AND t.account_id != ?
        AND t.trade_date >= ? AND t.trade_date <= ?
      ORDER BY t.trade_date, t.id`
  );
  const soldStmt = db.prepare(
    `SELECT COALESCE(SUM(quantity_sold), 0) AS q FROM tax_lot_sales WHERE sale_transaction_id = ?`
  );

  const out: ClosingEntryCandidate[] = [];
  for (const p of pairs) {
    const secType = (securityTypeStmt.get(p.security_id) as { t: string } | undefined)?.t ?? "";
    const isNewClass = secType === "option" || p.side === "short";
    if (!isNewClass) continue;
    const earliest = (
      earliestLotStmt.get(p.account_id, p.security_id, p.side === "short" ? 1 : 0) as { d: string | null }
    ).d;
    if (earliest == null) continue;

    for (const row of rowsStmt.all(p.security_id, p.account_id, earliest, p.flat_date) as CandidateRow[]) {
      const r = routeLedgerRow(row);
      const couldClose =
        (r.role === "close" && r.closeSide === p.side) ||
        r.role === "close_either" ||
        (r.role === "mixed" && r.closeSide === p.side);
      if (!couldClose) continue;

      const decidable = r.certainty === "certain" && r.engineLoads && r.role !== "mixed";
      const unabsorbed = decidable
        ? Math.abs(row.quantity ?? 0) - (soldStmt.get(row.id) as { q: number }).q
        : null;
      out.push({
        accountA: p.account_id,
        accountB: row.accountId,
        securityId: p.security_id,
        side: p.side,
        transactionId: row.id,
        tradeDate: row.tradeDate,
        type: row.type,
        role: r.role,
        certainty: r.certainty,
        engineLoads: r.engineLoads,
        unabsorbed,
      });
    }
  }
  return out;
}

/**
 * The hits: one CRITICAL `closing-entry-account-mismatch` per (A, B,
 * security, side) with at least one unmatched certain close, and one
 * `closing-entry-account-undecidable` WARNING per (A, B, security, side)
 * with at least one undecidable candidate.
 */
export function scanClosingEntryAccountHits(
  db: Database.Database,
  pairs: readonly PendingStatementPair[]
): IntegrityHit[] {
  const candidates = findClosingEntryAccountCandidates(db, pairs);
  if (candidates.length === 0) return [];

  const accountName = new Map(
    (db.prepare(`SELECT id, name FROM accounts`).all() as { id: number; name: string }[]).map((a) => [a.id, a.name])
  );
  const nameOf = (id: number) => accountName.get(id) ?? `account ${id}`;
  const symbolOf = new Map(pairs.map((p) => [p.security_id, p.symbol]));

  const critical = new Map<string, ClosingEntryCandidate[]>();
  const undecidable = new Map<string, ClosingEntryCandidate[]>();
  for (const c of candidates) {
    const id = `${c.accountA}:${c.accountB}:${c.securityId}:${c.side}`;
    if (c.unabsorbed == null) {
      const list = undecidable.get(id) ?? [];
      list.push(c);
      undecidable.set(id, list);
    } else if (c.unabsorbed > UNABSORBED_EPSILON) {
      const list = critical.get(id) ?? [];
      list.push(c);
      critical.set(id, list);
    }
  }

  const dates = (list: ClosingEntryCandidate[]) => Array.from(new Set(list.map((c) => c.tradeDate))).join(", ");
  const entryWord = (list: ClosingEntryCandidate[]) => (list.length === 1 ? "a closing entry" : "closing entries");

  const hits: IntegrityHit[] = [];
  for (const [id, list] of critical) {
    const c = list[0];
    const symbol = symbolOf.get(c.securityId) ?? `security ${c.securityId}`;
    hits.push({
      key: `closing-entry-account:${id}`,
      severity: "critical",
      kind: "closing-entry-account-mismatch",
      reason: `${symbol}: ${entryWord(list)} in ${nameOf(c.accountB)} (${dates(list)}) matched no open lot there, while ${nameOf(c.accountA)} still carries the ${c.side} lots its records show closed: the entry may be booked to the wrong account or a transfer may be missing`,
    });
  }
  for (const [id, list] of undecidable) {
    const c = list[0];
    const symbol = symbolOf.get(c.securityId) ?? `security ${c.securityId}`;
    hits.push({
      key: `closing-entry-account-undecidable:${id}`,
      severity: "warning",
      kind: "closing-entry-account-undecidable",
      reason: `${symbol}: ${entryWord(list)} in ${nameOf(c.accountB)} (${dates(list)}) cannot be checked against the ${c.side} lots ${nameOf(c.accountA)} still carries (a mixed open-and-close trade, or an entry with no price or quantity)`,
    });
  }
  return hits;
}
