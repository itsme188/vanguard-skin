import type { IBApiNext, MarketDataType } from "@stoqey/ib";

/**
 * The ONE place that sets the broker's market-data type (Gains at risk step 3,
 * ruling D2). The type belongs to the whole broker connection, so two callers
 * that set it at once can undo each other. Every caller (the price snapshot,
 * the earnings straddle read, the live stream, the option quote and the quote
 * batch) goes through this helper; a source test
 * (tests/repo/one-market-data-type-setter.test.ts) fails on any other call.
 *
 * Each call bumps a process counter. A quote compares the counter before and
 * after its snapshot: a change means someone else set the type while it was
 * in flight. The counter lives on globalThis (Turbopack HMR resets module
 * state, lib/tws/CLAUDE.md).
 */

const state = globalThis as unknown as { __tws_marketDataTypeGeneration?: number };

/**
 * Sets the type, then bumps the counter and returns its new value. A throw
 * from the broker call propagates unchanged (as the direct call did) and does
 * not bump the counter: nothing was sent.
 */
export function setMarketDataTypeCounted(api: Pick<IBApiNext, "setMarketDataType">, type: MarketDataType): number {
  api.setMarketDataType(type);
  state.__tws_marketDataTypeGeneration = (state.__tws_marketDataTypeGeneration ?? 0) + 1;
  return state.__tws_marketDataTypeGeneration;
}

/** The counter's current value (0 before the first setting in this process). */
export function marketDataTypeGeneration(): number {
  return state.__tws_marketDataTypeGeneration ?? 0;
}
