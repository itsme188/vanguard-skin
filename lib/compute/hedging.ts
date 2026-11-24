import type Database from "better-sqlite3";
import { unmaturedSecuritySql } from "@/lib/db/eastern-day-sql";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { accountScopeAndSql } from "@/lib/queries/account-scope-sql";
import { computePortfolioGreeks, exposureDelta, type GreeksDiagnostic } from "@/lib/compute/options-greeks";
import {
  optionExposureFallback,
  HOLDING_VALUE_USD_SQL,
  exposureNameKey,
  nameNettedExposure,
  underlyingSecurityIdSql,
} from "@/lib/compute/exposure";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { getEtfSectorWeights } from "@/lib/queries/etf-weights";
import { getConcentrationUniverse, splitConcentrationUniverse } from "@/lib/queries/concentration-universe";
import { explodeHoldingBySector } from "@/lib/compute/explode-sector";
import { betaConfidenceVerdict, MIN_BETA_PAIRS } from "@/lib/compute/beta-confidence";
import { liveOptionExpirationSql } from "@/lib/compute/option-expiry";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import {
  normalizeLeverageFactor,
  resolveLeveragedExposure,
  summarizeUnmodelledLeveragedFunds,
} from "@/lib/compute/leveraged-fund";
import { normalizeSector, GICS_SECTORS } from "@/lib/securities/normalize-sector";
import {
  normalizeFundCategory,
  isBondFundCategory,
  isLeveragedInverseFundCategory,
} from "@/lib/securities/normalize-fund-category";

/**
 * Defense/Hedging engine — classifies the book into hedged pairs (Tier 1),
 * proxy protection (Tier 2), amplifiers, and standalone bets, then scores
 * every hedge. Spec: docs/superpowers/specs/2026-07-05-defense-hedging-tab-design.md
 *
 * All classification runs on SIGNED delta-notional exposure (stocks at MV,
 * options at Δ·S·mult·qty). Sign rules generalize: any negative-exposure
 * instrument on an ETF with no long core is portfolio protection; on a
 * non-held single name it is a directional bet.
 */

// ─── Badge thresholds (Task 4 consumes; single tunable home) ────────
export const HEDGE_BADGE_THRESHOLDS = {
  EXPIRING_DAYS: 30,
  DECAYED_OTM_PCT: 0.2,
  DECAYED_RUNWAY_DAYS: 45,
  EXPENSIVE_MONTHLY_BLEED_PCT: 0.03,
  DEEP_ITM_ABS_DELTA: 0.8,
} as const;

export interface DefenseInstrument {
  securityId: number;
  symbol: string;
  /** issuerSiblings-canonical underlying (self for stock/ETF). */
  underlying: string;
  isOption: boolean;
  optionType: "CALL" | "PUT" | null;
  quantity: number; // signed
  /** Signed delta-notional USD. */
  exposure: number;
  /** Signed USD market value. */
  marketValue: number;
  underlyingIsEtf: boolean;
  sector: string | null;
  geography: string | null;
  greeksAvailable: boolean;
  // Option detail for scoring (Task 4); absent on shares.
  strike?: number;
  expiration?: string;
  daysToExpiry?: number;
  /** Daily theta in dollars for the whole position (negative = decay). */
  thetaPerDay?: number | null;
  /**
   * Per-contract delta. When a scope holds the contract in several accounts
   * this is the contract-weighted average across them (never "last account
   * wins").
   */
  delta?: number | null;
  /**
   * Where the volatility behind `delta` came from (options-greeks.ts):
   * "computed" (solved from the option's own price) and "ibkr" (the broker's
   * volatility for the underlying) are real market figures; "default" is the
   * assumed fallback volatility. Across several accounts the weakest source
   * is kept. Absent on shares and on options with no Greeks.
   */
  ivSource?: OptionVolSource;
  underlyingPrice?: number;
}

export type OptionVolSource = "computed" | "ibkr" | "default";

/** Row text for a call whose delta clears the bar only on the assumed volatility. */
export const ASSUMED_VOL_NOT_STOCK_NOTE = "delta from assumed volatility: not counted as stock";
/** Row text for a call whose delta clears the bar but has no volatility source at all. */
export const NO_VOL_SOURCE_NOT_STOCK_NOTE = "delta has no volatility source: not counted as stock";
/** Row text for a core that includes a deep in-the-money call. */
export const DEEP_CALL_COUNTED_NOTE = "deep in-the-money call counted as stock (delta-weighted)";

export interface StockEquivalentVerdict {
  /** True when the instrument joins the core as share-equivalents. */
  counts: boolean;
  /** Set only when the call clears the delta bar but is refused. */
  refusedReason: string | null;
}

/**
 * Owner ruling 2026-10-08: a LONG call with |delta| >= DEEP_ITM_ABS_DELTA is
 * economically stock (contracts x multiplier x delta shares) and counts as a
 * core holding, so a put against it is a hedge. Only a delta from a REAL
 * volatility counts: one computed from the assumed default volatility is
 * refused, with the reason carried to the row. A delta with no volatility
 * source at all is refused the same way, with its own reason (it used to be
 * refused silently). A null delta, a short call and every put never count.
 */
export function stockEquivalentVerdict(i: DefenseInstrument): StockEquivalentVerdict {
  const no: StockEquivalentVerdict = { counts: false, refusedReason: null };
  if (!i.isOption || i.optionType !== "CALL") return no;
  if (!(i.quantity > 0) || !(i.exposure > 0)) return no;
  if (!i.greeksAvailable) return no;
  if (typeof i.delta !== "number" || !Number.isFinite(i.delta)) return no;
  if (Math.abs(i.delta) < HEDGE_BADGE_THRESHOLDS.DEEP_ITM_ABS_DELTA) return no;
  if (i.ivSource === "computed" || i.ivSource === "ibkr") return { counts: true, refusedReason: null };
  if (i.ivSource === "default") return { counts: false, refusedReason: ASSUMED_VOL_NOT_STOCK_NOTE };
  return { counts: false, refusedReason: NO_VOL_SOURCE_NOT_STOCK_NOTE };
}

/**
 * An option that hedges a SHORT core: held long (quantity > 0) with positive
 * exposure, i.e. a long call. A written put has positive exposure too but is
 * income, not protection, so it never qualifies.
 */
function isShortCoreHedge(o: DefenseInstrument): boolean {
  return o.isOption && o.quantity > 0 && o.exposure > 0;
}

/**
 * The instruments of a pair that are scored in the hedge book. For a long
 * core: options with negative exposure (unchanged; see the TODO in
 * classifyBook about written calls). For a short core: long calls only, the
 * same rule classifyBook used to build the pair's offset.
 */
export function pairHedgeInstruments(pair: UnderlyingPair): DefenseInstrument[] {
  const coreSign = Math.sign(pair.coreExposure);
  if (coreSign < 0) return pair.instruments.filter(isShortCoreHedge);
  return pair.instruments.filter((i) => i.isOption && Math.sign(i.exposure) === -coreSign);
}

/** A long option with negative exposure: a long put. */
function isLongPutLeg(o: DefenseInstrument): boolean {
  return o.isOption && o.quantity > 0 && o.exposure < 0;
}

/** A written option with positive exposure: a written put. */
function isWrittenPutLeg(o: DefenseInstrument): boolean {
  return o.isOption && o.quantity < 0 && o.exposure > 0;
}

/**
 * The instruments of a proxy candidate that are scored in the hedge book:
 * those with negative exposure. On an ETF candidate (`etf_negative_stack`,
 * `no_core_etf`) only short shares and long puts qualify: a written call
 * (negative exposure, but only its premium in a crash) is left out, the same
 * way classifyBook leaves it out of the protective notional. `tier1_spill`
 * is unchanged (see the covered-call TODO in classifyBook).
 */
export function proxyHedgeInstruments(candidate: ProxyCandidate): DefenseInstrument[] {
  const protective = candidate.instruments.filter((inst) => inst.exposure < 0);
  if (candidate.source === "tier1_spill") return protective;
  return protective.filter((inst) => !inst.isOption || isLongPutLeg(inst));
}

export interface UnderlyingGroup {
  underlying: string;
  underlyingIsEtf: boolean;
  instruments: DefenseInstrument[];
}

export type PairClassification =
  | "hedged_long"
  | "hedged_short"
  | "amplified"
  | "unhedged"
  | "speculative";

export interface UnderlyingPair {
  underlying: string;
  classification: PairClassification;
  coreExposure: number;
  /** Σ opposing-option exposure magnitude, uncapped. */
  offsetExposure: number;
  /** min(offsetExposure, |core|) — what actually counts as hedged. */
  offsetCredited: number;
  amplifierExposure: number;
  hasAmplifiers: boolean;
  netExposure: number;
  /** offsetCredited / |core|; null when core === 0. */
  coveragePct: number | null;
  sector: string | null;
  instruments: DefenseInstrument[];
  /**
   * The part of `coreExposure` that comes from deep in-the-money long calls
   * counted as stock (see stockEquivalentVerdict). Absent when none.
   */
  stockEquivalentExposure?: number;
  /** Short plain-language caveats for the row. Absent when none. */
  notes?: string[];
}

export interface ProxyCandidate {
  underlying: string;
  protectiveNotional: number; // positive magnitude
  source: "no_core_etf" | "etf_negative_stack" | "tier1_spill";
  instruments: DefenseInstrument[];
}

/**
 * What makes a standalone bet bearish. The three option kinds are named for
 * the legs with negative exposure, so a call is never labelled a put:
 *   - `single_name_put`: every bearish leg is a put;
 *   - `single_name_short_call`: every bearish leg is a short call;
 *   - `single_name_bearish_options`: both (a long put with a short call).
 * `etf_bearish_options` is an ETF's options (or a short ETF stack outweighed
 * by written puts) that net bearish without being protection: a written ETF
 * call is open-ended risk in a rally, not a hedge.
 * `naked_short` is short shares with no option on the same name.
 * `short_with_bearish_options` is short shares plus bearish options on the
 * same name (long puts, written calls): the options add to the bet, and
 * nothing protects against a rally (owner ruling 2026-11-15, K4e).
 */
export type StandaloneBetKind =
  | "single_name_put"
  | "single_name_short_call"
  | "single_name_bearish_options"
  | "etf_bearish_options"
  | "naked_short"
  | "short_with_bearish_options";

/** Row text for short shares that carry bearish options on the same name. */
export function shortWithBearishOptionsNote(bearishLegs: DefenseInstrument[]): string {
  const kind = bearishOptionKind(bearishLegs);
  const legs =
    kind === "single_name_put" ? "long puts" : kind === "single_name_short_call" ? "written calls" : "puts and written calls";
  return `Short shares plus ${legs} on the same name: both gain in a fall, and nothing protects against a rally`;
}

/** The option kind for a set of bearish (negative-exposure) option legs. */
function bearishOptionKind(
  bearishLegs: DefenseInstrument[],
): Exclude<StandaloneBetKind, "naked_short" | "etf_bearish_options" | "short_with_bearish_options"> {
  const calls = bearishLegs.filter((o) => (o.optionType ?? "").toUpperCase() === "CALL").length;
  // No bearish leg at all, or a leg of unknown type, keeps the kind it had.
  if (calls === 0) return "single_name_put";
  return calls === bearishLegs.length ? "single_name_short_call" : "single_name_bearish_options";
}

export interface StandaloneBet {
  underlying: string;
  exposure: number; // signed (negative)
  kind: StandaloneBetKind;
  instruments: DefenseInstrument[];
  /** Short plain-language caveats for the row. Absent when none. */
  notes?: string[];
}

export interface ClassifyResult {
  pairs: UnderlyingPair[];
  proxyCandidates: ProxyCandidate[];
  standaloneBets: StandaloneBet[];
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function classifyBook(groups: Map<string, UnderlyingGroup>): ClassifyResult {
  const pairs: UnderlyingPair[] = [];
  const proxyCandidates: ProxyCandidate[] = [];
  const standaloneBets: StandaloneBet[] = [];

  for (const g of groups.values()) {
    const shareCore = sum(g.instruments.filter((i) => !i.isOption).map((i) => i.exposure));
    const allOptions = g.instruments.filter((i) => i.isOption);
    const netExposure = sum(g.instruments.map((i) => i.exposure));
    const sector = g.instruments.find((i) => i.sector)?.sector ?? null;

    // Deep in-the-money long calls count as stock (owner ruling 2026-10-08),
    // delta-weighted: the instrument's exposure is already
    // contracts x multiplier x delta x price. They join the core only when
    // the shares are long or absent. Against SHORT shares a long call is the
    // hedge of that short, and folding it into the core would hide the hedge.
    const stockEquivalents: DefenseInstrument[] = [];
    const notes: string[] = [];
    for (const o of allOptions) {
      const verdict = stockEquivalentVerdict(o);
      if (verdict.counts && shareCore >= 0) stockEquivalents.push(o);
      else if (verdict.refusedReason && shareCore >= 0 && !notes.includes(verdict.refusedReason)) {
        notes.push(verdict.refusedReason);
      }
    }
    const stockEquivalentExposure = sum(stockEquivalents.map((o) => o.exposure));
    if (stockEquivalents.length > 0) notes.push(DEEP_CALL_COUNTED_NOTE);
    const core = shareCore + stockEquivalentExposure;
    const options = allOptions.filter((o) => !stockEquivalents.includes(o));
    const extras = {
      ...(stockEquivalents.length > 0 ? { stockEquivalentExposure } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    };

    // Legs left over once protection is taken out get ONE row, so every
    // instrument lands in exactly one row: net bearish = a standalone bet of
    // `bearishKind`; otherwise a speculative row (the book's net-long row).
    const pushRemainderRow = (
      legs: DefenseInstrument[],
      coreExposure: number,
      bearishKind: StandaloneBetKind,
    ) => {
      if (legs.length === 0) return;
      const net = sum(legs.map((o) => o.exposure));
      if (net < 0) {
        standaloneBets.push({
          underlying: g.underlying,
          exposure: net,
          kind: bearishKind,
          instruments: legs,
          ...(notes.length > 0 ? { notes } : {}),
        });
        return;
      }
      const bullishLegs = legs.filter((o) => o.isOption && o.exposure > 0);
      pairs.push({
        underlying: g.underlying,
        classification: "speculative",
        coreExposure,
        offsetExposure: 0,
        offsetCredited: 0,
        amplifierExposure: sum(bullishLegs.map((o) => o.exposure)),
        hasAmplifiers: bullishLegs.length > 0,
        netExposure: net,
        coveragePct: null,
        sector,
        instruments: legs,
        ...extras,
      });
    };

    if (core > 0) {
      // TODO (owner ruling needed): a written call against a long core is credited as a hedge the same way
      const opposing = options.filter((o) => o.exposure < 0);
      const amplifying = options.filter((o) => o.exposure > 0);
      const offsetExposure = Math.abs(sum(opposing.map((o) => o.exposure)));
      const offsetCredited = Math.min(offsetExposure, core);
      const excess = offsetExposure - offsetCredited;
      if (excess > 0 && g.underlyingIsEtf) {
        proxyCandidates.push({
          underlying: g.underlying,
          protectiveNotional: excess,
          source: "tier1_spill",
          instruments: opposing,
        });
      }
      pairs.push({
        underlying: g.underlying,
        classification:
          opposing.length > 0 ? "hedged_long" : amplifying.length > 0 ? "amplified" : "unhedged",
        coreExposure: core,
        offsetExposure,
        offsetCredited,
        amplifierExposure: sum(amplifying.map((o) => o.exposure)),
        hasAmplifiers: amplifying.length > 0,
        netExposure,
        coveragePct: offsetCredited / core,
        sector,
        instruments: g.instruments,
        ...extras,
      });
      continue;
    }

    if (core < 0) {
      // Only an option the account is LONG with positive exposure (a long
      // call) hedges a short core. A WRITTEN put also has positive delta
      // exposure, but it is income (a covered put): if the stock rallies the
      // short loses and the put only pays its premium. It is neither opposing
      // nor an amplifier here; it stays in `g.instruments` (so it still lists
      // under the underlying) and its exposure stays in `netExposure`, which
      // sums every instrument because that is the position's true delta.
      const opposing = options.filter(isShortCoreHedge);
      const sameSign = options.filter((o) => o.exposure < 0);
      if (g.underlyingIsEtf) {
        // Negative ETF stack = portfolio protection, judged in a crash: the
        // short core and every LONG put gain; a WRITTEN put loses as prices
        // fall, so its delta comes off. Calls are neither credited nor
        // subtracted: a long call expires worthless in a crash and a written
        // call only keeps its premium. Floored at 0: a written put larger
        // than the stack leaves no protection, and the group then shows as
        // its net row instead of vanishing.
        const longPuts = options.filter(isLongPutLeg);
        const writtenPuts = options.filter(isWrittenPutLeg);
        const notional = Math.max(
          0,
          Math.abs(core) +
            Math.abs(sum(longPuts.map((o) => o.exposure))) -
            sum(writtenPuts.map((o) => o.exposure)),
        );
        if (notional > 0) {
          proxyCandidates.push({
            underlying: g.underlying,
            protectiveNotional: notional,
            source: "etf_negative_stack",
            instruments: g.instruments,
          });
        } else {
          pushRemainderRow(g.instruments, core, "etf_bearish_options");
        }
        continue;
      }
      if (opposing.length > 0) {
        const offsetExposure = sum(opposing.map((o) => o.exposure));
        const offsetCredited = Math.min(offsetExposure, Math.abs(core));
        pairs.push({
          underlying: g.underlying,
          classification: "hedged_short",
          coreExposure: core,
          offsetExposure,
          offsetCredited,
          amplifierExposure: sum(sameSign.map((o) => o.exposure)),
          hasAmplifiers: sameSign.length > 0,
          netExposure,
          coveragePct: offsetCredited / Math.abs(core),
          sector,
          instruments: g.instruments,
        });
      } else if (netExposure < 0) {
        // Bearish options beside the short (a long put, a written call) are
        // not a hedge of it: they gain in a fall too. Say so instead of
        // calling the short "naked" (owner ruling 2026-11-15, K4e).
        const bearishLegs = options.filter((o) => o.exposure < 0);
        standaloneBets.push({
          underlying: g.underlying,
          exposure: netExposure,
          kind: bearishLegs.length > 0 ? "short_with_bearish_options" : "naked_short",
          instruments: g.instruments,
          ...(bearishLegs.length > 0 ? { notes: [shortWithBearishOptionsNote(bearishLegs)] } : {}),
        });
      } else {
        // Written puts outweigh the short: the group is net long, so it is
        // not a naked short. It shows as the book's net-long row.
        pushRemainderRow(g.instruments, core, "naked_short");
      }
      continue;
    }

    // core === 0 — options only.
    const protective = options.filter((o) => o.exposure < 0);
    const bullish = options.filter((o) => o.exposure > 0);

    if (g.underlyingIsEtf) {
      // An ETF's options with no core, judged in a crash like a short ETF
      // stack: long puts are portfolio protection, less the delta of any
      // written puts (they lose as prices fall). The put legs are one
      // protection row only while they net short; otherwise they join the
      // remainder. A written call is never protection (it only keeps its
      // premium in a crash). Every other leg nets into ONE remainder row: a
      // bearish bet or the speculative row. The protection is not a "Most
      // exposed" row, so this still renders one exposure row per underlying.
      const putLegs = options.filter((o) => isLongPutLeg(o) || isWrittenPutLeg(o));
      const putNet = sum(putLegs.map((o) => o.exposure));
      const putsProtect = putLegs.some(isLongPutLeg) && putNet < 0;
      if (putsProtect) {
        proxyCandidates.push({
          underlying: g.underlying,
          protectiveNotional: -putNet,
          source: "no_core_etf",
          instruments: putLegs,
        });
      }
      pushRemainderRow(
        options.filter((o) => o.exposure !== 0 && !(putsProtect && putLegs.includes(o))),
        0,
        "etf_bearish_options",
      );
      continue;
    }

    // Single name, options only: ONE row for the underlying, sized by the
    // NET delta exposure of all its legs (owner ruling 2026-10-08). A put and
    // a call on one name used to render as a bearish bet plus a separate
    // speculative row. Net bearish = a standalone bet; otherwise a
    // speculative options position. Nothing is credited as protection either
    // way: with no core there is nothing to hedge.
    if (protective.length === 0 && bullish.length === 0) continue;
    const legs = [...protective, ...bullish];
    const net = sum(legs.map((o) => o.exposure));
    if (bullish.length === 0 || net < 0) {
      standaloneBets.push({
        underlying: g.underlying,
        exposure: net,
        kind: bearishOptionKind(protective),
        instruments: legs,
        ...(notes.length > 0 ? { notes } : {}),
      });
    } else {
      pairs.push({
        underlying: g.underlying,
        classification: "speculative",
        coreExposure: 0,
        offsetExposure: 0,
        offsetCredited: 0,
        amplifierExposure: sum(bullish.map((o) => o.exposure)),
        hasAmplifiers: true,
        netExposure: net,
        coveragePct: null,
        sector,
        instruments: legs,
        ...extras,
      });
    }
  }

  return { pairs, proxyCandidates, standaloneBets };
}

// ─── Beta Resolver (Task 2) ────────────────────────────────────────

const MAX_RETURN_PAIR_GAP_DAYS = 7; // prices-table hole guard (see CLAUDE.md)
const MIN_BETA_RETURN_PAIRS = 6;

function calendarDaysBetween(a: string, b: string): number {
  return Math.abs(new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86_400_000;
}

/** Log-return pairs aligned by date, dropping pairs spanning > MAX_RETURN_PAIR_GAP_DAYS. */
function gapGuardedReturns(series: Array<{ date: string; close: number }>): Map<string, number> {
  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const out = new Map<string, number>();
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.close <= 0 || cur.close <= 0) continue;
    if (calendarDaysBetween(prev.date, cur.date) > MAX_RETURN_PAIR_GAP_DAYS) continue;
    out.set(cur.date, Math.log(cur.close / prev.close));
  }
  return out;
}

export function computeGapGuardedBeta(
  series: Array<{ date: string; close: number }>,
  bench: Array<{ date: string; close: number }>
): number | null {
  return computeGapGuardedBetaStats(series, bench)?.beta ?? null;
}

/**
 * The same regression as computeGapGuardedBeta, plus what the confidence gate
 * (betaConfidenceVerdict) needs: the aligned pair count and r².
 */
/** Aligned, gap-guarded return pairs: the count the beta regression would use. */
export function countAlignedReturnPairs(
  series: Array<{ date: string; close: number }>,
  bench: Array<{ date: string; close: number }>
): number {
  const benchR = gapGuardedReturns(bench);
  let n = 0;
  for (const date of gapGuardedReturns(series).keys()) if (benchR.has(date)) n++;
  return n;
}

export function computeGapGuardedBetaStats(
  series: Array<{ date: string; close: number }>,
  bench: Array<{ date: string; close: number }>
): { beta: number; pairs: number; rSquared: number } | null {
  const secR = gapGuardedReturns(series);
  const benchR = gapGuardedReturns(bench);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [date, r] of secR) {
    const br = benchR.get(date);
    if (br !== undefined) {
      ys.push(r);
      xs.push(br);
    }
  }
  if (xs.length < MIN_BETA_RETURN_PAIRS) return null;
  const mx = sum(xs) / xs.length;
  const my = sum(ys) / ys.length;
  let cov = 0;
  let varx = 0;
  let vary = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    varx += (xs[i] - mx) ** 2;
    vary += (ys[i] - my) ** 2;
  }
  if (varx === 0) return null;
  // vary === 0 gives NaN; betaConfidenceVerdict fails a non-finite r² closed.
  const rSquared = (cov * cov) / (varx * vary);
  return { beta: cov / varx, pairs: xs.length, rSquared };
}

/**
 * Why a beta could not be measured: `no_history` (too few aligned prices to
 * measure one) or `low_fit` (one was measured but failed the house fit test,
 * betaConfidenceVerdict's r² floor).
 */
export type UnmeasuredBetaReason = "no_history" | "low_fit";

/**
 * A proxy fund's beta: measured (cached or computed), or unmeasured with the
 * reason. An unmeasured beta carries no number: nothing is assumed in its
 * place (owner ruling 19 = B, 2026-11-16).
 */
export type ResolvedBeta =
  | { beta: number; source: "cached" | "computed" }
  | { beta: null; source: "unmeasured"; reason: UnmeasuredBetaReason; history?: BetaHistoryOnFile };

/**
 * What resolveProxyBeta found on file for an unmeasured fund (display only;
 * it never changes a credit). The beta is regressed on the fund's daily
 * closes in `prices` and `benchmark_prices` against SPY's; a day-to-day move
 * counts only when both closes are at most a week apart and SPY moved over
 * the same day. `usablePairs` is that count; the house gate needs
 * `pairsNeeded` (MIN_BETA_PAIRS).
 */
export interface BetaHistoryOnFile {
  closesOnFile: number;
  usablePairs: number;
  pairsNeeded: number;
}

/**
 * The fund is usually long-established: the gap is in what this app has
 * collected, not in the fund's own history (review 2026-11-16).
 */
export const NOT_CREDITED_BETA_NO_HISTORY = "this app has not collected enough of its price history to measure a beta";
export const NOT_CREDITED_BETA_LOW_FIT = "its price history fits the market too loosely to measure its beta";

/**
 * What a proxy hedge is credited at its resolved beta: THE ONE PLACE that
 * decides the credit of a hedge credited through a beta (the own-sector and
 * whole-book routes of attributeProxies; a look-through or geography route
 * applies no beta). Owner ruling 19 = B (2026-11-16): a beta that cannot be
 * measured earns NO credit until it can be; the hedge is listed as not
 * credited with the plain reason. It replaced an assumed beta of 1.0.
 *
 * `appliedLeverageFactor` (review 2026-11-23): the signed factor of a
 * leveraged or inverse fund that the orchestrator ALREADY multiplied into
 * `notional` (theme T2: notional is in the tracked index, not in the fund).
 * The measured beta is the fund's own regression, so it already carries that
 * same leverage (about -1 for a -1x fund, -3 for a -3x fund); multiplying by
 * it again squared the leverage and flipped every inverse hedge negative.
 * The beta applied is therefore the tracked index's: measured beta / factor.
 * Still a measurement, so an unmeasured beta is still not credited. Absent,
 * null or unusable (normalizeLeverageFactor): the beta is used as measured.
 */
export function creditAtResolvedBeta(
  notional: number,
  resolved: ResolvedBeta,
  appliedLeverageFactor?: number | null
): { credited: number } | { notCreditedReason: string } {
  if (resolved.source === "unmeasured") {
    return { notCreditedReason: resolved.reason === "low_fit" ? NOT_CREDITED_BETA_LOW_FIT : NOT_CREDITED_BETA_NO_HISTORY };
  }
  const factor = normalizeLeverageFactor(appliedLeverageFactor);
  const beta = factor === null ? resolved.beta : resolved.beta / factor;
  return { credited: notional * beta };
}

/**
 * β for a proxy-hedge underlying: security_betas cache → gap-guarded compute
 * from cached closes (prices + benchmark_prices vs SPY) → unmeasured.
 */
export function resolveProxyBeta(db: Database.Database, symbol: string): ResolvedBeta {
  const cached = db
    .prepare(
      `SELECT sb.beta FROM security_betas sb
       JOIN securities s ON s.id = sb.security_id
       WHERE s.symbol = ? AND sb.beta IS NOT NULL ORDER BY sb.computed_at DESC LIMIT 1`
    )
    .get(symbol) as { beta: number } | undefined;
  if (cached) return { beta: cached.beta, source: "cached" };

  // Deterministic one-source-per-date: prefer `prices` (broker-sourced closes)
  // over `benchmark_prices` (fallback) when both tables have a row for the
  // same date — a same-date collision otherwise corrupts gapGuardedReturns'
  // date-keyed Map (identical dupes collapse variance to ~0; near-identical
  // dupes inject a few-bp noise return that can send beta wildly off).
  const closesFor = (sym: string): Array<{ date: string; close: number }> =>
    db
      .prepare(
        `SELECT date, close FROM (
           SELECT date, close_price AS close,
                  ROW_NUMBER() OVER (PARTITION BY date ORDER BY pri) AS rn
           FROM (
             SELECT p.date AS date, p.close_price, 1 AS pri
             FROM prices p JOIN securities s ON s.id = p.security_id
             WHERE s.symbol = ? AND p.close_price > 0
             UNION ALL
             SELECT bp.date, bp.close_price, 2 AS pri
             FROM benchmark_prices bp WHERE bp.symbol = ? AND bp.close_price > 0
           )
         ) WHERE rn = 1 ORDER BY date`
      )
      .all(sym, sym) as Array<{ date: string; close: number }>;

  const sec = closesFor(symbol);
  const spy = closesFor("SPY");
  const computed = computeGapGuardedBetaStats(sec, spy);
  const history: BetaHistoryOnFile = {
    closesOnFile: sec.length,
    usablePairs: computed?.pairs ?? countAlignedReturnPairs(sec, spy),
    pairsNeeded: MIN_BETA_PAIRS,
  };
  // House publish gate (r² ≥ 0.10, ≥ 30 pairs): a slope that fails it is
  // not a measurement; the hedge is then not credited (ruling 19 = B).
  if (computed === null) return { beta: null, source: "unmeasured", reason: "no_history", history };
  const verdict = betaConfidenceVerdict({ rSquared: computed.rSquared, pairs: computed.pairs });
  if (verdict.ok) return { beta: computed.beta, source: "computed" };
  // The gate's own reason: too few pairs is "no history"; a slope measured
  // on enough pairs that explains too little is "low fit".
  return { beta: null, source: "unmeasured", reason: verdict.reason === "low_r2" ? "low_fit" : "no_history", history };
}

// ─── Proxy Attribution (Task 3) ────────────────────────────────────────

export interface ProxyHedge {
  underlying: string;
  protectiveNotional: number;
  /**
   * `sector`: the fund's look-through weights. `geography`: a country fund.
   * `own_sector`: a fund with no look-through, credited to its own sector at
   * its beta. `beta`: the whole book at its beta. `not_credited`: a
   * commodity, bond or unknown-type fund, or one whose beta cannot be
   * measured (ruling 19 = B): no equity protection (creditedTo is empty;
   * `notCreditedReason` says why).
   */
  route: "sector" | "geography" | "own_sector" | "beta" | "not_credited";
  creditedTo: Array<{ bucket: string; credited: number }>;
  /** Set when a beta was looked up; "unmeasured" only on a not_credited row. */
  betaSource?: ResolvedBeta["source"];
  notCreditedReason?: string;
  /** What was on file when the beta could not be measured (display only). */
  betaHistory?: BetaHistoryOnFile;
  instruments: DefenseInstrument[];
}

/** What a fund's own row says about what it holds (securities columns). */
export interface ProxyFundIdentity {
  fundCategory: string | null;
  assetClass: string | null;
  sector: string | null;
  /** A stored leverage factor or a leveraged/inverse category. */
  leveraged: boolean;
}

export type ProxyFundVerdict =
  | { kind: "equity"; ownSector: string | null }
  | { kind: "not_credited"; reason: string }
  | { kind: "unchanged" };

export const NOT_CREDITED_COMMODITY = "commodity fund: it moves with raw materials, not with stocks";
export const NOT_CREDITED_BOND = "bond fund: it does not protect stocks";
export const NOT_CREDITED_UNKNOWN = "fund type unknown: no fund category or asset class on file";

const GICS_SECTOR_SET: ReadonlySet<string> = new Set(GICS_SECTORS);

/**
 * Owner ruling 2026-11-15 (K4b): how a hedge on a fund WITHOUT look-through
 * weights is credited. The ONE reader of that rule.
 *   - leveraged / inverse: "unchanged" (geography, then the book at its beta);
 *   - a commodity or bond category (normalizeFundCategory /
 *     isBondFundCategory): not credited, on every route;
 *   - equity evidence (an equity fund category, or asset class "equity"):
 *     its own GICS sector (normalizeSector) when it has one, else the book;
 *   - anything else is an unknown type and fails closed: not credited.
 */
export function proxyFundVerdict(id: ProxyFundIdentity | undefined): ProxyFundVerdict {
  if (id?.leveraged || isLeveragedInverseFundCategory(id?.fundCategory)) return { kind: "unchanged" };
  const category = normalizeFundCategory(id?.fundCategory);
  if (category !== null && /\bcommodit/i.test(category)) return { kind: "not_credited", reason: NOT_CREDITED_COMMODITY };
  if (isBondFundCategory(category)) return { kind: "not_credited", reason: NOT_CREDITED_BOND };
  const equity =
    (category !== null && /\bequit(?:y|ies)\b/i.test(category)) ||
    (id?.assetClass ?? "").trim().toLowerCase() === "equity";
  if (!equity) return { kind: "not_credited", reason: NOT_CREDITED_UNKNOWN };
  const sector = normalizeSector(id?.sector);
  return { kind: "equity", ownSector: sector !== null && GICS_SECTOR_SET.has(sector) ? sector : null };
}

export interface SectorCoverage {
  sector: string;
  longExposure: number;
  /** Every credit landed on this sector (Tier-1, look-through, own sector). */
  protected: number;
  /** protected / longExposure, capped at 1: a bar never passes 100%. */
  coveragePct: number | null;
  /**
   * The part of `protected` above the sector's long exposure (look-through
   * and Tier-1 credits are not capped; own-sector credits are). Kept in the
   * totals, shown beside the bar. 0 when the sector is not over-covered.
   */
  protectedBeyondExposure: number;
}

/**
 * Make sector parts sum to `amount`. Look-through weights that sum under 100
 * would lose the rest: it goes to `ownSector` (the fund's own sector), or
 * "Unknown" when there is none. Weights over 100 are scaled back. Parts that
 * already sum to the amount come back unchanged.
 */
export function conserveSectorParts(
  parts: Array<{ sector: string; value: number }>,
  amount: number,
  ownSector: string | null | undefined
): Array<{ sector: string; value: number }> {
  const sum = parts.reduce((a, p) => a + p.value, 0);
  if (Math.abs(sum - amount) <= 1e-9 * Math.max(1, Math.abs(amount))) return parts;
  if (sum !== 0 && Math.abs(sum) > Math.abs(amount)) {
    return parts.map((p) => ({ sector: p.sector, value: (p.value * amount) / sum }));
  }
  const home = ownSector && ownSector.trim() !== "" ? ownSector : "Unknown";
  return [...parts, { sector: home, value: amount - sum }];
}

export interface AttributionContext {
  /** getEtfSectorWeights(db) shape: symbol → [{sector, weight_pct}] */
  sectorWeights: Map<string, Array<{ sector: string; weight_pct: number }>>;
  /** ETF symbol → geography (from securities.geography of the ETF row). */
  etfGeography: Map<string, string>;
  longExposureBySector: Map<string, number>;
  longExposureByGeography: Map<string, number>;
  /** Tier-1 offsetCredited bucketed by the pair's sector (for the bars). */
  tier1CreditedBySector: Map<string, number>;
  /** Carried for interface completeness / future consumers — attributeProxies
   * itself never reads this field; the orchestrator computes and uses its
   * own totalLongExposure (for pctOfBook, etc.). Do not remove. */
  totalLongExposure: number;
  resolveBeta: (symbol: string) => ResolvedBeta;
  /** A fund's own sector, by underlying: the home for the part of a sector
   *  route's credit its weights do not cover. Absent: "Unknown". */
  ownSectorByUnderlying?: Map<string, string | null>;
  /** A fund's identity, by underlying, for proxyFundVerdict. Absent: an
   *  unknown type, which fails closed once sector weights and geography
   *  have both missed. */
  fundIdentityByUnderlying?: Map<string, ProxyFundIdentity>;
  /** The signed leverage factor already multiplied into a candidate's
   *  exposure, by underlying (creditAtResolvedBeta's third argument).
   *  Absent: no factor was applied. */
  appliedLeverageFactorByUnderlying?: Map<string, number>;
}

export function attributeProxies(
  candidates: ProxyCandidate[],
  ctx: AttributionContext
): { proxies: ProxyHedge[]; sectorCoverage: SectorCoverage[] } {
  // One ProxyHedge per candidate, in candidate order (the orchestrator joins
  // proxies[i] to candidates[i]).
  const proxies: ProxyHedge[] = [];
  const protectedBySector = new Map<string, number>(ctx.tier1CreditedBySector);
  const addToSector = (sector: string, amount: number) =>
    protectedBySector.set(sector, (protectedBySector.get(sector) ?? 0) + amount);

  // Own-sector credits are split in a second pass, after every Tier-1 and
  // look-through credit has landed, so a sector's room never depends on row
  // order (review 2026-11-15, R1).
  const ownSector: Array<{ hedge: ProxyHedge; c: ProxyCandidate; sector: string; credited: number }> = [];

  for (const c of candidates) {
    const base = { underlying: c.underlying, protectiveNotional: c.protectiveNotional, instruments: c.instruments };
    const weights = ctx.sectorWeights.get(c.underlying);
    if (weights && weights.length > 0) {
      const creditedTo = conserveSectorParts(
        weights.map((w) => ({ sector: w.sector, value: c.protectiveNotional * (w.weight_pct / 100) })),
        c.protectiveNotional,
        ctx.ownSectorByUnderlying?.get(c.underlying)
      ).map((p) => ({ bucket: p.sector, credited: p.value }));
      for (const ct of creditedTo) addToSector(ct.bucket, ct.credited);
      proxies.push({ ...base, route: "sector", creditedTo });
      continue;
    }
    const verdict = proxyFundVerdict(ctx.fundIdentityByUnderlying?.get(c.underlying));
    // A commodity, bond or unknown-type fund is never equity protection,
    // whatever its geography says: fail closed on every route (R3).
    if (verdict.kind === "not_credited") {
      proxies.push({ ...base, route: "not_credited", creditedTo: [], notCreditedReason: verdict.reason });
      continue;
    }
    const geo = ctx.etfGeography.get(c.underlying);
    if (geo && ctx.longExposureByGeography.has(geo)) {
      // Credited at notional x 1: regional exposure, no beta applied.
      proxies.push({ ...base, route: "geography", creditedTo: [{ bucket: geo, credited: c.protectiveNotional }] });
      continue;
    }
    const resolved = ctx.resolveBeta(c.underlying);
    const credit = creditAtResolvedBeta(
      c.protectiveNotional,
      resolved,
      ctx.appliedLeverageFactorByUnderlying?.get(c.underlying)
    );
    if ("notCreditedReason" in credit) {
      proxies.push({
        ...base,
        route: "not_credited",
        creditedTo: [],
        betaSource: resolved.source,
        notCreditedReason: credit.notCreditedReason,
        ...(resolved.source === "unmeasured" && resolved.history ? { betaHistory: resolved.history } : {}),
      });
      continue;
    }
    if (verdict.kind === "equity" && verdict.ownSector !== null) {
      const hedge: ProxyHedge = { ...base, route: "own_sector", creditedTo: [], betaSource: resolved.source };
      ownSector.push({ hedge, c, sector: verdict.ownSector, credited: credit.credited });
      proxies.push(hedge);
      continue;
    }
    proxies.push({
      ...base,
      route: "beta",
      creditedTo: [{ bucket: "book", credited: credit.credited }],
      betaSource: resolved.source,
    });
  }

  // Fixed order: by underlying symbol, then the larger credit first, then
  // source. The fund's own sector takes the credit up to that sector's long
  // exposure still unprotected; any rest protects the whole book at the same
  // beta. The total is conserved.
  ownSector.sort(
    (a, b) =>
      a.c.underlying.localeCompare(b.c.underlying) ||
      b.c.protectiveNotional - a.c.protectiveNotional ||
      a.c.source.localeCompare(b.c.source)
  );
  for (const { hedge, sector, credited } of ownSector) {
    const room = Math.max(0, (ctx.longExposureBySector.get(sector) ?? 0) - (protectedBySector.get(sector) ?? 0));
    const toSector = Math.min(credited, room);
    const toBook = credited - toSector;
    addToSector(sector, toSector);
    hedge.creditedTo = [
      { bucket: sector, credited: toSector },
      ...(toBook > 0 ? [{ bucket: "book", credited: toBook }] : []),
    ];
  }

  const sectors = new Set([...ctx.longExposureBySector.keys(), ...protectedBySector.keys()]);
  const sectorCoverage: SectorCoverage[] = [...sectors]
    .map((sector) => {
      const longExposure = ctx.longExposureBySector.get(sector) ?? 0;
      const prot = protectedBySector.get(sector) ?? 0;
      return {
        sector,
        longExposure,
        protected: prot,
        // The bar caps at 100%; the credit above it is named, not dropped.
        coveragePct: longExposure > 0 ? Math.min(1, prot / longExposure) : null,
        protectedBeyondExposure: Math.max(0, prot - Math.max(0, longExposure)),
      };
    })
    .sort((a, b) => b.longExposure - a.longExposure || a.sector.localeCompare(b.sector));

  return { proxies, sectorCoverage };
}

// ─── Per-hedge Scoring (Task 4) ────────────────────────────────────────

export type HedgeBadge = "expiring" | "decayed" | "expensive" | "deep_itm";

export interface HedgeScore {
  securityId: number;
  symbol: string;
  underlying: string;
  /** What it protects: a name, "sector: Technology (90%) + …", or "book". */
  protects: string;
  protectedNotional: number;
  thetaPerDay: number | null;
  /** Monthly theta as a fraction of protected notional; negative = the hedge
   *  COLLECTS theta (short-option premium income), not a cost. */
  monthlyBleedPct: number | null;
  runwayDays: number | null;
  /** (strike − spot) / spot; negative = OTM for puts. */
  moneynessPct: number | null;
  /** Dollars protected per dollar of monthly decay; null when no carry data. */
  efficiency: number | null;
  badges: HedgeBadge[];
  /**
   * "long": protects the long book (counted in the protection ratio).
   * "short": a call held against a short position, which protects against a
   * rally and is reported on its own (owner ruling 2026-11-15, K4a).
   */
  side: "long" | "short";
}

export interface HedgeScoreInput {
  instrument: DefenseInstrument;
  protects: string;
  protectedNotional: number;
  side?: "long" | "short";
}

export function scoreHedges(inputs: HedgeScoreInput[]): HedgeScore[] {
  const T = HEDGE_BADGE_THRESHOLDS;
  const scores = inputs.map(({ instrument: i, protects, protectedNotional, side = "long" }) => {
    const hasGreeks = i.greeksAvailable && i.isOption;
    const thetaPerDay = hasGreeks && typeof i.thetaPerDay === "number" ? i.thetaPerDay : null;
    // Signed carry: theta < 0 (long options) decays — positive bleed = cost.
    // theta > 0 (a short-option hedge collecting premium) — negative bleed =
    // income; "expensive" then never fires and efficiency stays null via the
    // existing monthlyBleed > 0 guard. Identical output for all long hedges.
    const monthlyBleed = thetaPerDay !== null && protectedNotional > 0 ? -thetaPerDay * 30 : null;
    const monthlyBleedPct = monthlyBleed !== null ? monthlyBleed / protectedNotional : null;
    const runwayDays = i.isOption && typeof i.daysToExpiry === "number" ? i.daysToExpiry : null;
    const moneynessPct =
      i.isOption && typeof i.strike === "number" && typeof i.underlyingPrice === "number" && i.underlyingPrice > 0
        ? (i.strike - i.underlyingPrice) / i.underlyingPrice
        : null;
    const efficiency = monthlyBleed !== null && monthlyBleed > 0 ? protectedNotional / monthlyBleed : null;

    const badges: HedgeBadge[] = [];
    if (runwayDays !== null && runwayDays < T.EXPIRING_DAYS) badges.push("expiring");
    const otmPct = i.optionType === "PUT" ? (moneynessPct !== null ? -moneynessPct : null) : moneynessPct;
    if (otmPct !== null && runwayDays !== null && otmPct > T.DECAYED_OTM_PCT && runwayDays < T.DECAYED_RUNWAY_DAYS) badges.push("decayed");
    if (monthlyBleedPct !== null && monthlyBleedPct > T.EXPENSIVE_MONTHLY_BLEED_PCT) badges.push("expensive");
    if (typeof i.delta === "number" && Math.abs(i.delta) >= T.DEEP_ITM_ABS_DELTA) badges.push("deep_itm");

    return {
      securityId: i.securityId,
      symbol: i.symbol,
      underlying: i.underlying,
      protects,
      protectedNotional,
      thetaPerDay,
      monthlyBleedPct,
      runwayDays,
      moneynessPct,
      efficiency,
      badges,
      side,
    };
  });

  return scores.sort((a, b) => {
    if (a.efficiency === null && b.efficiency === null) return 0;
    if (a.efficiency === null) return 1;
    if (b.efficiency === null) return -1;
    return a.efficiency - b.efficiency;
  });
}

// ─── Orchestrator (Task 5) ──────────────────────────────────────────────

interface DefenseHoldingRow {
  security_id: number;
  symbol: string;
  name: string | null;
  security_type: string | null;
  fund_category: string | null;
  option_type: string | null;
  underlying_symbol: string | null;
  sector: string | null;
  geography: string | null;
  currency: string | null;
  /** Signed leverage factor (migration 102); null for an ordinary row. */
  leverage_factor: number | null;
  /** An option's underlying securities row (underlyingSecurityIdSql); names it for the summary. */
  underlying_security_id: number | null;
  quantity: number;
  mv: number;
}

interface UnderlyingMeta {
  isEtf: boolean;
  geography: string | null;
  sector: string | null;
  securityId: number | null;
  fundCategory: string | null;
  assetClass: string | null;
  leverageFactor: number | null;
}

interface GreeksAgg {
  exposure: number;
  thetaPerDay: number;
  /** Contract-weighted average delta across the scoped accounts. */
  delta: number | null;
  /** Σ delta x |contracts| and Σ |contracts| behind that average. */
  deltaWeighted: number;
  deltaWeight: number;
  /** Weakest volatility source across the scoped accounts. */
  ivSource: OptionVolSource | undefined;
  daysToExpiry: number | null;
  strike: number | null;
  underlyingPrice: number | null;
  /** A delta is known (the Greeks', or an end-of-life delta). */
  greeksAvailable: boolean;
  /** At least one account's Greeks computed, so thetaPerDay is real. */
  thetaAvailable: boolean;
}

const VOL_SOURCE_WEAKNESS: Record<OptionVolSource, number> = { computed: 0, ibkr: 1, default: 2 };

/** issuerSiblings-canonical key for a raw underlying symbol. */
function canonicalUnderlying(symbol: string): string {
  return issuerSiblings(symbol).slice().sort()[0];
}

/** Options → underlying_symbol (fallback: OCC symbol prefix before the first space). Shares → own symbol. */
function rawUnderlyingOf(
  row: Pick<DefenseHoldingRow, "symbol" | "security_type" | "underlying_symbol">
): string {
  if ((row.security_type ?? "").toLowerCase() === "option") {
    return row.underlying_symbol ?? row.symbol.split(" ")[0];
  }
  return row.symbol;
}

/** The beta text in a route description: always a measured beta (ruling
 *  19 = B leaves an unmeasured one uncredited, so it never reaches here). */
function betaText(hedge: ProxyHedge): string {
  const credited = sum(hedge.creditedTo.map((c) => c.credited));
  const beta = hedge.protectiveNotional !== 0 ? credited / hedge.protectiveNotional : 1;
  return `β=${beta.toFixed(1)}`;
}

/**
 * "sector: Technology 90% / Communication Services 10%" | "geography: Europe"
 * | "own_sector: Healthcare (β=1.2)" | "book (β=1.2)"
 */
function describeProxyRoute(hedge: ProxyHedge): string {
  if (hedge.route === "sector") {
    return (
      "sector: " +
      hedge.creditedTo
        .map((c) => `${c.bucket} ${Math.round((c.credited / hedge.protectiveNotional) * 100)}%`)
        .join(" / ")
    );
  }
  if (hedge.route === "geography") {
    return `geography: ${hedge.creditedTo[0]?.bucket ?? "Unknown"}`;
  }
  if (hedge.route === "own_sector") {
    const spill = hedge.creditedTo.some((c) => c.bucket === "book") ? " + book" : "";
    return `own_sector: ${hedge.creditedTo[0]?.bucket ?? "Unknown"}${spill} (${betaText(hedge)})`;
  }
  return `book (${betaText(hedge)})`;
}

export interface RankedExposure {
  underlying: string;
  netExposure: number;
  pctOfBook: number | null; // |net| / totalLongExposure
  tier1CoveragePct: number | null;
  sectorProxyCoveragePct: number | null; // the sector's coverage, context column
  classification: PairClassification;
  hasAmplifiers: boolean;
  sector: string | null;
  securityId: number | null; // for SymbolLink; null if underlying row absent
  /** Short plain-language caveats for the row. Absent when none. */
  notes?: string[];
  /**
   * The option legs behind a row that holds no shares, so a put and a call
   * netted into one row can still be read leg by leg. Absent on rows with a
   * share core.
   */
  legs?: RankedExposureLeg[];
}

export interface RankedExposureLeg {
  securityId: number;
  symbol: string;
  optionType: "CALL" | "PUT" | null;
  /** Signed contracts. */
  quantity: number;
  /** Signed delta-notional USD. */
  exposure: number;
}

export interface DefenseDiagnostic {
  kind: "unmeasured_beta" | "no_sector_weights" | "greeks_fallback" | "unknown_underlying";
  symbol: string;
  detail: string;
}

export interface DefenseSummary {
  /**
   * Σ positive exposure, less the credited part of each call held against a
   * short (a hedge of the short book, not a long bet; K4a).
   */
  longExposure: number;
  shortExposure: number;
  /** Protection of the LONG book only (owner ruling 2026-11-15, K4a). */
  protectiveNotional: number;
  /** protectiveNotional / longExposure. */
  protectionRatio: number | null;
  /**
   * Credited offset of calls held against short positions: protection
   * against a rally, never counted in the protection ratio (K4a). Old
   * all-sides figure = protectiveNotional + shortSideHedgeNotional.
   */
  shortSideHedgeNotional: number;
  /** The credited delta of those calls, left out of longExposure. Net
   *  exposure = longExposure + shortExposure + shortSideHedgeExposure. */
  shortSideHedgeExposure: number;
  /** Hedge-book rows on the short side. */
  shortSideHedgeCount: number;
  /** Scored rows on the long side (the Hedge book table). hedgeCount =
   *  longSideHedgeCount + shortSideHedgeCount. */
  longSideHedgeCount: number;
  /** Fund hedges given no equity protection credit: a non-stock or
   *  unknown-type fund (K4b), or a beta that cannot be measured (ruling
   *  19 = B). */
  notCreditedCount: number;
  netExposure: number;
  /**
   * Σ |name exposure|: each name (a security's shares in every account plus
   * every option on it at delta) netted first, then the sizes added (owner
   * ruling 2026-11-24). The same helper and rule as the Diagnostics badge
   * (nameNettedExposure), over Defense's own universe, which leaves bonds
   * out: it equals the badge's gross only when the scope holds no bond. A
   * covered call shrinks its stock.
   */
  grossExposure: number;
  /**
   * Σ positive / Σ negative NAME exposure (the badge's rule; equal to its
   * long and short only when the scope holds no bond, as above):
   * grossExposure = nameLongExposure - nameShortExposure and netExposure =
   * nameLongExposure + nameShortExposure. Distinct from longExposure (the
   * protection ratio's base, the long book before its hedges, K4a) and
   * shortExposure (Σ negative INSTRUMENT exposure, a long put included).
   */
  nameLongExposure: number;
  nameShortExposure: number;
  hedgeCount: number;
  /** Loaded option instruments (any side) — lets the view tell "no options" from "no hedges". */
  optionPositionCount: number;
  /** Loaded instruments held short (negative quantity), options included. */
  shortPositionCount: number;
}

export interface NotCreditedHedge {
  underlying: string;
  /** Instruments behind the hedge (public symbols). */
  symbols: string[];
  protectiveNotional: number;
  reason: string;
  /** Set when the reason is an unmeasured beta: the daily closes on file,
   *  the usable day-to-day moves, and the moves the gate needs. */
  betaHistory?: BetaHistoryOnFile;
}

/**
 * "Cash and equivalents: X% of this scope" (owner ruling 2026-11-16). Read
 * through splitConcentrationUniverse, the concentration card's own reader,
 * so the two never disagree. Cash lowers what can be lost but is not a hedge
 * of the long book: it is NEVER part of the protection ratio.
 */
export interface DefenseCashLine {
  /** Positive cash-equivalent value / the scope's gross book (cash included). */
  weight: number;
  marketValue: number;
  holdingCount: number;
  /** Cash-equivalent positions valued below zero (borrowing), apart. */
  borrowed: { marketValue: number; holdingCount: number };
}

export interface DefenseAnalysis {
  summary: DefenseSummary;
  cashLine: DefenseCashLine;
  pairs: UnderlyingPair[];
  proxies: ProxyHedge[];
  sectorCoverage: SectorCoverage[];
  standaloneBets: StandaloneBet[];
  rankedExposures: RankedExposure[];
  hedgeScores: HedgeScore[];
  diagnostics: DefenseDiagnostic[];
  /**
   * Hedges on commodity, bond or unknown-type funds (owner ruling 2026-11-15,
   * K4b), or on a fund whose beta cannot be measured (ruling 19 = B): no
   * equity protection credit. One row per proxy candidate.
   */
  notCreditedHedges: NotCreditedHedge[];
  /**
   * Option positions whose Greeks here were priced off a SIBLING share class's
   * close (a GOOGL contract off GOOG) because the contract's own underlying
   * has none — `underlyingPriceSource` on PositionGreeks. Their exposure and
   * theta rest on a substitute price, so the view states the count.
   */
  siblingPricedPositions: number;
  /**
   * Leveraged and inverse funds, and options on them, held out of the hedge
   * book (`isLeveragedOrInverseExposure`, owner ruling 2026-11-01): count,
   * share of the loaded universe's gross value, and symbols (sorted).
   */
  leveragedFundsUnmodelled: { count: number; valueShare: number; symbols: string[] };
}

/**
 * Defense/Hedging orchestrator — pulls the holdings universe (shares + options,
 * shorts included, FX-adjusted), wires Greeks-derived exposure, classifies the
 * book (Task 1), attributes proxy hedges (Task 3), and scores every hedge
 * (Task 4). See docs/superpowers/specs/2026-07-05-defense-hedging-tab-design.md.
 */
export function computeDefenseAnalysis(db: Database.Database, accountIds?: number[]): DefenseAnalysis {
  const diagnostics: DefenseDiagnostic[] = [];
  // `undefined` is every account; a defined empty list is NO accounts (no
  // holdings row, and no Greeks pass below).
  const scopedAccountIds = accountIds;
  const { sql: accountFilter, params: accountParams } = accountScopeAndSql(scopedAccountIds);

  // ─── Note 1: SQL pull — holdings universe (shares + options, shorts
  // included), FX-adjusted, maturity/expiry filtered. ─────────────────
  const sql = `
    WITH latest_holdings AS (
      SELECT h.* FROM holdings h
      WHERE ${latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true, accountFilter })}
    ),
    latest_prices AS (
      SELECT p.security_id, p.close_price
      FROM prices p
      INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
      ON p.security_id = lp.security_id AND p.date = lp.max_date
    )
    SELECT
      s.id AS security_id, s.symbol, s.name, s.security_type, s.fund_category, s.option_type, s.underlying_symbol,
      s.sector, s.geography, s.currency, s.leverage_factor, h.quantity,
      ${underlyingSecurityIdSql("s")} AS underlying_security_id,
      ${HOLDING_VALUE_USD_SQL} AS mv
    FROM latest_holdings h
    JOIN securities s ON s.id = h.security_id
    LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
    LEFT JOIN fx_rates fx ON fx.currency = s.currency
    WHERE ${unmaturedSecuritySql("s")}
      AND ${liveOptionExpirationSql("s")}
      AND LOWER(s.security_type) IN ('stock', 'etf', 'common stock', 'option', 'mutual fund')
  `;
  const allRawRows = db.prepare(sql).all(...accountParams) as DefenseHoldingRow[];

  // Cash-equivalent sweep funds (stable $1.00 NAV) are cash, not market
  // exposure — exclude them here, before any aggregation, so they never
  // reach ranked exposures, the protection-ratio denominator, or any other
  // downstream computation in this function.
  const rawRows = allRawRows.filter((r) => !isCashEquivalentSecurity(r));

  // Sum quantity/mv across accounts per security_id.
  const aggregated = new Map<number, DefenseHoldingRow>();
  for (const r of rawRows) {
    const existing = aggregated.get(r.security_id);
    if (existing) {
      existing.quantity += r.quantity;
      existing.mv += r.mv;
    } else {
      aggregated.set(r.security_id, { ...r });
    }
  }
  const loadedRows = [...aggregated.values()];

  // ─── Leveraged and inverse funds (owner ruling 2026-11-01, item 2;
  // signed factors added under theme T2, 2026-11-07) ───────────────────
  // With a STORED signed factor the fund IS modelled here: it enters the
  // instrument universe and its exposure is its market value times the
  // factor, so a long 3x inverse fund carries NEGATIVE (short) exposure to
  // its index instead of counting as long exposure (TODO finding (h)).
  // WITHOUT a factor nothing can say which way it moves or by how much, so
  // it is held out of the universe BEFORE classification (no pair, proxy,
  // standalone bet, ranked exposure, hedge score or summary count) and
  // disclosed (`leveragedFundsUnmodelled`) — the stopgap, unchanged.
  const optionUnderlyingSymbols = [
    ...new Set(
      loadedRows
        .filter((r) => (r.security_type ?? "").toLowerCase() === "option")
        .map((r) => rawUnderlyingOf(r))
    ),
  ];
  const underlyingIdentityBySymbol = new Map<
    string,
    { security_type: string | null; fund_category: string | null; name: string | null; leverage_factor: number | null }
  >();
  if (optionUnderlyingSymbols.length > 0) {
    const identityRows = db
      .prepare(
        `SELECT symbol, security_type, fund_category, name, leverage_factor FROM securities
         WHERE symbol IN (${optionUnderlyingSymbols.map(() => "?").join(",")})
           AND LOWER(COALESCE(security_type, '')) != 'option'
         ORDER BY id`
      )
      .all(...optionUnderlyingSymbols) as Array<{
        symbol: string;
        security_type: string | null;
        fund_category: string | null;
        name: string | null;
        leverage_factor: number | null;
      }>;
    for (const r of identityRows) {
      if (!underlyingIdentityBySymbol.has(r.symbol)) underlyingIdentityBySymbol.set(r.symbol, r);
    }
  }
  const leveragedBySecurityId = new Map<number, number>();
  const leveragedFlags = loadedRows.map((r) => {
    const underlying =
      (r.security_type ?? "").toLowerCase() === "option"
        ? underlyingIdentityBySymbol.get(rawUnderlyingOf(r)) ?? null
        : null;
    const resolved = resolveLeveragedExposure(r, underlying);
    if (resolved.flagged && resolved.factor !== null) {
      leveragedBySecurityId.set(r.security_id, resolved.factor);
    }
    // Only an unsigned flagged row is held out and disclosed.
    return resolved.flagged && resolved.factor === null;
  });
  const leveragedFundsUnmodelled = summarizeUnmodelledLeveragedFunds(
    loadedRows.map((r, idx) => ({
      symbol: r.symbol,
      currentValue: Math.abs(r.mv),
      leveragedFundUnmodelled: leveragedFlags[idx],
    }))
  );
  const rows = loadedRows.filter((_, idx) => !leveragedFlags[idx]);
  const securityTypeById = new Map<number, string | null>();
  for (const row of rows) securityTypeById.set(row.security_id, row.security_type);

  // ─── Note 2: Greeks — signed delta-notional exposure + theta, summed
  // across scoped accounts; ±2.5×MV fallback when Greeks unavailable. ──
  const greeksMap = new Map<number, GreeksAgg>();
  const greeksDiagBySymbol = new Map<string, GreeksDiagnostic>();
  const siblingPricedSecurityIds = new Set<number>();
  const scopes: Array<number | undefined> = scopedAccountIds ?? [undefined];
  // computePortfolioGreeks works in NATIVE currency: the underlying's close
  // from `prices` and the option's own premium units, never converted. The
  // fallback path (market value) is USD, so convert here, once: exposure at
  // the underlying's rate (the spot's currency; the option's own when no
  // underlying row is found), theta at the option's rate (premium currency).
  // A missing rate reads as 1.0, as everywhere (COALESCE(fx.usd_per_unit, 1)).
  const optionFxStmt = db.prepare(
    `SELECT COALESCE(fo.usd_per_unit, 1) AS option_fx,
            CASE WHEN su.id IS NULL THEN COALESCE(fo.usd_per_unit, 1)
                 ELSE COALESCE(fu.usd_per_unit, 1) END AS underlying_fx
     FROM securities s
     LEFT JOIN fx_rates fo ON fo.currency = s.currency
     LEFT JOIN securities su ON su.id = (
       SELECT u.id FROM securities u
       WHERE u.symbol = s.underlying_symbol AND LOWER(COALESCE(u.security_type, '')) != 'option'
       ORDER BY u.id LIMIT 1)
     LEFT JOIN fx_rates fu ON fu.currency = su.currency
     WHERE s.id = ?`
  );
  const optionFxById = new Map<number, { optionFx: number; underlyingFx: number }>();
  const optionFxOf = (securityId: number): { optionFx: number; underlyingFx: number } => {
    let fx = optionFxById.get(securityId);
    if (!fx) {
      const r = optionFxStmt.get(securityId) as { option_fx: number; underlying_fx: number } | undefined;
      fx = { optionFx: r?.option_fx ?? 1, underlyingFx: r?.underlying_fx ?? 1 };
      optionFxById.set(securityId, fx);
    }
    return fx;
  };
  for (const accountId of scopes) {
    const greeks = computePortfolioGreeks(db, accountId !== undefined ? { accountId } : undefined);
    for (const d of greeks.diagnostics) greeksDiagBySymbol.set(d.symbol, d);
    for (const pos of greeks.positions) {
      const cur: GreeksAgg =
        greeksMap.get(pos.securityId) ?? {
          exposure: 0,
          thetaPerDay: 0,
          delta: null,
          deltaWeighted: 0,
          deltaWeight: 0,
          ivSource: undefined,
          daysToExpiry: pos.daysToExpiry,
          strike: pos.strike,
          underlyingPrice: pos.underlyingPrice,
          greeksAvailable: false,
          thetaAvailable: false,
        };
      // The Greeks' delta, or the end-of-life delta of a contract expired
      // only by today's close (exposureDelta, the rule the Diagnostics map
      // reads too); null falls back to ±2.5× market value below.
      const exposureDeltaValue = exposureDelta(pos);
      if (exposureDeltaValue !== null) {
        const fx = optionFxOf(pos.securityId);
        cur.exposure += exposureDeltaValue * pos.underlyingPrice * pos.multiplier * pos.quantity * fx.underlyingFx;
        // Weight the per-contract delta by the contracts each account holds
        // (it used to be "last account wins"). One contract has one delta,
        // so the accounts agree today; the weighting keeps that true if the
        // inputs ever differ by account.
        const contracts = Math.abs(pos.quantity);
        if (contracts > 0) {
          cur.deltaWeighted += exposureDeltaValue * contracts;
          cur.deltaWeight += contracts;
          cur.delta = cur.deltaWeighted / cur.deltaWeight;
        } else if (cur.delta === null) {
          cur.delta = exposureDeltaValue;
        }
        if (pos.greeks) {
          // An end-of-life delta carries no theta and no volatility: both
          // stay unset for such a contract (its theta reads null).
          cur.thetaPerDay += pos.greeks.theta * pos.multiplier * pos.quantity * fx.optionFx;
          cur.thetaAvailable = true;
          // A missing source is treated as the assumed one: never "real".
          const source: OptionVolSource = pos.greeks.ivSource ?? "default";
          if (cur.ivSource === undefined || VOL_SOURCE_WEAKNESS[source] > VOL_SOURCE_WEAKNESS[cur.ivSource]) {
            cur.ivSource = source;
          }
        }
        cur.greeksAvailable = true;
        if (pos.underlyingPriceSource) siblingPricedSecurityIds.add(pos.securityId);
      }
      cur.daysToExpiry = pos.daysToExpiry;
      cur.strike = pos.strike;
      cur.underlyingPrice = pos.underlyingPrice;
      greeksMap.set(pos.securityId, cur);
    }
  }

  // ─── Note 4: underlying isEtf / geography / sector / securityId — one
  // query over the distinct raw underlyings referenced by this universe. ──
  const rawUnderlyings = new Set<string>();
  for (const row of rows) rawUnderlyings.add(rawUnderlyingOf(row));
  const rawList = [...rawUnderlyings];
  const underlyingRows =
    rawList.length > 0
      ? (db
          .prepare(
            `SELECT id, symbol, security_type, geography, sector, fund_category, asset_class, leverage_factor
             FROM securities WHERE symbol IN (${rawList
              .map(() => "?")
              .join(",")})`
          )
          .all(...rawList) as Array<{
            id: number;
            symbol: string;
            security_type: string | null;
            geography: string | null;
            sector: string | null;
            fund_category: string | null;
            asset_class: string | null;
            leverage_factor: number | null;
          }>)
      : [];
  const rawInfoBySymbol = new Map(underlyingRows.map((r) => [r.symbol, r]));

  const underlyingInfo = new Map<string, UnderlyingMeta>();
  for (const raw of rawList) {
    const canonical = canonicalUnderlying(raw);
    const found = rawInfoBySymbol.get(raw);
    if (!found) {
      diagnostics.push({
        kind: "unknown_underlying",
        symbol: raw,
        detail: `No securities row found for underlying ${raw} — treated as non-ETF with unknown sector/geography`,
      });
    }
    const isEtf = found ? ["etf", "mutual fund"].includes((found.security_type ?? "").toLowerCase()) : false;
    const existing = underlyingInfo.get(canonical);
    underlyingInfo.set(canonical, {
      isEtf: (existing?.isEtf ?? false) || isEtf,
      geography: existing?.geography ?? found?.geography ?? null,
      sector: existing?.sector ?? found?.sector ?? null,
      securityId: existing?.securityId ?? found?.id ?? null,
      fundCategory: existing?.fundCategory ?? found?.fund_category ?? null,
      assetClass: existing?.assetClass ?? found?.asset_class ?? null,
      leverageFactor: existing?.leverageFactor ?? found?.leverage_factor ?? null,
    });
  }

  const etfGeography = new Map<string, string>();
  for (const [canonical, meta] of underlyingInfo) {
    if (meta.isEtf && meta.geography) etfGeography.set(canonical, meta.geography);
  }

  // ─── Display labels for family keys ─────────────────────────────────
  // The internal grouping key is issuerSiblings-sorted-first — "BRK A" for a
  // BRK/B holding, a share class the user may not own. Grouping keeps the
  // canonical key; every user-facing `underlying` gets relabeled at return
  // to the sibling(s) actually present in the book, share/ETF rows winning
  // over option-derived underlyings.
  const heldRawsByCanonical = new Map<string, { core: Set<string>; any: Set<string> }>();
  for (const row of rows) {
    const raw = rawUnderlyingOf(row);
    const canonical = canonicalUnderlying(raw);
    let entry = heldRawsByCanonical.get(canonical);
    if (!entry) {
      entry = { core: new Set(), any: new Set() };
      heldRawsByCanonical.set(canonical, entry);
    }
    entry.any.add(raw);
    if ((row.security_type ?? "").toLowerCase() !== "option") entry.core.add(raw);
  }
  const displayByCanonical = new Map<string, string>();
  for (const [canonical, { core, any }] of heldRawsByCanonical) {
    const pick = core.size > 0 ? core : any;
    const label = [...pick].sort().join("/");
    if (label && label !== canonical) displayByCanonical.set(canonical, label);
  }
  const relabel = (u: string): string => displayByCanonical.get(u) ?? u;

  // ─── Note 3 + instrument assembly ──────────────────────────────────
  const instruments: DefenseInstrument[] = [];
  const appliedLeverageFactorByUnderlying = new Map<string, number>();
  for (const row of rows) {
    const isOption = (row.security_type ?? "").toLowerCase() === "option";
    const raw = rawUnderlyingOf(row);
    const canonical = canonicalUnderlying(raw);
    const meta = underlyingInfo.get(canonical);

    let exposure: number;
    let thetaPerDay: number | null | undefined;
    let delta: number | null | undefined;
    let ivSource: OptionVolSource | undefined;
    let daysToExpiry: number | undefined;
    let strike: number | undefined;
    let underlyingPrice: number | undefined;
    let greeksAvailable = false;

    if (isOption) {
      const g = greeksMap.get(row.security_id);
      if (g && g.greeksAvailable) {
        exposure = g.exposure;
        thetaPerDay = g.thetaAvailable ? g.thetaPerDay : null;
        delta = g.delta;
        ivSource = g.ivSource;
        daysToExpiry = g.daysToExpiry ?? undefined;
        strike = g.strike ?? undefined;
        underlyingPrice = g.underlyingPrice ?? undefined;
        greeksAvailable = true;
      } else {
        exposure = optionExposureFallback(row.option_type, row.mv);
        thetaPerDay = null;
        delta = null;
        daysToExpiry = g?.daysToExpiry ?? undefined;
        strike = g?.strike ?? undefined;
        underlyingPrice = g?.underlyingPrice ?? undefined;
        greeksAvailable = false;
        const reasonDiag = greeksDiagBySymbol.get(row.symbol);
        diagnostics.push({
          kind: "greeks_fallback",
          symbol: row.symbol,
          detail: reasonDiag
            ? `Greeks unavailable (${reasonDiag.reason}) — using the ±2.5× market-value fallback`
            : `Greeks unavailable — using the ±2.5× market-value fallback`,
        });
      }
    } else {
      exposure = row.mv;
    }

    // A leveraged or inverse fund's exposure to the thing it tracks is its
    // money times its signed factor (theme T2): a long 3x inverse fund is
    // SHORT three times its market value. For an option on such a fund the
    // same factor converts delta-notional in the fund into notional in the
    // index. `marketValue` below stays the real money, unscaled.
    const leverageFactor = leveragedBySecurityId.get(row.security_id);
    if (leverageFactor !== undefined) {
      exposure *= leverageFactor;
      // The beta route must not apply this leverage a second time through
      // the fund's own measured beta (creditAtResolvedBeta).
      appliedLeverageFactorByUnderlying.set(canonical, leverageFactor);
    }

    instruments.push({
      securityId: row.security_id,
      symbol: row.symbol,
      underlying: canonical,
      isOption,
      // Case-insensitive normalize — house rule (see options-greeks.ts:399).
      optionType: isOption ? ((row.option_type?.toUpperCase() ?? null) as "CALL" | "PUT" | null) : null,
      quantity: row.quantity,
      exposure,
      marketValue: row.mv,
      underlyingIsEtf: meta?.isEtf ?? false,
      sector: row.sector,
      geography: row.geography,
      greeksAvailable,
      ...(isOption ? { strike, daysToExpiry, thetaPerDay, delta, underlyingPrice } : {}),
      ...(isOption && ivSource ? { ivSource } : {}),
    });
  }

  // ─── Group + classify ───────────────────────────────────────────────
  const groups = new Map<string, UnderlyingGroup>();
  for (const inst of instruments) {
    const g = groups.get(inst.underlying) ?? {
      underlying: inst.underlying,
      underlyingIsEtf: inst.underlyingIsEtf,
      instruments: [],
    };
    g.instruments.push(inst);
    groups.set(inst.underlying, g);
  }
  const classifyResult = classifyBook(groups);

  // ─── Note 5: attribution context ────────────────────────────────────
  const sectorWeights = getEtfSectorWeights(db);
  let totalLongExposure = 0;
  const longExposureBySector = new Map<string, number>();
  const longExposureByGeography = new Map<string, number>();

  /**
   * The weights key for a family: its canonical key (the key attributeProxies
   * reads), else the first sibling, in sorted order, that has weights. The
   * long side and the Tier-1 credit both read it, so the two always spread a
   * fund the same way.
   */
  const weightsKeyFor = (canonical: string): string => {
    if (sectorWeights.has(canonical)) return canonical;
    return (
      issuerSiblings(canonical)
        .slice()
        .sort()
        .find((s) => sectorWeights.has(s)) ?? canonical
    );
  };

  /**
   * One amount spread across sectors, conserved: explodeHoldingBySector's
   * parts, then any shortfall (look-through weights summing under 100) put
   * in the fund's own sector, or "Unknown" when it has none, and an excess
   * (weights over 100) scaled back. A fund's long exposure and the credit
   * for a hedge on it both go through here.
   */
  const spreadBySector = (
    canonical: string,
    securityType: string | null,
    amount: number,
    ownSector: string | null | undefined
  ): Array<{ sector: string; value: number }> => {
    const parts = explodeHoldingBySector(weightsKeyFor(canonical), securityType, amount, sectorWeights, ownSector);
    return conserveSectorParts(parts, amount, ownSector);
  };

  // A call held against a short is a hedge of the short book, not a long
  // bet (owner ruling 2026-11-15, K4a). Its credited delta is left out of the
  // long book, the same way a protective put's delta never enters it; only
  // any part beyond the short (uncredited, a net-long bet) stays long.
  const shortHedgeCreditedFraction = new Map<number, number>();
  for (const pair of classifyResult.pairs) {
    if (pair.coreExposure >= 0 || pair.offsetExposure <= 0) continue;
    const fraction = pair.offsetCredited / pair.offsetExposure;
    for (const inst of pairHedgeInstruments(pair)) shortHedgeCreditedFraction.set(inst.securityId, fraction);
  }
  let shortSideHedgeExposure = 0;

  for (const inst of instruments) {
    if (inst.exposure <= 0) continue;
    const excluded = inst.exposure * (shortHedgeCreditedFraction.get(inst.securityId) ?? 0);
    shortSideHedgeExposure += excluded;
    const longPart = inst.exposure - excluded;
    if (longPart <= 0) continue;
    totalLongExposure += longPart;

    // A fund held through call options is exposed to the fund's sectors just
    // as its shares are: spread by the same look-through weights, with the
    // underlying's own sector as the home for any remainder.
    const meta = underlyingInfo.get(inst.underlying);
    const parts = inst.isOption
      ? spreadBySector(inst.underlying, meta?.isEtf ? "ETF" : null, longPart, meta?.sector ?? inst.sector)
      : spreadBySector(inst.underlying, securityTypeById.get(inst.securityId) ?? null, longPart, inst.sector);
    for (const p of parts) {
      longExposureBySector.set(p.sector, (longExposureBySector.get(p.sector) ?? 0) + p.value);
    }

    const geo = meta?.geography ?? inst.geography ?? "Unknown";
    longExposureByGeography.set(geo, (longExposureByGeography.get(geo) ?? 0) + longPart);
  }

  const tier1CreditedBySector = new Map<string, number>();
  for (const pair of classifyResult.pairs) {
    // Long-book pairs only: a short's hedge is not long-sector cover (K4a).
    if (pair.offsetCredited > 0 && pair.coreExposure > 0) {
      // A hedge on a fund protects the whole fund: spread the credit by the
      // same look-through weights its long exposure was spread by above
      // (explodeHoldingBySector), never all of it onto the fund's own single
      // securities.sector. A single name (or a fund with no weights) keeps
      // one bucket, as before. The parts sum to offsetCredited
      // (spreadBySector conserves it).
      const parts = spreadBySector(
        pair.underlying,
        underlyingInfo.get(pair.underlying)?.isEtf ? "ETF" : null,
        pair.offsetCredited,
        pair.sector
      );
      for (const p of parts) {
        tier1CreditedBySector.set(p.sector, (tier1CreditedBySector.get(p.sector) ?? 0) + p.value);
      }
    }
  }

  // Wrap resolveProxyBeta: attributeProxies calls it only for a fund that
  // missed sector weights and geography and is credited on its beta (own
  // sector or the book). The route diagnostic is pushed after attribution,
  // per route; unmeasured_beta here when no beta could be measured.
  const resolveBeta = (symbol: string): ResolvedBeta => {
    const result = resolveProxyBeta(db, symbol);
    if (result.source === "unmeasured") {
      diagnostics.push({
        kind: "unmeasured_beta",
        symbol,
        detail:
          result.reason === "low_fit"
            ? `Measured beta for ${symbol} failed the fit test (r² below the floor) — not credited`
            : `This app has not collected enough price history for ${symbol} to measure a beta` +
              (result.history
                ? ` (${result.history.closesOnFile} daily closes on file, ${result.history.usablePairs} usable day-to-day moves, ${result.history.pairsNeeded} needed)`
                : "") +
              " — not credited",
      });
    }
    return result;
  };

  const attributionCtx: AttributionContext = {
    sectorWeights,
    etfGeography,
    longExposureBySector,
    longExposureByGeography,
    tier1CreditedBySector,
    totalLongExposure,
    resolveBeta,
    ownSectorByUnderlying: new Map([...underlyingInfo].map(([u, m]) => [u, m.sector])),
    fundIdentityByUnderlying: new Map(
      [...underlyingInfo].map(([u, m]) => [
        u,
        {
          fundCategory: m.fundCategory,
          assetClass: m.assetClass,
          sector: m.sector,
          leveraged: m.leverageFactor !== null,
        },
      ])
    ),
    appliedLeverageFactorByUnderlying,
  };

  const { proxies, sectorCoverage } = attributeProxies(classifyResult.proxyCandidates, attributionCtx);
  for (const hedge of proxies) {
    const detail =
      hedge.route === "beta"
        ? `No cached sector weights or geography match for ${hedge.underlying} — routed to beta-weighted broad-book credit`
        : hedge.route === "own_sector"
          ? `No cached sector weights for ${hedge.underlying} — credited to its own sector at its beta`
          : hedge.route === "not_credited"
            ? `No cached sector weights for ${hedge.underlying} — not credited (${hedge.notCreditedReason})`
            : null;
    if (detail) diagnostics.push({ kind: "no_sector_weights", symbol: hedge.underlying, detail });
  }

  // ─── Note 6: hedge score inputs ──────────────────────────────────────
  const pairsByUnderlying = new Map(classifyResult.pairs.map((p) => [p.underlying, p]));
  const scoreInputs: HedgeScoreInput[] = [];

  for (const pair of classifyResult.pairs) {
    if (pair.offsetExposure <= 0) continue;
    const opposing = pairHedgeInstruments(pair);
    const creditRatio = pair.offsetCredited / pair.offsetExposure;
    for (const inst of opposing) {
      scoreInputs.push({
        instrument: inst,
        protects: pair.underlying,
        protectedNotional: Math.abs(inst.exposure) * creditRatio,
        side: pair.coreExposure < 0 ? "short" : "long",
      });
    }
  }

  // Spill double-attribution guard: a tier1_spill proxy candidate shares its
  // `instruments` array with the pair it spilled from. Score the pair-side
  // fraction above (credited/offset) and the spill-side fraction here
  // (spill/offset) — the two fractions sum to 1, so the same dollar is never
  // scored twice.
  //
  // Index coupling: attributeProxies() emits exactly one ProxyHedge per
  // ProxyCandidate, IN ORDER — proxies[i] always describes
  // classifyResult.proxyCandidates[i]. Don't reorder either array independently.
  classifyResult.proxyCandidates.forEach((candidate, i) => {
    const hedge = proxies[i];
    // A not-credited fund hedge earns no hedge-book row; it is listed in
    // notCreditedHedges instead (K4b).
    if (hedge.route === "not_credited") return;
    const routeDescription = describeProxyRoute(hedge);
    // Only protective instruments earn a hedge-book row (proxyHedgeInstruments).
    // tier1_spill and no_core_etf candidates already carry only protective
    // instruments; etf_negative_stack's `instruments` is the WHOLE underlying
    // group, whose calls and written puts must never surface as a "hedge".
    const protective = proxyHedgeInstruments(candidate);
    if (candidate.source === "tier1_spill") {
      const pair = pairsByUnderlying.get(candidate.underlying);
      const ratio = pair && pair.offsetExposure > 0 ? candidate.protectiveNotional / pair.offsetExposure : 0;
      for (const inst of protective) {
        scoreInputs.push({
          instrument: inst,
          protects: routeDescription,
          protectedNotional: Math.abs(inst.exposure) * ratio,
        });
      }
    } else {
      // Scale to the credited notional so an etf_negative_stack core's full
      // (pre-offset) exposure never overstates what's actually protecting the
      // book — mirrors the tier1_spill ratio above. For no_core_etf the
      // ratio is 1 unless written puts reduced the long puts' protection.
      const protectiveSum = sum(protective.map((inst) => Math.abs(inst.exposure)));
      const ratio = protectiveSum > 0 ? candidate.protectiveNotional / protectiveSum : 0;
      for (const inst of protective) {
        scoreInputs.push({
          instrument: inst,
          protects: routeDescription,
          protectedNotional: Math.abs(inst.exposure) * ratio,
        });
      }
    }
  });

  const hedgeScores = scoreHedges(scoreInputs);

  // ─── Note 7: summary ─────────────────────────────────────────────────
  // Short exposure here is per INSTRUMENT (the protection book: a long put
  // is short exposure). Net, gross and the name long/short come from the
  // one by-name helper the Diagnostics badge reads (owner ruling 2026-11-24:
  // each name, its shares plus its options at delta, netted first): the same
  // helper and the same rule, over DEFENSE'S OWN universe (stocks, ETFs,
  // options and mutual funds), which leaves bonds out. The four figures
  // match the badge's only for a scope that holds no bond.
  let shortExposure = 0;
  for (const inst of instruments) {
    if (inst.exposure < 0) shortExposure += inst.exposure;
  }
  const rowBySecurityId = new Map(rows.map((r) => [r.security_id, r]));
  const byName = nameNettedExposure(
    instruments.map((inst) => {
      const row = rowBySecurityId.get(inst.securityId);
      return {
        name: row ? exposureNameKey(row) : inst.securityId,
        exposure: inst.exposure,
      };
    })
  );
  const netExposure = byName.net;
  const grossExposure = byName.gross;

  // Long-book protection only (K4a); a short's hedge is reported apart.
  let protectiveNotional = 0;
  let shortSideHedgeNotional = 0;
  for (const pair of classifyResult.pairs) {
    if (pair.coreExposure < 0) shortSideHedgeNotional += pair.offsetCredited;
    else protectiveNotional += pair.offsetCredited;
  }
  for (const proxy of proxies) {
    for (const c of proxy.creditedTo) protectiveNotional += c.credited;
  }

  const summary: DefenseSummary = {
    longExposure: totalLongExposure,
    shortExposure,
    protectiveNotional,
    protectionRatio: totalLongExposure > 0 ? protectiveNotional / totalLongExposure : null,
    netExposure,
    grossExposure,
    nameLongExposure: byName.long,
    nameShortExposure: byName.short,
    shortSideHedgeNotional,
    shortSideHedgeExposure,
    shortSideHedgeCount: hedgeScores.filter((h) => h.side === "short").length,
    longSideHedgeCount: hedgeScores.filter((h) => h.side !== "short").length,
    notCreditedCount: proxies.filter((p) => p.route === "not_credited").length,
    hedgeCount: hedgeScores.length,
    optionPositionCount: instruments.filter((i) => i.isOption).length,
    shortPositionCount: instruments.filter((i) => i.quantity < 0).length,
  };

  // ─── Note 8: ranked exposures ────────────────────────────────────────
  function coreSecurityId(insts: DefenseInstrument[], canonical: string): number | null {
    const core = insts.find((i) => !i.isOption);
    if (core) return core.securityId;
    return underlyingInfo.get(canonical)?.securityId ?? null;
  }

  // Legs are listed only for a row with no shares behind it.
  const optionOnlyLegs = (insts: DefenseInstrument[]): { legs?: RankedExposureLeg[] } =>
    insts.length > 0 && insts.every((i) => i.isOption)
      ? {
          legs: insts.map((i) => ({
            securityId: i.securityId,
            symbol: i.symbol,
            optionType: i.optionType,
            quantity: i.quantity,
            exposure: i.exposure,
          })),
        }
      : {};

  const rankedExposures: RankedExposure[] = [];
  for (const pair of classifyResult.pairs) {
    rankedExposures.push({
      underlying: pair.underlying,
      netExposure: pair.netExposure,
      pctOfBook: totalLongExposure > 0 ? Math.abs(pair.netExposure) / totalLongExposure : null,
      tier1CoveragePct: pair.coveragePct,
      // Sector cover is long-book cover: a short row shows none (K4e).
      sectorProxyCoveragePct:
        pair.sector && pair.coreExposure >= 0
          ? sectorCoverage.find((s) => s.sector === pair.sector)?.coveragePct ?? null
          : null,
      classification: pair.classification,
      hasAmplifiers: pair.hasAmplifiers,
      sector: pair.sector,
      securityId: coreSecurityId(pair.instruments, pair.underlying),
      ...(pair.notes && pair.notes.length > 0 ? { notes: pair.notes } : {}),
      ...optionOnlyLegs(pair.instruments),
    });
  }
  for (const bet of classifyResult.standaloneBets) {
    const sector = bet.instruments.find((i) => i.sector)?.sector ?? null;
    rankedExposures.push({
      underlying: bet.underlying,
      netExposure: bet.exposure,
      pctOfBook: totalLongExposure > 0 ? Math.abs(bet.exposure) / totalLongExposure : null,
      tier1CoveragePct: null,
      // Every standalone bet is net short: long-sector cover does not apply.
      sectorProxyCoveragePct: null,
      // Standalone bets are, by definition, never paired with an offsetting
      // instrument — "unhedged" is the PairClassification value that matches.
      classification: "unhedged",
      hasAmplifiers: false,
      sector,
      securityId: coreSecurityId(bet.instruments, bet.underlying),
      ...(bet.notes && bet.notes.length > 0 ? { notes: bet.notes } : {}),
      ...optionOnlyLegs(bet.instruments),
    });
  }
  rankedExposures.sort((a, b) => Math.abs(b.netExposure) - Math.abs(a.netExposure));

  // Relabel at the boundary only — grouping, spill-index coupling, and score
  // joins above all ran on canonical keys. `protects` may carry a route
  // description ("sector: …", "book (β=…)"), which relabel() passes through.
  const relabelInstruments = (insts: DefenseInstrument[]): DefenseInstrument[] =>
    insts.map((i) => ({ ...i, underlying: relabel(i.underlying) }));

  // Cash line: the concentration card's own cash figure for this scope
  // (splitConcentrationUniverse), shown beside the ratio, never inside it.
  const cashSplit = splitConcentrationUniverse(getConcentrationUniverse(db, scopedAccountIds));
  const cashLine: DefenseCashLine = {
    weight: cashSplit.cash.weight,
    marketValue: cashSplit.cash.marketValue,
    holdingCount: cashSplit.cash.holdingCount,
    borrowed: { ...cashSplit.negativeCash },
  };

  return {
    summary,
    cashLine,
    pairs: classifyResult.pairs.map((p) => ({
      ...p,
      underlying: relabel(p.underlying),
      instruments: relabelInstruments(p.instruments),
    })),
    proxies: proxies.map((p) => ({
      ...p,
      underlying: relabel(p.underlying),
      instruments: relabelInstruments(p.instruments),
    })),
    sectorCoverage,
    standaloneBets: classifyResult.standaloneBets.map((b) => ({
      ...b,
      underlying: relabel(b.underlying),
      instruments: relabelInstruments(b.instruments),
    })),
    rankedExposures: rankedExposures.map((r) => ({ ...r, underlying: relabel(r.underlying) })),
    hedgeScores: hedgeScores.map((h) => ({
      ...h,
      underlying: relabel(h.underlying),
      protects: relabel(h.protects),
    })),
    diagnostics,
    notCreditedHedges: proxies
      .filter((p) => p.route === "not_credited")
      .map((p) => ({
        underlying: relabel(p.underlying),
        symbols: proxyHedgeInstruments(classifyResult.proxyCandidates[proxies.indexOf(p)]).map((i) => i.symbol),
        protectiveNotional: p.protectiveNotional,
        reason: p.notCreditedReason ?? NOT_CREDITED_UNKNOWN,
        ...(p.betaHistory ? { betaHistory: p.betaHistory } : {}),
      })),
    leveragedFundsUnmodelled,
    // Counted over the option rows this analysis actually loaded, so a
    // contract outside the view's universe never inflates it.
    siblingPricedPositions: rows.filter(
      (r) =>
        (r.security_type ?? "").toLowerCase() === "option" &&
        siblingPricedSecurityIds.has(r.security_id)
    ).length,
  };
}
