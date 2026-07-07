/**
 * Earnings plausibility guard — single source, ZERO imports by design.
 *
 * The Worker mirror (workers/cron/src/plausibility.ts) is a byte-parity hand
 * copy below this header, pinned by workers/cron/test/plausibility-parity.test.ts
 * (same convention as print-push-message / presence-position / editions).
 * Never add an import here; change both files together.
 */

/**
 * Reject a Finnhub-sourced earnings row whose actual diverges from
 * consensus by an implausible amount. The thresholds are loose enough to
 * preserve genuine outsize beats/misses (e.g. PWR Q1 2026 EPS +28% over
 * consensus is real) but tight enough to catch known scrape failures
 * (GOOGL Q1 2026 stored EPS 5.11 vs consensus 2.70 — 89% above, confirmed
 * bogus). Exported for direct unit testing.
 */
export function isPlausibleEarnings(
  consensusEps: number | null,
  actualEps: number | null,
  consensusRev: number | null,
  actualRev: number | null,
): boolean {
  // B19: an EPS sign flip between actual and consensus is a basis mismatch
  // (GAAP vs adjusted / FFO — U +0.23 vs cons −0.24 last season) far more
  // often than a genuine loss↔profit surprise. Better no number than a
  // wrong-basis one; POST /api/earnings/actuals is the manual override.
  if (
    consensusEps != null && actualEps != null &&
    consensusEps !== 0 && actualEps !== 0 &&
    Math.sign(consensusEps) !== Math.sign(actualEps)
  ) {
    return false;
  }

  if (consensusEps != null && actualEps != null && consensusEps > 0 && actualEps !== 0) {
    // actualEps 0 carries no ratio claim — a genuine $0.00 print never produces
    // a divide-by-zero or ratio trip, so treat it like zero consensus (printable
    // as-is, not implausible). Only actualEps null or nonzero enter the ratio guard.
    // Magnitude check guards both directions. Calibrated so that PWR's
    // genuine +28% EPS beat (Q1 2026, ratio 1.28) survives, while GOOGL's
    // bogus 5.11-vs-2.70 case (ratio 1.89) gets rejected. Real >70% beats
    // from a single quarterly print are essentially unheard-of for the
    // mega-cap names this loop iterates on; if a small-cap real-world case
    // ever trips this, we'll lower the threshold and add a fixture.
    const ratio = Math.abs(actualEps) / Math.abs(consensusEps);
    if (ratio >= 1.7 || ratio <= 0.5) return false;
  }
  if (consensusRev != null && actualRev != null && consensusRev > 0) {
    // Revenue is structurally more stable than EPS — a 40% beat or 30%
    // miss on revenue from a single quarter is a near-certain scrape
    // failure for any name big enough to have a Finnhub consensus.
    const ratio = actualRev / consensusRev;
    if (ratio >= 1.4 || ratio <= 0.7) return false;
  }
  return true;
}
