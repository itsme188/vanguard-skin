/**
 * One position's move for one trading session (owner ruling, 2026-10-08).
 *
 * The old rule was CURRENT quantity x (latest close - prior close). That
 * credits a position bought today with the whole move since yesterday's
 * close, which it never earned. The rule here splits the quantity by when it
 * was held:
 *
 *   - Quantity held at the prior close and still held: close-to-close.
 *   - Quantity opened or added since the prior close: latest close minus what
 *     those shares cost. With no usable cost it is LEFT OUT, never guessed.
 *   - Quantity sold since the prior close: nothing. Only what is still held is
 *     measured; no realised figure is invented.
 *
 * Pure: no database, no dates, no currency. Every money input is in the
 * security's NATIVE currency; the caller converts the result.
 *
 * Inputs
 *   priorQty         quantity in the book as of the prior session's date.
 *                    null or 0 = the position was not held then.
 *   currentQty       quantity now. Negative = short.
 *   priorClose       prior session's close, per share / per 100 face.
 *   latestClose      this session's close, same units.
 *   priorCostBasis   TOTAL cost of the prior-date row. null or 0 = unknown.
 *   currentCostBasis TOTAL cost of the current row. null or 0 = unknown.
 *   multiplier       value of one price point for one unit of quantity: 1 for
 *                    a stock, the contract multiplier for an option, 0.01 for
 *                    a bond (priced per 100 face).
 *
 * Cost is a TOTAL in currency, not per share, so an option's cost already
 * carries its multiplier (the live writer stores quantity x average cost, and
 * the broker's average cost for an option is per contract). A short's cost is
 * its sale proceeds; its sign is ignored for a position opened today because
 * stored short bases use more than one sign convention.
 */

export type DayMoveBasis =
  /** Measured close-to-close on the quantity held through the session. */
  | "prior_close"
  /** Opened today: measured from cost. */
  | "cost"
  /** Added to today: held part close-to-close, added part from its cost. */
  | "mixed"
  /** Opened today with no usable cost: left out of the move. */
  | "excluded"
  /** A close needed for the measurement is missing: the move is unknown. */
  | "unpriced";

export interface PositionDayMoveInput {
  priorQty: number | null;
  currentQty: number;
  priorClose: number | null;
  latestClose: number | null;
  priorCostBasis: number | null;
  currentCostBasis: number | null;
  multiplier: number;
}

export interface PositionDayMove {
  /** The session's gain in native currency. null = unknown or left out. */
  gain: number | null;
  /**
   * What the gain is a return ON, never negative: the prior-close value of the
   * held quantity plus the cost of the quantity opened today. null with gain.
   */
  base: number | null;
  basis: DayMoveBasis;
  /** No quantity of this sign was held at the prior date. */
  openedToday: boolean;
  /** Signed quantity opened or added since the prior date (0 if none). */
  addedQty: number;
  /**
   * The position was added to and the added shares' cost could not be
   * derived: they are left out, the held quantity is still measured.
   */
  addedCostUnknown: boolean;
}

/** A per-share cost further than this from the latest close is not believed. */
export const COST_PLAUSIBILITY_FACTOR = 3;

function usableCost(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value === 0) return null;
  return value;
}

function usablePrice(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value;
}

/** A per-share cost is believed only inside a third to three times the close. */
function plausiblePerShareCost(perShare: number, latestClose: number): boolean {
  if (!Number.isFinite(perShare) || perShare <= 0 || latestClose <= 0) return false;
  return (
    perShare <= latestClose * COST_PLAUSIBILITY_FACTOR &&
    perShare >= latestClose / COST_PLAUSIBILITY_FACTOR
  );
}

export function computePositionDayMove(input: PositionDayMoveInput): PositionDayMove {
  const multiplier =
    Number.isFinite(input.multiplier) && input.multiplier > 0 ? input.multiplier : 1;
  const current = Number.isFinite(input.currentQty) ? input.currentQty : 0;
  const prior =
    input.priorQty != null && Number.isFinite(input.priorQty) ? input.priorQty : 0;
  const latestClose = usablePrice(input.latestClose);
  const priorClose = usablePrice(input.priorClose);

  if (current === 0) {
    return {
      gain: null, base: null, basis: "unpriced",
      openedToday: false, addedQty: 0, addedCostUnknown: false,
    };
  }

  // A flip through zero (long yesterday, short today) leaves nothing of the
  // old position: the whole current quantity was opened today.
  const openedToday = prior === 0 || Math.sign(prior) !== Math.sign(current);

  if (openedToday) {
    const opened = { openedToday: true, addedQty: current, addedCostUnknown: false };
    if (latestClose === null) {
      return { gain: null, base: null, basis: "unpriced", ...opened };
    }
    const cost = usableCost(input.currentCostBasis);
    const perShare = cost === null ? null : Math.abs(cost) / (Math.abs(current) * multiplier);
    if (perShare === null || !plausiblePerShareCost(perShare, latestClose)) {
      return { gain: null, base: null, basis: "excluded", ...opened };
    }
    return {
      gain: (latestClose - perShare) * current * multiplier,
      base: perShare * Math.abs(current) * multiplier,
      basis: "cost",
      ...opened,
    };
  }

  // Same direction as the prior date. `held` is what was held then AND now.
  const added = Math.abs(current) > Math.abs(prior) ? current - prior : 0;
  const held = added === 0 ? current : prior;

  if (latestClose === null || priorClose === null) {
    return {
      gain: null, base: null, basis: "unpriced",
      openedToday: false, addedQty: added, addedCostUnknown: false,
    };
  }

  const heldGain = held * (latestClose - priorClose) * multiplier;
  const heldBase = Math.abs(held * priorClose * multiplier);

  if (added === 0) {
    return {
      gain: heldGain, base: heldBase, basis: "prior_close",
      openedToday: false, addedQty: 0, addedCostUnknown: false,
    };
  }

  // The row stores ONE blended cost for the whole position, so the added
  // shares' cost is the change in total cost between the two rows. Both rows
  // are signed alike by one writer, so the signed division is positive for a
  // long and for a short; rows that disagree on convention fall outside the
  // band and are left out.
  const priorCost = usableCost(input.priorCostBasis);
  const currentCost = usableCost(input.currentCostBasis);
  const addedCost = priorCost === null || currentCost === null ? null : currentCost - priorCost;
  const addedPerShare = addedCost === null ? null : addedCost / (added * multiplier);

  if (
    addedCost === null ||
    addedPerShare === null ||
    !plausiblePerShareCost(addedPerShare, latestClose)
  ) {
    return {
      gain: heldGain, base: heldBase, basis: "prior_close",
      openedToday: false, addedQty: added, addedCostUnknown: true,
    };
  }

  return {
    gain: heldGain + (latestClose - addedPerShare) * added * multiplier,
    base: heldBase + Math.abs(addedCost),
    basis: "mixed",
    openedToday: false,
    addedQty: added,
    addedCostUnknown: false,
  };
}
