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
import { getTaxConventionState } from "@/lib/compute/tax-convention";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";

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

function sortWorstFirst(points: { toDate: string; residual: number }[]): void {
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

  const posByKey = new Map(positions.map((p) => [`${p.accountId}:${p.securityId}`, p]));
  const lotsByKey = new Map(lotRows.map((l) => [`${l.accountId}:${l.securityId}`, l]));

  const allKeys = Array.from(new Set<string>([...posByKey.keys(), ...lotsByKey.keys()])).sort();
  if (allKeys.length === 0) return [];

  const accountNameById = new Map(
    (db.prepare(`SELECT id, name FROM accounts`).all() as { id: number; name: string }[]).map((a) => [
      a.id,
      a.name,
    ])
  );
  const symbolBySecurityId = new Map(
    (db.prepare(`SELECT id, symbol FROM securities`).all() as { id: number; symbol: string }[]).map(
      (s) => [s.id, s.symbol]
    )
  );

  const fillsStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM transactions
      WHERE account_id = ? AND security_id = ?
        AND UPPER(type) IN (${EQUITY_FILL_TYPES.map(() => "?").join(",")})
        AND quantity IS NOT NULL AND quantity <> 0`
  );

  const hits: IntegrityHit[] = [];

  for (const key of allKeys) {
    const [accountIdStr, securityIdStr] = key.split(":");
    const accountId = Number(accountIdStr);
    const securityId = Number(securityIdStr);
    const pos = posByKey.get(key);
    const lot = lotsByKey.get(key);
    const posQty = pos?.posQty ?? 0;
    const signedLotQty = lot?.signedQty ?? 0;
    const diff = posQty - signedLotQty;
    if (Math.abs(diff) <= LOT_DRIFT_EPSILON) continue;

    const accountName = accountNameById.get(accountId) ?? `account ${accountId}`;
    const symbol = symbolBySecurityId.get(securityId) ?? `security ${securityId}`;

    if (!lot && pos) {
      const fills = fillsStmt.get(accountId, securityId, ...EQUITY_FILL_TYPES) as { n: number };
      if (fills.n > 0) {
        hits.push({
          key: `lot-drift:${accountId}:${securityId}`,
          severity: "critical",
          reason: `${symbol} (${accountName}): position has ${fills.n} fill${fills.n === 1 ? "" : "s"} but zero tax lots`,
        });
      } else {
        hits.push({
          key: `lot-drift:${accountId}:${securityId}`,
          severity: "warning",
          reason: `${symbol} (${accountName}): position has zero lots and zero transactions`,
        });
      }
      continue;
    }

    if (lot && !pos) {
      hits.push({
        key: `lot-drift:${accountId}:${securityId}`,
        severity: "warning",
        reason: `${symbol} (${accountName}): open tax lots with no matching position`,
      });
      continue;
    }

    const ratio = Math.abs(diff) / Math.max(Math.abs(posQty), Math.abs(signedLotQty));
    if (ratio > LOT_DRIFT_RATIO_THRESHOLD) {
      hits.push({
        key: `lot-drift:${accountId}:${securityId}`,
        severity: "critical",
        reason: `${symbol} (${accountName}): position/lot drift ${(ratio * 100).toFixed(1)}%`,
      });
    }
  }

  return hits;
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

// ── Entry point ──────────────────────────────────────────────────────

export function runIntegrityChecks(db: Database.Database): {
  critical: IntegrityHit[];
  warnings: IntegrityHit[];
} {
  const critical: IntegrityHit[] = [];
  const warnings: IntegrityHit[] = [];

  for (const hit of scanTypeIdentityHits(db)) {
    (hit.severity === "critical" ? critical : warnings).push(hit);
  }

  for (const hit of scanUnexplainedResidualHits(db)) {
    critical.push(hit);
  }

  if (getTaxConventionState(db).recomputeCurrent) {
    for (const hit of scanLotDriftHits(db)) {
      (hit.severity === "critical" ? critical : warnings).push(hit);
    }
  }

  for (const hit of scanReconcileDeltaHits(db)) {
    warnings.push(hit);
  }

  return { critical, warnings };
}
