import { formatUSDPrecise } from "@/lib/format";

/**
 * Chart price/level label formatting.
 *
 * The per-security candlestick chart (SecurityChart) intentionally stays in
 * the security's NATIVE currency frame — bars, levels, and the last-price
 * pill are never converted to USD (2026-08-12 QA decision:
 * charts-price-axis--krw-native-values-labeled-with-dollar-sign). Only the
 * LABEL should reflect the native currency; values must never be converted
 * here.
 *
 * USD (and null/undefined/blank — the rest of the app treats a missing
 * currency as USD, see lib/queries/fx-rates.ts getUsdPerUnit) renders with
 * the chart's pre-existing "$1234.56" style (two decimals, no thousands
 * separator) so USD securities see byte-identical output to before this
 * helper existed.
 *
 * Any other ISO 4217 code renders via Intl.NumberFormat's currency style —
 * e.g. "₩976,000" for KRW (KRW has no minor unit, so Intl already omits
 * decimals). Currency codes are matched case-insensitively. Malformed codes
 * (not exactly 3 letters) fall back to a plain "CODE 123,456.78" rendering
 * instead of throwing — well-formed-but-unrecognized 3-letter codes already
 * format fine on their own (the JS engine renders the code itself as the
 * symbol, e.g. "ZZZ 976,000").
 */
export function formatChartPrice(
  currency: string | null | undefined,
  value: number,
): string {
  const code = (currency ?? "").trim().toUpperCase();
  if (code === "" || code === "USD") {
    return `$${value.toFixed(2)}`;
  }
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
    }).format(value);
  } catch {
    return `${code} ${value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
}

/**
 * Level price label — the LevelsPanel sibling of formatChartPrice (2026-08-12
 * QA follow-up: LevelsPanel is the "Levels & Alerts" list below the chart,
 * app/dashboard/components/LevelsPanel.tsx — the one surface 9ba9158
 * deliberately left $-labeling native prices).
 *
 * LevelsPanel's PRE-EXISTING USD formatter is `formatUSDPrecise`
 * (thousands-grouped, "$1,234.56"), not the chart's own no-grouping
 * "$1234.56" pill style — the two surfaces had different USD conventions
 * before either was currency-aware. So USD (and null/undefined/blank, same
 * "missing currency = USD" convention as formatChartPrice) delegates to
 * `formatUSDPrecise` to stay byte-identical to LevelsPanel's prior output.
 * Any other ISO code delegates to `formatChartPrice`, which already renders
 * it correctly (e.g. "₩976,000" for KRW) — no need to duplicate that logic.
 */
export function formatLevelPrice(
  currency: string | null | undefined,
  value: number,
): string {
  const code = (currency ?? "").trim().toUpperCase();
  if (code === "" || code === "USD") {
    return formatUSDPrecise(value);
  }
  return formatChartPrice(currency, value);
}
