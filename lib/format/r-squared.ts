import { MIN_BETA_R_SQUARED } from "@/lib/compute/beta-confidence";

/**
 * Display an r². Two decimals normally. A value just under the beta
 * confidence gate that would round up to the gate gets more digits, so the
 * tile never reads "0.10" beside a caption saying r² is below 0.10.
 */
export function formatRSquared(value: number): string {
  const base = value.toFixed(2);
  if (!Number.isFinite(value) || value >= MIN_BETA_R_SQUARED) return base;
  if (Number(base) < MIN_BETA_R_SQUARED) return base;
  for (let d = 3; d <= 6; d++) {
    const s = value.toFixed(d);
    if (Number(s) < MIN_BETA_R_SQUARED) return s;
  }
  return value.toFixed(7);
}
