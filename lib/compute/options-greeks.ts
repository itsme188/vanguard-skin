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

// ─── Types ──────────────────────────────────────────────────────

export interface OptionGreeks {
  delta: number;
  gamma: number;
  theta: number; // daily theta in dollars (negative = decay)
  vega: number; // per 1% IV move
  iv: number | null; // implied volatility (annualized, 0.30 = 30%)
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

export interface PortfolioGreeks {
  totalDelta: number; // net delta exposure in share-equivalents
  totalGamma: number; // net gamma in share-equivalents per $1 move
  totalTheta: number; // daily $ P&L from time decay
  totalVega: number; // $ P&L per 1% IV move
  positions: PositionGreeks[];
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

const DEFAULT_RISK_FREE_RATE = 0.045;

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
}

/**
 * Compute Greeks for all option positions in the portfolio.
 */
export function computePortfolioGreeks(
  db: Database.Database,
  options?: { accountId?: number; riskFreeRate?: number }
): PortfolioGreeks {
  const r = options?.riskFreeRate ?? DEFAULT_RISK_FREE_RATE;
  const today = new Date().toISOString().slice(0, 10);

  const accountFilter = options?.accountId
    ? "AND h.account_id = ?"
    : "";
  const params: (string | number)[] = [today];
  if (options?.accountId) params.push(options.accountId);

  // Get option positions from latest holdings with underlying prices
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
         ORDER BY p.date DESC LIMIT 1) AS underlying_price
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       WHERE s.security_type = 'option'
         AND s.strike_price IS NOT NULL
         AND s.expiration_date IS NOT NULL
         AND s.option_type IS NOT NULL
         AND s.underlying_symbol IS NOT NULL
         AND h.as_of_date = (
           SELECT MAX(h2.as_of_date) FROM holdings h2
           WHERE h2.as_of_date <= ?
         )
         ${accountFilter}`
    )
    .all(...params) as OptionHoldingRow[];

  const positions: PositionGreeks[] = [];
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

    if (!S || S <= 0 || daysToExpiry < 0) {
      positions.push(position);
      continue;
    }

    // Compute IV from market price, or use a default if no price
    let iv: number | null = null;
    let sigmaForGreeks = 0.3; // fallback: 30% vol

    if (row.option_price && row.option_price > 0) {
      iv = impliedVolatility(row.option_price, S, row.strike_price, T, r, optType);
      if (iv !== null) {
        sigmaForGreeks = iv;
      }
    }

    if (T <= 0) {
      // Expired — no meaningful Greeks
      position.greeks = { delta: 0, gamma: 0, theta: 0, vega: 0, iv: null };
      positions.push(position);
      continue;
    }

    const d = delta(S, row.strike_price, T, r, sigmaForGreeks, optType);
    const g = gamma(S, row.strike_price, T, r, sigmaForGreeks);
    const th = theta(S, row.strike_price, T, r, sigmaForGreeks, optType);
    const v = vega(S, row.strike_price, T, r, sigmaForGreeks);

    position.greeks = { delta: d, gamma: g, theta: th, vega: v, iv };

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
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA + "T00:00:00Z");
  const b = new Date(dateB + "T00:00:00Z");
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}
