/**
 * Pending-statement contract types and the one disclosure reducer.
 * Pure module: no db, no app imports. Every surface shapes its pending
 * disclosure through `reducePendingDisclosure`, so a cost basis is never
 * summed with short-sale proceeds.
 */

export type PendingReason = "awaiting_statement" | "closing_entry_missing" | "resymbol_repair_pending";
export type PendingSide = "long" | "short";
export type PendingFigureKind = "cost_basis" | "short_sale_proceeds";

export const PENDING_REASON_ORDER: readonly PendingReason[] = [
  "awaiting_statement",
  "closing_entry_missing",
  "resymbol_repair_pending",
];

/** Per-lot precedence when several could apply: resymbol > closing_entry_missing > awaiting. */
export const PENDING_REASON_PRECEDENCE: readonly PendingReason[] = [
  "resymbol_repair_pending",
  "closing_entry_missing",
  "awaiting_statement",
];

const SIDE_ORDER: readonly PendingSide[] = ["long", "short"];

/** SQLite stores is_short as 0/1; null or undefined means long. */
export function sideOf(isShort: number | boolean | null | undefined): PendingSide {
  return isShort === true || (typeof isShort === "number" && isShort !== 0) ? "short" : "long";
}

export function figureKindForSide(side: PendingSide): PendingFigureKind {
  return side === "short" ? "short_sale_proceeds" : "cost_basis";
}

export interface PendingDisclosureRow {
  reason: PendingReason;
  side: PendingSide;
  positions: number;
  lots: number;
  figure: number;
  figureKind: PendingFigureKind;
}

export interface PendingDisclosureInput {
  account_id: number;
  security_id: number;
  is_short: number | boolean;
  reason: PendingReason;
  lotCount: number;
  figure: number;
}

/** One row per (reason, side) present; ordered by reason, long before short. Never sums across sides. */
export function reducePendingDisclosure(inputs: readonly PendingDisclosureInput[]): PendingDisclosureRow[] {
  const groups = new Map<string, { reason: PendingReason; side: PendingSide; pairs: Set<string>; lots: number; figure: number }>();
  for (const input of inputs) {
    const side = sideOf(input.is_short);
    const key = `${input.reason}|${side}`;
    let g = groups.get(key);
    if (!g) {
      g = { reason: input.reason, side, pairs: new Set(), lots: 0, figure: 0 };
      groups.set(key, g);
    }
    g.pairs.add(`${input.account_id}:${input.security_id}:${side}`);
    g.lots += input.lotCount;
    g.figure += input.figure;
  }
  const rows: PendingDisclosureRow[] = [];
  for (const reason of PENDING_REASON_ORDER) {
    for (const side of SIDE_ORDER) {
      const g = groups.get(`${reason}|${side}`);
      if (!g) continue;
      rows.push({
        reason,
        side,
        positions: g.pairs.size,
        lots: g.lots,
        figure: g.figure,
        figureKind: figureKindForSide(side),
      });
    }
  }
  return rows;
}

/** Distinct (account, security, side) positions; long and short of one symbol count as two. */
export function countPendingPositions(
  inputs: readonly Pick<PendingDisclosureInput, "account_id" | "security_id" | "is_short">[],
): number {
  const seen = new Set<string>();
  for (const i of inputs) seen.add(`${i.account_id}:${i.security_id}:${sideOf(i.is_short)}`);
  return seen.size;
}
