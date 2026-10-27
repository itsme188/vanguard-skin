import type Database from "better-sqlite3";
import { liveOriginHoldingSql, statementGradeHoldingSql } from "@/lib/db/holding-sources";
import {
  findLaterImportSplit,
  IMPORT_SPLIT_ACTION_TYPES_SQL,
  positionChangingTxnTypesSql,
  type ImportSplitDate,
} from "@/lib/compute/synthetic-close-guards";
import { liveOptionExpirationSql } from "@/lib/compute/option-expiry";
import { getTaxConventionState } from "@/lib/compute/tax-convention";
import { resymbolTargetsFrom } from "@/lib/securities/option-resymbol-targets";
import { isCertainOpeningOn, sideOpeningSql, type LedgerRowInput } from "@/lib/queries/ledger-side-routing";
import {
  figureKindForSide,
  PENDING_REASON_ORDER,
  sideOf,
  type PendingFigureKind,
  type PendingReason,
  type PendingSide,
} from "@/lib/queries/pending-statement-types";

/**
 * PENDING STATEMENT — the read model for open lots whose position the
 * holdings evidence shows flat while the ledger still carries the lots.
 * Nothing is persisted: this is derived on every read. One row per
 * (account, security, SIDE) that is pending, with ONE reason.
 *
 * Specs: docs/superpowers/specs/2026-10-02-statement-only-synthetic-closes-design.md
 * §2.2 (long stock, unchanged) and
 * docs/superpowers/specs/2026-10-08-live-closed-options-shorts-pending-design.md
 * §5, as corrected by the plan's rulings
 * (docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * §1A, R1-R17). Every surface reads pending state through this module
 * (`getPendingStatementIndex`, `pendingStatementKey`): never a local
 * re-derivation, never a hand-built key.
 *
 * Classes, per (account, security, side σ) with open lots
 * (`quantity_remaining > 0`):
 *  - long_equity: long stock/ETF lots. Today's rule, unchanged: the pair's
 *    newest holdings row of any source is LIVE-origin with quantity <= 0
 *    (flat, or flipped short: PR #123), no statement-grade zero is the
 *    pair's newest statement-grade row (that pair is the engine's synthetic
 *    close), and neither shared engine guard (a later imported position-
 *    changing fill, a later import split, both after the live row's date)
 *    skips it → `awaiting_statement`.
 *  - new: any option lot (long or short) and short stock/ETF lots. The
 *    engine never mints a synthetic close for these, so a statement zero
 *    alone never returns them to "open and valued" (Option A). An option
 *    past its expiration (Eastern day, `liveOptionExpirationSql`) is never
 *    pending: expired beats pending.
 *  - everything else (bonds, funds, cash equivalents, currency conversions):
 *    never pending.
 *
 * The rule for the new classes (ruling R2: only SIDE-MATCHING evidence ends
 * pending; splits never do; TRANSFER_OUT never does):
 *  - flat evidence: a live-origin row flat on σ's side (long: qty <= 0;
 *    short: qty >= 0) or a statement-grade row at exactly zero. When the
 *    pair's newest row is not flat evidence, the side is not pending (E3).
 *  - `resymbol_repair_pending` when the option's symbol has a known
 *    replacement contract (lib/securities/option-resymbol-targets.ts) held
 *    non-zero in the SAME account. "Known replacement held" only; whether a
 *    script can move the rows is the repair planner's answer (R7).
 *  - `closing_entry_missing` when the newest statement-grade row is a zero
 *    and no same-side reopening is dated after it; flat date = that
 *    statement date (even under a newer live zero).
 *  - `awaiting_statement` when the newest row is live-origin flat evidence
 *    and no same-side reopening is dated after it; flat date = its date.
 *  - A REOPENING (E4, R11, R17: strictly after the flat date). When the
 *    tax-lot results are CURRENT (`getTaxConventionState().recomputeCurrent`)
 *    it is the engine's own outcome: a lot of the pair on σ (open or since
 *    closed) whose acquisition transaction is dated after the flat date,
 *    a mixed trade's residual opening included. When results are STALE it
 *    is a certain, engine-loadable PURE opening on σ per the routing
 *    catalogue (lib/queries/ledger-side-routing.ts); a mixed row never
 *    counts, so the side stays pending.
 *  Closing entries need no rule: they shrink or close the lots (E1); a
 *  remainder stays pending.
 */
export interface PendingStatementPair {
  account_id: number;
  security_id: number;
  symbol: string;
  side: PendingSide;
  reason: PendingReason;
  /** The evidence date the reason rests on (the statement date for closing_entry_missing). */
  flat_date: string;
  /** Σ quantity_remaining over the side's open lots (always positive). */
  open_quantity: number;
  /** Still-open share of the side's stored lot dollars, USD (FX at read time): cost for long, short-sale proceeds for short. Never signed. */
  open_figure: number;
  figure_kind: PendingFigureKind;
  lot_count: number;
}

export interface PendingStatementReadOptions {
  /** Eastern day for the option-expiry precedence (defaults to todayET() inside liveOptionExpirationSql). */
  today?: string;
}

export type PendingClass = "long_equity" | "new";
export type HoldingEvidence = "statement" | "live" | "other";

/** Inputs of the pure per-side decision (each loaded by SQL in `getPendingStatementPairs`). */
export interface PendingDecisionInput {
  cls: PendingClass | null;
  side: PendingSide;
  isOption: boolean;
  /** The pair's newest holdings row of any source. */
  newest: { date: string; quantity: number; evidence: HoldingEvidence } | null;
  /** The pair's newest statement-grade holdings row. */
  statement: { date: string; quantity: number } | null;
  /** A known replacement contract is held non-zero in the same account (options only). */
  resymbolReplacementHeld: boolean;
  /** long_equity only: the engine's shared guards, measured from the newest row's date. */
  longEquityGuards: { laterFill: boolean; laterSplit: boolean };
  /** new class only: does a same-side reopening exist strictly after `date`? */
  reopenedAfter: (date: string) => boolean;
}

export interface PendingDecision {
  reason: PendingReason;
  flatDate: string;
}

function isFlatFor(side: PendingSide, row: { quantity: number; evidence: HoldingEvidence }): boolean {
  if (row.evidence === "live") return side === "long" ? row.quantity <= 0 : row.quantity >= 0;
  if (row.evidence === "statement") return row.quantity === 0;
  return false;
}

/** The pending rule for one (account, security, side). Pure; exported for tests. */
export function decidePendingReason(input: PendingDecisionInput): PendingDecision | null {
  const { cls, side, newest, statement } = input;
  if (cls == null || newest == null) return null;

  if (cls === "long_equity") {
    if (side !== "long") return null;
    if (newest.evidence !== "live" || newest.quantity > 0) return null;
    if (statement && statement.quantity === 0) return null;
    if (input.longEquityGuards.laterFill || input.longEquityGuards.laterSplit) return null;
    return { reason: "awaiting_statement", flatDate: newest.date };
  }

  if (!isFlatFor(side, newest)) return null;
  if (input.isOption && input.resymbolReplacementHeld) {
    return { reason: "resymbol_repair_pending", flatDate: newest.date };
  }
  if (statement && statement.quantity === 0 && !input.reopenedAfter(statement.date)) {
    return { reason: "closing_entry_missing", flatDate: statement.date };
  }
  if (newest.evidence === "live" && !input.reopenedAfter(newest.date)) {
    return { reason: "awaiting_statement", flatDate: newest.date };
  }
  return null;
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  );
}

interface SideRow {
  account_id: number;
  security_id: number;
  symbol: string;
  security_type: string;
  short_flag: number;
  open_quantity: number;
  open_figure: number;
  lot_count: number;
  n_date: string | null;
  n_qty: number | null;
  n_evidence: HoldingEvidence | null;
  s_date: string | null;
  s_qty: number | null;
  later_fill: number;
}

const sideSortRank = (side: PendingSide): number => (side === "long" ? 0 : 1);

/**
 * Pending sides, optionally scoped to `accountIds` (undefined = every
 * account; a multi-account scope keeps every listed account; an empty list
 * selects nothing). Sorted by symbol, account, then long before short.
 */
export function getPendingStatementPairs(
  db: Database.Database,
  accountIds?: readonly number[],
  opts: PendingStatementReadOptions = {}
): PendingStatementPair[] {
  if (accountIds && accountIds.length === 0) return [];
  if (!tableExists(db, "holdings") || !tableExists(db, "tax_lots")) return [];

  const scopeSql = accountIds ? `AND tl.account_id IN (${accountIds.map(() => "?").join(", ")})` : "";

  // One row per open side, with the pair's newest holdings row (h) and its
  // newest statement-grade row. `open_figure` is the remainingLotBasisSql()
  // form (lib/queries/tax-lots.ts), written out here because importing that
  // module would make an import cycle (it imports this one).
  const rows = db
    .prepare(
      `SELECT tl.account_id, tl.security_id, s.symbol,
              LOWER(COALESCE(s.security_type, '')) AS security_type,
              CASE WHEN COALESCE(tl.is_short, 0) != 0 THEN 1 ELSE 0 END AS short_flag,
              SUM(tl.quantity_remaining) AS open_quantity,
              SUM(CASE WHEN tl.quantity_acquired != 0
                       THEN tl.cost_basis * tl.quantity_remaining / tl.quantity_acquired
                       ELSE 0 END * COALESCE(fx.usd_per_unit, 1)) AS open_figure,
              COUNT(*) AS lot_count,
              h.as_of_date AS n_date,
              h.quantity AS n_qty,
              CASE WHEN ${statementGradeHoldingSql("h")} THEN 'statement'
                   WHEN ${liveOriginHoldingSql("h")} THEN 'live'
                   ELSE 'other' END AS n_evidence,
              (SELECT z.as_of_date FROM holdings z
                WHERE z.account_id = h.account_id AND z.security_id = h.security_id
                  AND ${statementGradeHoldingSql("z")}
                ORDER BY z.as_of_date DESC LIMIT 1) AS s_date,
              (SELECT z.quantity FROM holdings z
                WHERE z.account_id = h.account_id AND z.security_id = h.security_id
                  AND ${statementGradeHoldingSql("z")}
                ORDER BY z.as_of_date DESC LIMIT 1) AS s_qty,
              EXISTS (
                SELECT 1 FROM transactions t2
                 WHERE t2.account_id = tl.account_id AND t2.security_id = tl.security_id
                   AND t2.trade_date > h.as_of_date
                   AND LOWER(t2.type) IN (${positionChangingTxnTypesSql()})
              ) AS later_fill
         FROM tax_lots tl
         JOIN securities s ON s.id = tl.security_id
         LEFT JOIN fx_rates fx ON fx.currency = s.currency
         JOIN holdings h
           ON h.account_id = tl.account_id AND h.security_id = tl.security_id
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id
          )
        WHERE tl.quantity_remaining > 0
          AND (LOWER(COALESCE(s.security_type, '')) IN ('stock', 'etf')
               OR (LOWER(COALESCE(s.security_type, '')) = 'option'
                   AND ${liveOptionExpirationSql("s", opts.today)}))
          ${scopeSql}
        GROUP BY tl.account_id, tl.security_id, short_flag`
    )
    .all(...(accountIds ?? [])) as SideRow[];

  if (rows.length === 0) return [];

  // Split guard rows (long_equity only): the same predicate and row set the
  // engine applies to its orphans (import-sourced corporate actions).
  const splits: ImportSplitDate[] = tableExists(db, "corporate_actions")
    ? (db
        .prepare(
          `SELECT security_id, effective_date FROM corporate_actions
            WHERE source = 'import'
              AND UPPER(action_type) IN (${IMPORT_SPLIT_ACTION_TYPES_SQL})`
        )
        .all() as ImportSplitDate[])
    : [];

  const resultsCurrent = tableExists(db, "settings") && getTaxConventionState(db).recomputeCurrent;
  const engineReopen = db.prepare(
    `SELECT 1 FROM tax_lots tl
       JOIN transactions t ON t.id = tl.acquisition_transaction_id
      WHERE tl.account_id = ? AND tl.security_id = ?
        AND (CASE WHEN COALESCE(tl.is_short, 0) != 0 THEN 1 ELSE 0 END) = ?
        AND t.trade_date > ?
      LIMIT 1`
  );
  const candidateSql = (side: PendingSide) =>
    `SELECT t.type, t.quantity, t.price_per_share, t.amount, t.notes,
            LOWER(COALESCE(s.security_type, '')) AS security_type
       FROM transactions t JOIN securities s ON s.id = t.security_id
      WHERE t.account_id = ? AND t.security_id = ? AND t.trade_date > ?
        AND ${sideOpeningSql(side)}`;
  const catalogueCandidates = {
    long: db.prepare(candidateSql("long")),
    short: db.prepare(candidateSql("short")),
  };
  // "Known replacement contract held": the replacement's newest holdings row
  // in the SAME account is non-zero (any source).
  const replacementHeld = db.prepare(
    `SELECT 1 FROM holdings h
       JOIN securities s ON s.id = h.security_id
      WHERE h.account_id = ? AND s.symbol = ? AND h.quantity != 0
        AND h.as_of_date = (
          SELECT MAX(h2.as_of_date) FROM holdings h2
           WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id
        )
      LIMIT 1`
  );

  const out: PendingStatementPair[] = [];
  for (const r of rows) {
    const side = sideOf(r.short_flag);
    const isOption = r.security_type === "option";
    const cls: PendingClass = !isOption && side === "long" ? "long_equity" : "new";

    const reopenedAfter = (date: string): boolean => {
      if (resultsCurrent) {
        return engineReopen.get(r.account_id, r.security_id, r.short_flag, date) != null;
      }
      const candidates = catalogueCandidates[side].all(r.account_id, r.security_id, date) as LedgerRowInput[];
      return candidates.some((c) => isCertainOpeningOn(c, side));
    };

    const decision = decidePendingReason({
      cls,
      side,
      isOption,
      newest:
        r.n_date == null || r.n_qty == null || r.n_evidence == null
          ? null
          : { date: r.n_date, quantity: r.n_qty, evidence: r.n_evidence },
      statement: r.s_date == null || r.s_qty == null ? null : { date: r.s_date, quantity: r.s_qty },
      resymbolReplacementHeld:
        isOption &&
        resymbolTargetsFrom(r.symbol).some((t) => replacementHeld.get(r.account_id, t.toSymbol) != null),
      longEquityGuards: {
        laterFill: r.later_fill === 1,
        laterSplit:
          cls === "long_equity" && r.n_date != null
            ? findLaterImportSplit(splits, r.security_id, r.n_date) != null
            : false,
      },
      reopenedAfter,
    });
    if (!decision) continue;

    out.push({
      account_id: r.account_id,
      security_id: r.security_id,
      symbol: r.symbol,
      side,
      reason: decision.reason,
      flat_date: decision.flatDate,
      open_quantity: r.open_quantity,
      open_figure: r.open_figure,
      figure_kind: figureKindForSide(side),
      lot_count: r.lot_count,
    });
  }

  out.sort(
    (a, b) =>
      (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0) ||
      a.account_id - b.account_id ||
      sideSortRank(a.side) - sideSortRank(b.side)
  );
  return out;
}

/**
 * The (account, security, side) key every surface joins pending sides on:
 * `${account}:${security}:${side}`. The ONLY key builder; no other file
 * writes this string.
 */
export function pendingStatementKey(row: {
  account_id: number;
  security_id: number;
  is_short: number | boolean | null | undefined;
}): string {
  return `${row.account_id}:${row.security_id}:${sideOf(row.is_short)}`;
}

export interface PendingStatementIndex {
  pairs: readonly PendingStatementPair[];
  /** The lot's pending reason, or null when its side is not pending. */
  reasonFor(lot: { account_id: number; security_id: number; is_short: number | boolean | null | undefined }): PendingReason | null;
  /** Every reason on any side of the pair, in PENDING_REASON_ORDER, no repeats. */
  pairReasons(accountId: number, securityId: number): PendingReason[];
  /** The pending sides of one (account, security), long before short. */
  sidesFor(accountId: number, securityId: number): readonly PendingStatementPair[];
}

/** The lookup index over `getPendingStatementPairs` (same scope and options). */
export function getPendingStatementIndex(
  db: Database.Database,
  accountIds?: readonly number[],
  opts: PendingStatementReadOptions = {}
): PendingStatementIndex {
  const pairs = getPendingStatementPairs(db, accountIds, opts);
  const bySide = new Map<string, PendingStatementPair>();
  const byPair = new Map<string, PendingStatementPair[]>();
  for (const p of pairs) {
    bySide.set(pendingStatementKey({ ...p, is_short: p.side === "short" ? 1 : 0 }), p);
    // Pair-level grouping is internal to this index (never a pending key).
    const pairId = `${p.account_id}|${p.security_id}`;
    const list = byPair.get(pairId) ?? [];
    list.push(p);
    byPair.set(pairId, list);
  }
  for (const list of byPair.values()) list.sort((a, b) => sideSortRank(a.side) - sideSortRank(b.side));
  const sidesFor = (accountId: number, securityId: number): readonly PendingStatementPair[] =>
    byPair.get(`${accountId}|${securityId}`) ?? [];
  return {
    pairs,
    reasonFor: (lot) => bySide.get(pendingStatementKey(lot))?.reason ?? null,
    pairReasons: (accountId, securityId) => {
      const present = new Set(sidesFor(accountId, securityId).map((p) => p.reason));
      return PENDING_REASON_ORDER.filter((r) => present.has(r));
    },
    sidesFor,
  };
}

/** True when the lot's (account, security, side) is pending for any reason. */
export function isPendingStatementLot(
  index: PendingStatementIndex,
  lot: { account_id: number; security_id: number; is_short: number | boolean | null | undefined }
): boolean {
  return index.reasonFor(lot) != null;
}
