/**
 * Gains at risk, step 2: trial positions (spec
 * docs/superpowers/specs/2026-11-24-gains-at-risk-step2-trial-positions-design.md,
 * rulings R1-R10 and P1-P11).
 *
 * A trial position is a row the owner types that does not exist yet: an
 * option to buy or write, or shares to buy or sell. This module holds the
 * pieces around the engine's trial pass (`computeGainsAtRisk` prices the rows
 * in the same run as the book):
 *
 *   - the ENTRY (R1, R2, R10, P3, P11): `buildTrialEntry` resolves a symbol
 *     the app already knows, takes the underlying's price at the click,
 *     solves the option's volatility ONCE from the typed price
 *     (`solveTrialEntry`, step 1's own-price probe; never the broker's
 *     volatility) and snapshots every account's holdings of that exact
 *     security or contract;
 *   - the server-side check every trial route runs (`checkTrialSecurity`, P9);
 *   - the valuation price (`trialValuationPrice`): the stored price the
 *     loader reads for a name held in any account, else the latest priced
 *     daily close, else the stored price; the same in every stress scope and
 *     read by the entry too;
 *   - "leaves you short" over the whole trial list (`trialShortfalls`, P4);
 *   - the crossing sentence's pattern (`trialCrossing`, P5).
 *
 * READ-ONLY over the database. Nothing about a trial position is stored.
 * Imports only TYPES from the engine, so the engine can value-import this
 * module without a cycle.
 */

import type Database from "better-sqlite3";
import { addDays, todayET } from "@/lib/calendar/date-utils";
import { previousTradingDay } from "@/lib/calendar/market-holidays";
import { getLatestDailyBar, PRICED_BAR_SQL } from "@/lib/queries/ohlcv";
import { getRiskFreeRate } from "@/lib/queries/risk-free-rate";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { FACTOR_COLUMNS, type FactorColumn } from "@/lib/factors";
import { TRIAL_OPTION_MULTIPLIER, TRIAL_POSITION_BOUNDS } from "@/lib/analysis/gains-at-risk-constants";
import { liveOptionExpirationSql, normalizeOptionExpiration, optionExpirationDashedSql } from "./option-expiry";
import { isExpiredAsOf, yearsToExpiry, callPrice, putPrice } from "./options-greeks";
import { isOptionSecurityType, OPTION_ROW_SQL } from "./option-elasticity";
import { repriceOptionUnderShock } from "./option-reprice";
import { DAILY_BAR_WINDOW_DAYS } from "./security-regression";
import type { ScenarioPositionAccountRow } from "./scenario-positions";
import type {
  GainsAtRiskTrialCrossing,
  GainsAtRiskTrialRow,
  TrialPositionDraft,
  TrialPositionInput,
} from "./gains-at-risk";

// ─── Shared reads ───────────────────────────────────────────────

/** The securities columns a trial row reads, plus its FX rate (null = no `fx_rates` row). */
export interface TrialSecurityRow {
  id: number;
  symbol: string;
  name: string | null;
  security_type: string | null;
  sector: string | null;
  style: string | null;
  market_cap_category: string | null;
  fund_category: string | null;
  industry: string | null;
  geography: string | null;
  currency: string | null;
  duration_years: number | null;
  maturity_date: string | null;
  coupon_rate: number | null;
  credit_rating: string | null;
  leverage_factor: number | null;
  ib_con_id: number | null;
  fx_usd_per_unit: number | null;
}

type FactorRow = Record<FactorColumn, string | null>;

/** One securities row by id, with its FX rate and factor buckets; null when the id is not on file. */
export function readTrialSecurity(
  db: Database.Database,
  securityId: number,
): (TrialSecurityRow & { factors: FactorRow }) | null {
  const row = db
    .prepare(
      `SELECT s.id, s.symbol, s.name, s.security_type, s.sector, s.style, s.market_cap_category, s.fund_category,
              s.industry, s.geography, s.currency, s.duration_years, s.maturity_date, s.coupon_rate,
              s.credit_rating, s.leverage_factor, s.ib_con_id, fx.usd_per_unit AS fx_usd_per_unit,
              ${FACTOR_COLUMNS.map((c) => `sf.${c} AS f_${c}`).join(", ")}
         FROM securities s
         LEFT JOIN fx_rates fx ON fx.currency = s.currency
         LEFT JOIN security_factors sf ON sf.security_id = s.id
        WHERE s.id = ?`,
    )
    .get(securityId) as (TrialSecurityRow & Record<string, string | number | null>) | undefined;
  if (!row) return null;
  const factors = Object.fromEntries(FACTOR_COLUMNS.map((c) => [c, (row[`f_${c}`] as string | null) ?? null])) as FactorRow;
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    security_type: row.security_type,
    sector: row.sector,
    style: row.style,
    market_cap_category: row.market_cap_category,
    fund_category: row.fund_category,
    industry: row.industry,
    geography: row.geography,
    currency: row.currency,
    duration_years: row.duration_years,
    maturity_date: row.maturity_date,
    coupon_rate: row.coupon_rate,
    credit_rating: row.credit_rating,
    leverage_factor: row.leverage_factor,
    ib_con_id: row.ib_con_id,
    fx_usd_per_unit: row.fx_usd_per_unit,
    factors,
  };
}

/** A row's currency, trimmed and upper-cased; a missing currency is US dollars (the loader's own reading). */
export function trialCurrency(row: { currency: string | null }): string {
  return (row.currency ?? "USD").trim().toUpperCase() || "USD";
}

/**
 * The row the engine's beta ladder reads for a trial position, shaped as the
 * position loader shapes a held row of that kind: shares read as the
 * security's own row; an option reads as an option row whose underlying is
 * the security (classification inherited from the underlying, as the
 * loader's COALESCE does). Quantity, price and value fields are zero or null:
 * the trial pass prices the row itself and reads only identity fields here.
 */
export function trialBetaRow(
  sec: TrialSecurityRow & { factors: FactorRow },
  kind: "option" | "shares",
): ScenarioPositionAccountRow {
  const common = {
    account_id: 0,
    account_name: "",
    bond_price: null,
    strike_price: null,
    expiration_date: null,
    option_type: null,
    own_price: null,
    underlying_price: null,
    underlying_iv: null,
    market_value: 0,
    total_qty: 0,
    multiplier: 1,
    usd_per_unit: sec.fx_usd_per_unit ?? 1,
    fx_usd_per_unit: sec.fx_usd_per_unit,
    ...sec.factors,
  };
  if (kind === "shares") {
    return {
      ...common,
      security_id: sec.id,
      symbol: sec.symbol,
      security_name: sec.name,
      security_type: sec.security_type ?? "",
      sector: sec.sector,
      style: sec.style,
      market_cap_category: sec.market_cap_category,
      fund_category: sec.fund_category,
      industry: sec.industry,
      subject_fund_category: sec.fund_category,
      geography: sec.geography,
      currency: sec.currency,
      duration_years: sec.duration_years,
      maturity_date: sec.maturity_date,
      coupon_rate: sec.coupon_rate,
      credit_rating: sec.credit_rating,
      underlying_security_type: null,
      underlying_fund_category: null,
      underlying_name: null,
      leverage_factor: sec.leverage_factor,
      underlying_leverage_factor: null,
      underlying_symbol: null,
      underlying_sector: null,
      underlying_industry: null,
      underlying_geography: null,
      underlying_currency: null,
      underlying_security_id: null,
      stored_underlying_symbol: null,
    };
  }
  return {
    ...common,
    security_id: 0,
    symbol: sec.symbol,
    security_name: null,
    security_type: "Option",
    sector: sec.sector,
    style: sec.style,
    market_cap_category: sec.market_cap_category,
    fund_category: null,
    industry: sec.industry,
    subject_fund_category: sec.fund_category,
    geography: sec.geography,
    currency: sec.currency,
    duration_years: null,
    maturity_date: null,
    coupon_rate: null,
    credit_rating: null,
    underlying_security_type: sec.security_type,
    underlying_fund_category: sec.fund_category,
    underlying_name: sec.name,
    leverage_factor: null,
    underlying_leverage_factor: sec.leverage_factor,
    underlying_symbol: sec.symbol,
    underlying_sector: sec.sector,
    underlying_industry: sec.industry,
    underlying_geography: sec.geography,
    underlying_currency: sec.currency,
    underlying_security_id: sec.id,
    stored_underlying_symbol: sec.symbol,
  };
}

// ─── The entry (R1) ─────────────────────────────────────────────

export type TrialEntrySolve =
  | { ok: true; volatility: number }
  | { ok: false; reason: "below-intrinsic" | "not-solvable" | "expired" | "no-option-terms" };

/** A real calendar day in YYYY-MM-DD (2026-02-30 fails). */
export function isTrialCalendarDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** Newton steps that tighten a solved volatility so the model reprices the typed price to well under a cent per contract. */
const POLISH_STEPS = 20;

/**
 * The volatility a typed option price implies at the underlying's price at
 * the click (R1). Step 1's typed-price probe: `repriceOptionUnderShock` with
 * the price as the option's own price, NO broker volatility, a 0% move and
 * none of the time-aware options; only `modelled` with `ivSource:
 * "own-price"` is accepted. A price below exercise value at that underlying
 * is `below-intrinsic`; any other failure (no positive price, a price no
 * volatility explains) is `not-solvable`. There is no fallback volatility.
 *
 * The accepted figure is then polished by a few Newton steps on the same
 * Black-Scholes value, kept only when it reprices the price more closely, so
 * a trial at the click is worth exactly what was paid to the cent.
 */
export function solveTrialEntry(input: {
  right: "put" | "call";
  strike: number;
  expiry: string;
  price: number;
  underlyingPrice: number;
  riskFreeRate: number;
  today?: string;
  now?: Date;
}): TrialEntrySolve {
  const today = input.today ?? todayET();
  const now = input.now ?? new Date();
  if (!isTrialCalendarDay(input.expiry)) return { ok: false, reason: "no-option-terms" };
  if (!(Number.isFinite(input.strike) && input.strike > 0)) return { ok: false, reason: "no-option-terms" };
  if (isExpiredAsOf(input.expiry, today, now)) return { ok: false, reason: "expired" };
  const { price, underlyingPrice: S, strike: K } = input;
  if (!(Number.isFinite(price) && price > 0) || !(Number.isFinite(S) && S > 0)) return { ok: false, reason: "not-solvable" };
  const intrinsic = input.right === "put" ? Math.max(K - S, 0) : Math.max(S - K, 0);
  if (price < intrinsic) return { ok: false, reason: "below-intrinsic" };

  const probe = repriceOptionUnderShock(
    {
      option_type: input.right === "put" ? "PUT" : "CALL",
      strike_price: K,
      expiration_date: input.expiry,
      own_price: price,
      underlying_price: S,
      underlying_iv: null,
    },
    { underlyingMove: 0, riskFreeRate: input.riskFreeRate, today, now },
  );
  if (!probe.modelled) {
    if (probe.reason === "expired") return { ok: false, reason: "expired" };
    if (probe.reason === "no-option-terms") return { ok: false, reason: "no-option-terms" };
    return { ok: false, reason: "not-solvable" };
  }
  if (probe.ivSource !== "own-price") return { ok: false, reason: "not-solvable" };

  // Polish on the repricer's own clock (same T, same r).
  const T = yearsToExpiry(input.expiry, today, now);
  const r = input.riskFreeRate;
  const bs = (sigma: number) => (input.right === "put" ? putPrice(S, K, T, r, sigma) : callPrice(S, K, T, r, sigma));
  let best = probe.sigma;
  let bestErr = Math.abs(bs(best) - price);
  let sigma = best;
  for (let i = 0; i < POLISH_STEPS && bestErr > 1e-12; i++) {
    const h = Math.max(sigma * 1e-6, 1e-9);
    const slope = (bs(sigma + h) - bs(sigma - h)) / (2 * h);
    if (!(Number.isFinite(slope) && slope > 1e-12)) break;
    const next = sigma - (bs(sigma) - price) / slope;
    if (!(Number.isFinite(next) && next > 0)) break;
    sigma = next;
    const err = Math.abs(bs(sigma) - price);
    if (err < bestErr) {
      best = sigma;
      bestErr = err;
    }
  }
  // Beyond the engine's bound no stated volatility explains the price.
  if (!(best > 0 && best <= TRIAL_POSITION_BOUNDS.maxVolatility)) return { ok: false, reason: "not-solvable" };
  return { ok: true, volatility: best };
}

export type TrialEntryRequest =
  | {
      kind: "option";
      symbol: string;
      right: "put" | "call";
      side: "buy" | "write";
      expiry: string;
      strike: number;
      contracts: number;
      price: number;
      quotedUnderlyingPrice?: number;
    }
  | { kind: "shares"; symbol: string; side: "buy" | "sell"; quantity: number; price: number };

export type TrialEntryRefusal =
  | "unknown-symbol"
  | "is-an-option"
  | "foreign-currency"
  | "no-underlying-price"
  | "below-intrinsic"
  | "not-solvable"
  | "expired"
  | "no-option-terms";

export type TrialEntryResult =
  | {
      ok: true;
      position: TrialPositionDraft;
      symbol: string;
      name: string | null;
      underlyingPrice: number;
      underlyingPriceDate: string;
      /** "quote" when a quote was fetched; else the engine's own valuation source (`trialValuationPrice`). */
      underlyingPriceSource: "quote" | "book" | "daily-bar" | "stored-price";
      /** "priced against the <date> close" (R2): set when no quote was used and the date is before previousTradingDay(today). */
      staleCloseDate: string | null;
      /** R4/P3 snapshot: account id → holdings of that exact security or contract now (accounts at 0 omitted). */
      holdingsAtAddByAccount: Record<number, number>;
      hasContractId: boolean;
    }
  | { ok: false; reason: TrialEntryRefusal; symbol: string };

function normSymbol(symbol: string): string {
  return (symbol ?? "").trim().toUpperCase();
}

/**
 * A trial position at the click (R1, R2, R10, P3, P11). The symbol must name
 * a non-option, US-dollar security the app already has. The underlying's
 * price is the quote's last price when one was fetched (`quotedUnderlyingPrice`,
 * dated today), else `trialValuationPrice`: the ONE rule the engine values the
 * trial with, so a trial accepted here is never refused later for want of a
 * price, and starts from the price the engine will use. An option needs an expiry not before today
 * (and not past today's close) and a price a volatility explains; that
 * volatility is recorded on the position and never solved again.
 */
export function buildTrialEntry(
  db: Database.Database,
  req: TrialEntryRequest,
  opts?: { today?: string; now?: Date },
): TrialEntryResult {
  const today = opts?.today ?? todayET();
  const now = opts?.now ?? new Date();
  const symbol = normSymbol(req.symbol);
  const refuse = (reason: TrialEntryRefusal): TrialEntryResult => ({ ok: false, reason, symbol });

  const found = lookupTrialSecurity(db, symbol, { today });
  if (found === null) {
    const optionOnly = db
      .prepare("SELECT security_type FROM securities WHERE UPPER(TRIM(symbol)) = ?")
      .all(symbol) as { security_type: string | null }[];
    return refuse(optionOnly.some((r) => isOptionSecurityType(r.security_type)) ? "is-an-option" : "unknown-symbol");
  }
  const check = checkTrialSecurity(db, found.securityId, { requireContractId: false });
  if (!check.ok) {
    // Not required here, so "no-contract-id" cannot arise; "not-found" cannot either (the lookup found it).
    return refuse(check.reason === "is-an-option" || check.reason === "foreign-currency" ? check.reason : "unknown-symbol");
  }

  if (req.kind === "option") {
    if (!isTrialCalendarDay(req.expiry)) return refuse("no-option-terms");
    // P11: a NEW entry needs an expiry not before today (and a contract still trading).
    // isExpiredAsOf is true for any day before today and for today after the 16:00 Eastern close.
    if (isExpiredAsOf(req.expiry, today, now)) return refuse("expired");
  }

  // R2: the underlying's price at the click.
  let underlyingPrice: number;
  let underlyingPriceDate: string;
  let underlyingPriceSource: "quote" | "book" | "daily-bar" | "stored-price";
  // The engine's own price for the name at the click: an option is marked relative to it.
  const valuation = trialValuationPrice(db, found.securityId, { today });
  if (valuation === null) return refuse("no-underlying-price");
  const quoted = req.kind === "option" ? req.quotedUnderlyingPrice : undefined;
  if (quoted !== undefined && Number.isFinite(quoted) && quoted > 0) {
    underlyingPrice = quoted;
    underlyingPriceDate = today;
    underlyingPriceSource = "quote";
  } else {
    underlyingPrice = valuation.price;
    underlyingPriceDate = valuation.date;
    underlyingPriceSource = valuation.source;
  }
  const staleCloseDate =
    underlyingPriceSource !== "quote" && underlyingPriceDate < previousTradingDay(today) ? underlyingPriceDate : null;

  let position: TrialPositionDraft;
  if (req.kind === "option") {
    const solved = solveTrialEntry({
      right: req.right,
      strike: req.strike,
      expiry: req.expiry,
      price: req.price,
      underlyingPrice,
      riskFreeRate: getRiskFreeRate(db),
      today,
      now,
    });
    if (!solved.ok) return refuse(solved.reason);
    position = {
      kind: "option",
      underlyingSecurityId: found.securityId,
      right: req.right,
      side: req.side,
      expiry: req.expiry,
      strike: req.strike,
      contracts: req.contracts,
      pricePaid: req.price,
      entryUnderlyingPrice: underlyingPrice,
      valuationPriceAtEntry: valuation.price,
      entryVolatility: solved.volatility,
    };
  } else {
    position = { kind: "shares", securityId: found.securityId, side: req.side, quantity: req.quantity, price: req.price };
  }

  return {
    ok: true,
    position,
    symbol: found.symbol,
    name: found.name,
    underlyingPrice,
    underlyingPriceDate,
    underlyingPriceSource,
    staleCloseDate,
    holdingsAtAddByAccount: trialHoldingsByAccount(db, position),
    hasContractId: found.hasContractId,
  };
}

// ─── Lookup and the route check (R10, P8, P9) ───────────────────

/**
 * A non-option security by its exact symbol (trimmed, upper-cased), with its
 * valuation price (`trialValuationPrice`: the price the engine marks a trial
 * against, so a share trial at this default price shows exactly zero; native
 * currency; null when the name has no price of any kind) and its priced daily bars in
 * [today - DAILY_BAR_WINDOW_DAYS, today) (P8). Several rows on one symbol:
 * one with a broker contract first, then the lowest id. Null when none.
 */
export function lookupTrialSecurity(
  db: Database.Database,
  symbol: string,
  opts?: { today?: string },
): {
  securityId: number;
  symbol: string;
  name: string | null;
  /** `trialValuationPrice` of the name; null when it has none. */
  price: number | null;
  priceDate: string | null;
  priceSource: "book" | "daily-bar" | "stored-price" | null;
  hasContractId: boolean;
  /** P8: priced daily bars in [today - DAILY_BAR_WINDOW_DAYS, today). */
  dailyBars: { count: number; through: string | null };
} | null {
  const key = normSymbol(symbol);
  if (key === "") return null;
  const today = opts?.today ?? todayET();
  const rows = db
    .prepare(
      `SELECT id, symbol, name, security_type, ib_con_id FROM securities
        WHERE UPPER(TRIM(symbol)) = ?
        ORDER BY (ib_con_id IS NULL) ASC, id ASC`,
    )
    .all(key) as { id: number; symbol: string; name: string | null; security_type: string | null; ib_con_id: number | null }[];
  const pick = rows.find((r) => !isOptionSecurityType(r.security_type));
  if (!pick) return null;
  const latest = trialValuationPrice(db, pick.id, { today });
  const barStats = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(bar_date) AS through FROM ohlcv_bars
        WHERE security_id = ? AND bar_size = '1 day' AND ${PRICED_BAR_SQL}
          AND bar_date >= ? AND bar_date < ?`,
    )
    .get(pick.id, addDays(today, -DAILY_BAR_WINDOW_DAYS), today) as { n: number; through: string | null };
  return {
    securityId: pick.id,
    symbol: pick.symbol,
    name: pick.name,
    price: latest ? latest.price : null,
    priceDate: latest ? latest.date : null,
    priceSource: latest ? latest.source : null,
    hasContractId: pick.ib_con_id !== null,
    dailyBars: { count: barStats.n, through: barStats.n > 0 ? barStats.through : null },
  };
}

export type TrialSecurityRefusal = "not-found" | "is-an-option" | "foreign-currency" | "no-contract-id";

/** P9: the one server-side check every trial route runs before a broker request or a write. */
export function checkTrialSecurity(
  db: Database.Database,
  securityId: number,
  opts: { requireContractId: boolean },
): { ok: true; symbol: string; ibConId: number | null } | { ok: false; reason: TrialSecurityRefusal } {
  if (!Number.isSafeInteger(securityId) || securityId <= 0) return { ok: false, reason: "not-found" };
  const row = db
    .prepare("SELECT symbol, security_type, currency, ib_con_id FROM securities WHERE id = ?")
    .get(securityId) as { symbol: string; security_type: string | null; currency: string | null; ib_con_id: number | null } | undefined;
  if (!row) return { ok: false, reason: "not-found" };
  if (isOptionSecurityType(row.security_type)) return { ok: false, reason: "is-an-option" };
  if (trialCurrency(row) !== "USD") return { ok: false, reason: "foreign-currency" };
  if (opts.requireContractId && row.ib_con_id === null) return { ok: false, reason: "no-contract-id" };
  return { ok: true, symbol: row.symbol, ibConId: row.ib_con_id };
}

// ─── Valuation (P2) ─────────────────────────────────────────────

/**
 * The valuation price of a name (controller ruling, fix round 1, replacing
 * the P2 wording). One name has one price in every stress scope, and the
 * entry reads this same function:
 *   (a) held in ANY account, as shares or as the underlying of a held live
 *       option: its latest stored `prices` row, the very row the position
 *       loader reads for the book's own rows (`own_price` / `underlying_price`),
 *       source "book";
 *   (b) else its latest priced daily bar close, source "daily-bar";
 *   (c) else its latest stored `prices` row with that row's date, source
 *       "stored-price".
 * A held name with no stored price falls to (b). None of the three: null
 * (refused `no-underlying-price`). Native currency.
 */
export function trialValuationPrice(
  db: Database.Database,
  securityId: number,
  opts?: { today?: string },
): GainsAtRiskTrialRow["valuation"] {
  const today = opts?.today ?? todayET();
  const sec = db.prepare("SELECT symbol FROM securities WHERE id = ?").get(securityId) as { symbol: string } | undefined;
  if (!sec) return null;
  const stored = db
    .prepare("SELECT close_price, date FROM prices WHERE security_id = ? ORDER BY date DESC LIMIT 1")
    .get(securityId) as { close_price: number; date: string } | undefined;
  const storedOk = stored !== undefined && stored.close_price != null && stored.close_price > 0;
  if (storedOk) {
    const held = db
      .prepare(
        `SELECT 1 AS held FROM holdings h
           JOIN securities s ON s.id = h.security_id
          WHERE ${latestHoldingsPredicate({ includeShorts: true })}
            AND ${liveOptionExpirationSql("s", today)}
            AND (h.security_id = ? OR (${OPTION_ROW_SQL} AND s.underlying_symbol = ?))
          LIMIT 1`,
      )
      .get(securityId, sec.symbol) as { held: number } | undefined;
    if (held) return { price: stored.close_price, date: stored.date, source: "book" };
  }
  const bar = getLatestDailyBar(db, securityId);
  if (bar) return { price: bar.close, date: bar.date, source: "daily-bar" };
  return storedOk ? { price: stored.close_price, date: stored.date, source: "stored-price" } : null;
}

// ─── Holdings (R4, P3) and shortfalls (P4) ──────────────────────

/**
 * R4/P3: account id → holdings now, every account, of that exact security
 * (shares) or contract (option: the underlying's symbol, put or call, strike,
 * expiry, and a multiplier of TRIAL_OPTION_MULTIPLIER or none stored).
 * Latest row per (account, security); accounts at 0 omitted.
 */
export function trialHoldingsByAccount(
  db: Database.Database,
  position: TrialPositionInput | TrialPositionDraft,
): Record<number, number> {
  let securityIds: number[];
  if (position.kind === "shares") {
    securityIds = [position.securityId];
  } else {
    const u = db.prepare("SELECT symbol FROM securities WHERE id = ?").get(position.underlyingSecurityId) as
      | { symbol: string }
      | undefined;
    if (!u) return {};
    const rows = db
      .prepare(
        `SELECT s.id, s.security_type FROM securities s
          WHERE UPPER(TRIM(s.underlying_symbol)) = ?
            AND UPPER(TRIM(s.option_type)) LIKE ?
            AND s.strike_price = ?
            AND (${optionExpirationDashedSql("s.expiration_date")}) = ?
            AND (s.multiplier IS NULL OR s.multiplier = ?)`,
      )
      .all(
        normSymbol(u.symbol),
        position.right === "put" ? "P%" : "C%",
        position.strike,
        normalizeOptionExpiration(position.expiry),
        TRIAL_OPTION_MULTIPLIER,
      ) as { id: number; security_type: string | null }[];
    securityIds = rows.filter((r) => isOptionSecurityType(r.security_type)).map((r) => r.id);
  }
  if (securityIds.length === 0) return {};
  const held = db
    .prepare(
      `SELECT h.account_id AS account_id, SUM(h.quantity) AS qty
         FROM holdings h
        WHERE ${latestHoldingsPredicate({ includeShorts: true })}
          AND h.security_id IN (${securityIds.map(() => "?").join(", ")})
        GROUP BY h.account_id
        ORDER BY h.account_id`,
    )
    .all(...securityIds) as { account_id: number; qty: number }[];
  const out: Record<number, number> = {};
  for (const h of held) if (h.qty !== 0) out[h.account_id] = h.qty;
  return out;
}

/**
 * P4: per sale row in list order, and per name.
 *
 * For each name: every account's holding plus ALL trial buys of it (wherever
 * they sit in the list), less its trial sales taken in list order. A sale's
 * figure is the part of it the running holding cannot cover (0 when covered).
 * `byName` holds each name the trial sales leave short, with the part the
 * trial positions cause: the sum of its per-sale figures (a short held before
 * any trial is not in it; the engine reports that apart). Option rows are
 * ignored.
 */
export function trialShortfalls(
  positions: TrialPositionInput[],
  heldBySecurity: Map<number, number>,
): { bySaleId: Map<string, number>; byName: Map<number, number> } {
  const running = new Map<number, number>();
  for (const p of positions) {
    if (p.kind !== "shares") continue;
    if (!running.has(p.securityId)) running.set(p.securityId, heldBySecurity.get(p.securityId) ?? 0);
    if (p.side === "buy") running.set(p.securityId, (running.get(p.securityId) as number) + p.quantity);
  }
  const bySaleId = new Map<string, number>();
  const caused = new Map<number, number>();
  for (const p of positions) {
    if (p.kind !== "shares" || p.side !== "sell") continue;
    const before = running.get(p.securityId) as number;
    const uncovered = Math.max(0, p.quantity - Math.max(before, 0));
    bySaleId.set(p.id, uncovered);
    running.set(p.securityId, before - p.quantity);
    caused.set(p.securityId, (caused.get(p.securityId) ?? 0) + uncovered);
  }
  const byName = new Map<number, number>();
  for (const [id, n] of caused) if (n > 0) byName.set(id, n);
  return { bySaleId, byName };
}

// ─── The crossing (P5) ──────────────────────────────────────────

/**
 * P5: over the moves at or below 0, by deepening fall; "better" = trial
 * total > 0 (exactly 0 is not better). A boundary between two points is
 * found by linear interpolation of the trial total to 0; a point at exactly 0
 * is itself the boundary. No move at or below 0, or every total exactly 0:
 * `no-trial-effect`.
 */
export function trialCrossing(moves: number[], trialPnlByMove: number[]): GainsAtRiskTrialCrossing {
  const pts = moves
    .map((move, i) => ({ move, pnl: trialPnlByMove[i], i }))
    .filter((p) => p.move <= 0)
    .sort((a, b) => b.move - a.move || a.i - b.i);
  if (pts.length === 0 || pts.every((p) => p.pnl === 0)) return { kind: "no-trial-effect" };
  const better = pts.map((p) => p.pnl > 0);
  if (better.every(Boolean)) return { kind: "better-at-every-move" };
  if (!better.some(Boolean)) return { kind: "worse-at-every-move", deepestMove: pts[pts.length - 1].move };

  /** The boundary between point j and j + 1 (their sides differ). */
  const boundary = (j: number): number => {
    const a = pts[j];
    const b = pts[j + 1];
    if (a.pnl === 0) return a.move;
    if (b.pnl === 0) return b.move;
    return a.move + ((0 - a.pnl) / (b.pnl - a.pnl)) * (b.move - a.move);
  };
  const changes: number[] = [];
  for (let j = 0; j + 1 < pts.length; j++) if (better[j] !== better[j + 1]) changes.push(j);

  if (changes.length === 1) {
    const at = boundary(changes[0]);
    return better[0] ? { kind: "helps-until", move: at } : { kind: "pays-beyond", move: at };
  }
  // More than one change: the first interval that helps.
  if (better[0]) return { kind: "changes-more-than-once", firstHelpFrom: pts[0].move, firstHelpTo: boundary(changes[0]) };
  return { kind: "changes-more-than-once", firstHelpFrom: boundary(changes[0]), firstHelpTo: boundary(changes[1]) };
}
