/**
 * Options Greeks Engine — Black-Scholes model with analytical Greeks.
 *
 * Computes delta, gamma, theta, vega, and implied volatility for option
 * positions. Portfolio-level Greeks are aggregated from per-position values.
 *
 * Uses the Abramowitz & Stegun rational approximation for the cumulative
 * normal distribution (no external stats library needed).
 *
 * IV solver uses Newton-Raphson with bisection fallback — same pattern
 * as lib/compute/xirr.ts.
 */

import type Database from "better-sqlite3";
import { todayET } from "@/lib/calendar/date-utils";
import { getRiskFreeRate } from "@/lib/queries/risk-free-rate";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";

// ─── Types ──────────────────────────────────────────────────────

export interface OptionGreeks {
  delta: number;
  gamma: number;
  theta: number; // daily theta in dollars (negative = decay)
  vega: number; // per 1% IV move
  iv: number | null; // implied volatility (annualized, 0.30 = 30%)
  // Where the vol used for the Greeks came from:
  //   "computed" — solved from the option's market price (best)
  //   "ibkr"     — underlying IV from the cached IBKR snapshot (no option price)
  //   "default"  — blind 30% fallback (iv left null; neither source available)
  ivSource?: "computed" | "ibkr" | "default";
}

export interface PositionGreeks {
  securityId: number;
  symbol: string;
  underlying: string;
  optionType: "CALL" | "PUT";
  strike: number;
  expiration: string;
  quantity: number; // signed: positive = long, negative = short
  multiplier: number;
  underlyingPrice: number;
  optionPrice: number | null;
  daysToExpiry: number;
  greeks: OptionGreeks | null; // null if can't compute (expired, no price, etc.)
}

export interface GreeksDiagnostic {
  symbol: string;
  underlying: string;
  reason: "no_underlying_price" | "expired" | "missing_iv" | "missing_option_price";
  daysToExpiry: number | null;
}

export interface PortfolioGreeks {
  totalDelta: number; // net delta exposure in share-equivalents
  totalGamma: number; // net gamma in share-equivalents per $1 move
  totalTheta: number; // daily $ P&L from time decay
  totalVega: number; // $ P&L per 1% IV move
  positions: PositionGreeks[];
  diagnostics: GreeksDiagnostic[];
}

// ─── Math: Cumulative Normal Distribution ───────────────────────

/**
 * Standard normal PDF: φ(x) = (1/√2π) × e^(-x²/2)
 */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal CDF using Abramowitz & Stegun approximation (26.2.17).
 * Max error: 7.5 × 10⁻⁸.
 */
export function normCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;

  // Coefficients for A&S 26.2.17
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const p = 0.2316419;

  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  // Q(x) = φ(x) × (b1*t + b2*t² + ... + b5*t⁵) where φ(x) is the PDF
  const poly = ((((b5 * t + b4) * t + b3) * t + b2) * t + b1) * t;
  const q = normPdf(absX) * poly;

  return x < 0 ? q : 1.0 - q;
}

// ─── Black-Scholes Model ────────────────────────────────────────

/**
 * Compute d1 and d2 for Black-Scholes.
 * S = underlying price, K = strike, T = time to expiry (years),
 * r = risk-free rate, σ = volatility
 */
function d1d2(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number
): { d1: number; d2: number } {
  const d1 =
    (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return { d1, d2 };
}

/**
 * Black-Scholes call price.
 */
export function callPrice(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number
): number {
  if (T <= 0) return Math.max(S - K, 0); // expired: intrinsic only
  const { d1, d2 } = d1d2(S, K, T, r, sigma);
  return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
}

/**
 * Black-Scholes put price.
 */
export function putPrice(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number
): number {
  if (T <= 0) return Math.max(K - S, 0); // expired: intrinsic only
  const { d1, d2 } = d1d2(S, K, T, r, sigma);
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

// ─── Analytical Greeks ──────────────────────────────────────────

/**
 * Delta: ∂V/∂S
 * Call delta ∈ [0, 1], Put delta ∈ [-1, 0]
 */
export function delta(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  optionType: "CALL" | "PUT"
): number {
  if (T <= 0) {
    // Expired: delta is 1 if ITM, 0 if OTM
    if (optionType === "CALL") return S > K ? 1 : 0;
    return S < K ? -1 : 0;
  }
  const { d1 } = d1d2(S, K, T, r, sigma);
  return optionType === "CALL" ? normCdf(d1) : normCdf(d1) - 1;
}

/**
 * Gamma: ∂²V/∂S² (same for calls and puts)
 */
export function gamma(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number
): number {
  if (T <= 0) return 0;
  const { d1 } = d1d2(S, K, T, r, sigma);
  return normPdf(d1) / (S * sigma * Math.sqrt(T));
}

/**
 * Theta: ∂V/∂t (per calendar day, in price units)
 * Returns negative values for long positions (time decay costs money).
 */
export function theta(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  optionType: "CALL" | "PUT"
): number {
  if (T <= 0) return 0;
  const { d1, d2 } = d1d2(S, K, T, r, sigma);
  const sqrtT = Math.sqrt(T);

  // First term: time decay of the option value
  const term1 = -(S * normPdf(d1) * sigma) / (2 * sqrtT);

  if (optionType === "CALL") {
    const term2 = -r * K * Math.exp(-r * T) * normCdf(d2);
    return (term1 + term2) / 365; // per calendar day
  } else {
    const term2 = r * K * Math.exp(-r * T) * normCdf(-d2);
    return (term1 + term2) / 365; // per calendar day
  }
}

/**
 * Vega: ∂V/∂σ (per 1% move in IV, same for calls and puts)
 * Returns the dollar change per contract for a 1 percentage point IV increase.
 */
export function vega(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number
): number {
  if (T <= 0) return 0;
  const { d1 } = d1d2(S, K, T, r, sigma);
  return (S * normPdf(d1) * Math.sqrt(T)) / 100; // per 1% IV move
}

// ─── Implied Volatility Solver ──────────────────────────────────

const IV_MAX_ITERATIONS = 100;
const IV_TOLERANCE = 1e-6;

/**
 * Solve for implied volatility using Newton-Raphson with bisection fallback.
 * Returns annualized IV as decimal (0.30 = 30%), or null if no convergence.
 */
export function impliedVolatility(
  marketPrice: number,
  S: number,
  K: number,
  T: number,
  r: number,
  optionType: "CALL" | "PUT"
): number | null {
  if (T <= 0 || marketPrice <= 0 || S <= 0 || K <= 0) return null;

  // Check price bounds — allow small float tolerance below intrinsic
  const intrinsic =
    optionType === "CALL"
      ? Math.max(S - K * Math.exp(-r * T), 0)
      : Math.max(K * Math.exp(-r * T) - S, 0);
  if (marketPrice < intrinsic * 0.95 - 0.10) return null; // well below theoretical floor

  const priceFn =
    optionType === "CALL"
      ? (sig: number) => callPrice(S, K, T, r, sig)
      : (sig: number) => putPrice(S, K, T, r, sig);

  // Vega for Newton step (vega in raw units, not per-1%)
  const vegaFn = (sig: number) => {
    const { d1 } = d1d2(S, K, T, r, sig);
    return S * normPdf(d1) * Math.sqrt(T);
  };

  // Newton-Raphson
  let sig = 0.3; // initial guess: 30% vol
  for (let i = 0; i < IV_MAX_ITERATIONS; i++) {
    const price = priceFn(sig);
    const v = vegaFn(sig);

    if (Math.abs(v) < 1e-12) {
      sig = sig > 1 ? 0.5 : 1.5;
      continue;
    }

    const newSig = sig - (price - marketPrice) / v;

    if (newSig <= 0.001) {
      sig = 0.01;
      continue;
    }
    if (newSig > 10) {
      sig = 5;
      continue;
    }

    if (Math.abs(newSig - sig) < IV_TOLERANCE) {
      return newSig;
    }
    sig = newSig;
  }

  // Bisection fallback: search [0.01, 5.0] (1% to 500% vol)
  let lo = 0.01;
  let hi = 5.0;
  const fLo = priceFn(lo) - marketPrice;
  const fHi = priceFn(hi) - marketPrice;
  if (fLo * fHi > 0) return null;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = priceFn(mid) - marketPrice;
    if (Math.abs(fMid) < IV_TOLERANCE || (hi - lo) / 2 < IV_TOLERANCE) {
      return mid;
    }
    if (fMid * fLo < 0) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return null;
}

// ─── Portfolio Greeks Computation ───────────────────────────────

interface OptionHoldingRow {
  security_id: number;
  symbol: string;
  underlying_symbol: string;
  option_type: string;
  strike_price: number;
  expiration_date: string;
  multiplier: number;
  quantity: number;
  option_price: number | null;
  underlying_price: number | null;
  underlying_iv: number | null; // cached IBKR snapshot IV for the underlying
}

/**
 * Compute Greeks for all option positions in the portfolio.
 */
export function computePortfolioGreeks(
  db: Database.Database,
  options?: { accountId?: number; riskFreeRate?: number; today?: string }
): PortfolioGreeks {
  // Risk-free rate flows from FRED's DGS3MO via the settings cache; falls
  // back to 0.045 if never fetched. See lib/queries/risk-free-rate.ts.
  const r = options?.riskFreeRate ?? getRiskFreeRate(db);
  const today = options?.today ?? todayET();

  const accountFilter = options?.accountId
    ? "AND h.account_id = ?"
    : "";
  const params: (string | number)[] = [];
  if (options?.accountId) params.push(options.accountId);

  // Get option positions from latest holdings with underlying prices.
  // asOfDate=today scopes "latest" to today-or-earlier (vs picking up a stray
  // future-dated row) — literal-substituted, no positional bind. See
  // lib/queries/latest-holdings.ts for the safety contract.
  const rows = db
    .prepare(
      `SELECT
        s.id AS security_id,
        s.symbol,
        s.underlying_symbol,
        s.option_type,
        s.strike_price,
        s.expiration_date,
        COALESCE(s.multiplier, 1) AS multiplier,
        h.quantity,
        (SELECT p.close_price FROM prices p
         WHERE p.security_id = s.id
         ORDER BY p.date DESC LIMIT 1) AS option_price,
        (SELECT p.close_price FROM prices p
         JOIN securities su ON su.id = p.security_id
         WHERE su.symbol = s.underlying_symbol
         ORDER BY p.date DESC LIMIT 1) AS underlying_price,
        (SELECT sq.iv_underlying FROM security_quotes sq
         JOIN securities su2 ON su2.id = sq.security_id
         WHERE su2.symbol = s.underlying_symbol
         LIMIT 1) AS underlying_iv
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       WHERE LOWER(s.security_type) = 'option'
         AND s.strike_price IS NOT NULL
         AND s.expiration_date IS NOT NULL
         AND s.option_type IS NOT NULL
         AND s.underlying_symbol IS NOT NULL
         AND ${latestHoldingsPredicate({ asOfDate: today, accountFilter })}`
    )
    .all(...params) as OptionHoldingRow[];

  const positions: PositionGreeks[] = [];
  const diagnostics: GreeksDiagnostic[] = [];
  let totalDelta = 0;
  let totalGamma = 0;
  let totalTheta = 0;
  let totalVega = 0;

  for (const row of rows) {
    const daysToExpiry = daysBetween(today, row.expiration_date);
    const T = Math.max(daysToExpiry / 365, 0);
    const optType = row.option_type.toUpperCase() as "CALL" | "PUT";
    const S = row.underlying_price;

    const position: PositionGreeks = {
      securityId: row.security_id,
      symbol: row.symbol,
      underlying: row.underlying_symbol,
      optionType: optType,
      strike: row.strike_price,
      expiration: row.expiration_date,
      quantity: row.quantity,
      multiplier: row.multiplier,
      underlyingPrice: S ?? 0,
      optionPrice: row.option_price,
      daysToExpiry,
      greeks: null,
    };

    if (!S || S <= 0) {
      diagnostics.push({
        symbol: row.symbol,
        underlying: row.underlying_symbol,
        reason: "no_underlying_price",
        daysToExpiry,
      });
      positions.push(position);
      continue;
    }

    if (daysToExpiry <= 0) {
      diagnostics.push({
        symbol: row.symbol,
        underlying: row.underlying_symbol,
        reason: "expired",
        daysToExpiry,
      });
      positions.push(position);
      continue;
    }

    // Resolve the vol for the Greeks, in priority order:
    //   1. IV solved from the option's own market price ("computed")
    //   2. the underlying's cached IBKR snapshot IV ("ibkr") — when no option price
    //   3. a blind 30% default ("default") — neither source available
    let iv: number | null = null;
    let sigmaForGreeks = 0.3;
    let ivSource: "computed" | "ibkr" | "default" = "default";
    const hasOptionPrice = !!row.option_price && row.option_price > 0;

    if (hasOptionPrice) {
      const solved = impliedVolatility(row.option_price as number, S, row.strike_price, T, r, optType);
      if (solved !== null) {
        iv = solved;
        sigmaForGreeks = solved;
        ivSource = "computed";
      }
    }

    if (ivSource === "default" && row.underlying_iv != null && row.underlying_iv > 0) {
      // No usable computed IV — fall back to the underlying's IBKR snapshot IV,
      // a real market figure that beats the blind 30%.
      iv = row.underlying_iv;
      sigmaForGreeks = row.underlying_iv;
      ivSource = "ibkr";
    }

    if (ivSource === "default") {
      // Still no real IV — record WHY (no price at all vs. price present but
      // unsolvable) so the diagnostic block stays accurate.
      diagnostics.push({
        symbol: row.symbol,
        underlying: row.underlying_symbol,
        reason: hasOptionPrice ? "missing_iv" : "missing_option_price",
        daysToExpiry,
      });
      // sigmaForGreeks stays at 0.3 — Greeks still computed, iv stays null.
    }

    const d = delta(S, row.strike_price, T, r, sigmaForGreeks, optType);
    const g = gamma(S, row.strike_price, T, r, sigmaForGreeks);
    const th = theta(S, row.strike_price, T, r, sigmaForGreeks, optType);
    const v = vega(S, row.strike_price, T, r, sigmaForGreeks);

    position.greeks = { delta: d, gamma: g, theta: th, vega: v, iv, ivSource };

    // Aggregate to portfolio level
    // Multiply by quantity (signed) and multiplier for dollar-equivalent exposure
    const shareEquiv = row.quantity * row.multiplier;
    totalDelta += d * shareEquiv;
    totalGamma += g * shareEquiv;
    totalTheta += th * shareEquiv;
    totalVega += v * shareEquiv;

    positions.push(position);
  }

  return {
    totalDelta,
    totalGamma,
    totalTheta,
    totalVega,
    positions,
    diagnostics,
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA + "T00:00:00Z");
  const b = new Date(dateB + "T00:00:00Z");
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}
