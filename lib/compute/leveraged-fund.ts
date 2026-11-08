/**
 * Leveraged and inverse funds in scenarios and the What-if (owner ruling
 * 2026-11-01, item 2: stopgap "B").
 *
 * A daily-reset leveraged or inverse fund does not move as a linear multiple
 * of its index over a multi-day shock, and the scenario engines had no sign
 * or multiple for it: a 3x inverse fund was marked DOWN when its index fell.
 * Until a signed leverage factor is stored per security (a later build), such
 * a fund takes no figure in either scenario engine and is named and counted,
 * and the What-if leaves it out of its beta, sector and factor buckets.
 *
 * THE RULE (`isLeveragedOrInverseFund` for a security on its own, and
 * `isLeveragedOrInverseExposure` for a held row, which every engine calls):
 *   1. Only a stock, ETF or mutual fund row can match on its own fields. An
 *      option matches through its UNDERLYING: an option whose underlying is
 *      such a fund is treated exactly like the fund (QA 2026-11-03: a call on
 *      a 2x crude fund was repriced off a 1x move). A bond never matches. A
 *      stock type is accepted because IBKR labels every STK contract
 *      'Stock', ETFs included.
 *   2. A fund category containing the word "leveraged" or "inverse"
 *      (case-insensitive) matches: "Leveraged/Inverse", "Leveraged Equity",
 *      "Leveraged ETF", "Leveraged/Inverse (Commodities)".
 *   3. Otherwise the name decides. Strong markers apply to every accepted
 *      type: a leverage token of its own ("2X", "3X", "-1X"), or the whole
 *      words ULTRAPRO, ULTRASHORT or INVERSE.
 *   4. Weak markers apply only when the row is fund-typed (ETF / mutual
 *      fund) or carries a non-empty fund category: the whole word ULTRA,
 *      and the Direxion abbreviation "DAI / DAIL / DAILY ... BULL / BEAR /
 *      BU / BE". A plain 'Stock' row with no category never matches on them,
 *      so an operating company named "Ultra ..." or "... Bear ..." is safe.
 *
 * THE FACTOR (theme T2 durable build, 2026-11-07). A flagged row may also
 * carry a signed multiple in `securities.leverage_factor` (+3 for a 3x bull
 * fund, -3 for a 3x bear fund), derived by the enrichment rule in
 * `lib/securities/leverage-factor.ts`. `resolveLeveragedExposure` is the one
 * reader every engine calls: it answers whether the row is flagged AND, when
 * it is, the factor to multiply the tracked thing's move by. A flagged row
 * with a NULL (or unusable) factor keeps the stopgap behaviour exactly — no
 * figure in either scenario engine, out of the What-if buckets, out of the
 * hedge book — so "not modelled" shrinks to the rows nothing could sign.
 *
 * Pure helpers, shared by both scenario engines and the What-if engine. The
 * one import (`isOptionSecurityType`) comes from an import-free module.
 */

import { isOptionSecurityType } from "./option-elasticity";

export const LEVERAGED_FUND_UNMODELLED_LABEL =
  "leveraged or inverse fund, or an option on one, with no stored leverage factor: not modelled (no sign and no multiple to apply)";

function normalizedType(securityType: string | null | undefined): string {
  return (securityType ?? "").trim().toLowerCase();
}

const FUND_FAMILY_TYPES = new Set(["etf", "mutual fund", "mutual_fund"]);
const ACCEPTED_TYPES = new Set(["stock", ...FUND_FAMILY_TYPES]);

const LEVERAGED_CATEGORY = /\b(leveraged|inverse)\b/i;
/** A leverage token standing on its own: "2X", "3x", "-1X" (never "13X" or "X2"). */
const LEVERAGE_TOKEN = /(?<![\w.-])-?[1-3]X(?![\w])/i;
const STRONG_WORDS = /\b(ULTRAPRO|ULTRASHORT|INVERSE)\b/i;
const WEAK_ULTRA = /\bULTRA\b/i;
/** Direxion's abbreviated names, e.g. "DIREX DAIL SEMI BU", "DAILY ... BEAR". */
const DIREXION_DAILY = /\bDAI(?:L|LY)?\b.*\b(BULL|BEAR|BU|BE)\b/i;

/**
 * True for a stock-, ETF- or mutual-fund-typed security whose fund category
 * or name marks it as a leveraged or inverse fund (see the rule above).
 */
export function isLeveragedOrInverseFund(sec: {
  security_type: string | null;
  fund_category: string | null;
  name: string | null;
}): boolean {
  const type = normalizedType(sec.security_type);
  if (!ACCEPTED_TYPES.has(type)) return false;
  const category = (sec.fund_category ?? "").trim();
  if (LEVERAGED_CATEGORY.test(category)) return true;
  const name = sec.name ?? "";
  if (LEVERAGE_TOKEN.test(name) || STRONG_WORDS.test(name)) return true;
  const weakApplies = FUND_FAMILY_TYPES.has(type) || category.length > 0;
  return weakApplies && (WEAK_ULTRA.test(name) || DIREXION_DAILY.test(name));
}

type SecurityIdentity = {
  security_type: string | null;
  fund_category: string | null;
  name: string | null;
};

/**
 * The reader every engine calls for a held or hypothetical row: true when
 * the row is itself a leveraged or inverse fund, or when it is an option and
 * its underlying (null when unknown or not an option) is one. Only an option
 * looks through to an underlying; a stock or bond row never does.
 */
export function isLeveragedOrInverseExposure(
  sec: SecurityIdentity,
  underlying: SecurityIdentity | null,
): boolean {
  return resolveLeveragedExposure(sec, underlying).flagged;
}

/**
 * The disclosure on a scenario result: how many leveraged or inverse funds
 * were left out, their share of the book's gross value, and their symbols
 * (sorted). Reporting only; no figure reads it.
 */
export function summarizeUnmodelledLeveragedFunds(
  rows: Array<{ symbol: string; currentValue: number; leveragedFundUnmodelled?: boolean }>,
): { count: number; valueShare: number; symbols: string[] } {
  let total = 0;
  let flagged = 0;
  const symbols: string[] = [];
  for (const row of rows) {
    const value = Math.abs(row.currentValue);
    total += value;
    if (row.leveragedFundUnmodelled) {
      flagged += value;
      symbols.push(row.symbol);
    }
  }
  symbols.sort();
  return { count: symbols.length, valueShare: total > 0 ? flagged / total : 0, symbols };
}

/**
 * The largest multiple any listed leveraged fund states. A stored figure
 * outside ±this, zero, or non-finite is unusable: the row falls back to the
 * stopgap rather than carrying a figure no rule would have written. This
 * reader never throws on stored data.
 */
const MAX_LEVERAGE_MAGNITUDE = 5;

/** The stored factor if it is usable, else null. */
export function normalizeLeverageFactor(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value === 0 || Math.abs(value) > MAX_LEVERAGE_MAGNITUDE) return null;
  return value;
}

type FactoredIdentity = SecurityIdentity & { leverage_factor?: number | null };

export type LeveragedExposure =
  /** Not a leveraged or inverse fund, and not an option on one: model it normally. */
  | { flagged: false; factor: null }
  /**
   * A leveraged or inverse fund, or an option on one. `factor` is the signed
   * multiple to apply to the tracked thing's move, or null when the row
   * carries none — and a null factor means the stopgap: no figure at all.
   */
  | { flagged: true; factor: number | null };

const NOT_FLAGGED: LeveragedExposure = { flagged: false, factor: null };

/**
 * The ONE reader every engine calls for a held or hypothetical row. An option
 * looks through to its UNDERLYING for both the flag and the factor (QA
 * 2026-11-03: a call on a 2x crude fund was repriced off a 1x move); a stock
 * or bond row never does.
 */
export function resolveLeveragedExposure(
  sec: FactoredIdentity,
  underlying: FactoredIdentity | null,
): LeveragedExposure {
  if (isLeveragedOrInverseFund(sec)) {
    return { flagged: true, factor: normalizeLeverageFactor(sec.leverage_factor) };
  }
  if (isOptionSecurityType(sec.security_type) && underlying !== null && isLeveragedOrInverseFund(underlying)) {
    return { flagged: true, factor: normalizeLeverageFactor(underlying.leverage_factor) };
  }
  return NOT_FLAGGED;
}
