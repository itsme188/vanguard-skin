/**
 * Options Strategy Detection Engine.
 *
 * Pure functions that analyze a set of positions (stock + option holdings
 * in the same account) and identify common option strategies.
 *
 * Detects: covered call, protective put, vertical spread (bull/bear),
 * straddle, strangle, iron condor, naked options.
 */

import { todayET } from "@/lib/calendar/date-utils";

// ─── Types ──────────────────────────────────────────────────────

export interface PositionLeg {
  symbol: string;
  underlying: string;
  securityType: "stock" | "option";
  optionType?: "CALL" | "PUT";
  strike?: number;
  expiration?: string;
  quantity: number; // signed: positive = long, negative = short
  multiplier: number;
  currentPrice?: number | null;
}

export type StrategyType =
  | "covered_call"
  | "protective_put"
  | "bull_call_spread"
  | "bear_call_spread"
  | "bull_put_spread"
  | "bear_put_spread"
  | "straddle"
  | "strangle"
  | "iron_condor"
  | "naked_call"
  | "naked_put";

export interface DetectedStrategy {
  type: StrategyType;
  name: string;
  underlying: string;
  expiration?: string;
  legs: PositionLeg[];
  maxProfit: number | null; // null if unlimited
  maxLoss: number | null; // null if unlimited
  breakevens: number[];
  description: string;
  /**
   * True when any leg feeding the payoff (option OR stock) lacks a usable
   * mark. The structure is still reported, but maxProfit / maxLoss are null
   * and breakevens empty — missing, zero, or stale prices must never be
   * modelled as a $0 premium. Consumers MUST check this before reading a null
   * maxProfit / maxLoss as "unlimited".
   */
  pricingIncomplete: boolean;
  /**
   * WHY the figures are withheld; null when pricingIncomplete is false. A
   * price row can exist and still be unusable, so the note under a withheld
   * strategy is worded from this, never assumed to be "no price yet".
   */
  pricingIncompleteReason: PricingIncompleteReason | null;
}

/**
 * - `missing_price`   — a leg has no price at all (or a non-finite one).
 * - `zero_mark`       — a leg is marked at zero or below.
 * - `below_intrinsic` — an option is marked below what it is worth if
 *                       exercised right now, so the mark cannot be real.
 */
export type PricingIncompleteReason =
  | "missing_price"
  | "zero_mark"
  | "below_intrinsic";

/**
 * The sentence shown under a strategy whose figures are withheld. Worded from
 * the reason: "no price yet" is false when a price exists but is zero or
 * below intrinsic value. An absent reason (an older payload) gets the neutral
 * wording.
 */
export function pricingIncompleteNote(
  reason: PricingIncompleteReason | null | undefined
): string {
  switch (reason) {
    case "missing_price":
      return "One or more legs have no price yet — refresh prices to compute the payoff.";
    case "zero_mark":
      return "One or more legs are marked at zero, which is not a real price — the payoff is withheld until a real mark arrives.";
    case "below_intrinsic":
      return "An option leg is marked below its intrinsic value (what it is worth if exercised now), so the mark is stale — the payoff is withheld until prices refresh.";
    default:
      return "One or more legs have no usable price — the payoff is withheld.";
  }
}

/** A strategy as the builders produce it, before the pricing gate runs. */
type StrategyDraft = Omit<
  DetectedStrategy,
  "pricingIncomplete" | "pricingIncompleteReason"
>;

/** Worst problem first: the note names one reason per strategy. */
const REASON_PRIORITY: PricingIncompleteReason[] = [
  "missing_price",
  "zero_mark",
  "below_intrinsic",
];

/**
 * Why a leg's mark is not payoff-grade, or null when it is usable.
 *
 * `underlyingPrice` is the underlying stock's price as detectStrategies knows
 * it (the account's stock leg), NOT a search of the strategy's own legs — a
 * spread or a naked option has no stock leg, and searching its legs left every
 * such option unchecked against intrinsic value.
 *
 * Intrinsic rule: an option's mark is withheld only when it sits below
 * intrinsic value by MORE than max($0.05, 1% of intrinsic). The stock close
 * and the option close are taken moments apart, so a real mark can trail
 * intrinsic by a few cents; anything further below cannot be a real price.
 *
 * When the underlying has no usable price (the account holds no stock leg for
 * it, or that leg is unpriced) intrinsic cannot be checked: the option's mark
 * is then accepted on the positive-and-finite test alone.
 */
function legPricingProblem(
  leg: PositionLeg,
  underlyingPrice: number | null | undefined
): PricingIncompleteReason | null {
  if (typeof leg.currentPrice !== "number" || !Number.isFinite(leg.currentPrice)) {
    return "missing_price";
  }
  if (leg.currentPrice <= 0) return "zero_mark";

  if (leg.securityType !== "option" || !leg.optionType || leg.strike == null) {
    return null;
  }
  if (
    typeof underlyingPrice !== "number" ||
    !Number.isFinite(underlyingPrice) ||
    underlyingPrice <= 0
  ) {
    return null;
  }

  const intrinsic =
    leg.optionType === "PUT"
      ? leg.strike - underlyingPrice
      : underlyingPrice - leg.strike;
  if (intrinsic <= 0) return null;
  const tolerance = Math.max(0.05, intrinsic * 0.01);
  return leg.currentPrice < intrinsic - tolerance ? "below_intrinsic" : null;
}

/**
 * The single pricing gate for every builder. The builders price a missing
 * leg at `?? 0`, which turns "no price row" into a $0 premium and a
 * confident-looking max loss / breakeven (QA
 * analysis-detected-strategies--protective-put-missing-put-price-treated-as-zero-premium).
 * Stale below-intrinsic and zero marks are equally unsafe: when any leg is not
 * payoff-grade the figures are withheld; fully priced strategies pass through
 * with their math untouched.
 */
function withPricing(
  draft: StrategyDraft,
  underlyingPrice: number | null | undefined
): DetectedStrategy {
  const problems = new Set(
    draft.legs.map((leg) => legPricingProblem(leg, underlyingPrice))
  );
  const reason = REASON_PRIORITY.find((r) => problems.has(r)) ?? null;
  if (reason === null) {
    return { ...draft, pricingIncomplete: false, pricingIncompleteReason: null };
  }
  return {
    ...draft,
    maxProfit: null,
    maxLoss: null,
    breakevens: [],
    pricingIncomplete: true,
    pricingIncompleteReason: reason,
  };
}

// ─── Strategy Detection ─────────────────────────────────────────

/**
 * Normalize an expiration to ISO YYYY-MM-DD for date comparison. Accepts both
 * spellings the DB actually holds — ISO, and the YYYYMMDD a handful of
 * TWS-enriched rows carry (same two shapes formatExpiry parses). Returns null
 * for missing/unrecognized values, which callers must treat as "unknown",
 * never as expired.
 */
function normalizeExpiration(expiry?: string): string | null {
  if (!expiry) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return expiry;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(expiry);
  return compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : null;
}

export interface DetectStrategiesOptions {
  /** ET "today" (YYYY-MM-DD) used as the expiry cutoff. Defaults to todayET(). */
  today?: string;
}

/**
 * Detect option strategies from a set of positions in the same account.
 * Positions should all belong to the same account.
 *
 * Contracts that expired BEFORE `today` are excluded: an expired contract is
 * not a position, and pricing one produced a live-looking protective put with
 * a MAX LOSS figure on a contract that had already settled (QA
 * analysis-detected-strategies--expired-option-rendered-live-protective-put).
 * The Options Greeks table, the Defense hedge book and the Option Expirations
 * panel all already exclude them — this brings strategy detection in line.
 * Expiry day itself still counts (the contract can be exercised or traded),
 * and an unknown/unparseable expiration is kept rather than guessed away.
 */
export function detectStrategies(
  positions: PositionLeg[],
  opts: DetectStrategiesOptions = {}
): DetectedStrategy[] {
  const strategies: StrategyDraft[] = [];
  const today = opts.today ?? todayET();

  // Separate stocks and options
  const stocks = positions.filter((p) => p.securityType === "stock");
  const options = positions.filter((p) => {
    if (p.securityType !== "option") return false;
    const expiration = normalizeExpiration(p.expiration);
    return expiration === null || expiration >= today;
  });

  // Group options by underlying
  const optionsByUnderlying = new Map<string, PositionLeg[]>();
  for (const opt of options) {
    const group = optionsByUnderlying.get(opt.underlying) || [];
    group.push(opt);
    optionsByUnderlying.set(opt.underlying, group);
  }

  // Index stock positions by symbol for lookup
  const stockBySymbol = new Map<string, PositionLeg>();
  for (const s of stocks) {
    stockBySymbol.set(s.symbol, s);
  }

  for (const [underlying, opts] of optionsByUnderlying) {
    const stock = stockBySymbol.get(underlying);

    // Check for covered calls and protective puts
    if (stock && stock.quantity > 0) {
      strategies.push(...detectCoveredStrategies(stock, opts));
    }

    // Check for spreads, straddles, strangles, iron condors
    strategies.push(...detectSpreadStrategies(underlying, opts));

    // Check for naked options (options without stock coverage or spread)
    const usedSymbols = new Set(strategies.flatMap((s) => s.legs.map((l) => l.symbol)));
    for (const opt of opts) {
      if (!usedSymbols.has(opt.symbol) && opt.quantity < 0) {
        strategies.push(createNakedOption(underlying, opt));
      }
    }
  }

  return strategies.map((draft) =>
    withPricing(draft, stockBySymbol.get(draft.underlying)?.currentPrice)
  );
}

// ─── Covered Strategies (stock + option) ────────────────────────

function detectCoveredStrategies(
  stock: PositionLeg,
  options: PositionLeg[]
): StrategyDraft[] {
  const strategies: StrategyDraft[] = [];
  const shares = stock.quantity;

  // Covered Call: long stock + short call
  const shortCalls = options.filter(
    (o) => o.optionType === "CALL" && o.quantity < 0
  );
  for (const call of shortCalls) {
    const coveredContracts = Math.min(
      Math.abs(call.quantity),
      Math.floor(shares / (call.multiplier || 100))
    );
    if (coveredContracts <= 0) continue;

    const strike = call.strike!;
    const premium = (call.currentPrice ?? 0) * call.multiplier;
    const stockCost = stock.currentPrice ?? 0;
    // Worst case is the stock going to zero. Same convention as the protective
    // put below: every share held carries its full value down, and only the
    // covered contracts' premium is received. Shares BEYOND the covered
    // contracts are unhedged long stock (the call gives them no cushion), so
    // they must not be left out of the loss. Floored at 0.
    const coveredShares = coveredContracts * call.multiplier;
    const uncoveredShares = Math.max(0, shares - coveredShares);
    const coveredPremium = (call.currentPrice ?? 0) * call.multiplier * coveredContracts;
    const maxLoss = Math.max(
      0,
      coveredShares * stockCost + uncoveredShares * stockCost - coveredPremium
    );
    // Short calls beyond what the shares cover are NAKED: above the strike
    // their loss has no limit. The figures here stay those of the covered
    // part, so the description must say so in words — a finite max loss with
    // no caveat would read as the whole position's risk.
    const nakedContracts = Math.abs(call.quantity) - coveredContracts;

    strategies.push({
      type: "covered_call",
      name: `Covered Call: ${stock.symbol} ${formatStrike(strike)} Call`,
      underlying: stock.symbol,
      expiration: call.expiration,
      legs: [stock, call],
      // The short call caps the upside of the COVERED shares only. Any share
      // beyond coveredContracts x multiplier is plain long stock with no cap,
      // so the package's upside is unlimited (null) — a finite figure here
      // would understate it.
      // With NAKED contracts the position is net short above the strike, so
      // the upside is not unlimited: profit peaks AT the strike, where every
      // share has gained (strike - cost) and every short call expires
      // worthless with its premium kept.
      maxProfit:
        nakedContracts > 0
          ? (strike - stockCost) * shares +
            (call.currentPrice ?? 0) * call.multiplier * Math.abs(call.quantity)
          : uncoveredShares > 0
            ? null
            : (strike - stockCost + (call.currentPrice ?? 0)) * call.multiplier * coveredContracts,
      maxLoss,
      breakevens: [stockCost - (call.currentPrice ?? 0)],
      description: `Long ${shares} shares + short ${Math.abs(call.quantity)} ${formatExpiry(call.expiration)} ${formatStrike(strike)} call${Math.abs(call.quantity) > 1 ? "s" : ""}${
        uncoveredShares > 0
          ? ` (${coveredShares} sh covered of ${shares} held — ${uncoveredShares} sh ${nakedContracts > 0 ? "beyond the covered contracts" : "uncapped"})`
          : ""
      }${
        nakedContracts > 0
          ? `. ${nakedContracts} call contract${nakedContracts > 1 ? "s are" : " is"} uncovered: unlimited loss above ${formatStrike(strike)}; max profit is reached at the strike, and the max loss shown is the downside case only`
          : ""
      }`,
    });
  }

  // Protective Put: long stock + long put
  const longPuts = options.filter(
    (o) => o.optionType === "PUT" && o.quantity > 0
  );
  for (const put of longPuts) {
    const strike = put.strike!;
    const stockCost = stock.currentPrice ?? 0;
    const putCost = put.currentPrice ?? 0;
    const contracts = put.quantity;
    // Puts beyond the share count are outright long puts — their downside is
    // capped at their own premium, not the (price - strike) share loss. Only
    // the covered shares carry that leg of the worst case; shares BEYOND what
    // the puts cover are unhedged long stock and carry their full cost down.
    const putSharesCovered = put.multiplier * contracts;
    const coveredShares = Math.min(shares, putSharesCovered);
    const uncoveredShares = Math.max(0, shares - putSharesCovered);
    const totalPremium = putCost * put.multiplier * contracts;
    const overHedged = putSharesCovered > shares;

    // The expiry payoff is piecewise linear with its only kink at the strike,
    // so the worst case is the worse of two candidate prices:
    //   P = strike — the hedge pays nothing and every share held is down
    //                (stockCost - strike);
    //   P = 0      — the covered shares are made whole at the strike, but the
    //                UNCOVERED shares lose their entire cost.
    // They coincide when the puts cover every share; when they cover fewer (an
    // under-hedge) P = 0 is worse by strike x uncovered shares, and pricing
    // only the covered shares left those naked shares out of the worst case
    // altogether. Every contract's premium is spent either way — and on the
    // covered shares (stockCost - strike) goes NEGATIVE once the put is
    // in-the-money, netting the intrinsic value back so only the time value is
    // at risk there. Floored at 0 (a stale mark can price the put below
    // intrinsic; a guaranteed gain is not a loss).
    const maxLoss = Math.max(
      0,
      coveredShares * (stockCost - strike) +
        uncoveredShares * stockCost +
        totalPremium
    );
    // Breakeven is the expiry price that returns the package to flat. Above
    // the strike the puts expire worthless, so EVERY share held carries its
    // slice of the premium: spread the premium over `shares`, not over the
    // covered subset (which overstated the breakeven whenever the puts covered
    // fewer shares than were held). Falls back to price + premium if there are
    // no shares to divide by.
    const breakeven =
      shares > 0 ? stockCost + totalPremium / shares : stockCost + putCost;

    // Name the unhedged shares explicitly: a hedge that covers only part of
    // the position must never read like a fully protected one.
    const putWord = `put${contracts > 1 ? "s" : ""}`;
    const coverageNote = overHedged
      ? ` (${contracts} ${putWord} cover ${putSharesCovered} sh vs ${shares} held)`
      : uncoveredShares > 0
        ? ` (${contracts} ${putWord} hedge ${coveredShares} sh of ${shares} held — ${uncoveredShares} sh unhedged)`
        : "";

    strategies.push({
      type: "protective_put",
      name: `Protective Put: ${stock.symbol} ${formatStrike(strike)} Put`,
      underlying: stock.symbol,
      expiration: put.expiration,
      legs: [stock, put],
      maxProfit: null, // unlimited upside
      maxLoss,
      breakevens: [breakeven],
      description: `Long ${shares} shares + long ${contracts} ${formatExpiry(put.expiration)} ${formatStrike(strike)} ${putWord}${coverageNote}`,
    });
  }

  return strategies;
}

// ─── Spread Strategies (option + option) ────────────────────────

function detectSpreadStrategies(
  underlying: string,
  options: PositionLeg[]
): StrategyDraft[] {
  const strategies: StrategyDraft[] = [];

  // Group by expiration
  const byExpiry = new Map<string, PositionLeg[]>();
  for (const opt of options) {
    if (!opt.expiration) continue;
    const group = byExpiry.get(opt.expiration) || [];
    group.push(opt);
    byExpiry.set(opt.expiration, group);
  }

  for (const [expiry, expiryOpts] of byExpiry) {
    const calls = expiryOpts.filter((o) => o.optionType === "CALL");
    const puts = expiryOpts.filter((o) => o.optionType === "PUT");

    // Vertical Call Spreads
    strategies.push(...detectVerticalSpreads(underlying, expiry, calls, "CALL"));

    // Vertical Put Spreads
    strategies.push(...detectVerticalSpreads(underlying, expiry, puts, "PUT"));

    // Straddle: same strike, same expiry, call + put
    strategies.push(...detectStraddles(underlying, expiry, calls, puts));

    // Strangle: different strikes, same expiry, call + put
    strategies.push(...detectStrangles(underlying, expiry, calls, puts));

    // Iron Condor: bear call spread + bull put spread
    strategies.push(...detectIronCondors(underlying, expiry, calls, puts));
  }

  return strategies;
}

function detectVerticalSpreads(
  underlying: string,
  expiry: string,
  options: PositionLeg[],
  type: "CALL" | "PUT"
): StrategyDraft[] {
  const strategies: StrategyDraft[] = [];

  const longs = options.filter((o) => o.quantity > 0);
  const shorts = options.filter((o) => o.quantity < 0);

  for (const long of longs) {
    for (const short of shorts) {
      if (!long.strike || !short.strike || long.strike === short.strike) continue;

      const lowStrike = Math.min(long.strike, short.strike);
      const highStrike = Math.max(long.strike, short.strike);
      const spread = highStrike - lowStrike;
      const multiplier = long.multiplier;
      // Dollar figures cover the MATCHED contracts only; breakevens are per
      // share and do not scale. Any remainder is named in the description.
      const contracts = matchedContracts([long, short]);
      const size = multiplier * contracts;

      if (type === "CALL") {
        if (long.strike < short.strike) {
          // Bull Call Spread: buy lower, sell higher
          const netDebit = ((long.currentPrice ?? 0) - (short.currentPrice ?? 0)) * size;
          strategies.push({
            type: "bull_call_spread",
            name: `Bull Call Spread: ${underlying} ${formatStrike(lowStrike)}/${formatStrike(highStrike)}`,
            underlying,
            expiration: expiry,
            legs: [long, short],
            maxProfit: (spread * size) - netDebit,
            maxLoss: netDebit,
            breakevens: [lowStrike + netDebit / size],
            description: `Long ${formatStrike(lowStrike)} call, short ${formatStrike(highStrike)} call ${formatExpiry(expiry)}${sizingNote([long, short], contracts)}`,
          });
        } else {
          // Bear Call Spread: sell lower, buy higher
          const netCredit = ((short.currentPrice ?? 0) - (long.currentPrice ?? 0)) * size;
          strategies.push({
            type: "bear_call_spread",
            name: `Bear Call Spread: ${underlying} ${formatStrike(lowStrike)}/${formatStrike(highStrike)}`,
            underlying,
            expiration: expiry,
            legs: [short, long],
            maxProfit: netCredit,
            maxLoss: (spread * size) - netCredit,
            breakevens: [lowStrike + netCredit / size],
            description: `Short ${formatStrike(lowStrike)} call, long ${formatStrike(highStrike)} call ${formatExpiry(expiry)}${sizingNote([long, short], contracts)}`,
          });
        }
      } else {
        // PUT spreads
        if (long.strike > short.strike) {
          // Bear Put Spread: buy higher, sell lower
          const netDebit = ((long.currentPrice ?? 0) - (short.currentPrice ?? 0)) * size;
          strategies.push({
            type: "bear_put_spread",
            name: `Bear Put Spread: ${underlying} ${formatStrike(lowStrike)}/${formatStrike(highStrike)}`,
            underlying,
            expiration: expiry,
            legs: [long, short],
            maxProfit: (spread * size) - netDebit,
            maxLoss: netDebit,
            breakevens: [highStrike - netDebit / size],
            description: `Long ${formatStrike(highStrike)} put, short ${formatStrike(lowStrike)} put ${formatExpiry(expiry)}${sizingNote([long, short], contracts)}`,
          });
        } else {
          // Bull Put Spread: sell higher, buy lower
          const netCredit = ((short.currentPrice ?? 0) - (long.currentPrice ?? 0)) * size;
          strategies.push({
            type: "bull_put_spread",
            name: `Bull Put Spread: ${underlying} ${formatStrike(lowStrike)}/${formatStrike(highStrike)}`,
            underlying,
            expiration: expiry,
            legs: [short, long],
            maxProfit: netCredit,
            maxLoss: (spread * size) - netCredit,
            breakevens: [highStrike - netCredit / size],
            description: `Short ${formatStrike(highStrike)} put, long ${formatStrike(lowStrike)} put ${formatExpiry(expiry)}${sizingNote([long, short], contracts)}`,
          });
        }
      }
    }
  }

  return strategies;
}

function detectStraddles(
  underlying: string,
  expiry: string,
  calls: PositionLeg[],
  puts: PositionLeg[]
): StrategyDraft[] {
  const strategies: StrategyDraft[] = [];

  for (const call of calls) {
    for (const put of puts) {
      if (!call.strike || !put.strike) continue;
      if (call.strike !== put.strike) continue;
      // Both same direction (both long or both short)
      if ((call.quantity > 0) !== (put.quantity > 0)) continue;

      const strike = call.strike;
      const isLong = call.quantity > 0;
      const multiplier = call.multiplier;
      // Figures cover the matched contracts; breakevens stay per share.
      const contracts = matchedContracts([call, put]);
      const perShare = (call.currentPrice ?? 0) + (put.currentPrice ?? 0);
      const totalPremium = perShare * multiplier * contracts;

      strategies.push({
        type: "straddle",
        name: `${isLong ? "Long" : "Short"} Straddle: ${underlying} ${formatStrike(strike)}`,
        underlying,
        expiration: expiry,
        legs: [call, put],
        maxProfit: isLong ? null : totalPremium,
        maxLoss: isLong ? totalPremium : null,
        breakevens: [
          strike - perShare,
          strike + perShare,
        ],
        description: `${isLong ? "Long" : "Short"} ${formatStrike(strike)} call + put ${formatExpiry(expiry)}${sizingNote([call, put], contracts)}`,
      });
    }
  }

  return strategies;
}

function detectStrangles(
  underlying: string,
  expiry: string,
  calls: PositionLeg[],
  puts: PositionLeg[]
): StrategyDraft[] {
  const strategies: StrategyDraft[] = [];

  for (const call of calls) {
    for (const put of puts) {
      if (!call.strike || !put.strike) continue;
      if (call.strike === put.strike) continue; // straddle, not strangle
      if (call.strike < put.strike) continue; // call strike should be above put
      if ((call.quantity > 0) !== (put.quantity > 0)) continue;

      const isLong = call.quantity > 0;
      const multiplier = call.multiplier;
      // Figures cover the matched contracts; breakevens stay per share.
      const contracts = matchedContracts([call, put]);
      const perShare = (call.currentPrice ?? 0) + (put.currentPrice ?? 0);
      const totalPremium = perShare * multiplier * contracts;

      strategies.push({
        type: "strangle",
        name: `${isLong ? "Long" : "Short"} Strangle: ${underlying} ${formatStrike(put.strike)}/${formatStrike(call.strike)}`,
        underlying,
        expiration: expiry,
        legs: [put, call],
        maxProfit: isLong ? null : totalPremium,
        maxLoss: isLong ? totalPremium : null,
        breakevens: [
          put.strike - perShare,
          call.strike + perShare,
        ],
        description: `${isLong ? "Long" : "Short"} ${formatStrike(put.strike)} put + ${formatStrike(call.strike)} call ${formatExpiry(expiry)}${sizingNote([put, call], contracts)}`,
      });
    }
  }

  return strategies;
}

function detectIronCondors(
  underlying: string,
  expiry: string,
  calls: PositionLeg[],
  puts: PositionLeg[]
): StrategyDraft[] {
  const strategies: StrategyDraft[] = [];

  // Iron condor = bear call spread (short lower call, long higher call)
  //             + bull put spread (short higher put, long lower put)
  const shortCalls = calls.filter((c) => c.quantity < 0);
  const longCalls = calls.filter((c) => c.quantity > 0);
  const shortPuts = puts.filter((p) => p.quantity < 0);
  const longPuts = puts.filter((p) => p.quantity > 0);

  for (const sc of shortCalls) {
    for (const lc of longCalls) {
      if (!sc.strike || !lc.strike || sc.strike >= lc.strike) continue;
      for (const sp of shortPuts) {
        for (const lp of longPuts) {
          if (!sp.strike || !lp.strike || lp.strike >= sp.strike) continue;
          if (sp.strike >= sc.strike) continue; // put spread must be below call spread

          const multiplier = sc.multiplier;
          const callSpread = lc.strike - sc.strike;
          const putSpread = sp.strike - lp.strike;
          // Figures cover the matched contracts; breakevens stay per share.
          const contracts = matchedContracts([lp, sp, sc, lc]);
          const size = multiplier * contracts;
          const creditPerShare =
            (sc.currentPrice ?? 0) -
            (lc.currentPrice ?? 0) +
            (sp.currentPrice ?? 0) -
            (lp.currentPrice ?? 0);
          const netCredit = creditPerShare * size;

          strategies.push({
            type: "iron_condor",
            name: `Iron Condor: ${underlying} ${formatStrike(lp.strike)}/${formatStrike(sp.strike)}/${formatStrike(sc.strike)}/${formatStrike(lc.strike)}`,
            underlying,
            expiration: expiry,
            legs: [lp, sp, sc, lc],
            maxProfit: netCredit,
            maxLoss: Math.max(callSpread, putSpread) * size - netCredit,
            breakevens: [
              sp.strike - creditPerShare,
              sc.strike + creditPerShare,
            ],
            description: `Put spread ${formatStrike(lp.strike)}/${formatStrike(sp.strike)} + Call spread ${formatStrike(sc.strike)}/${formatStrike(lc.strike)} ${formatExpiry(expiry)}${sizingNote([lp, sp, sc, lc], contracts)}`,
          });
        }
      }
    }
  }

  return strategies;
}

// ─── Contract Sizing (option + option structures) ───────────────

/**
 * A multi-leg structure exists once per MATCHED contract: the smallest
 * contract count across its legs. Dollar figures are sized on this.
 */
function matchedContracts(legs: PositionLeg[]): number {
  return Math.min(...legs.map((l) => Math.abs(l.quantity)));
}

/**
 * Description suffix that states the sizing. Says how many contracts the
 * figures cover when more than one, and names every contract left over when
 * the legs are unequal — the remainder is real exposure that the figures do
 * not include, so it is never dropped silently.
 */
function sizingNote(legs: PositionLeg[], matched: number): string {
  const leftovers = legs
    .filter((l) => Math.abs(l.quantity) > matched)
    .map((l) => {
      const extra = Math.abs(l.quantity) - matched;
      const kind = l.optionType === "CALL" ? "call" : "put";
      return `${extra} ${l.quantity > 0 ? "long" : "short"} ${formatStrike(l.strike!)} ${kind}${extra !== 1 ? "s" : ""}`;
    });
  const sized = `${matched} contract${matched !== 1 ? "s" : ""}`;
  if (leftovers.length > 0) {
    return ` (figures sized on ${sized}; ${leftovers.join(", ")} unmatched and not in these figures)`;
  }
  return matched !== 1 ? ` (${sized})` : "";
}

// ─── Naked Options ──────────────────────────────────────────────

function createNakedOption(
  underlying: string,
  opt: PositionLeg
): StrategyDraft {
  const isCall = opt.optionType === "CALL";
  const premium = (opt.currentPrice ?? 0) * opt.multiplier * Math.abs(opt.quantity);

  return {
    type: isCall ? "naked_call" : "naked_put",
    name: `Naked ${isCall ? "Call" : "Put"}: ${underlying} ${formatStrike(opt.strike!)}`,
    underlying,
    expiration: opt.expiration,
    legs: [opt],
    maxProfit: premium,
    maxLoss: isCall ? null : (opt.strike! * opt.multiplier * Math.abs(opt.quantity) - premium),
    breakevens: isCall
      ? [opt.strike! + premium / (opt.multiplier * Math.abs(opt.quantity))]
      : [opt.strike! - premium / (opt.multiplier * Math.abs(opt.quantity))],
    description: `Short ${Math.abs(opt.quantity)} ${formatExpiry(opt.expiration)} ${formatStrike(opt.strike!)} ${isCall ? "call" : "put"}${Math.abs(opt.quantity) > 1 ? "s" : ""}`,
  };
}

// ─── Formatting Helpers ─────────────────────────────────────────

function formatStrike(strike: number): string {
  return strike % 1 === 0 ? `$${strike}` : `$${strike.toFixed(2)}`;
}

function formatExpiry(expiry?: string): string {
  if (!expiry) return "";
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  // Accept ISO ("2026-06-19") or YYYYMMDD ("20260619"). A handful of TWS-enriched
  // option rows wrote YYYYMMDD into expiration_date instead of ISO, which made
  // the original ISO-only parse return Invalid Date and surface "undefined NaN"
  // in strategy descriptions.
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry);
  if (iso) {
    const m = parseInt(iso[2], 10) - 1;
    const d = parseInt(iso[3], 10);
    if (m >= 0 && m < 12 && d >= 1 && d <= 31) return `${months[m]} ${d}`;
  }
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(expiry);
  if (compact) {
    const m = parseInt(compact[2], 10) - 1;
    const d = parseInt(compact[3], 10);
    if (m >= 0 && m < 12 && d >= 1 && d <= 31) return `${months[m]} ${d}`;
  }
  return "";
}
