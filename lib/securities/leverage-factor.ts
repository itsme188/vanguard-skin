/**
 * The signed leverage factor of a leveraged or inverse fund (theme T2, the
 * durable build behind the 2026-11-01 stopgap; sign table approved by the
 * owner 2026-11-07).
 *
 * The stopgap could only NAME such a fund. `securities.leverage_factor`
 * (migration 102) stores the multiple the fund itself states, SIGNED: +3 for
 * a 3x bull fund, -3 for a 3x bear fund. Every reader multiplies the move of
 * the thing the fund tracks by that factor; a NULL keeps the stopgap
 * behaviour for that row (not modelled, named and counted).
 *
 * THE RULE. Only a row `isLeveragedOrInverseFund` already matches can get a
 * factor — the flag rule in `lib/compute/leveraged-fund.ts` stays the single
 * flag source, and this module never forks it. For a flagged row:
 *
 *   MAGNITUDE, from the name, first match wins:
 *     1. a standalone leverage token — "2X", "3x", "-1X" (never "DOW30",
 *        never "X2"): its digit;
 *     2. the ProShares house words, which state the multiple in prose:
 *        ULTRAPRO = 3x, ULTRASHORT = 2x, ULTRA = 2x. (UltraProShort reads
 *        as ULTRAPRO, magnitude 3, and takes its sign from SHORT below.)
 *   No magnitude means no factor: the row stays NULL and keeps the stopgap.
 *
 *   SIGN: negative when the name carries an inverse marker — INVERSE,
 *   SHORT/SHRT, BEAR, Direxion's abbreviated BE, ULTRASHORT, or a leverage
 *   token written with a leading minus. Positive otherwise. An inverse fund
 *   always says so in its name (that is the whole point of the name); a bull
 *   fund often says nothing, so positive is the default and the asymmetry is
 *   deliberate.
 *
 *   SEEDS: a flagged row whose stored fields carry no multiple at all (TBT's
 *   `securities.name` is blank) takes its factor from `LEVERAGE_FACTOR_SEEDS`,
 *   by ticker identity, from the owner's hand-check. The seed is consulted
 *   only AFTER the name rule finds nothing, so a name that later arrives
 *   takes over — and for TBT it agrees ("UltraShort 20+ Year Treasury" reads
 *   as -2 by the rule above).
 *
 * The fund category ("Leveraged/Inverse") states neither a multiple nor a
 * direction, so it is never read for either; it only ever flags.
 *
 * Pure derivation lives here; the database pass that writes the column lives
 * in `apply-leverage-factors.ts` beside it.
 */

import { isLeveragedOrInverseFund } from "@/lib/compute/leveraged-fund";

/**
 * Hand-checked factors for flagged funds whose stored fields state no
 * multiple (owner approval 2026-11-07). Keyed by symbol, consulted only when
 * the name rule derives nothing. Add an entry only with the owner's word on
 * that fund's factor.
 *
 *   TBT -- ProShares UltraShort 20+ Year Treasury, -2x. Its
 *          `securities.name` is blank in the live table, so the row states no
 *          multiple and no direction.
 */
export const LEVERAGE_FACTOR_SEEDS: Readonly<Record<string, number>> = Object.freeze({
  TBT: -2,
});

/** A standalone leverage token: "2X", "3x", "-1X" — never "DOW30", never "X2". */
const LEVERAGE_TOKEN = /(?<![\w.])(-?)([1-3])X(?![\w])/i;
/** ProShares states the multiple in prose. Longest word first. */
const HOUSE_MAGNITUDES: Array<[RegExp, number]> = [
  [/\bULTRAPRO\b/i, 3],
  [/\bULTRASHORT\b/i, 2],
  [/\bULTRA\b/i, 2],
];
/** An inverse fund always names itself. Direxion abbreviates "bear" to "BE". */
const INVERSE_MARKERS = /\b(INVERSE|SHORT|SHRT|BEAR|BE|ULTRASHORT)\b/i;

export type LeverageFactorDerivation =
  | { factor: number; source: "name" | "seed"; reason?: undefined }
  /** No factor: the row keeps the stopgap behaviour (not modelled). */
  | { factor: null; source: null; reason: "not_flagged" | "no_multiple" };

export type LeverageFactorIdentity = {
  symbol: string;
  security_type: string | null;
  fund_category: string | null;
  name: string | null;
};

/**
 * The one rule. Returns the signed factor for a flagged fund, or a null
 * factor with the reason it has none.
 */
export function deriveLeverageFactor(sec: LeverageFactorIdentity): LeverageFactorDerivation {
  if (!isLeveragedOrInverseFund(sec)) {
    return { factor: null, source: null, reason: "not_flagged" };
  }
  const name = sec.name ?? "";
  const token = LEVERAGE_TOKEN.exec(name);
  let magnitude: number | null = token ? Number(token[2]) : null;
  // A token written "-3X" states its own direction.
  let negative = token ? token[1] === "-" : false;
  if (magnitude === null) {
    for (const [pattern, value] of HOUSE_MAGNITUDES) {
      if (pattern.test(name)) {
        magnitude = value;
        break;
      }
    }
  }
  if (magnitude === null) {
    const seeded = LEVERAGE_FACTOR_SEEDS[sec.symbol.trim().toUpperCase()];
    if (typeof seeded === "number" && Number.isFinite(seeded) && seeded !== 0) {
      return { factor: seeded, source: "seed" };
    }
    return { factor: null, source: null, reason: "no_multiple" };
  }
  if (INVERSE_MARKERS.test(name)) negative = true;
  return { factor: negative ? -magnitude : magnitude, source: "name" };
}
