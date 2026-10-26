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
import {
  getPendingStatementIndex,
  type PendingStatementIndex,
  type PendingStatementReadOptions,
} from "@/lib/queries/pending-statement";
import {
  PENDING_REASON_PRECEDENCE,
  type PendingReason,
  type PendingSide,
} from "@/lib/queries/pending-statement-types";
import { scanClosingEntryAccountHits } from "@/lib/queries/closing-entry-account-mismatch";
import { scanExerciseLegMissingHits, scanExercisePriceMissingHits } from "@/lib/queries/exercise-link-gaps";
import { isCurrencyConversionSecurityType } from "@/lib/queries/tax-lots";
import { addDays, todayET } from "@/lib/calendar/date-utils";
import { isOptionLive } from "@/lib/compute/option-expiry";

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
  kind?: IntegrityHitKind;
  /**
   * Every pending reason of the pair (lib/queries/pending-statement.ts), in
   * PENDING_REASON_ORDER, on a lot-drift hit whose kind is a pending reason
   * other than plain "awaiting statement" (OPEN-4: one hit per pair, every
   * reason kept and named in the text). Absent on every other hit, including
   * the awaiting-statement-only hit, which keeps its pre-2026-10-26 shape.
   */
  pendingReasons?: PendingReason[];
}

/**
 * Typed sub-kinds (plan docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md, Task 8):
 *  - "closing-entry-missing": a pending option or short side whose statement
 *    shows it closed with no closing entry imported (warning, never caps).
 *  - "resymbol-repair-pending": an option renamed to a new contract after a
 *    split and still held under it in the same account (warning).
 *  - "closing-entry-account-mismatch": a closing entry in another account the
 *    engine matched to no lot there, inside a pending side's window (CRITICAL).
 *  - "closing-entry-account-undecidable": such an entry that cannot be judged
 *    (mixed evidence, or not loaded by the engine) (warning).
 *  - "exercise-price-missing" / "exercise-leg-missing": an exercise or
 *    assignment whose premium is not moved to the stock (warning, ledger only).
 */
export type IntegrityHitKind =
  | "statement-lag"
  | "closing-entry-missing"
  | "resymbol-repair-pending"
  | "closing-entry-account-mismatch"
  | "closing-entry-account-undecidable"
  | "exercise-price-missing"
  | "exercise-leg-missing";

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
//   3. When the ledger is newer than the statement (a quantity-bearing
//      transaction or a corporate action dated after the statement row), the
//      lots are ROLLED BACK to the statement date before the comparison
//      (`rollLotsBackToStatement`): today's open-lot quantity minus the
//      signed quantity those later ledger rows moved, with an import-sourced
//      split undone by its ratio. A rolled-back quantity that disagrees with
//      the statement is a real hit, exactly as in rule 2: a later trade never
//      hides a disagreement that was already there on the statement date.
//      When the roll-back cannot be done exactly (a spin-off, a merger, a
//      hand-entered split, an unknown transaction type, an expiry the lots
//      did not record), the pair is a "statement-lag" WARNING whose reason
//      says so, unless a snapshot at least as new as the ledger agrees with
//      the lots.
//   4. When the statement agrees with the lots (as they stand, or rolled
//      back) and a snapshot at least as new as the ledger still differs from
//      the lots, the hit is a WARNING of kind "statement-lag" (pending
//      statement). It never caps the score. A snapshot OLDER than the newest
//      ledger row cannot judge today's lots: the rolled-back comparison has
//      already accounted for every row after the statement, so there is no
//      difference left to report.
//
// Every pair with a statement book therefore ends in exactly one of: no
// difference, a real hit, or a pending-statement warning.
//
// PENDING PAIRS (2026-10-26, plan
// docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
// rulings R12 and OPEN-4). A pair the pending read model lists
// (`getPendingStatementIndex`, any side, any reason) gets exactly ONE pending
// warning keyed `lot-drift:<a>:<s>`, whatever the signed drift is: a long and
// a short side that cancel to zero still get it. Its kind is the first
// present reason in PENDING_REASON_PRECEDENCE; awaiting-statement alone keeps
// the "statement-lag" kind and text it always had. The assessment above
// still runs for the pair and its output is sorted in two:
//   * INDEPENDENT findings (real drift against the statement or the
//     rolled-back statement: fills with zero lots, no lots and no fills, a
//     ratio drift; and the roll-back uncertainty warning) are emitted beside
//     the pending hit under the key suffix `:drift`, at their usual severity;
//   * FALLBACK pending disclosures (a lots-without-position outcome on either
//     comparator, and the step-4 statement-lag warning) are suppressed: the
//     pending hit already explains the pair.
// A pair with no pending reason follows the rules above exactly.

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

/**
 * Signed share movement per transaction type (compare with UPPER(type)).
 * +1 raises the signed position (buys, covers, arrivals); -1 lowers it
 * (sales, short opens, departures, maturities). Signed arithmetic makes the
 * same table right for longs and shorts: a cover moves -100 toward zero by
 * adding, a short open moves away from zero by subtracting.
 */
const LEDGER_MOVE_SIGN: Record<string, 1 | -1> = {
  BUY: 1,
  REINVESTMENT: 1,
  BUY_TO_OPEN: 1,
  BUY_TO_COVER: 1,
  BUY_TO_CLOSE: 1,
  TRANSFER_IN: 1,
  SELL: -1,
  SELL_TO_CLOSE: -1,
  SELL_TO_OPEN: -1,
  SHORT_SELL: -1,
  TRANSFER_OUT: -1,
  REDEMPTION: -1,
};

/**
 * Types that close whatever is open, long or short, so the type alone does
 * not give a direction. The direction is read from the lots the engine
 * actually closed for that row (`tax_lot_sales`).
 */
const LEDGER_CLOSE_TOWARD_ZERO = new Set(["EXPIRED", "EXERCISED", "ASSIGNED", "RECONCILE_CLOSE"]);

const IMPORT_SPLIT_ACTION_TYPES = new Set(["SPLIT", "REVERSE_SPLIT"]);

type LotRollBack = { ok: true; quantity: number } | { ok: false; why: string };

interface LedgerRowAfter {
  id: number;
  date: string;
  type: string;
  quantity: number;
}

interface CorporateActionAfter {
  date: string;
  actionType: string;
  source: string | null;
  ratio: number | null;
}

/**
 * The signed open-lot quantity as it stood at the end of the statement date:
 * today's quantity with every later ledger row undone, newest first. Within
 * one date the engine applies trades first and the split last (end-of-day
 * rule), so the undo runs the split first and the trades after it.
 *
 * Quantities only: an option's multiplier and a bond's per-100 pricing never
 * enter a share-count comparison.
 */
function rollLotsBackToStatement(
  signedLotQty: number,
  ledgerRows: LedgerRowAfter[],
  corporateActions: CorporateActionAfter[],
  closedSignedQty: (transactionId: number) => number | null
): LotRollBack {
  type Step =
    | { date: string; rank: 0; ratio: number }
    | { date: string; rank: 1; row: LedgerRowAfter };
  const steps: Step[] = [];
  for (const ca of corporateActions) {
    if (!IMPORT_SPLIT_ACTION_TYPES.has(ca.actionType)) {
      return { ok: false, why: "a corporate action dated after the statement" };
    }
    if (ca.source !== "import") {
      return { ok: false, why: "a hand-entered split dated after the statement" };
    }
    if (ca.ratio === null || !Number.isFinite(ca.ratio) || ca.ratio <= 0) {
      return { ok: false, why: "a split with no usable ratio dated after the statement" };
    }
    steps.push({ date: ca.date, rank: 0, ratio: ca.ratio });
  }
  for (const row of ledgerRows) steps.push({ date: row.date, rank: 1, row });
  steps.sort((a, b) => (a.date === b.date ? a.rank - b.rank : a.date < b.date ? 1 : -1));

  let quantity = signedLotQty;
  for (const step of steps) {
    if (step.rank === 0) {
      quantity /= step.ratio;
      continue;
    }
    const { row } = step;
    const sign = LEDGER_MOVE_SIGN[row.type];
    if (sign !== undefined) {
      quantity -= sign * Math.abs(row.quantity);
      continue;
    }
    if (LEDGER_CLOSE_TOWARD_ZERO.has(row.type)) {
      const closed = closedSignedQty(row.id);
      if (closed === null) {
        return { ok: false, why: "an expiry, exercise or assignment after the statement that closed no tax lot" };
      }
      quantity -= closed;
      continue;
    }
    return { ok: false, why: "a corporate action dated after the statement" };
  }
  return { ok: true, quantity };
}

const PENDING_HIT_KIND: Record<PendingReason, IntegrityHitKind> = {
  awaiting_statement: "statement-lag",
  closing_entry_missing: "closing-entry-missing",
  resymbol_repair_pending: "resymbol-repair-pending",
};

/** This file's own words per reason (lib files never import app copy). */
const PENDING_HIT_PHRASE: Record<PendingReason, string> = {
  awaiting_statement: "closed per live data — awaiting statement",
  closing_entry_missing: "statement shows the position closed but its closing entry is not imported — lots not valued",
  resymbol_repair_pending:
    "renamed to a new contract after a split and still held under it — the ledger entries must be moved to the new symbol before these lots are valued",
};

/**
 * The one pending warning for a pair. Awaiting statement on its own keeps
 * the exact pre-2026-10-26 hit (no `pendingReasons`); any other reason names
 * every pending side and its reason.
 */
function pendingLotDriftHit(
  hitKey: string,
  label: string,
  sides: readonly { side: PendingSide; reason: PendingReason }[],
  reasons: PendingReason[]
): IntegrityHit {
  const lead = PENDING_REASON_PRECEDENCE.find((r) => reasons.includes(r))!;
  if (lead === "awaiting_statement") {
    return {
      key: hitKey,
      severity: "warning",
      kind: "statement-lag",
      reason: `${label}: ${PENDING_HIT_PHRASE.awaiting_statement}`,
    };
  }
  const text = sides.map((p) => `${p.side} side: ${PENDING_HIT_PHRASE[p.reason]}`).join("; ");
  return {
    key: hitKey,
    severity: "warning",
    kind: PENDING_HIT_KIND[lead],
    pendingReasons: reasons,
    reason: `${label}: ${text}`,
  };
}

function scanLotDriftHits(
  db: Database.Database,
  pendingIndex: PendingStatementIndex,
  today: string = todayET()
): IntegrityHit[] {
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

  // Local pair keys (never a pending-statement key): every pair the pending
  // index lists is scanned too (R12), even if no other source names it.
  const allKeys = Array.from(
    new Set<string>([
      ...posByKey.keys(),
      ...lotsByKey.keys(),
      ...statementByKey.keys(),
      ...pendingIndex.pairs.map((p) => `${p.account_id}:${p.security_id}`),
    ])
  ).sort();
  if (allKeys.length === 0) return [];

  const accountNameById = new Map(
    (db.prepare(`SELECT id, name FROM accounts`).all() as { id: number; name: string }[]).map((a) => [
      a.id,
      a.name,
    ])
  );
  const secRows = db
    .prepare(`SELECT id, symbol, security_type, fund_category, expiration_date FROM securities`)
    .all() as {
    id: number;
    symbol: string;
    security_type: string | null;
    fund_category: string | null;
    expiration_date: string | null;
  }[];
  const symbolBySecurityId = new Map(secRows.map((s) => [s.id, s.symbol]));
  // Options past their expiration (Eastern day, the one expiry reader): their
  // lots are "expired, awaiting the closing entry" on Tax Lots, never
  // "awaiting statement", so the step-4 wording below says the same.
  const expiredOptionIds = new Set(
    secRows
      .filter((s) => (s.security_type ?? "").toLowerCase() === "option" && !isOptionLive(s.expiration_date, today))
      .map((s) => s.id)
  );
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
  // Ledger rows that move shares for the pair, dated after its statement.
  // Every quantity-bearing transaction counts (fills, reinvestments, in-kind
  // transfers, redemptions, expiries); income rows carry no quantity.
  // Deliberately wider than the synthetic-close later-fill list: these are
  // the rows the roll-back to the statement date has to undo.
  const ledgerAfterStmt = db.prepare(
    `SELECT id, trade_date AS date, UPPER(TRIM(type)) AS type, quantity
       FROM transactions
      WHERE account_id = ? AND security_id = ?
        AND quantity IS NOT NULL AND quantity <> 0
        AND trade_date > ?`
  );
  // Corporate actions on the security after the statement. A split is
  // market-wide (the engine applies it to every account holding the
  // security), so there is no account filter.
  const corporateActionsAfterStmt = db.prepare(
    `SELECT effective_date AS date, UPPER(TRIM(action_type)) AS actionType, source,
            CASE WHEN ratio_denominator <> 0
                 THEN CAST(ratio_numerator AS REAL) / ratio_denominator END AS ratio
       FROM corporate_actions
      WHERE security_id = ? AND effective_date > ?`
  );
  // What a close-toward-zero row (expiry, exercise, assignment, synthetic
  // close) did to the signed position: closing a long lot lowers it, closing
  // a short lot raises it. NULL when the engine closed nothing for the row.
  const closedByTxnStmt = db.prepare(
    `SELECT SUM(CASE WHEN l.is_short = 1 THEN s.quantity_sold ELSE -s.quantity_sold END) AS q
       FROM tax_lot_sales s JOIN tax_lots l ON l.id = s.tax_lot_id
      WHERE s.sale_transaction_id = ?`
  );
  const closedSignedQty = (transactionId: number): number | null =>
    (closedByTxnStmt.get(transactionId) as { q: number | null }).q;
  const fillsAsOfStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM transactions
      WHERE account_id = ? AND security_id = ?
        AND UPPER(type) IN (${EQUITY_FILL_TYPES.map(() => "?").join(",")})
        AND quantity IS NOT NULL AND quantity <> 0
        AND trade_date <= ?`
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

    // R12: a pending pair gets its one pending warning first; the
    // assessment below then reports only its INDEPENDENT findings, under
    // `:drift`, and its fallback pending disclosures are dropped.
    const pendingReasons = pendingIndex.pairReasons(accountId, securityId);
    const pending = pendingReasons.length > 0;
    if (pending) {
      hits.push({
        magnitude: 0,
        hit: pendingLotDriftHit(hitKey, label, pendingIndex.sidesFor(accountId, securityId), pendingReasons),
      });
    }
    const emit = (hit: IntegrityHit, magnitude: number, role: "independent" | "fallback"): void => {
      if (!pending) {
        hits.push({ magnitude, hit });
      } else if (role === "independent") {
        hits.push({ magnitude, hit: { ...hit, key: `${hitKey}:drift` } });
      }
    };

    let fillsMemo: number | undefined;
    const fillCount = (): number => {
      if (fillsMemo === undefined) {
        fillsMemo = (fillsStmt.get(accountId, securityId, ...EQUITY_FILL_TYPES) as { n: number }).n;
      }
      return fillsMemo;
    };

    const pushReal = (drift: LotDriftShape, fills: () => number = fillCount): void => {
      if (drift.shape === "fills-zero-lots") {
        const n = fills();
        emit(
          {
            key: hitKey,
            severity: "critical",
            reason: `${label}: position has ${n} fill${n === 1 ? "" : "s"} but zero tax lots`,
          },
          drift.magnitude,
          "independent"
        );
      } else if (drift.shape === "no-lots-no-fills") {
        emit(
          {
            key: hitKey,
            severity: "warning",
            // On the rolled-back path later transactions exist, so the plain
            // wording would be untrue: say what the statement date showed.
            reason:
              fills === fillCount
                ? `${label}: position has zero lots and zero transactions`
                : `${label}: statement position has no tax lots and no transactions up to the statement date`,
          },
          0,
          "independent"
        );
      } else if (drift.shape === "lots-no-position") {
        // A fallback disclosure: for a pending pair the index explains it.
        emit(
          { key: hitKey, severity: "warning", reason: `${label}: open tax lots with no matching position` },
          0,
          "fallback"
        );
      } else {
        emit(
          {
            key: hitKey,
            severity: "critical",
            reason: `${label}: position/lot drift ${(drift.magnitude * 100).toFixed(1)}%`,
          },
          drift.magnitude,
          "independent"
        );
      }
    };

    const latestDrift = classifyLotDrift(latestQty, signedLotQty, hasLot, fillCount);

    // (1) No statement book for this account: nothing to wait for.
    const accountStatementDate = statementDateByAccount.get(accountId);
    if (!accountStatementDate) {
      if (!pending) {
        if (latestDrift) pushReal(latestDrift);
        continue;
      }
      // A pending pair: the pending sides are explained by the pending hit,
      // so the latest position is compared with the OTHER lots only (signed
      // lots with the pending sides' open quantity taken out). A held side
      // that matches the position leaves nothing to report; a held side that
      // does not is a genuine gap (`:drift`). `hasLot` keeps counting the
      // pending lots, so a gap reads as a ratio drift, never as "fills but
      // zero tax lots" (those fills opened the pending side).
      const pendingSigned = pendingIndex
        .sidesFor(accountId, securityId)
        .reduce((sum, p) => sum + (p.side === "short" ? -p.open_quantity : p.open_quantity), 0);
      const heldDrift = classifyLotDrift(latestQty, signedLotQty - pendingSigned, hasLot, fillCount);
      if (heldDrift) pushReal(heldDrift);
      continue;
    }

    // (2)/(3) Statement position vs lots: as they stand, or rolled back to
    // the statement date when the ledger has moved past it.
    const statementRow = statementByKey.get(key);
    const statementDate = statementRow?.asOfDate ?? accountStatementDate;
    const statementQty = statementRow?.quantity ?? 0;
    const ledgerRows = ledgerAfterStmt.all(accountId, securityId, statementDate) as LedgerRowAfter[];
    const corporateActions = corporateActionsAfterStmt.all(securityId, statementDate) as CorporateActionAfter[];
    const ledgerNewerThanStatement = ledgerRows.length > 0 || corporateActions.length > 0;
    // Newest ledger event after the statement (ISO dates sort as strings).
    const lastLedgerMove = [...ledgerRows, ...corporateActions].reduce<string | null>(
      (max, r) => (max === null || r.date > max ? r.date : max),
      null
    );
    const newestDate = newestDateByKey.get(key);
    const snapshotOlderThanLedger =
      lastLedgerMove !== null && (newestDate === undefined || newestDate < lastLedgerMove);

    if (!ledgerNewerThanStatement) {
      const statementDrift = classifyLotDrift(statementQty, signedLotQty, hasLot, fillCount);
      if (statementDrift) {
        pushReal(statementDrift);
        continue;
      }
    } else {
      const rolled = rollLotsBackToStatement(signedLotQty, ledgerRows, corporateActions, closedSignedQty);
      if (!rolled.ok) {
        // The statement cannot judge these lots. A snapshot at least as new
        // as the ledger that agrees with them is the only clean bill left;
        // anything else is said out loud, never skipped.
        if (!latestDrift && !snapshotOlderThanLedger) continue;
        // Independent of the pending reason: the statement cannot judge the lots.
        emit(
          {
            key: hitKey,
            severity: "warning",
            kind: "statement-lag",
            reason: `${label}: tax lots cannot be checked against the statement (${rolled.why}) — pending statement`,
          },
          0,
          "independent"
        );
        continue;
      }
      let fillsAsOfMemo: number | undefined;
      const fillCountAsOfStatement = (): number => {
        if (fillsAsOfMemo === undefined) {
          fillsAsOfMemo = (
            fillsAsOfStmt.get(accountId, securityId, ...EQUITY_FILL_TYPES, statementDate) as { n: number }
          ).n;
        }
        return fillsAsOfMemo;
      };
      const rolledDrift = classifyLotDrift(
        statementQty,
        rolled.quantity,
        Math.abs(rolled.quantity) > LOT_DRIFT_EPSILON,
        fillCountAsOfStatement
      );
      if (rolledDrift) {
        pushReal(rolledDrift, fillCountAsOfStatement);
        continue;
      }
    }

    // (4) The statement agrees with the lots, as they stand or rolled back.
    if (!latestDrift) continue; // no difference anywhere
    // The newest snapshot predates the newest ledger row, so it cannot judge
    // today's lots; the roll-back above already reconciled every row after
    // the statement. No difference left.
    if (ledgerNewerThanStatement && snapshotOlderThanLedger) continue;
    // The statement agrees with the lots and the newest live row is a
    // quantity-0 tombstone: the position is closed per live data, whatever
    // the security type. A pair the pending index lists never reaches the
    // owner through here (a fallback disclosure, suppressed for it, R12);
    // this branch words the pairs the index does not list (2026-10-19).
    const closedPerLive = latestDrift.shape === "lots-no-position";
    emit(
      {
        key: hitKey,
        severity: "warning",
        kind: "statement-lag",
        reason: expiredOptionIds.has(securityId)
          ? `${label}: expired — awaiting its closing entry`
          : closedPerLive
            ? `${label}: closed per live data — awaiting statement`
            : `${label}: live position differs from tax lots — pending statement`,
      },
      0,
      "fallback"
    );
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

// ── Check 5: possible duplicate ledger rows ────────────────────────────
//
// The lot roll-back above has one known limit: a duplicated import dated
// AFTER the newest statement looks exactly like a real purchase whose sale is
// not imported yet, so it is silent there. This check asks the question for
// that window only.
//
// A hit is two or more transactions that agree on account, security, trade
// date, UPPER(type), quantity and amount in whole cents, AND show one of the
// two fingerprints a duplicated import leaves:
//
//   * one of them carries the importer's ordinal suffix (`:#2` or higher on
//     `source_key`): the parsers (canonical-csv, ibkr-activity) append it to
//     the second identical row of ONE file, so the second copy lands as a new
//     row instead of deduping; or
//   * they came from different import batches (`import_batch_id`; a row with
//     no batch counts as its own origin): the same trade arrived twice under
//     two different keys, which the source-key dedupe cannot see.
//
// Identical rows in one batch with no suffix are left alone: no importer
// writes that shape, so it is not import evidence.
//
// Two identical fills on one day are real at a broker, so the wording is a
// question and the severity is always "warning": it never caps the score.
// There is no dismiss switch; the note goes away when the data is fixed, or
// when the next statement moves the window past the rows (from then on the
// lot comparison against the statement judges them).
//
// Not hits: rows with no security or no quantity (dividends, interest, fees
// and cash movements carry none, so equal same-day income rows never reach
// the comparison) and engine-owned closes, which are never user activity.
//
// Window: rows dated after the account's newest statement-grade holdings
// row; an account with no statement book gets the last 45 days.

const DUPLICATE_LEDGER_NO_STATEMENT_DAYS = 45;
const ENGINE_OWNED_LEDGER_TYPES = new Set(["RECONCILE_CLOSE"]);
const ORDINAL_SUFFIX_RE = /:#(\d+)$/;

/** True for a source key the importer suffixed as the 2nd+ identical row of a file. */
function hasOrdinalSuffix(sourceKey: string | null): boolean {
  if (!sourceKey) return false;
  const m = ORDINAL_SUFFIX_RE.exec(sourceKey);
  return m !== null && Number(m[1]) >= 2;
}

export function scanPossibleDuplicateLedgerHits(
  db: Database.Database,
  today: string = todayET()
): IntegrityHit[] {
  // Each account's newest statement-grade date, reduced in JS.
  const statementDates = db
    .prepare(
      `SELECT DISTINCT h.account_id AS accountId, h.as_of_date AS asOfDate
         FROM holdings h
        WHERE ${statementGradeHoldingSql("h")}`
    )
    .all() as { accountId: number; asOfDate: string }[];
  const statementDateByAccount = new Map<number, string>();
  for (const r of statementDates) {
    const prev = statementDateByAccount.get(r.accountId);
    if (!prev || r.asOfDate > prev) statementDateByAccount.set(r.accountId, r.asOfDate);
  }
  const noStatementFloor = addDays(today, -DUPLICATE_LEDGER_NO_STATEMENT_DAYS);

  const accounts = db.prepare(`SELECT id, name FROM accounts ORDER BY id`).all() as {
    id: number;
    name: string;
  }[];
  const rowsStmt = db.prepare(
    `SELECT t.id AS id, t.security_id AS securityId, t.trade_date AS date,
            UPPER(TRIM(t.type)) AS type, t.quantity AS quantity, t.amount AS amount,
            t.source_key AS sourceKey, t.import_batch_id AS batchId, s.symbol AS symbol
       FROM transactions t
       JOIN securities s ON s.id = t.security_id
      WHERE t.account_id = ?
        AND t.quantity IS NOT NULL AND t.quantity <> 0
        AND t.trade_date > ?
      ORDER BY t.id`
  );

  interface Row {
    id: number;
    securityId: number;
    date: string;
    type: string;
    quantity: number;
    amount: number | null;
    sourceKey: string | null;
    batchId: number | null;
    symbol: string;
  }

  const hits: IntegrityHit[] = [];
  for (const account of accounts) {
    const after = statementDateByAccount.get(account.id) ?? noStatementFloor;
    const groups = new Map<string, Row[]>();
    for (const row of rowsStmt.all(account.id, after) as Row[]) {
      if (ENGINE_OWNED_LEDGER_TYPES.has(row.type)) continue;
      const cents = Math.round((row.amount ?? 0) * 100);
      const key = `${row.securityId}|${row.date}|${row.type}|${row.quantity}|${cents}`;
      const list = groups.get(key);
      if (list) list.push(row);
      else groups.set(key, [row]);
    }
    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      const suffixed = rows.some((r) => hasOrdinalSuffix(r.sourceKey));
      // A row with no import batch is its own origin (keyed by its row id),
      // so two identical batch-less rows count as two origins.
      const origins = new Set(
        rows.map((r) => (r.batchId === null ? `row:${r.id}` : `batch:${r.batchId}`))
      );
      if (!suffixed && origins.size < 2) continue;
      const first = rows[0]; // lowest id: rows are read in id order
      hits.push({
        key: `duplicate-ledger:${first.id}`,
        severity: "warning",
        reason: `${first.symbol} (${account.name}): ${rows.length} identical ${first.type} rows on ${first.date}: check for a duplicate import`,
      });
    }
  }
  return hits;
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
  | "closing-entry-account"
  | "duplicate-ledger"
  | "exercise-price"
  | "exercise-leg"
  | "reconcile-delta"
  | "other";

/** Display order = the order runIntegrityChecks runs the scans. */
export const INTEGRITY_CHECK_ORDER: readonly IntegrityCheckId[] = [
  "type-contradiction",
  "cash-residual",
  "lot-drift",
  "closing-entry-account",
  "duplicate-ledger",
  "exercise-price",
  "exercise-leg",
  "reconcile-delta",
  "other",
];

export const INTEGRITY_CHECK_LABELS: Record<IntegrityCheckId, string> = {
  "type-contradiction": "Security type contradicts its trades",
  "cash-residual": "Cash movement no transaction explains",
  "lot-drift": "Position does not match its tax lots",
  "closing-entry-account": "Closing entry booked in another account",
  "duplicate-ledger": "Identical ledger rows on one day, possibly a duplicate import",
  "exercise-price": "Option exercise or assignment with no price",
  "exercise-leg": "Option exercise or assignment with no stock trade linked",
  "reconcile-delta": "Corporate action share count does not reconcile",
  other: "Other",
};

/** Key prefixes that are not themselves a check id. */
const KEY_PREFIX_CHECK: Record<string, IntegrityCheckId> = {
  "closing-entry-account-undecidable": "closing-entry-account",
  "exercise-price-missing": "exercise-price",
  "exercise-leg-missing": "exercise-leg",
};

export function integrityCheckIdOf(key: string): IntegrityCheckId {
  const prefix = key.split(":")[0];
  const mapped = KEY_PREFIX_CHECK[prefix];
  if (mapped) return mapped;
  return prefix === "type-contradiction" ||
    prefix === "closing-entry-account" ||
    prefix === "cash-residual" ||
    prefix === "lot-drift" ||
    prefix === "duplicate-ledger" ||
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

export function runIntegrityChecks(
  db: Database.Database,
  /** `today` reaches the pending read model's option-expiry precedence (default todayET()). */
  opts: PendingStatementReadOptions = {}
): {
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
    const pendingIndex = getPendingStatementIndex(db, undefined, opts);
    for (const hit of scanLotDriftHits(db, pendingIndex, opts.today)) {
      (hit.severity === "critical" ? critical : warnings).push(hit);
    }
    // Reads tax_lot_sales, so it shares the lot-drift gate (R4). Critical
    // only for a decidable unmatched pure close; never for a pending reason.
    for (const hit of scanClosingEntryAccountHits(db, pendingIndex.pairs)) {
      (hit.severity === "critical" ? critical : warnings).push(hit);
    }
  }

  // Independent of the tax-lot convention marker: it reads the ledger only.
  // Always a warning, so it can never cap the score.
  for (const hit of scanPossibleDuplicateLedgerHits(db, opts.today)) {
    warnings.push(hit);
  }

  // Ledger only, outside the convention gate, always warnings (R5, R15).
  for (const hit of scanExercisePriceMissingHits(db)) {
    warnings.push(hit);
  }
  for (const hit of scanExerciseLegMissingHits(db)) {
    warnings.push(hit);
  }

  for (const hit of scanReconcileDeltaHits(db)) {
    warnings.push(hit);
  }

  return { critical, warnings, lotDriftChecked };
}
