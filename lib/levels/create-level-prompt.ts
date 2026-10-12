/**
 * The question an Add form asks when POST /api/levels refuses a create with
 * an arm-guard code (lib/levels/create-level.ts). Client-safe: no imports, so
 * the Levels panel's Add form and the chart-click popover share one wording
 * without pulling server modules into the browser bundle.
 */
export type CreateRefusalCode = "would_fire_immediately" | "beyond_scan_range";

export interface CreateRefusalPrompt {
  code: CreateRefusalCode;
  title: string;
  message: string;
  confirmLabel: string;
}

/** Shown when the user declines; the create wrote nothing. */
export const CREATE_DECLINED_MESSAGE = "Nothing was saved. The level was not added.";

/**
 * The question for a 409 create refusal, or null when the response is not
 * one (any other failure is reported as a plain error). `formatPrice` labels
 * a price in the security's own currency.
 */
export function createRefusalPrompt(
  status: number | undefined,
  raw: { code?: unknown; currentPrice?: unknown; effectivePrice?: unknown } | null,
  formatPrice: (price: number) => string,
): CreateRefusalPrompt | null {
  if (status !== 409 || !raw) return null;
  const code = raw.code;
  if (code !== "would_fire_immediately" && code !== "beyond_scan_range") return null;
  const current = typeof raw.currentPrice === "number" ? formatPrice(raw.currentPrice) : null;
  const effective = typeof raw.effectivePrice === "number" ? formatPrice(raw.effectivePrice) : null;
  const level = effective ? `The new level (${effective})` : "The new level";
  const price = current ? `the current price ${current}` : "the current price";
  const message =
    code === "would_fire_immediately"
      ? `${current ? `Price ${current} is` : "The current price is"} already past ${effective ? `the new level (${effective})` : "the new level"}. Adding it will fire an alert on the next scan. Add anyway?`
      : `${level} is outside the scanner's range at ${price}, so every scan would skip it and it could not alert. This usually means a mis-scaled price. Add anyway?`;
  return { code, title: "Add this level?", message, confirmLabel: "Add anyway" };
}
