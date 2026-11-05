/**
 * Basis-aware scoring (theme T1, slice 2; owner-approved build order,
 * 2026-11-05). One shared rule decides whether an actual may be scored
 * (beat / miss / delta) against a bogey: only when the two figures' bases are
 * KNOWN to match. A GAAP actual is never scored against an adjusted bogey, and
 * the reverse; an unknown basis on either side scores nothing. When a pair is
 * not scored, the surface prints both figures side by side with their bases
 * and NO delta, the same honest labelling the vendor-only footnote uses
 * ("vendor feed only (no accepted filing figure on file)").
 *
 * Pure and import-free so the server pages, the email composer and any future
 * Worker mirror can share it.
 *
 * THE EQUIVALENCE RULE (`basesMatch`):
 *   - the same basis matches itself (gaap/gaap, non_gaap/non_gaap, vendor/vendor);
 *   - `na` ("the distinction does not apply": revenue, units, ARR; the
 *     print-watch line contract's own meaning, lib/print-watch/types.ts)
 *     matches any KNOWN basis;
 *   - `vendor` (a Finnhub-style figure whose basis the feed does not state)
 *     matches `non_gaap`. The feed's EPS is the street's adjusted figure, and
 *     the scoreboard has always scored a promoted adjusted actual against the
 *     vendor consensus (owner ruling 2026-10-08 labels the worksheet figure
 *     "adjusted" with the vendor figure as a basis-may-differ footnote). It
 *     NEVER matches `gaap`;
 *   - `null` (unknown) matches nothing, not even itself.
 */

export type FigureBasis = "gaap" | "non_gaap" | "na" | "vendor";
/** `null` = the basis is not known. */
export type MaybeBasis = FigureBasis | null;

export function basesMatch(actual: MaybeBasis, bogey: MaybeBasis): boolean {
  if (actual === null || bogey === null) return false;
  if (actual === bogey) return true;
  if (actual === "na" || bogey === "na") return true;
  if (
    (actual === "vendor" && bogey === "non_gaap") ||
    (actual === "non_gaap" && bogey === "vendor")
  ) {
    return true;
  }
  return false;
}

const BASIS_WORDS: Record<FigureBasis, string> = {
  gaap: "GAAP",
  non_gaap: "adjusted",
  na: "no GAAP/adjusted distinction",
  vendor: "vendor feed, basis unspecified",
};

/** The basis as a desk word. Never empty: an unknown basis says so. */
export function basisWord(b: MaybeBasis): string {
  return b === null ? "unknown basis" : BASIS_WORDS[b];
}

export type ScoreEligibility =
  | { scored: true }
  | { scored: false; note: string };

/**
 * May this actual be scored against this bogey? `what` names the metric for the
 * note ("EPS"). The note is the sentence a surface prints beside the two
 * figures.
 */
export function scoreEligibility(
  what: string,
  actual: MaybeBasis,
  bogey: MaybeBasis,
): ScoreEligibility {
  if (basesMatch(actual, bogey)) return { scored: true };
  return {
    scored: false,
    note: `${what} not scored: the actual is ${basisWord(actual)}; the bogey is ${basisWord(bogey)}. The two figures are shown side by side.`,
  };
}

/**
 * The shared comparison point: the delta, or null when the bases are not known
 * to match (or the arithmetic is undefined). `compute` is the caller's own
 * arithmetic, so each surface keeps its formatting; only the basis gate is
 * shared.
 */
export function scoreWhenBasisMatches<T>(
  actualBasis: MaybeBasis,
  bogeyBasis: MaybeBasis,
  compute: () => T | null,
): T | null {
  return basesMatch(actualBasis, bogeyBasis) ? compute() : null;
}

/**
 * Display rows: may this row's EPS actual be scored against its consensus?
 * (The consensus a row shows is always the vendor feed's.) A row with no
 * attached basis follows its own stamp, as `renderHeadlineTable` does.
 */
export function epsRowScoring(row: {
  eps_actual_basis?: FigureBasis;
  manual_actuals_at?: string | null;
}): ScoreEligibility & { basis: FigureBasis } {
  const basis: FigureBasis = row.eps_actual_basis ?? (row.manual_actuals_at ? "non_gaap" : "vendor");
  return { ...scoreEligibility("EPS", basis, "vendor"), basis };
}
