/**
 * The one ticker rule for the Settings lists (coverage list, earnings mute
 * list). Plain module: no imports, safe to load from a route.
 */
export const TICKER_RE = /^[A-Z0-9.-]{1,10}$/;

/** Trim and upper-case an entry the way both lists do before checking it. */
export function normalizeTicker(item: string): string {
  return item.trim().toUpperCase();
}

/** The refusal sentence for an entry that fails the rule. */
export function invalidTickerMessage(item: string): string {
  return `"${item}" is not a valid ticker (letters, digits, dot or dash, up to 10 characters).`;
}
