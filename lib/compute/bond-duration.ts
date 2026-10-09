/**
 * The rate leg of a scenario for bonds and bond funds: the ONE duration rule
 * both scenario engines share (owner rulings 2026-10-06).
 *
 * Before this module each engine defaulted a missing duration to 5 years, so a
 * two-month Treasury bill and a thirty-year bond with no stored duration were
 * marked down by the same 5-year figure, and the custom engine skipped bond
 * funds altogether while the preset moved them through equity factor buckets.
 *
 * Rules for an individual bond, in order:
 *   1. A maturity date in the past: matured, unmodelled (even with a stored
 *      duration; a matured bond has no rate risk left to estimate).
 *   2. A stored duration is used as stored.
 *   3. No maturity date: unmodelled.
 *   4. Zero coupon (a coupon of 0, or a Treasury bill by name with no
 *      stored coupon): years to maturity.
 *   5. Within one coupon period of maturity: one cash flow is left, so the
 *      duration is the time to maturity. Needs neither coupon nor price.
 *   6. A coupon bond: modified duration from its coupon, its maturity and the
 *      yield its stored price implies.
 *   7. Anything else (no coupon, no usable price or yield) adds NOTHING to
 *      the rate leg and is reported as unmodelled. No coupon, yield or
 *      duration is ever assumed for a bond.
 *
 * Where the coupon comes from (owner ruling 2026-10-07): the stored coupon
 * (`securities.coupon_rate`, written only from the broker's contract details)
 * first; with none stored, the coupon read from the bond's stored name by the
 * strict parser in lib/bonds.ts; a name that does not parse leaves the bond
 * unmodelled. The result says which was used (`couponSource`).
 *
 * A fixed-income FUND uses its stored duration, else a 5-year default. The
 * default is for funds only, and only for a fund that really is a bond fund
 * (ruling D6, 2026-10-08): its fund category must be in the bond family AND
 * nothing else on the row may say it is an equity fund (see
 * `fundDefaultRefusal`). A fund that fails either test adds NOTHING to the
 * rate leg and is listed and counted as not modelled.
 *
 * Cash equivalents are not handled here: each engine keeps its own existing
 * cash treatment and never reaches this module for one. Options are not
 * handled here either.
 *
 * Client-safe: no database import (the scenario card reads the constant).
 */

import { isCashEquivalentSecurity } from "./cash-equivalents";
import { normalizeSector, GICS_SECTORS } from "@/lib/securities/normalize-sector";
import { isBondFundCategory, isLeveragedInverseFundCategory } from "@/lib/securities/normalize-fund-category";
import { extractCouponRate } from "@/lib/bonds";

/** Ruled 2026-10-06: a bond FUND with no stored duration is priced at 5 years. */
export const FUND_DEFAULT_DURATION_YEARS = 5;

/** US convention: two coupons a year. The schema stores no payment frequency. */
const COUPONS_PER_YEAR = 2;
const MONTHS_PER_COUPON = 12 / COUPONS_PER_YEAR;
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
  /** Coupon bond with one cash flow left: years to maturity. */
  | "single-flow"
  /** Coupon bond: modified duration from the STORED (broker) coupon, maturity and price-implied yield. */
  | "coupon-yield"
  /** The same derivation with the coupon read from the bond's name (none stored). */
  | "coupon-yield-name"
  /** `securities.duration_years` on a fixed-income fund. */
  | "fund-stored"
  /** Fixed-income fund with no stored duration: FUND_DEFAULT_DURATION_YEARS. */
  | "fund-default";

/** Where a bond's coupon came from: the stored broker figure, or the bond's stored name. */
export type CouponSource = "broker" | "name";

export type BondUnmodelledReason =
  | "no-maturity"
  | "matured"
  /** No coupon stored and none readable in the name. */
  | "no-coupon"
  /** A coupon IS stored but is not a usable number (negative, not finite). The name is not consulted. */
  | "unusable-coupon"
  | "no-price"
  | "no-yield"
  | FundUnmodelledReason;

/**
 * Why a fund with no stored duration was refused the 5-year default
 * (ruling D6, 2026-10-08). Funds only; an individual bond never carries one.
 */
export type FundUnmodelledReason =
  /** Labelled a bond fund, but its sector or its name says it holds equities. */
  | "fund-equity-evidence"
  /** Its fund category is not a recognised bond category (missing or unknown). */
  | "fund-category-unconfirmed";

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
  /**
   * Set only when a coupon decided the outcome: a zero coupon, the coupon
   * bond derivation, or a coupon bond left out for want of a price or yield.
   * Absent for a stored duration, a bill known by name alone, a single
   * remaining flow, a fund, and a bond with no coupon at all.
   */
  couponSource?: CouponSource;
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
 * Fund-family security types, compared case-insensitively. The repo has no
 * shared fund-family helper: lib/tws/security-type-map.ts maps both 'ETF' and
 * 'Stock' to the broker's STK (and imports the broker SDK, which this
 * client-safe module must not), so the two stored spellings are matched here.
 */
function isFundFamilyType(securityType: string | null | undefined): boolean {
  const type = (securityType ?? "").trim().toLowerCase();
  return type === "etf" || type === "mutual fund" || type === "mutual_fund";
}

/**
 * A fixed-income fund (controller ruling 2026-10-07 on the owner's "bond
 * funds get the duration estimate"):
 *   - the security type is in the fund family (ETF / mutual fund). A Stock, a
 *     CD or a preferred share with a Fixed Income sector is NOT a bond fund;
 *   - it is not a cash equivalent (those keep their own treatment);
 *   - it is not a leveraged or inverse fund. An inverse Treasury fund GAINS
 *     when rates rise and a leveraged one moves by a multiple, so a plain
 *     duration mark-down would be the wrong sign or the wrong size. Such a
 *     fund gets no rate leg from this rule, and it is not an individual bond,
 *     so it is not listed as an unmodelled bond either;
 *   - its normalized fund category is a bond category (the one grouping in
 *     lib/securities/normalize-fund-category.ts), or its sector normalizes
 *     to "Fixed Income". The category test is what reaches a fund the broker
 *     never enriched with a sector.
 */
export function isFixedIncomeFund(sec: {
  security_type: string | null;
  sector: string | null;
  fund_category: string | null;
}): boolean {
  if (!isFundFamilyType(sec.security_type)) return false;
  if (isCashEquivalentSecurity(sec)) return false;
  if (isLeveragedInverseFundCategory(sec.fund_category)) return false;
  return isBondFundCategory(sec.fund_category) || normalizeSector(sec.sector) === "Fixed Income";
}

/** The eleven GICS sectors are all equity sectors ("Fixed Income" and "Diversified" are not among them). */
const EQUITY_SECTORS: ReadonlySet<string> = new Set<string>(GICS_SECTORS);

/**
 * Whole words in a fund's name that say it holds equities: "Equity",
 * "Equities", "Stock", "Stocks", and "Long Short" in its three spellings.
 * Whole words only, so "Shares", "iShares" and "Stockton" do not match.
 */
const EQUITY_NAME_WORDS = /\b(?:equity|equities|stocks?|long[\s/-]+short)\b/i;

/**
 * Whether a fixed-income fund with no stored duration may take the 5-year
 * default (ruling D6, 2026-10-08). Null means yes; otherwise the reason it is
 * left out. The ONE reader of the rule.
 *
 * Why: an equity fund the classifier had labelled "Diversified Bond" was
 * marked down like a mortgage-bond fund. The category alone is one piece of
 * evidence (and may be an AI label), so the default now needs both:
 *   1. no equity evidence: the sector must not normalize to a GICS equity
 *      sector, and the name must carry no equity word. Checked first, so a
 *      fund failing both tests is named as an equity fund;
 *   2. the normalized fund category is in the bond family (the one grouping
 *      in lib/securities/normalize-fund-category.ts). A "Fixed Income" sector
 *      with a missing or unknown category is not enough.
 *
 * Not read: `securities.asset_class`. The broker codes every exchange-traded
 * fund, bond funds included, as stock there, so it cannot tell the two apart.
 */
export function fundDefaultRefusal(sec: {
  security_name: string | null;
  sector: string | null;
  fund_category: string | null;
}): FundUnmodelledReason | null {
  const sector = normalizeSector(sec.sector);
  if (sector != null && EQUITY_SECTORS.has(sector)) return "fund-equity-evidence";
  if (sec.security_name && EQUITY_NAME_WORDS.test(sec.security_name)) return "fund-equity-evidence";
  if (!isBondFundCategory(sec.fund_category)) return "fund-category-unconfirmed";
  return null;
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

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIsoDate(value: string): { y: number; m: number; d: number } | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

function dayNumber(value: string): number | null {
  const parts = parseIsoDate(value);
  if (!parts) return null;
  const ms = Date.UTC(parts.y, parts.m - 1, parts.d);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null;
}

/** Signed whole days from `from` to `to` (both YYYY-MM-DD); null if either is unreadable. */
function signedDaysBetween(from: string, to: string): number | null {
  const a = dayNumber(from);
  const b = dayNumber(to);
  return a == null || b == null ? null : b - a;
}

/**
 * `date` moved back by whole calendar months, keeping the day of month and
 * clamping it to the month's last day (31 August less six months is the last
 * day of February).
 */
function minusMonths(date: { y: number; m: number; d: number }, months: number): string {
  const index = date.y * 12 + (date.m - 1) - months;
  const y = Math.floor(index / 12);
  const m = index - y * 12; // 0-based
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = Math.min(date.d, lastDay);
  return `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * The coupon dates still to come, earliest first: the maturity date and every
 * six calendar months before it that falls AFTER `today` (a coupon dated
 * today is already paid). Each date is stepped from the maturity date itself,
 * so a month-end clamp never drifts down the schedule. Empty when the bond
 * matures today or earlier, or a date is unreadable.
 */
export function remainingCouponDates(maturityDate: string, today: string): string[] {
  const maturity = parseIsoDate(maturityDate);
  const todayNumber = dayNumber(today);
  if (!maturity || todayNumber == null) return [];
  const dates: string[] = [];
  for (let k = 0; k < 400; k++) {
    const date = minusMonths(maturity, k * MONTHS_PER_COUPON);
    const n = dayNumber(date);
    if (n == null || n <= todayNumber) break;
    dates.push(date);
  }
  return dates.reverse();
}

export type CouponDurationResult =
  | {
      ok: true;
      modifiedDuration: number;
      macaulayDuration: number;
      /** Null when one flow is left: the duration is then the time to maturity and no yield is solved. */
      yieldToMaturity: number | null;
      remainingFlows: number;
    }
  | { ok: false; reason: "no-maturity" | "matured" | "no-coupon" | "no-price" | "no-yield" };

/**
 * Standard modified duration of a fixed-coupon bullet bond.
 *
 * Cash flows: half the annual coupon on each remaining coupon date (six
 * calendar months apart, counted BACK from the maturity date), plus 100 at
 * maturity. With one flow left the duration is simply the time to maturity
 * and nothing else is needed. Otherwise the stored price is taken as a clean
 * quote, accrued interest for the running coupon period is added, and the
 * yield that discounts the flows to that price is solved (semiannual
 * compounding; the first flow is a fraction of a period away, measured in
 * days over the days in the running period). Macaulay duration is the
 * present-value-weighted time to each flow; modified duration divides it by
 * (1 + y/2).
 *
 * Approximations, stated: semiannual coupons; each coupon period counts as
 * half a year.
 */
export function couponBondModifiedDuration(input: {
  couponRatePct: number;
  cleanPrice: number | null;
  maturityDate: string;
  today: string;
}): CouponDurationResult {
  const days = signedDaysBetween(input.today, input.maturityDate);
  if (days == null) return { ok: false, reason: "no-maturity" };
  if (days < 0) return { ok: false, reason: "matured" };
  if (days === 0) return { ok: true, modifiedDuration: 0, macaulayDuration: 0, yieldToMaturity: null, remainingFlows: 0 };

  const dates = remainingCouponDates(input.maturityDate, input.today);
  if (dates.length === 0) return { ok: false, reason: "no-maturity" };
  if (dates.length === 1) {
    // One cash flow: its timing is the whole story, so small price noise
    // near maturity cannot make the bond unpriceable.
    const years = days / DAYS_PER_YEAR;
    return { ok: true, modifiedDuration: years, macaulayDuration: years, yieldToMaturity: null, remainingFlows: 1 };
  }

  if (!Number.isFinite(input.couponRatePct) || input.couponRatePct < 0) return { ok: false, reason: "no-coupon" };
  if (input.cleanPrice == null || !Number.isFinite(input.cleanPrice) || !(input.cleanPrice > 0)) {
    return { ok: false, reason: "no-price" };
  }

  const couponPerPeriod = input.couponRatePct / COUPONS_PER_YEAR;
  const maturity = parseIsoDate(input.maturityDate)!;
  const previousCoupon = minusMonths(maturity, dates.length * MONTHS_PER_COUPON);
  const periodDays = signedDaysBetween(previousCoupon, dates[0]);
  const daysToNext = signedDaysBetween(input.today, dates[0]);
  if (periodDays == null || daysToNext == null || !(periodDays > 0)) return { ok: false, reason: "no-maturity" };
  // Fraction of a coupon period until the next coupon: 1 on a coupon date.
  const w = Math.max(0, Math.min(1, daysToNext / periodDays));
  const accrued = couponPerPeriod * (1 - w);
  const dirtyPrice = input.cleanPrice + accrued;

  // Flow j (0-based) is w + j periods away.
  const flows = dates.map((_, j) => ({
    periods: w + j,
    amount: couponPerPeriod + (j === dates.length - 1 ? 100 : 0),
  }));
  const presentValue = (y: number) =>
    flows.reduce((sum, f) => sum + f.amount * Math.pow(1 + y / COUPONS_PER_YEAR, -f.periods), 0);

  // Present value falls as yield rises, so bisection brackets the yield.
  let lo = MIN_YIELD;
  let hi = MAX_YIELD;
  if (presentValue(lo) < dirtyPrice || presentValue(hi) > dirtyPrice) return { ok: false, reason: "no-yield" };
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (presentValue(mid) > dirtyPrice) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-13) break;
  }
  const y = (lo + hi) / 2;
  const pv = presentValue(y);
  if (!Number.isFinite(pv) || !(pv > 0)) return { ok: false, reason: "no-yield" };

  const macaulayDuration =
    flows.reduce(
      (sum, f) => sum + (f.periods / COUPONS_PER_YEAR) * f.amount * Math.pow(1 + y / COUPONS_PER_YEAR, -f.periods),
      0,
    ) / pv;
  const modifiedDuration = macaulayDuration / (1 + y / COUPONS_PER_YEAR);
  if (!Number.isFinite(modifiedDuration) || modifiedDuration < 0) return { ok: false, reason: "no-yield" };
  return { ok: true, modifiedDuration, macaulayDuration, yieldToMaturity: y, remainingFlows: dates.length };
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
    // A stored duration is a stored input and is used as stored.
    if (stored != null) {
      return { changePercent: rateLegForDuration(stored, rateBps), durationYears: stored, durationSource: "fund-stored" };
    }
    // The default is for a corroborated bond fund only; anything else is
    // left out and reported, never given a duration.
    const refusal = fundDefaultRefusal(pos);
    if (refusal) return { changePercent: 0, unmodelledReason: refusal };
    return {
      changePercent: rateLegForDuration(FUND_DEFAULT_DURATION_YEARS, rateBps),
      durationYears: FUND_DEFAULT_DURATION_YEARS,
      durationSource: "fund-default",
    };
  }

  const modelled = (durationYears: number, durationSource: RateDurationSource, couponSource?: CouponSource): BondRateLeg => ({
    changePercent: rateLegForDuration(durationYears, rateBps),
    durationYears,
    durationSource,
    ...(couponSource ? { couponSource } : {}),
  });
  const unmodelled = (unmodelledReason: BondUnmodelledReason, couponSource?: CouponSource): BondRateLeg => ({
    changePercent: 0,
    unmodelledReason,
    ...(couponSource ? { couponSource } : {}),
  });

  const days = pos.maturity_date ? signedDaysBetween(today, pos.maturity_date) : null;
  // A known maturity date in the past wins over a stored duration.
  if (days != null && days < 0) return unmodelled("matured");
  if (stored != null) return modelled(stored, "stored");
  if (days == null) return unmodelled("no-maturity");

  // The stored coupon first; with none stored, the one the name states.
  const storedCoupon = pos.coupon_rate;
  const nameCoupon = storedCoupon == null ? extractCouponRate(pos.security_name) : null;
  const coupon = storedCoupon ?? nameCoupon;
  const couponSource: CouponSource | undefined = storedCoupon != null ? "broker" : nameCoupon != null ? "name" : undefined;

  // Zero-coupon: one cash flow, so the duration is the time to it. The bill
  // name decides only when no coupon is stored; a positive stored coupon on a
  // row named like a bill is a coupon bond.
  if (coupon === 0) return modelled(days / DAYS_PER_YEAR, "bill-maturity", couponSource);
  if (storedCoupon == null && isTreasuryBillName(pos.security_name)) {
    return modelled(days / DAYS_PER_YEAR, "bill-maturity");
  }

  // One flow left needs neither the coupon nor the price.
  if (remainingCouponDates(pos.maturity_date!, today).length <= 1) {
    return modelled(days / DAYS_PER_YEAR, "single-flow");
  }

  if (coupon == null) return unmodelled("no-coupon");
  // Same outcome as before (left out, nothing assumed); only the reason now
  // says a coupon is on file and is bad, so the card does not claim "none".
  if (!Number.isFinite(coupon) || coupon < 0) return unmodelled("unusable-coupon");
  const derived = couponBondModifiedDuration({
    couponRatePct: coupon,
    cleanPrice: pos.bond_price,
    maturityDate: pos.maturity_date!,
    today,
  });
  if (!derived.ok) return unmodelled(derived.reason, couponSource);
  return modelled(derived.modifiedDuration, couponSource === "name" ? "coupon-yield-name" : "coupon-yield", couponSource);
}

/**
 * How many individual bonds a rate move left unmodelled, and their share of
 * the absolute individual-bond value. Funds are not in that share: a fund
 * left out (refused the default, see `fundDefaultRefusal`) is counted on its
 * own in `fundCount`.
 */
export function summarizeUnmodelledBonds(
  rows: Array<{ securityType: string; currentValue: number; bondUnmodelledReason?: BondUnmodelledReason }>,
): { count: number; valueShare: number; fundCount: number } {
  let count = 0;
  let fundCount = 0;
  let unmodelledValue = 0;
  let bondValue = 0;
  for (const row of rows) {
    if ((row.securityType ?? "").trim().toLowerCase() !== "bond") {
      if (row.bondUnmodelledReason) fundCount += 1;
      continue;
    }
    const value = Math.abs(row.currentValue);
    bondValue += value;
    if (row.bondUnmodelledReason) {
      count += 1;
      unmodelledValue += value;
    }
  }
  return { count, valueShare: bondValue > 0 ? unmodelledValue / bondValue : 0, fundCount };
}
