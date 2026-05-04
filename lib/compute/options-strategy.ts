/**
 * Options Strategy Detection Engine.
 *
 * Pure functions that analyze a set of positions (stock + option holdings
 * in the same account) and identify common option strategies.
 *
 * Detects: covered call, protective put, vertical spread (bull/bear),
 * straddle, strangle, iron condor, naked options.
 */

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
}

// ─── Strategy Detection ─────────────────────────────────────────

/**
 * Detect option strategies from a set of positions in the same account.
 * Positions should all belong to the same account.
 */
export function detectStrategies(positions: PositionLeg[]): DetectedStrategy[] {
  const strategies: DetectedStrategy[] = [];

  // Separate stocks and options
  const stocks = positions.filter((p) => p.securityType === "stock");
  const options = positions.filter((p) => p.securityType === "option");

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

  return strategies;
}

// ─── Covered Strategies (stock + option) ────────────────────────

function detectCoveredStrategies(
  stock: PositionLeg,
  options: PositionLeg[]
): DetectedStrategy[] {
  const strategies: DetectedStrategy[] = [];
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

    strategies.push({
      type: "covered_call",
      name: `Covered Call: ${stock.symbol} ${formatStrike(strike)} Call`,
      underlying: stock.symbol,
      expiration: call.expiration,
      legs: [stock, call],
      maxProfit: (strike - stockCost + (call.currentPrice ?? 0)) * call.multiplier * coveredContracts,
      maxLoss: (stockCost - (call.currentPrice ?? 0)) * call.multiplier * coveredContracts,
      breakevens: [stockCost - (call.currentPrice ?? 0)],
      description: `Long ${shares} shares + short ${Math.abs(call.quantity)} ${formatExpiry(call.expiration)} ${formatStrike(strike)} call${Math.abs(call.quantity) > 1 ? "s" : ""}`,
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

    strategies.push({
      type: "protective_put",
      name: `Protective Put: ${stock.symbol} ${formatStrike(strike)} Put`,
      underlying: stock.symbol,
      expiration: put.expiration,
      legs: [stock, put],
      maxProfit: null, // unlimited upside
      maxLoss: (stockCost - strike + putCost) * put.multiplier * put.quantity,
      breakevens: [stockCost + putCost],
      description: `Long ${shares} shares + long ${put.quantity} ${formatExpiry(put.expiration)} ${formatStrike(strike)} put${put.quantity > 1 ? "s" : ""}`,
    });
  }

  return strategies;
}

// ─── Spread Strategies (option + option) ────────────────────────

function detectSpreadStrategies(
  underlying: string,
  options: PositionLeg[]
): DetectedStrategy[] {
  const strategies: DetectedStrategy[] = [];

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
): DetectedStrategy[] {
  const strategies: DetectedStrategy[] = [];

  const longs = options.filter((o) => o.quantity > 0);
  const shorts = options.filter((o) => o.quantity < 0);

  for (const long of longs) {
    for (const short of shorts) {
      if (!long.strike || !short.strike || long.strike === short.strike) continue;

      const lowStrike = Math.min(long.strike, short.strike);
      const highStrike = Math.max(long.strike, short.strike);
      const spread = highStrike - lowStrike;
      const multiplier = long.multiplier;

      if (type === "CALL") {
        if (long.strike < short.strike) {
          // Bull Call Spread: buy lower, sell higher
          const netDebit = ((long.currentPrice ?? 0) - (short.currentPrice ?? 0)) * multiplier;
          strategies.push({
            type: "bull_call_spread",
            name: `Bull Call Spread: ${underlying} ${formatStrike(lowStrike)}/${formatStrike(highStrike)}`,
            underlying,
            expiration: expiry,
            legs: [long, short],
            maxProfit: (spread * multiplier) - netDebit,
            maxLoss: netDebit,
            breakevens: [lowStrike + netDebit / multiplier],
            description: `Long ${formatStrike(lowStrike)} call, short ${formatStrike(highStrike)} call ${formatExpiry(expiry)}`,
          });
        } else {
          // Bear Call Spread: sell lower, buy higher
          const netCredit = ((short.currentPrice ?? 0) - (long.currentPrice ?? 0)) * multiplier;
          strategies.push({
            type: "bear_call_spread",
            name: `Bear Call Spread: ${underlying} ${formatStrike(lowStrike)}/${formatStrike(highStrike)}`,
            underlying,
            expiration: expiry,
            legs: [short, long],
            maxProfit: netCredit,
            maxLoss: (spread * multiplier) - netCredit,
            breakevens: [lowStrike + netCredit / multiplier],
            description: `Short ${formatStrike(lowStrike)} call, long ${formatStrike(highStrike)} call ${formatExpiry(expiry)}`,
          });
        }
      } else {
        // PUT spreads
        if (long.strike > short.strike) {
          // Bear Put Spread: buy higher, sell lower
          const netDebit = ((long.currentPrice ?? 0) - (short.currentPrice ?? 0)) * multiplier;
          strategies.push({
            type: "bear_put_spread",
            name: `Bear Put Spread: ${underlying} ${formatStrike(lowStrike)}/${formatStrike(highStrike)}`,
            underlying,
            expiration: expiry,
            legs: [long, short],
            maxProfit: (spread * multiplier) - netDebit,
            maxLoss: netDebit,
            breakevens: [highStrike - netDebit / multiplier],
            description: `Long ${formatStrike(highStrike)} put, short ${formatStrike(lowStrike)} put ${formatExpiry(expiry)}`,
          });
        } else {
          // Bull Put Spread: sell higher, buy lower
          const netCredit = ((short.currentPrice ?? 0) - (long.currentPrice ?? 0)) * multiplier;
          strategies.push({
            type: "bull_put_spread",
            name: `Bull Put Spread: ${underlying} ${formatStrike(lowStrike)}/${formatStrike(highStrike)}`,
            underlying,
            expiration: expiry,
            legs: [short, long],
            maxProfit: netCredit,
            maxLoss: (spread * multiplier) - netCredit,
            breakevens: [highStrike - netCredit / multiplier],
            description: `Short ${formatStrike(highStrike)} put, long ${formatStrike(lowStrike)} put ${formatExpiry(expiry)}`,
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
): DetectedStrategy[] {
  const strategies: DetectedStrategy[] = [];

  for (const call of calls) {
    for (const put of puts) {
      if (!call.strike || !put.strike) continue;
      if (call.strike !== put.strike) continue;
      // Both same direction (both long or both short)
      if ((call.quantity > 0) !== (put.quantity > 0)) continue;

      const strike = call.strike;
      const isLong = call.quantity > 0;
      const multiplier = call.multiplier;
      const totalPremium =
        ((call.currentPrice ?? 0) + (put.currentPrice ?? 0)) * multiplier;

      strategies.push({
        type: "straddle",
        name: `${isLong ? "Long" : "Short"} Straddle: ${underlying} ${formatStrike(strike)}`,
        underlying,
        expiration: expiry,
        legs: [call, put],
        maxProfit: isLong ? null : totalPremium,
        maxLoss: isLong ? totalPremium : null,
        breakevens: [
          strike - totalPremium / multiplier,
          strike + totalPremium / multiplier,
        ],
        description: `${isLong ? "Long" : "Short"} ${formatStrike(strike)} call + put ${formatExpiry(expiry)}`,
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
): DetectedStrategy[] {
  const strategies: DetectedStrategy[] = [];

  for (const call of calls) {
    for (const put of puts) {
      if (!call.strike || !put.strike) continue;
      if (call.strike === put.strike) continue; // straddle, not strangle
      if (call.strike < put.strike) continue; // call strike should be above put
      if ((call.quantity > 0) !== (put.quantity > 0)) continue;

      const isLong = call.quantity > 0;
      const multiplier = call.multiplier;
      const totalPremium =
        ((call.currentPrice ?? 0) + (put.currentPrice ?? 0)) * multiplier;

      strategies.push({
        type: "strangle",
        name: `${isLong ? "Long" : "Short"} Strangle: ${underlying} ${formatStrike(put.strike)}/${formatStrike(call.strike)}`,
        underlying,
        expiration: expiry,
        legs: [put, call],
        maxProfit: isLong ? null : totalPremium,
        maxLoss: isLong ? totalPremium : null,
        breakevens: [
          put.strike - totalPremium / multiplier,
          call.strike + totalPremium / multiplier,
        ],
        description: `${isLong ? "Long" : "Short"} ${formatStrike(put.strike)} put + ${formatStrike(call.strike)} call ${formatExpiry(expiry)}`,
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
): DetectedStrategy[] {
  const strategies: DetectedStrategy[] = [];

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
          const netCredit =
            ((sc.currentPrice ?? 0) -
              (lc.currentPrice ?? 0) +
              (sp.currentPrice ?? 0) -
              (lp.currentPrice ?? 0)) *
            multiplier;

          strategies.push({
            type: "iron_condor",
            name: `Iron Condor: ${underlying} ${formatStrike(lp.strike)}/${formatStrike(sp.strike)}/${formatStrike(sc.strike)}/${formatStrike(lc.strike)}`,
            underlying,
            expiration: expiry,
            legs: [lp, sp, sc, lc],
            maxProfit: netCredit,
            maxLoss: Math.max(callSpread, putSpread) * multiplier - netCredit,
            breakevens: [
              sp.strike - netCredit / multiplier,
              sc.strike + netCredit / multiplier,
            ],
            description: `Put spread ${formatStrike(lp.strike)}/${formatStrike(sp.strike)} + Call spread ${formatStrike(sc.strike)}/${formatStrike(lc.strike)} ${formatExpiry(expiry)}`,
          });
        }
      }
    }
  }

  return strategies;
}

// ─── Naked Options ──────────────────────────────────────────────

function createNakedOption(
  underlying: string,
  opt: PositionLeg
): DetectedStrategy {
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
