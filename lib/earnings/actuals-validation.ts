import { formatLargeUSD, parseLargeUSD } from "@/lib/format";

/**
 * Parses the two "actual" text inputs on the BogeysEditModal (Actual EPS /
 * Actual revenue) and classifies the result.
 *
 * Both fields feed through parseLargeUSD, so "not a number" and "blank" both
 * come out as `null` numerically — but they are different user situations
 * and need different error copy. Collapsing them into one "provide at least
 * one actual value" message tells a user who typed `not-a-number` into EPS
 * to supply a value they can already see on screen (finding
 * today-bogeys-actuals--nonnumeric-eps-wrong-error-message, 2026-08-19).
 * This resolver checks each non-blank field for a parse failure BEFORE
 * falling back to the both-blank case.
 */
export interface ActualsInputResult {
  eps_actual: number | null;
  revenue_actual_usd: number | null;
  error: string | null;
}

export function parseActualsInput(epsRaw: string, revenueRaw: string): ActualsInputResult {
  const epsTrimmed = epsRaw.trim();
  const revenueTrimmed = revenueRaw.trim();
  const eps_actual = epsTrimmed ? parseLargeUSD(epsTrimmed) : null;
  const revenue_actual_usd = revenueTrimmed ? parseLargeUSD(revenueTrimmed) : null;

  if (epsTrimmed && eps_actual == null) {
    return { eps_actual, revenue_actual_usd, error: "EPS must be a number." };
  }
  if (revenueTrimmed && revenue_actual_usd == null) {
    return {
      eps_actual,
      revenue_actual_usd,
      error: "Revenue must be a number (e.g. 1.3B or 1300000000).",
    };
  }
  if (eps_actual == null && revenue_actual_usd == null) {
    return {
      eps_actual,
      revenue_actual_usd,
      error: "Provide at least one actual value (EPS or revenue).",
    };
  }
  return { eps_actual, revenue_actual_usd, error: null };
}

/** With no consensus to compare against, an EPS above this is questioned. */
export const MANUAL_EPS_ABSOLUTE_CEILING = 1000;
/** An EPS this many times its consensus is questioned whatever the sign. */
export const MANUAL_EPS_CONSENSUS_MULTIPLE = 100;

/**
 * A client copy of `isPlausibleEarnings` in lib/earnings/plausibility.ts.
 * This module is on the short list a Today client file may value-import
 * (tests/repo/hub-live-client-boundary), and that list is kept pure, so the
 * rule is repeated here rather than imported.
 * tests/dashboard/bogeys-manual-actuals-sanity.test.ts runs both over one grid
 * of figures so the copies cannot drift. Change the thresholds there, not here.
 */
export function plausibleEarningsClientCopy(
  consensusEps: number | null,
  actualEps: number | null,
  consensusRev: number | null,
  actualRev: number | null,
): boolean {
  if (
    consensusEps != null && actualEps != null &&
    consensusEps !== 0 && actualEps !== 0 &&
    Math.sign(consensusEps) !== Math.sign(actualEps)
  ) {
    return false;
  }
  if (consensusEps != null && actualEps != null && consensusEps > 0 && actualEps !== 0) {
    const ratio = Math.abs(actualEps) / Math.abs(consensusEps);
    if (ratio >= 1.7 || ratio <= 0.5) return false;
  }
  if (consensusRev != null && actualRev != null && consensusRev > 0) {
    const ratio = actualRev / consensusRev;
    if (ratio >= 1.4 || ratio <= 0.7) return false;
  }
  return true;
}

const usd2 = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

/**
 * The consensus a typed actual is checked against: the newest stored bogey
 * that states one (`bogeys` arrives newest first). The desk's own EPS bogey
 * wins over the vendor figure on the same row.
 */
export function consensusForActualsCheck(
  bogeys: Array<{
    eps_consensus?: number | null;
    eps_consensus_vendor?: number | null;
    revenue_consensus_usd?: number | null;
  }>,
): { eps: number | null; revenueUsd: number | null } {
  const num = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
  let eps: number | null = null;
  let revenueUsd: number | null = null;
  for (const b of bogeys) {
    if (eps == null) eps = num(b.eps_consensus) ? b.eps_consensus : num(b.eps_consensus_vendor) ? b.eps_consensus_vendor : null;
    if (revenueUsd == null && num(b.revenue_consensus_usd)) revenueUsd = b.revenue_consensus_usd;
  }
  return { eps, revenueUsd };
}

/**
 * Sanity check on hand-typed actuals (owner-approved 2026-10-07): the classic
 * slip is revenue typed into the EPS box, which stored a nine-digit EPS and
 * sent it to the recap scoreboard. Returns one sentence per figure that looks
 * wrong, or an empty list.
 *
 * It only ever ASKS. The typed figure is never changed, dropped or withheld
 * (owner ruling: a manual actual is never silently suppressed) — the caller
 * shows these in a confirm and saves on "OK".
 *
 * A figure is questioned when it fails the plausibility guard against the
 * consensus, when the EPS is 100x its consensus (covers a negative consensus,
 * which that guard does not ratio-check), or — with no EPS consensus at all —
 * when the EPS is above $1,000 a share.
 */
export function manualActualsSanityWarnings(input: {
  epsActual: number | null;
  revenueActualUsd: number | null;
  epsConsensus: number | null;
  revenueConsensusUsd: number | null;
}): string[] {
  const { epsActual, revenueActualUsd, epsConsensus, revenueConsensusUsd } = input;
  const warnings: string[] = [];
  if (epsActual != null) {
    if (epsConsensus != null) {
      const farMultiple =
        epsConsensus !== 0 &&
        Math.abs(epsActual) > MANUAL_EPS_CONSENSUS_MULTIPLE * Math.abs(epsConsensus);
      if (farMultiple || !plausibleEarningsClientCopy(epsConsensus, epsActual, null, null)) {
        warnings.push(
          `Actual EPS ${usd2(epsActual)} is a long way from the EPS consensus on file (${usd2(epsConsensus)}). Check it is not revenue typed into the EPS box.`,
        );
      }
    } else if (Math.abs(epsActual) > MANUAL_EPS_ABSOLUTE_CEILING) {
      warnings.push(
        `Actual EPS ${usd2(epsActual)} is above $1,000 a share and there is no consensus on file to compare it with. Check it is not revenue typed into the EPS box.`,
      );
    }
  }
  if (
    revenueActualUsd != null &&
    revenueConsensusUsd != null &&
    !plausibleEarningsClientCopy(null, null, revenueConsensusUsd, revenueActualUsd)
  ) {
    warnings.push(
      `Actual revenue ${formatLargeUSD(revenueActualUsd)} is a long way from the revenue consensus on file (${formatLargeUSD(revenueConsensusUsd)}).`,
    );
  }
  return warnings;
}
