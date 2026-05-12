/**
 * Presence-only position formatter for outbound emails.
 *
 * Outbound emails (briefing / earnings / evening / digest) are shared with
 * additional recipients (brother on cc, future external readers). The
 * in-app `<PrivateText>` masking does NOT apply at the email boundary, so
 * any exact $ amount the composer puts into the prompt will be echoed
 * verbatim by Sonnet/Opus into prose.
 *
 * This helper produces ownership-disclosure strings without exact $:
 *   - "500 sh AAPL (vanguard taxable, up ~12%)"
 *   - "200 sh short META (ibkr)"
 *   - "3 long AAPL $145 call expiring 2026-06-19 (ibkr, up ~8%)"
 *   - "2 short SPY $590 put expiring 2026-05-23 (ibkr)"
 *
 * Relative % returns ARE kept (per session 2026-05-12 user direction):
 * P&L direction / magnitude in % terms is fine; what stays hidden is the
 * underlying $ exposure. The helper accepts raw cost basis + latest price
 * internally to COMPUTE the %, but never returns either $ value.
 *
 * Strike + expiry on options are public market data (any reader can look up
 * that AAPL has $145 strikes trading on 2026-06-19) — they reveal nothing
 * about the user's exposure size beyond the contract count + direction.
 *
 * Shorts: relative-return is NOT emitted (sign convention on cost_basis
 * for short positions varies across our import paths; safer to omit than
 * mislead). Direction is communicated via "N sh short SYMBOL".
 */

export interface OptionMeta {
  underlyingSymbol: string | null;
  strikePrice: number | null;
  expirationDate: string | null; // YYYY-MM-DD
  optionType: string | null; // "CALL" | "PUT"
  multiplier: number | null; // typically 100
}

export interface PositionPresenceArgs {
  symbol: string;
  accountName: string;
  quantity: number; // signed: negative = short
  securityType: string; // "stock" | "option" | "bond" | "etf" | ...
  optionMeta?: OptionMeta | null;
  costBasis?: number | null; // total $ for the position
  latestPrice?: number | null; // per-share for stocks, per-share (1× multiplier) for options
}

export function formatPositionPresence(args: PositionPresenceArgs): string {
  const isOption = args.securityType.toLowerCase() === "option";
  const direction = args.quantity >= 0 ? "long" : "short";
  const qty = Math.abs(args.quantity);
  const returnSuffix = formatReturnSuffix(args);

  if (isOption && args.optionMeta) {
    const right = (args.optionMeta.optionType ?? "?").toLowerCase();
    const strike =
      args.optionMeta.strikePrice != null
        ? `$${args.optionMeta.strikePrice}`
        : "?";
    const expiry = args.optionMeta.expirationDate ?? "?";
    const underlying = args.optionMeta.underlyingSymbol ?? args.symbol;
    return `${qty} ${direction} ${underlying} ${strike} ${right} expiring ${expiry} (${args.accountName}${returnSuffix})`;
  }

  const qtyStr = formatQty(args.quantity);
  const shortPrefix = direction === "short" ? "short " : "";
  return `${qtyStr} sh ${shortPrefix}${args.symbol} (${args.accountName}${returnSuffix})`;
}

/**
 * Format the "(account, up ~12%)" tail. Returns empty string when:
 *   - cost basis or latest price is missing
 *   - position is short (sign convention varies — omit to avoid mislead)
 *   - cost basis is zero (would divide by zero or produce noise)
 */
function formatReturnSuffix(args: PositionPresenceArgs): string {
  if (args.quantity < 0) return ""; // short — omit return %
  if (args.costBasis == null || args.latestPrice == null) return "";
  if (args.costBasis === 0) return "";

  const contracts = Math.abs(args.quantity);
  if (contracts === 0) return "";

  const isOption = args.securityType.toLowerCase() === "option";
  let currentValue: number;
  if (isOption) {
    const mult = args.optionMeta?.multiplier ?? 100;
    currentValue = args.latestPrice * contracts * mult;
  } else {
    currentValue = args.latestPrice * contracts;
  }

  const pnlPct =
    ((currentValue - args.costBasis) / Math.abs(args.costBasis)) * 100;
  if (!Number.isFinite(pnlPct)) return "";

  const dir = pnlPct >= 0 ? "up" : "down";
  return `, ${dir} ~${Math.abs(pnlPct).toFixed(1)}%`;
}

function formatQty(q: number): string {
  const abs = Math.abs(q);
  if (Number.isInteger(abs)) return abs.toString();
  return abs.toFixed(2);
}

/**
 * Combined-positions summary for use in earnings-email prompts. Replaces the
 * old "Combined exposure: ${combinedShares} shares + ${contracts} option
 * contract(s) (~${notional} shares notional)" line that leaked the
 * derivable-from-price notional dollar exposure.
 *
 * Returns a presence-only summary: position counts + direction breakdown,
 * no derivable $.
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
  if (args.longShares > 0) parts.push(`${args.longShares.toFixed(0)} long shares`);
  if (args.shortShares > 0) parts.push(`${args.shortShares.toFixed(0)} short shares`);
  if (args.longContracts > 0)
    parts.push(`${args.longContracts.toFixed(0)} long option contract(s)`);
  if (args.shortContracts > 0)
    parts.push(`${args.shortContracts.toFixed(0)} short option contract(s)`);
  return parts.length > 0 ? parts.join(" + ") : "no live exposure";
}
