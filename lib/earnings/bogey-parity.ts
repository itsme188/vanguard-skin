/**
 * Figure parity between two extractions of the same sheet (provider-failover
 * design §8, step 2 — the HARD gate): every numeric field the Anthropic
 * baseline produced must match the candidate EXACTLY, the candidate may not
 * invent a company the baseline did not find, and may not drop one.
 *
 * Pure. Used by scripts/failover-pdf-parity.ts on real sheets and by the unit
 * tests on synthetic ones. Text fields (notes, guidance) are narrative and are
 * reported as informational only — they never fail the gate.
 */
import type { ExtractedBogey } from "@/lib/earnings/extract-bogeys";

export interface ParityMismatch {
  symbol: string;
  field: string;
  baseline: number | null;
  candidate: number | null;
}

export interface BogeyParityReport {
  pass: boolean;
  /** In the baseline, absent from the candidate. */
  missingSymbols: string[];
  /** In the candidate, not in the baseline (an invented company). */
  extraSymbols: string[];
  mismatches: ParityMismatch[];
  /** Count of numeric figures compared (so a pass on zero figures is visible). */
  figuresCompared: number;
}

const SCALARS = [
  "eps_consensus",
  "eps_whisper",
  "revenue_consensus_usd",
  "revenue_whisper_usd",
  "expected_move_pct",
] as const;

function normLabel(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Numeric figures of one bogey, keyed by a stable field name. */
function figures(b: ExtractedBogey): Map<string, number | null> {
  const m = new Map<string, number | null>();
  for (const f of SCALARS) m.set(f, b[f]);
  for (const [seg, v] of Object.entries(b.segment_breakdown ?? {})) {
    m.set(`segment:${normLabel(seg)}:consensus`, v.consensus ?? null);
    m.set(`segment:${normLabel(seg)}:whisper`, v.whisper ?? null);
  }
  for (const w of b.watch_metrics) {
    // The id is derived from identity, but compare on label + period so a report reads plainly.
    const key = `watch:${normLabel(w.label)}:${w.period}`;
    m.set(`${key}:consensus`, w.consensus ?? null);
    m.set(`${key}:whisper`, w.whisper ?? null);
  }
  return m;
}

export function compareBogeyParity(baseline: ExtractedBogey[], candidate: ExtractedBogey[]): BogeyParityReport {
  const base = new Map(baseline.map((b) => [b.symbol, b]));
  const cand = new Map(candidate.map((b) => [b.symbol, b]));
  const missingSymbols = [...base.keys()].filter((s) => !cand.has(s)).sort();
  const extraSymbols = [...cand.keys()].filter((s) => !base.has(s)).sort();
  const mismatches: ParityMismatch[] = [];
  let figuresCompared = 0;
  for (const [symbol, b] of base) {
    const c = cand.get(symbol);
    if (!c) continue;
    const bf = figures(b);
    const cf = figures(c);
    for (const [field, bv] of bf) {
      // A figure the baseline did not produce is not a baseline claim.
      if (bv == null) continue;
      figuresCompared += 1;
      const cv = cf.get(field) ?? null;
      if (cv !== bv) mismatches.push({ symbol, field, baseline: bv, candidate: cv });
    }
  }
  return {
    pass: missingSymbols.length === 0 && extraSymbols.length === 0 && mismatches.length === 0,
    missingSymbols,
    extraSymbols,
    mismatches,
    figuresCompared,
  };
}
