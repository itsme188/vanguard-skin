/**
 * The rate leg of a scenario for bonds and bond funds: the ONE duration rule
 * both scenario engines share (owner rulings 2026-10-06).
 *
 * Before this module each engine defaulted a missing duration to 5 years, so a
 * two-month Treasury bill and a thirty-year bond with no stored duration were
 * marked down by the same 5-year figure, and the custom engine skipped bond
 * funds altogether while the preset moved them through equity factor buckets.
 *
 * Rules, in order:
 *   1. An individual bond with a stored duration uses it.
 *   2. Otherwise the duration is derived from the maturity date:
 *        - a Treasury bill or a stored zero coupon: years to maturity;
 *        - a coupon bond: modified duration from its stored coupon, its
 *          maturity and the yield its stored price implies.
 *   3. A bond that cannot be derived (no maturity date, no stored coupon, no
 *      usable price or yield) adds NOTHING to the rate leg and is reported as
 *      unmodelled. No coupon, yield or duration is ever assumed for a bond.
 *   4. A fixed-income FUND uses its stored duration, else a 5-year default.
 *      The default is for funds only.
 *
 * Cash equivalents are not handled here: each engine keeps its own existing
 * cash treatment and never reaches this module for one. Options are not
 * handled here either.
 *
 * Client-safe: no database import (the scenario card reads the constant).
 */

import { isCashEquivalentSecurity } from "./cash-equivalents";
import { isOptionSecurityType } from "./option-elasticity";
import { normalizeSector } from "@/lib/securities/normalize-sector";

/** Ruled 2026-10-06: a bond FUND with no stored duration is priced at 5 years. */
export const FUND_DEFAULT_DURATION_YEARS = 5;

/** US convention: two coupons a year. The schema stores no payment frequency. */
const COUPONS_PER_YEAR = 2;
const DAYS_PER_YEAR = 365;
/**
 * A solved yield outside this range means the stored price or coupon is bad
 * data, not a real bond; the row is then unmodelled.
 */
const MIN_YIELD = -0.05;
const MAX_YIELD = 1.0;

export type RateDurationSource =
  /** `securities.duration_years` on an individual bond. */
  | "stored"
  /** Zero-coupon instrument: years to maturity. */
  | "bill-maturity"
  /** Coupon bond: modified duration from coupon, maturity and price-implied yield. */
  | "coupon-yield"
  /** `securities.duration_years` on a fixed-income fund. */
  | "fund-stored"
  /** Fixed-income fund with no stored duration: FUND_DEFAULT_DURATION_YEARS. */
  | "fund-default";

export type BondUnmodelledReason = "no-maturity" | "matured" | "no-coupon" | "no-price" | "no-yield";

/** The stored inputs the rate leg reads. Both engines select exactly these. */
export interface RateLegInputs {
  security_type: string;
  /** `securities.name`: the only stored field that says "Treasury bill". */
  security_name: string | null;
  sector: string | null;
  fund_category: string | null;
  duration_years: number | null;
  maturity_date: string | null;
  /** Annual coupon in PERCENT of face (4.375 = 4.375%), as the Fixed Income card reads it. */
  coupon_rate: number | null;
  /** Latest stored price per 100 face, treated as a clean (ex-accrued) quote. */
  bond_price: number | null;
}

export interface BondRateLeg {
  /** The rate leg as a fraction of value. Exactly 0 when unmodelled. */
  changePercent: number;
  durationYears?: number;
  durationSource?: RateDurationSource;
  unmodelledReason?: BondUnmodelledReason;
}

/**
 * Price change for a duration and a parallel rate move, in basis points.
 * exp(-D * dy) - 1 is smooth, monotonic and can never reach -100%, unlike the
 * linear -D * dy.
 */
export function rateLegForDuration(durationYears: number, rateBps: number): number {
  if (durationYears === 0 || rateBps === 0) return 0;
  return Math.exp(-durationYears * (rateBps / 10000)) - 1;
}

/**
 * A fixed-income fund: a holding that is not an individual bond, not an
 * option and not a cash equivalent, whose sector normalizes to "Fixed
 * Income". The sector vocabulary is single-sourced through normalizeSector;
 * there is deliberately no fund-category string list here. The type is not
 * required to be a fund type because the broker labels ETFs 'Stock'.
 */
export function isFixedIncomeFund(sec: {
  security_type: string | null;
  sector: string | null;
  fund_category: string | null;
}): boolean {
  const type = (sec.security_type ?? "").trim().toLowerCase();
  if (type === "bond" || isOptionSecurityType(type)) return false;
  if (isCashEquivalentSecurity(sec)) return false;
  return normalizeSector(sec.sector) === "Fixed Income";
}

/**
 * True when the stored name says the instrument is a Treasury bill ("T-Bill",
 * "TREASURY BILL"). Bills pay no coupon, and the security type does not keep
 * the distinction (every broker bill is typed 'Bond').
 */
export function isTreasuryBillName(name: string | null | undefined): boolean {
  if (!name) return false;
  return /\b(?:t-bills?|treasury\s+bills?)\b/i.test(name);
}

/** Signed whole days from `from` to `to` (both YYYY-MM-DD); null if either is unreadable. */
function signedDaysBetween(from: string, to: string): number | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(from) || !iso.test(to)) return null;
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

export type CouponDurationResult =
  | { ok: true; modifiedDuration: number; macaulayDuration: number; yieldToMaturity: number }
  | { ok: false; reason: "no-maturity" | "matured" | "no-coupon" | "no-price" | "no-yield" };

/**
 * Standard modified duration of a fixed-coupon bullet bond.
 *
 * Cash flows: half the annual coupon every six months counted BACK from the
 * maturity date, plus 100 at maturity. The stored price is a clean quote, so
 * accrued interest for the running coupon period is added before solving the
 * yield that discounts those flows to that price (semiannual compounding).
 * Macaulay duration is the present-value-weighted time to each flow; modified
 * duration divides it by (1 + y/2).
 *
 * Approximations, stated: semiannual coupons, time measured in days / 365,
 * coupon periods of exactly half a year.
 */
export function couponBondModifiedDuration(input: {
  couponRatePct: number;
  cleanPrice: number;
  maturityDate: string;
  today: string;
}): CouponDurationResult {
  const days = signedDaysBetween(input.today, input.maturityDate);
  if (days == null) return { ok: false, reason: "no-maturity" };
  if (days < 0) return { ok: false, reason: "matured" };
  if (!Number.isFinite(input.couponRatePct) || input.couponRatePct < 0) return { ok: false, reason: "no-coupon" };
  if (!Number.isFinite(input.cleanPrice) || !(input.cleanPrice > 0)) return { ok: false, reason: "no-price" };
  if (days === 0) return { ok: true, modifiedDuration: 0, macaulayDuration: 0, yieldToMaturity: 0 };

  const yearsToMaturity = days / DAYS_PER_YEAR;
  const period = 1 / COUPONS_PER_YEAR;
  const couponPerPeriod = input.couponRatePct / COUPONS_PER_YEAR;

  // Flow times, nearest first is last in this list: T, T - 0.5, T - 1, ... > 0.
  const flows: Array<{ t: number; amount: number }> = [];
  for (let k = 0; ; k++) {
    const t = yearsToMaturity - k * period;
    if (!(t > 1e-9)) break;
    flows.push({ t, amount: couponPerPeriod + (k === 0 ? 100 : 0) });
  }
  const timeToNextCoupon = flows[flows.length - 1].t;
  const accrued = couponPerPeriod * Math.max(0, Math.min(1, (period - timeToNextCoupon) / period));
  const dirtyPrice = input.cleanPrice + accrued;

  const presentValue = (y: number) =>
    flows.reduce((sum, f) => sum + f.amount * Math.pow(1 + y / COUPONS_PER_YEAR, -COUPONS_PER_YEAR * f.t), 0);

  // Present value falls as yield rises, so bisection brackets the yield.
  let lo = MIN_YIELD;
  let hi = MAX_YIELD;
  if (presentValue(lo) < dirtyPrice || presentValue(hi) > dirtyPrice) return { ok: false, reason: "no-yield" };
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (presentValue(mid) > dirtyPrice) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-12) break;
  }
  const y = (lo + hi) / 2;
  const pv = presentValue(y);
  if (!Number.isFinite(pv) || !(pv > 0)) return { ok: false, reason: "no-yield" };

  const macaulayDuration =
    flows.reduce((sum, f) => sum + f.t * f.amount * Math.pow(1 + y / COUPONS_PER_YEAR, -COUPONS_PER_YEAR * f.t), 0) / pv;
  const modifiedDuration = macaulayDuration / (1 + y / COUPONS_PER_YEAR);
  if (!Number.isFinite(modifiedDuration) || modifiedDuration < 0) return { ok: false, reason: "no-yield" };
  return { ok: true, modifiedDuration, macaulayDuration, yieldToMaturity: y };
}

function storedDuration(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The rate leg for one position, or null when the position is neither an
 * individual bond nor a fixed-income fund (the caller then applies whatever it
 * applied before). `today` is the run's ET calendar date, read once per run.
 */
export function estimateBondRateLeg(pos: RateLegInputs, rateBps: number, today: string): BondRateLeg | null {
  const type = (pos.security_type ?? "").trim().toLowerCase();
  const stored = storedDuration(pos.duration_years);

  if (type !== "bond") {
    if (!isFixedIncomeFund(pos)) return null;
    const durationYears = stored ?? FUND_DEFAULT_DURATION_YEARS;
    return {
      changePercent: rateLegForDuration(durationYears, rateBps),
      durationYears,
      durationSource: stored != null ? "fund-stored" : "fund-default",
    };
  }

  const modelled = (durationYears: number, durationSource: RateDurationSource): BondRateLeg => ({
    changePercent: rateLegForDuration(durationYears, rateBps),
    durationYears,
    durationSource,
  });
  const unmodelled = (unmodelledReason: BondUnmodelledReason): BondRateLeg => ({ changePercent: 0, unmodelledReason });

  if (stored != null) return modelled(stored, "stored");

  const days = pos.maturity_date ? signedDaysBetween(today, pos.maturity_date) : null;
  if (days == null) return unmodelled("no-maturity");
  if (days < 0) return unmodelled("matured");

  // Zero-coupon: one cash flow, so the duration is the time to it.
  if (pos.coupon_rate === 0 || isTreasuryBillName(pos.security_name)) {
    return modelled(days / DAYS_PER_YEAR, "bill-maturity");
  }

  if (pos.coupon_rate == null || !Number.isFinite(pos.coupon_rate) || pos.coupon_rate < 0) return unmodelled("no-coupon");
  if (pos.bond_price == null) return unmodelled("no-price");
  const derived = couponBondModifiedDuration({
    couponRatePct: pos.coupon_rate,
    cleanPrice: pos.bond_price,
    maturityDate: pos.maturity_date!,
    today,
  });
  if (!derived.ok) return unmodelled(derived.reason);
  return modelled(derived.modifiedDuration, "coupon-yield");
}

/**
 * How many individual bonds a rate move left unmodelled, and their share of
 * the absolute individual-bond value. Funds are never unmodelled (they fall
 * back to the default), so they are not in the denominator.
 */
export function summarizeUnmodelledBonds(
  rows: Array<{ securityType: string; currentValue: number; bondUnmodelledReason?: BondUnmodelledReason }>,
): { count: number; valueShare: number } {
  let count = 0;
  let unmodelledValue = 0;
  let bondValue = 0;
  for (const row of rows) {
    if ((row.securityType ?? "").trim().toLowerCase() !== "bond") continue;
    const value = Math.abs(row.currentValue);
    bondValue += value;
    if (row.bondUnmodelledReason) {
      count += 1;
      unmodelledValue += value;
    }
  }
  return { count, valueShare: bondValue > 0 ? unmodelledValue / bondValue : 0 };
}
