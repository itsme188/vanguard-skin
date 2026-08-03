/**
 * Presence-only position formatter for outbound emails — Worker hand-copy of
 * lib/digest/presence-only-position.ts.
 *
 * The Worker can't cross the Next.js `@/` path-alias boundary, so (like the
 * issuerSiblings copy in fallback-earnings.ts) this is a byte-for-byte mirror
 * below the OptionMeta interface. Keep in sync with the Mac original; the
 * logic is pure + slow-moving. Parity is pinned by
 * workers/cron/test/presence-position.test.ts.
 *
 * Why this exists: outbound emails (briefing / earnings / evening) are shared
 * with cc recipients, so anything the composer writes into the body reaches
 * them verbatim. 2026-08-02 (supersedes 2026-05-12): share/contract counts
 * AND relative % returns are BOTH omitted — count × public price reconstructs
 * the exact dollar exposure. Only direction, account, and option strike/expiry
 * (public market data) remain: "long AAPL (ibkr)".
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
