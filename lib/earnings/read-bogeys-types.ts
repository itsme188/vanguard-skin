/**
 * The answer of POST /api/earnings/bogeys/read (bogey intake 2026-11-18).
 *
 * Type-only and import-free at runtime, so the edit box (a client component)
 * can `import type` it without pulling server code into the bundle. The one
 * import below is type-only and points at a client-safe module.
 */
import type { ExtraMetricSpec } from "@/lib/print-watch/extra-metrics";

export interface ReadBogeysResult {
  /** True when the input gave at least one figure for this print's company. */
  found: boolean;
  /** The figures read for this print's company; all null when `found` is false. */
  values: {
    eps_consensus: number | null;
    eps_whisper: number | null;
    revenue_consensus_usd: number | null;
    revenue_whisper_usd: number | null;
    expected_move_pct: number | null;
    guidance_notes: string | null;
    notes: string | null;
  };
  /** Watch lines (segments included), aligned to the sheet's existing lines. */
  extraMetrics: ExtraMetricSpec[];
  /** A source label for the manual row the owner may save. */
  suggestedLabel: string;
  /** The model that read it; null only if no model was called. */
  modelId: string | null;
  /** One sentence for the edit box. */
  message: string;
}
