import type Database from "better-sqlite3";
import { scanTypeContradictions } from "@/lib/compute/type-contradictions";
import {
  computeCashFlowResiduals,
  isUnexplainedCashFlow,
  collectSeamDatesByAccount,
  collectLiveAnchorDatesByAccount,
  isLikelyIbkrAccountName,
  CONFIDENCE_RESIDUAL_ABS_FLOOR,
  CONFIDENCE_RESIDUAL_REL_FLOOR,
} from "@/lib/compute/cash-flow-audit";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import { getTaxConventionState } from "@/lib/compute/tax-convention";
import { statementGradeHoldingSql } from "@/lib/db/holding-sources";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { pendingStatementKeySet } from "@/lib/queries/pending-statement";
import { isCurrencyConversionSecurityType } from "@/lib/queries/tax-lots";

/**
 * Cross-cutting number-trust integrity scan (spec: number-trust durable
 * fixes, task 17). Four independent checks over already-landed data — never
 * a repair, always a disclosure. Every `reason` is short and names the
 * object (symbol/date); it renders inside `<PrivateText>` at the call
 * site, so it must never leak beyond what a symbol/date/percent already
 * discloses.
 */

export interface IntegrityHit {
  key: string;
  severity: "critical" | "warning";
  reason: string;
  /**
   * Optional typed sub-kind. "statement-lag": the tax lots differ from the
   * position only in LIVE data — a position closed per live data (the
   * pending-statement read model, lib/queries/pending-statement.ts), or any
   * other difference between a live sync and the lots while the statement
   * book agrees with them. Expected, self-resolving on the next statement
   * import: severity stays "warning" (never caps the score) and the popover
   * renders it as informational "awaiting statement". Absent on every other
   * hit.
   */
  kind?: "statement-lag";
}

// ── Check 1: type-identity contradictions ──────────────────────────────
//
// scanTypeContradictions (lib/compute/type-contradictions.ts) is the
// single source of truth for the OR-union detector; a HELD contradiction
// is critical (a live position is being mispriced through the wrong
// valuation convention right now), an unheld one is a warning (historical
// data quality, nothing currently mispriced).

function scanTypeIdentityHits(db: Database.Database): IntegrityHit[] {
  return scanTypeContradictions(db).map((hit) => ({
    key: `type-contradiction:${hit.securityId}`,
    severity: hit.held ? "critical" : "warning",
    reason: `${hit.symbol}: ${hit.securityType} type contradicts ${hit.equityFills} equity fill${
      hit.equityFills === 1 ? "" : "s"
    }`,
  }));
}

// ── Check 2: unexplained negative cash-flow residual ────────────────────
//
// Uses data-confidence.ts's CONFIDENCE_RESIDUAL_* floors (2%/$1,000), not
// isUnexplainedCashFlow's stricter defaults (5%/$5,000 — the repair
// script's "propose a fix" bar) — this is a disclosure surface like the
// cash-accuracy confidence dimension, not a repair-candidate list, so it
// shares that dimension's more sensitive early-warning bar
// (lib/queries/data-confidence.ts:371-374's findWorstUnexplainedCashFlow).
// `source-seam` and `live-anchor-residual` points are measurement-basis
// artifacts, never a real missing flow (see cash-flow-audit.ts's
// classification doc) — both are excluded regardless of how large they
// read. Only residuals landing within the account's own last 30 valuation
// days are live-gated here; older ones inform Data Health, not a "this
// needs attention now" flag.

const CONFIDENCE_FLOORS = {
  absFloor: CONFIDENCE_RESIDUAL_ABS_FLOOR,
  relFloor: CONFIDENCE_RESIDUAL_REL_FLOOR,
};

/** Sorts flagged residual points worst-first: most recent toDate, then
 *  largest |residual| as a tiebreak. Single source of truth (consolidated
 *  task 18 — this file and data-confidence.ts each carried an identical
 *  copy): shared by this file's scanUnexplainedResidualHits AND by
 *  data-confidence.ts's unexplainedFlow/timingResidual selections
 *  (findWorstUnexplainedCashFlow) so their "worst" definitions can never
 *  silently drift apart. Lives here (not data-confidence.ts) so
 *  data-confidence.ts's import of runIntegrityChecks stays one-directional
 *  — this file never imports from data-confidence.ts. */
export type CashFlowResidualPointForSort = { toDate: string; residual: number };

export function sortWorstFirst(points: CashFlowResidualPointForSort[]): void {
  points.sort((a, b) =>
    a.toDate !== b.toDate
      ? a.toDate < b.toDate
        ? 1
        : -1 // most recent date first
      : Math.abs(b.residual) - Math.abs(a.residual)
  );
}

const RECENT_VALUATION_WINDOW = 30;

function scanUnexplainedResidualHits(db: Database.Database): IntegrityHit[] {
  const accounts = db.prepare(`SELECT id, name FROM accounts`).all() as {
    id: number;
    name: string;
  }[];
  // Mirrors findWorstUnexplainedCashFlow's account universe exactly
  // (lib/queries/data-confidence.ts:349-360): IBKR's margin/multi-leg/
  // same-day-sweep cash model produces ~10x the residual noise of a
  // statement-fed account under this same per-type model, so it's excluded
  // here too — consistency with the sibling cash-accuracy dimension.
  const nonIbkrAccounts = accounts.filter((a) => !isLikelyIbkrAccountName(a.name));
  if (nonIbkrAccounts.length === 0) return [];
  const accountIds = nonIbkrAccounts.map((a) => a.id);

  const seamDatesByAccount = collectSeamDatesByAccount(db, accountIds);
  const liveAnchorDatesByAccount = collectLiveAnchorDatesByAccount(db, accountIds);

  const points = computeCashFlowResiduals(db, {
    accountIds,
    seamDatesByAccount,
    liveAnchorDatesByAccount,
  });
  if (points.length === 0) return [];

  const recentDatesStmt = db.prepare(
    `SELECT valuation_date FROM daily_valuations
      WHERE account_id = ?
      ORDER BY valuation_date DESC
      LIMIT ${RECENT_VALUATION_WINDOW}`
  );
  const recentDatesByAccount = new Map<number, Set<string>>();
  for (const id of accountIds) {
    const rows = recentDatesStmt.all(id) as { valuation_date: string }[];
    recentDatesByAccount.set(id, new Set(rows.map((r) => r.valuation_date)));
  }

  const flagged = points.filter(
    (p) =>
      p.residual < 0 &&
      isUnexplainedCashFlow(p, CONFIDENCE_FLOORS) &&
      p.classification !== "source-seam" &&
      p.classification !== "live-anchor-residual" &&
      (recentDatesByAccount.get(p.accountId)?.has(p.toDate) ?? false)
  );
  sortWorstFirst(flagged);

  return flagged.map((p) => ({
    key: `cash-residual:${p.accountId}:${p.toDate}`,
    severity: "critical",
    reason: `${p.accountName}: unexplained cash residual of ${p.residual.toFixed(2)} on ${p.toDate}`,
  }));
}

// ── Check 3: position ↔ tax-lot drift ────────────────────────────────
//
// Signed comparison (short lots negate via is_short), guarded by a float
// epsilon so genuine reconciliation isn't flagged over rounding dust. DARK
// (returns no hits) while the tax-lots convention marker is stale — a
// drift signal computed against a pre-recompute engine isn't trustworthy
// (Track A dependency; see getTaxConventionState's doc).
//
// WHICH position the lots are compared with (2026-10-08). Tax lots are built
// from the imported ledger, and the ledger moves only when a statement or an
// activity file is imported. A live sync (TWS / IBKR Web API / Plaid) is
// fresher than the ledger, so a difference seen only there is timing, not a
// defect. Per (account, security):
//
//   1. The account has no statement-grade holdings row at all: there is no
//      statement to wait for, so the lots are compared with the latest
//      position of any source, at full severity (the original behaviour).
//   2. Otherwise the comparator is the STATEMENT position: the pair's newest
//      statement-grade row (`statementGradeHoldingSql`, the same evidence
//      class the synthetic-close anchor uses), or zero when the pair has none
//      (the statement book is complete). A disagreement here is a real hit.
//   3. The statement is skipped as comparator when the ledger is newer than
//      it (a quantity-bearing transaction dated after the statement row):
//      the lots have legitimately moved on.
//   4. When the statement agrees (or was skipped) and a snapshot at least as
//      new as the ledger still differs from the lots, the hit is a WARNING
//      of kind "statement-lag" (pending statement). It never caps the score.

const LOT_DRIFT_EPSILON = 1e-4; // shares
const LOT_DRIFT_RATIO_THRESHOLD = 0.05; // 5%

const EQUITY_FILL_TYPES = [
  "BUY",
  "SELL",
  "SHORT_SELL",
  "BUY_TO_COVER",
  "BUY_TO_OPEN",
  "SELL_TO_OPEN",
  "BUY_TO_CLOSE",
  "SELL_TO_CLOSE",
];

type LotDriftShape =
  | { shape: "fills-zero-lots"; magnitude: 1 }
  | { shape: "no-lots-no-fills"; magnitude: 0 }
  | { shape: "lots-no-position"; magnitude: 0 }
  | { shape: "ratio"; magnitude: number };

/**
 * The one comparison both comparators (statement position, latest position)
 * run. `posQty` 0 means "no position"; `signedLotQty` 0 with `hasLot` false
 * means "no open lots". `fillCount` is only consulted for a position with no
 * lots. Returns null when the two reconcile (or differ by 5% or less).
 */
function classifyLotDrift(
  posQty: number,
  signedLotQty: number,
  hasLot: boolean,
  fillCount: () => number
): LotDriftShape | null {
  const diff = posQty - signedLotQty;
  if (Math.abs(diff) <= LOT_DRIFT_EPSILON) return null;
  const hasPos = posQty !== 0;
  if (!hasLot && hasPos) {
    return fillCount() > 0
      ? { shape: "fills-zero-lots", magnitude: 1 }
      : { shape: "no-lots-no-fills", magnitude: 0 };
  }
  if (hasLot && !hasPos) return { shape: "lots-no-position", magnitude: 0 };
  const ratio = Math.abs(diff) / Math.max(Math.abs(posQty), Math.abs(signedLotQty));
  return ratio > LOT_DRIFT_RATIO_THRESHOLD ? { shape: "ratio", magnitude: ratio } : null;
}

function scanLotDriftHits(db: Database.Database): IntegrityHit[] {
  const positions = db
    .prepare(
      `SELECT h.account_id AS accountId, h.security_id AS securityId, h.quantity AS posQty
         FROM holdings h
        WHERE ${latestHoldingsPredicate({ keyBy: "account_security" })}`
    )
    .all() as { accountId: number; securityId: number; posQty: number }[];

  const lotRows = db
    .prepare(
      `SELECT account_id AS accountId, security_id AS securityId,
              SUM(CASE WHEN is_short = 1 THEN -quantity_remaining ELSE quantity_remaining END) AS signedQty
         FROM tax_lots
        WHERE quantity_remaining > 0
        GROUP BY account_id, security_id`
    )
    .all() as { accountId: number; securityId: number; signedQty: number }[];

  // The STATEMENT book: each pair's newest statement-grade row (a zero row is
  // a statement-pass tombstone: the statement says the position is closed).
  const statementRows = db
    .prepare(
      `SELECT h.account_id AS accountId, h.security_id AS securityId,
              h.quantity AS quantity, h.as_of_date AS asOfDate
         FROM holdings h
        WHERE ${statementGradeHoldingSql("h")}
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id
               AND ${statementGradeHoldingSql("h2")}
          )`
    )
    .all() as { accountId: number; securityId: number; quantity: number; asOfDate: string }[];

  // Date of each pair's newest row of ANY source, zero rows included (the
  // `positions` read above drops zero rows, so it cannot date a live flat).
  const newestRows = db
    .prepare(
      `SELECT h.account_id AS accountId, h.security_id AS securityId, h.as_of_date AS asOfDate
         FROM holdings h
        WHERE h.as_of_date = (
            SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id
          )`
    )
    .all() as { accountId: number; securityId: number; asOfDate: string }[];

  const posByKey = new Map(positions.map((p) => [`${p.accountId}:${p.securityId}`, p]));
  const lotsByKey = new Map(lotRows.map((l) => [`${l.accountId}:${l.securityId}`, l]));
  const statementByKey = new Map(statementRows.map((r) => [`${r.accountId}:${r.securityId}`, r]));
  const newestDateByKey = new Map(newestRows.map((r) => [`${r.accountId}:${r.securityId}`, r.asOfDate]));
  // An account's statement date: its newest statement-grade row. A pair the
  // statement book does not carry is flat as of this date.
  const statementDateByAccount = new Map<number, string>();
  for (const r of statementRows) {
    const prev = statementDateByAccount.get(r.accountId);
    if (!prev || r.asOfDate > prev) statementDateByAccount.set(r.accountId, r.asOfDate);
  }

  const allKeys = Array.from(
    new Set<string>([...posByKey.keys(), ...lotsByKey.keys(), ...statementByKey.keys()])
  ).sort();
  if (allKeys.length === 0) return [];

  // Same `${account}:${security}` key as posByKey/lotsByKey above.
  const pendingKeys = pendingStatementKeySet(db);

  const accountNameById = new Map(
    (db.prepare(`SELECT id, name FROM accounts`).all() as { id: number; name: string }[]).map((a) => [
      a.id,
      a.name,
    ])
  );
  const secRows = db
    .prepare(`SELECT id, symbol, security_type, fund_category FROM securities`)
    .all() as {
    id: number;
    symbol: string;
    security_type: string | null;
    fund_category: string | null;
  }[];
  const symbolBySecurityId = new Map(secRows.map((s) => [s.id, s.symbol]));
  // Sweep / money-market funds carry no meaningful tax lots, so a position
  // with zero lots is expected, not drift (single source: isCashEquivalentSecurity).
  const cashEquivalentIds = new Set(secRows.filter((s) => isCashEquivalentSecurity(s)).map((s) => s.id));
  // A currency conversion (IBKR forex trade) mints lots but never a holdings
  // row — the currency sits in the cash balance. Lots without a position are
  // its normal state, not an orphan (single source: isCurrencyConversionSecurityType).
  const currencyConversionIds = new Set(
    secRows.filter((s) => isCurrencyConversionSecurityType(s.security_type)).map((s) => s.id)
  );

  const fillsStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM transactions
      WHERE account_id = ? AND security_id = ?
        AND UPPER(type) IN (${EQUITY_FILL_TYPES.map(() => "?").join(",")})
        AND quantity IS NOT NULL AND quantity <> 0`
  );
  // Newest ledger row that moves shares for the pair. Every quantity-bearing
  // transaction counts (fills, reinvestments, in-kind transfers, splits,
  // redemptions); income rows carry no quantity. Deliberately wider than the
  // synthetic-close later-fill list: the question here is only "has the
  // ledger moved since this snapshot?".
  const lastLedgerMoveStmt = db.prepare(
    `SELECT MAX(trade_date) AS d FROM transactions
      WHERE account_id = ? AND security_id = ?
        AND quantity IS NOT NULL AND quantity <> 0`
  );

  // Each hit carries the drift magnitude it was measured at so the list can
  // be returned worst-first: the header's cap line names critical[0], and a
  // key-order list named whichever pair sorted first, not the largest drift
  // (qa:header-dataconfidence--cap-line-names-first-critical-hit-not-the-worst).
  // A position with fills but zero lots is a full (1.0) drift; warnings carry
  // 0 so they trail the criticals. Ties keep key order (stable sort).
  const hits: Array<{ hit: IntegrityHit; magnitude: number }> = [];

  for (const key of allKeys) {
    const [accountIdStr, securityIdStr] = key.split(":");
    const accountId = Number(accountIdStr);
    const securityId = Number(securityIdStr);
    if (cashEquivalentIds.has(securityId)) continue;
    if (currencyConversionIds.has(securityId)) continue;
    const lot = lotsByKey.get(key);
    const hasLot = Boolean(lot);
    const signedLotQty = lot?.signedQty ?? 0;
    const latestQty = posByKey.get(key)?.posQty ?? 0;

    const accountName = accountNameById.get(accountId) ?? `account ${accountId}`;
    const symbol = symbolBySecurityId.get(securityId) ?? `security ${securityId}`;
    const hitKey = `lot-drift:${accountId}:${securityId}`;
    const label = `${symbol} (${accountName})`;

    let fillsMemo: number | undefined;
    const fillCount = (): number => {
      if (fillsMemo === undefined) {
        fillsMemo = (fillsStmt.get(accountId, securityId, ...EQUITY_FILL_TYPES) as { n: number }).n;
      }
      return fillsMemo;
    };

    const pushReal = (drift: LotDriftShape): void => {
      if (drift.shape === "fills-zero-lots") {
        const n = fillCount();
        hits.push({
          magnitude: drift.magnitude,
          hit: {
            key: hitKey,
            severity: "critical",
            reason: `${label}: position has ${n} fill${n === 1 ? "" : "s"} but zero tax lots`,
          },
        });
      } else if (drift.shape === "no-lots-no-fills") {
        hits.push({
          magnitude: 0,
          hit: { key: hitKey, severity: "warning", reason: `${label}: position has zero lots and zero transactions` },
        });
      } else if (drift.shape === "lots-no-position") {
        hits.push({
          magnitude: 0,
          hit: { key: hitKey, severity: "warning", reason: `${label}: open tax lots with no matching position` },
        });
      } else {
        hits.push({
          magnitude: drift.magnitude,
          hit: {
            key: hitKey,
            severity: "critical",
            reason: `${label}: position/lot drift ${(drift.magnitude * 100).toFixed(1)}%`,
          },
        });
      }
    };

    const latestDrift = classifyLotDrift(latestQty, signedLotQty, hasLot, fillCount);

    // Closed per live data, lots still open: the pending-statement read model
    // owns this pair on every surface, so it wins here too.
    if (latestDrift?.shape === "lots-no-position" && pendingKeys.has(key)) {
      hits.push({
        magnitude: 0,
        hit: {
          key: hitKey,
          severity: "warning",
          kind: "statement-lag",
          reason: `${label}: closed per live data — awaiting statement`,
        },
      });
      continue;
    }

    // (1) No statement book for this account: nothing to wait for.
    const accountStatementDate = statementDateByAccount.get(accountId);
    if (!accountStatementDate) {
      if (latestDrift) pushReal(latestDrift);
      continue;
    }

    // (2)/(3) Statement position vs lots, unless the ledger is newer.
    const statementRow = statementByKey.get(key);
    const statementDate = statementRow?.asOfDate ?? accountStatementDate;
    const statementQty = statementRow?.quantity ?? 0;
    const lastLedgerMove = (lastLedgerMoveStmt.get(accountId, securityId) as { d: string | null }).d;
    const ledgerNewerThanStatement = lastLedgerMove !== null && lastLedgerMove > statementDate;
    if (!ledgerNewerThanStatement) {
      const statementDrift = classifyLotDrift(statementQty, signedLotQty, hasLot, fillCount);
      if (statementDrift) {
        pushReal(statementDrift);
        continue;
      }
    }

    // (4) The statement agrees (or the ledger has moved past it). A snapshot
    // that is older than the newest ledger move cannot judge the lots; a
    // newer one that still differs is waiting on the statement.
    if (!latestDrift) continue;
    const newestDate = newestDateByKey.get(key);
    const snapshotOlderThanLedger =
      lastLedgerMove !== null && (newestDate === undefined || newestDate < lastLedgerMove);
    if (ledgerNewerThanStatement && snapshotOlderThanLedger) continue;
    hits.push({
      magnitude: 0,
      hit: {
        key: hitKey,
        severity: "warning",
        kind: "statement-lag",
        reason: `${label}: live position differs from tax lots — pending statement`,
      },
    });
  }

  return hits.sort((a, b) => b.magnitude - a.magnitude).map((h) => h.hit);
}

// ── Check 4: corporate-action reconcile delta ───────────────────────────

function scanReconcileDeltaHits(db: Database.Database): IntegrityHit[] {
  const rows = db
    .prepare(
      `SELECT ca.id AS id, ca.effective_date AS effectiveDate, s.symbol AS symbol,
              ca.reconcile_delta AS reconcileDelta
         FROM corporate_actions ca
         JOIN securities s ON s.id = ca.security_id
        WHERE ca.reconcile_delta IS NOT NULL
        ORDER BY ca.id ASC`
    )
    .all() as { id: number; effectiveDate: string; symbol: string; reconcileDelta: number }[];

  return rows.map((r) => ({
    key: `reconcile-delta:${r.id}`,
    severity: "warning",
    reason: `${r.symbol}: corporate action reconcile delta ${r.reconcileDelta} on ${r.effectiveDate}`,
  }));
}

// ── Grouping for a reader ─────────────────────────────────────────────
//
// Every hit's `key` starts with the check that produced it. The Data Health
// page lists hits under the check's plain name (the list can run to dozens),
// so the mapping lives beside the scanners that mint the keys.

export type IntegrityCheckId =
  | "type-contradiction"
  | "cash-residual"
  | "lot-drift"
  | "reconcile-delta"
  | "other";

/** Display order = the order runIntegrityChecks runs the scans. */
export const INTEGRITY_CHECK_ORDER: readonly IntegrityCheckId[] = [
  "type-contradiction",
  "cash-residual",
  "lot-drift",
  "reconcile-delta",
  "other",
];

export const INTEGRITY_CHECK_LABELS: Record<IntegrityCheckId, string> = {
  "type-contradiction": "Security type contradicts its trades",
  "cash-residual": "Cash movement no transaction explains",
  "lot-drift": "Position does not match its tax lots",
  "reconcile-delta": "Corporate action share count does not reconcile",
  other: "Other",
};

export function integrityCheckIdOf(key: string): IntegrityCheckId {
  const prefix = key.split(":")[0];
  return prefix === "type-contradiction" ||
    prefix === "cash-residual" ||
    prefix === "lot-drift" ||
    prefix === "reconcile-delta"
    ? prefix
    : "other";
}

/**
 * Hits grouped by check, groups in scan order, hits in the order given (the
 * lot-drift scan is already worst-first). Empty groups are left out. No hit is
 * dropped: an unrecognised key lands in "other".
 */
export function groupIntegrityHits(
  hits: readonly IntegrityHit[],
): Array<{ check: IntegrityCheckId; label: string; hits: IntegrityHit[] }> {
  const byCheck = new Map<IntegrityCheckId, IntegrityHit[]>();
  for (const hit of hits) {
    const check = integrityCheckIdOf(hit.key);
    const list = byCheck.get(check);
    if (list) list.push(hit);
    else byCheck.set(check, [hit]);
  }
  return INTEGRITY_CHECK_ORDER.filter((c) => byCheck.has(c)).map((check) => ({
    check,
    label: INTEGRITY_CHECK_LABELS[check],
    hits: byCheck.get(check)!,
  }));
}

// ── Entry point ──────────────────────────────────────────────────────

export function runIntegrityChecks(db: Database.Database): {
  critical: IntegrityHit[];
  warnings: IntegrityHit[];
  /** False means the position/lot comparison was skipped, not that it passed. */
  lotDriftChecked: boolean;
} {
  const critical: IntegrityHit[] = [];
  const warnings: IntegrityHit[] = [];

  for (const hit of scanTypeIdentityHits(db)) {
    (hit.severity === "critical" ? critical : warnings).push(hit);
  }

  for (const hit of scanUnexplainedResidualHits(db)) {
    critical.push(hit);
  }

  const lotDriftChecked = getTaxConventionState(db).recomputeCurrent;
  if (lotDriftChecked) {
    for (const hit of scanLotDriftHits(db)) {
      (hit.severity === "critical" ? critical : warnings).push(hit);
    }
  }

  for (const hit of scanReconcileDeltaHits(db)) {
    warnings.push(hit);
  }

  return { critical, warnings, lotDriftChecked };
}
