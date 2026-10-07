/**
 * INTENTIONALLY NOT CALLED YET (controller ruling 2026-10-07). No production
 * file imports this module; tests/repo/bond-coupon-unwired.test.ts fails if
 * one starts to.
 *
 * Why: today the only way a bond reaches a contract-details request is by
 * SYMBOL with secType BOND, which can return many issues of one issuer.
 * Taking the first and storing its coupon would attach another bond's coupon
 * to this one, and a stored coupon outranks the bond's name from then on.
 *
 * What must be proven against a real broker session before wiring it:
 *   1. a contract-details request BY CONTRACT ID (`{ conId }`) for a held
 *      bond returns exactly one contract, that bond;
 *   2. the reply fills `coupon` at all (the type below says it may not);
 *   3. its unit (percent, as the column needs, or a fraction);
 *   4. what a bill and a zero-coupon bond return.
 * Then call `assessBrokerCoupon` + `storeBrokerCoupon` from that by-id
 * request only, never from a by-symbol lookup.
 *
 * A bond's coupon from the broker's contract details: the one place that
 * decides whether a broker figure is stored, and the one statement that
 * writes `securities.coupon_rate` (owner ruling 2026-10-07).
 *
 * The contract, as shipped in @stoqey/ib 1.5.3
 * (dist/api/contract/contractDetails.d.ts):
 *
 *     /**
 *      * The interest rate used to calculate the amount you will receive in
 *      * interest payments over the course of the year.
 *      * This field is currently not available from the TWS API.
 *      * For Bonds only.
 *      *\/
 *     coupon?: number;
 *
 * and the decoder fills it for a bond reply (dist/core/io/decoder.js,
 * decodeMsg_BOND_CONTRACT_DATA: `contract.coupon = this.readDouble()`).
 *
 * What that leaves open, and how this module closes it WITHOUT a live
 * session to test against:
 *   - The type states no unit. The column holds an annual PERCENT (4.375
 *     means 4.375%), which is what lib/compute/bond-duration.ts reads. A
 *     broker figure is therefore stored only when it cannot be a fraction:
 *     above 0.25, or confirmed by the coupon the bond's own name states. A
 *     figure of 0.25 or less with no confirming name is refused (it could be
 *     0.25% or a fraction meaning 25%), and a figure that is exactly the
 *     name's coupon divided by 100 is refused as a fraction.
 *   - The type says the field may not be available, and a decoded double
 *     cannot tell "zero coupon" from "not provided". A zero is stored only
 *     when the name says the instrument is a bill or states a zero coupon.
 *     A coupon bond stored as zero-coupon would be given its full time to
 *     maturity as its duration, which overstates its loss under a rate rise.
 *
 *   - A figure that differs from the coupon the bond's own name states is
 *     refused: two sources that disagree are not evidence for either, and a
 *     stored figure would silently outrank the name.
 *
 * A refused figure stores nothing: the bond then falls back to the coupon in
 * its name, or stays not modelled. Nothing is ever guessed.
 */

import type Database from "better-sqlite3";
import { extractCouponRate, MAX_PLAUSIBLE_COUPON_PCT } from "@/lib/bonds";
import { isTreasuryBillName } from "@/lib/compute/bond-duration";

/** At or below this a broker figure could be a fraction of 1 rather than a percent. */
const UNIT_AMBIGUOUS_AT_OR_BELOW = 0.25;
/** Two coupon figures closer than this are the same coupon. */
const SAME_COUPON_TOLERANCE = 0.0005;

export type BrokerCouponDecision =
  | { store: true; couponRatePct: number }
  | {
      store: false;
      reason:
        | "absent"
        | "out-of-range"
        | "zero-unconfirmed"
        | "unit-mismatch-with-name"
        | "differs-from-name"
        | "unit-ambiguous";
    };

/**
 * Decide whether a contract-details `coupon` is stored. `name` is the bond's
 * stored name. Pure.
 */
export function assessBrokerCoupon(raw: unknown, name: string | null | undefined): BrokerCouponDecision {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return { store: false, reason: "absent" };
  if (raw < 0 || raw > MAX_PLAUSIBLE_COUPON_PCT) return { store: false, reason: "out-of-range" };

  const nameCoupon = extractCouponRate(name);

  if (raw === 0) {
    const confirmed = nameCoupon === 0 || (nameCoupon == null && isTreasuryBillName(name));
    return confirmed ? { store: true, couponRatePct: 0 } : { store: false, reason: "zero-unconfirmed" };
  }

  if (nameCoupon != null) {
    if (Math.abs(raw - nameCoupon) <= SAME_COUPON_TOLERANCE) return { store: true, couponRatePct: raw };
    if (nameCoupon > 0 && Math.abs(raw * 100 - nameCoupon) <= SAME_COUPON_TOLERANCE) {
      return { store: false, reason: "unit-mismatch-with-name" };
    }
    // The name states a different coupon: store neither.
    return { store: false, reason: "differs-from-name" };
  }

  if (raw <= UNIT_AMBIGUOUS_AT_OR_BELOW) return { store: false, reason: "unit-ambiguous" };
  // The name states no coupon, and the figure cannot be a fraction.
  return { store: true, couponRatePct: raw };
}

/**
 * Fill `securities.coupon_rate` for a bond that has none. Never replaces a
 * stored coupon (so never writes null or a second opinion over one), never
 * touches a row that is not typed Bond, and re-checks the range at the write.
 * Returns whether a row changed.
 */
export function storeBrokerCoupon(db: Database.Database, securityId: number, couponRatePct: number): boolean {
  if (!Number.isFinite(couponRatePct) || couponRatePct < 0 || couponRatePct > MAX_PLAUSIBLE_COUPON_PCT) return false;
  const result = db
    .prepare(
      `UPDATE securities
          SET coupon_rate = ?
        WHERE id = ?
          AND coupon_rate IS NULL
          AND LOWER(TRIM(COALESCE(security_type, ''))) = 'bond'`,
    )
    .run(couponRatePct, securityId);
  return result.changes > 0;
}
