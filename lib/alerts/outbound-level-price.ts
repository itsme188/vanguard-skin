/**
 * Level-price label for OUTBOUND text: the weekly briefing prompt, the daily
 * digest and the push notifications.
 *
 * A level price is native currency: labelled, never converted (ruling
 * 2026-10-07). On screen the app labels with `formatLevelPrice`
 * (lib/chart/price-formatter.ts), which formats with the runtime's DEFAULT
 * locale. Outbound text is written by two runtimes (the Mac's Node and the
 * Cloudflare Worker) whose default locales can differ, so this formatter pins
 * "en-US" and replaces the non-breaking spaces Intl may emit with plain ones.
 *
 * MIRROR: workers/cron/src/level-price.ts is a hand copy (the Worker cannot
 * import lib/). Change both together. Parity is pinned by
 * tests/alerts/outbound-level-price.test.ts and
 * workers/cron/test/level-price-parity.test.ts over one fixture set
 * (tests/fixtures/level-price-parity.json).
 *
 * This file must stay import-free: the Worker's test project loads it.
 *
 * USD (and a missing or blank currency, the app-wide "missing means USD"
 * rule) keeps each caller's long-standing dollar style, so a dollar level
 * reads byte-for-byte as it did before currencies were labelled:
 *   - "plain":   "$1234.50"  (briefing prompt, digest)
 *   - "grouped": "$1,234.50" (push notifications)
 * Any other code renders through Intl's currency style ("¥976,000",
 * "£12.50", "CA$45.10", "CHF 88.25"). A code Intl rejects falls back to
 * "CODE 1,234.50".
 *
 * The number is never rounded below what was stored: a currency with no minor
 * unit (yen, won) shows a whole price whole, and a fractional one (a half-yen
 * tick) with its fraction.
 */

export type OutboundUsdStyle = "plain" | "grouped";

const OUTBOUND_LOCALE = "en-US";
const NBSP = String.fromCharCode(0x00a0);
const NARROW_NBSP = String.fromCharCode(0x202f);

function plainSpaces(text: string): string {
  return text.split(NBSP).join(" ").split(NARROW_NBSP).join(" ");
}

function twoDecimals(value: number): string {
  return value.toLocaleString(OUTBOUND_LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatOutboundLevelPrice(
  currency: string | null | undefined,
  value: number,
  usdStyle: OutboundUsdStyle = "plain",
): string {
  const code = (currency ?? "").trim().toUpperCase();
  if (code === "" || code === "USD") {
    return usdStyle === "grouped" ? `$${twoDecimals(value)}` : `$${value.toFixed(2)}`;
  }
  try {
    const base = new Intl.NumberFormat(OUTBOUND_LOCALE, { style: "currency", currency: code });
    const digits = base.resolvedOptions().maximumFractionDigits ?? 2;
    const scale = 10 ** digits;
    const losesPrecision = digits < 2 && Math.round(value * scale) / scale !== value;
    const fmt = losesPrecision
      ? new Intl.NumberFormat(OUTBOUND_LOCALE, {
          style: "currency",
          currency: code,
          maximumFractionDigits: 2,
        })
      : base;
    return plainSpaces(fmt.format(value));
  } catch {
    return `${code} ${twoDecimals(value)}`;
  }
}
