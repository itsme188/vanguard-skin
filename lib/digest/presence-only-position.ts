/**
 * Presence-only position formatter for outbound emails.
 *
 * Outbound emails (briefing / earnings / evening / digest) are shared with
 * additional recipients (brother on cc, future external readers). The
 * in-app `<PrivateText>` masking does NOT apply at the email boundary, so
 * anything the composer puts into the prompt is echoed verbatim by the
 * model into prose.
 *
 * This helper produces ownership-disclosure strings with NO reconstructable
 * exposure:
 *   - "long AAPL (vanguard taxable)"
 *   - "short META (ibkr)"
 *   - "long AAPL $145 calls exp 2026-06-19 (ibkr)"
 *   - "short SPY $590 puts exp 2026-05-23 (ibkr)"
 *
 * 2026-08-02 (supersedes the 2026-05-12 direction): share/contract counts
 * AND relative % returns are BOTH omitted now. Every symbol's price is
 * public, so `count × price` reconstructs the exact dollar exposure — a
 * share count was never presence-only. Direction, account name, and option
 * strike/expiry (public market data — any reader can look up that AAPL has
 * $145 strikes trading on 2026-06-19) are all that remain.
 */

export interface OptionMeta {
  underlyingSymbol: string | null;
  strikePrice: number | null;
  expirationDate: string | null; // YYYY-MM-DD
  optionType: string | null; // "CALL" | "PUT"
}

export interface PositionPresenceArgs {
  symbol: string;
  accountName: string;
  quantity: number; // signed — consumed ONLY for its sign (direction)
  securityType: string; // "stock" | "option" | "bond" | "etf" | ...
  optionMeta?: OptionMeta | null;
}

export function formatPositionPresence(args: PositionPresenceArgs): string {
  const isOption = args.securityType.toLowerCase() === "option";
  const direction = args.quantity >= 0 ? "long" : "short";

  if (isOption && args.optionMeta) {
    const right = pluralRight(args.optionMeta.optionType);
    const strike =
      args.optionMeta.strikePrice != null
        ? `$${args.optionMeta.strikePrice}`
        : "?";
    const expiry = args.optionMeta.expirationDate ?? "?";
    const underlying = args.optionMeta.underlyingSymbol ?? args.symbol;
    return `${direction} ${underlying} ${strike} ${right} exp ${expiry} (${args.accountName})`;
  }

  return `${direction} ${args.symbol} (${args.accountName})`;
}

/** "CALL" → "calls", "PUT" → "puts"; unknown right → "?" (never invent one). */
function pluralRight(optionType: string | null): string {
  if (!optionType) return "?";
  const t = optionType.toLowerCase();
  if (t === "call") return "calls";
  if (t === "put") return "puts";
  return t;
}

/**
 * Combined-positions summary for use in earnings-email prompts. Presence
 * flags only — the input counts are consumed as >0 booleans (signature kept
 * so callers' long/short bucketing code is unchanged). Never emits a number:
 * "500 long shares" was reconstructable exposure, "long shares" is not.
 */
export function formatCombinedExposurePresence(args: {
  positionCount: number;
  longShares: number;
  shortShares: number;
  longContracts: number;
  shortContracts: number;
}): string {
  if (args.positionCount === 0) return "no live exposure";
  const parts: string[] = [];
  if (args.longShares > 0) parts.push("long shares");
  if (args.shortShares > 0) parts.push("short shares");
  if (args.longContracts > 0) parts.push("long options");
  if (args.shortContracts > 0) parts.push("short options");
  return parts.length > 0 ? parts.join(" + ") : "no live exposure";
}
