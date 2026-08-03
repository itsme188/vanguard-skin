/**
 * Expected-move precedence resolver — Worker hand-copy of
 * lib/earnings/expected-move.ts (sheet > straddle > iv_approx, always
 * source-labeled; feedback #5, 2026-08-03).
 *
 * The Worker bundle can't cross the Next.js path-alias boundary, so this is a
 * byte-parity mirror below the ExpectedMoveBogey interface — same constraint
 * as plausibility.ts / print-push-message.ts. Change BOTH files together;
 * parity is pinned by workers/cron/test/expected-move-parity.test.ts.
 */

export interface ExpectedMoveBogey {
  /** Absolute percent (±6% → 6); null when the source states no move. */
  expectedMovePct: number | null;
  sourceLabel: string | null;
  /** ISO-ish timestamp; newest wins. Null sorts last (undated). */
  uploadedAt: string | null;
}

export interface ExpectedMoveResolution {
  pct: number;
  method: "sheet" | "straddle" | "iv_approx";
  /** The winning bogey's source_label when method === "sheet"; else null. */
  sourceLabel: string | null;
}

export function resolveExpectedMove(args: {
  bogeys: ExpectedMoveBogey[];
  impliedMovePct: number | null;
  impliedMethod: "straddle" | "iv_approx" | null;
}): ExpectedMoveResolution | null {
  const sheetCandidates = args.bogeys.filter(
    (b) =>
      b.expectedMovePct != null &&
      Number.isFinite(b.expectedMovePct) &&
      b.expectedMovePct > 0,
  );
  if (sheetCandidates.length > 0) {
    // Newest wins; a null uploadedAt sorts last (a dated sheet beats an
    // undated one). String compare is fine — both sides are ISO-ordered.
    const newest = [...sheetCandidates].sort((a, b) => {
      if (a.uploadedAt == null && b.uploadedAt == null) return 0;
      if (a.uploadedAt == null) return 1;
      if (b.uploadedAt == null) return -1;
      return b.uploadedAt.localeCompare(a.uploadedAt);
    })[0];
    return {
      pct: newest.expectedMovePct as number,
      method: "sheet",
      sourceLabel: newest.sourceLabel,
    };
  }

  // Market-derived fallback. A pct without a method is treated as absent —
  // an unlabeled number can't satisfy the always-source-labeled rule.
  if (args.impliedMovePct != null && args.impliedMethod != null) {
    return { pct: args.impliedMovePct, method: args.impliedMethod, sourceLabel: null };
  }
  return null;
}
