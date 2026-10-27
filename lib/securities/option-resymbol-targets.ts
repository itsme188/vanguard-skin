/**
 * XLU ran a 2:1 split 2025-12-05 and — unlike IBKR — the broker RE-SYMBOLED
 * the calls (strike halved: 260618C00100000 → 260618C00050000, contracts ×2,
 * premium basis ÷2). The pre-split BUY_TO_OPEN was transcribed under the old
 * OCC symbol; the closes were transcribed under the new one, leaving two
 * orphan positions (+10 on the 100-strike, −20 on the 50-strike). Repair:
 * move the buy to the new symbol's security AND normalize qty ×2 / price ÷2
 * (amount + source_key untouched — same re-import caveat as all split
 * normalizations: re-importing the Nov-2025 file re-adds the old-symbol row;
 * re-run this script if that happens).
 */
export const OPTION_RESYMBOL_TARGETS = [
  {
    fromSymbol: "XLU   260618C00100000",
    toSymbol: "XLU   260618C00050000",
    tradeDate: "2025-11-18",
    type: "BUY_TO_OPEN",
    preQty: 10,
    ratio: 2,
  },
  // IBKR 4:1 (2025-06-18): buys were already quantity/price-normalized by
  // OPTION_SPLIT_TARGETS above (ratio 1 here = pure move, no re-scale); the
  // post-split legs (June-2025 expiry ×4 on the $35 put, the 2026 closes and
  // live holdings on the $55 call) all live under the re-struck symbols.
  {
    fromSymbol: "IBKR  250620P00140000",
    toSymbol: "IBKR  250620P00035000",
    tradeDate: "2025-04-17",
    type: "BUY_TO_OPEN",
    preQty: 4,
    ratio: 1,
  },
  {
    fromSymbol: "IBKR  270115C00220000",
    toSymbol: "IBKR  270115C00055000",
    tradeDate: "2025-04-17",
    type: "BUY_TO_OPEN",
    preQty: 4,
    ratio: 1,
  },
  // CRWD 4:1 (2026-07-01): the broker re-struck the March-2027 call
  // (270319C00470000 → 270319C00117500, contracts ×4). The July statement
  // transcribed the split as a quantity-only "SPLIT 6" row on the new symbol
  // (not a replay event), so the two February opening legs stayed on the
  // pre-split symbol while every close and the live position sit on the
  // re-struck one. Pure re-symbol + product-preserving normalization
  // (1 → 4 contracts, price ÷4, amount + source_key untouched). Verified
  // 2026-09-15 against the July/August statements: 8 post-split contracts,
  // sold 1 (07-06) + 2 (08-27) + 1 (08-31, unsettled section) → 4 held at
  // 08-31 with the second February lot's basis remaining, i.e. FIFO.
  {
    fromSymbol: "CRWD  270319C00470000",
    toSymbol: "CRWD  270319C00117500",
    tradeDate: "2026-02-05",
    type: "BUY_TO_OPEN",
    preQty: 1,
    ratio: 4,
  },
  {
    fromSymbol: "CRWD  270319C00470000",
    toSymbol: "CRWD  270319C00117500",
    tradeDate: "2026-02-06",
    type: "BUY_TO_OPEN",
    preQty: 1,
    ratio: 4,
  },
] as const;

/**
 * Every re-symbol entry whose old contract is exactly `fromSymbol` (the stored
 * symbol, no trimming or case change, as the repair planner matches it).
 * Says only that a known replacement contract exists; whether a script can
 * move a given ledger row is the planner's answer, not this list's.
 */
export function resymbolTargetsFrom(fromSymbol: string): readonly (typeof OPTION_RESYMBOL_TARGETS)[number][] {
  return OPTION_RESYMBOL_TARGETS.filter((t) => t.fromSymbol === fromSymbol);
}
