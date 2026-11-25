import { db } from "@/lib/db";
import { todayET } from "@/lib/calendar/date-utils";
import { computeGainsAtRisk } from "@/lib/compute/gains-at-risk";
import { computeYearGain } from "@/lib/compute/year-gain";
import { getPositionsFreshness } from "@/lib/queries/positions-freshness";
import { gainsAtRiskAccountIds } from "@/lib/analysis/gains-at-risk-scope";
import type { AnalysisScope } from "@/lib/analysis/view-param";
import { latestValuationDate, type GainsAtRiskResponse } from "@/lib/analysis/gains-at-risk-input";
import {
  DEFAULT_DRIVER,
  DEFAULT_SELECTED_MOVE,
  defaultSweep,
  defaultValuationDate,
  requestMoves,
} from "@/lib/analysis/gains-at-risk-view";
import { EmptySection } from "../EmptySection";
import { GainsAtRiskView } from "./GainsAtRiskView";
import { TrialPositionsProvider } from "./TrialPositionsProvider";

/**
 * Gains at risk (Analysis, step 1): the server half. Computes the first
 * paint with the default controls (QQQ, Dec 31, no volatility change, the
 * default sweep) and hands it to the client view, which re-asks the route
 * on every control change. Read-only.
 *
 * The account ids follow the route's own rule, one copy
 * (`gainsAtRiskAccountIds`): "all" is every account; any other scope word
 * reads only the accounts it names, and a word that names no account reads
 * nothing ([]), never every account.
 *
 * Trial positions (step 2) live in TrialPositionsProvider, rendered AROUND
 * the keyed view and NOT keyed itself: a scope pill is a soft navigation, so
 * the provider keeps the trial positions while the view remounts with the
 * new scope. The server never sees them here; the view asks the route with
 * them at once when it mounts with some.
 */

export function GainsAtRiskSection({ scope }: { scope: AnalysisScope }) {
  const today = todayET();
  const accountIds = gainsAtRiskAccountIds(db, scope);
  const scopeHasAccounts = accountIds === undefined || accountIds.length > 0;
  const valuationDate = defaultValuationDate(today);
  const moves = requestMoves(defaultSweep(), null);

  let initial: GainsAtRiskResponse;
  try {
    initial = {
      result: computeGainsAtRisk(db, {
        accountIds,
        driverSymbol: DEFAULT_DRIVER,
        valuationDate,
        moves,
        volChangePoints: 0,
        today,
      }),
      // The year's gain is every account, whatever the stress scope (ruling 1).
      yearGain: computeYearGain(db, { today }),
      yearGainFreshness: getPositionsFreshness(db, undefined, today),
      scopeFreshness: getPositionsFreshness(db, accountIds, today),
    };
  } catch {
    // One content-free log line: no exception text, no figure
    // (tests/repo/honest-mutating-handlers.test.ts). The page says it failed.
    console.error("[gains-at-risk] first paint failed");
    return (
      <EmptySection
        title="Gains at risk"
        reason="Could not compute gains at risk. Reload the page to try again."
      />
    );
  }

  return (
    <TrialPositionsProvider>
      <GainsAtRiskView
        // A new scope is a new page: start from the defaults the server used.
        // Only the trial positions carry over, through the provider above.
        key={scope}
        scope={scope}
        scopeHasAccounts={scopeHasAccounts}
        today={today}
        latestDate={latestValuationDate(today)}
        initial={initial}
        initialInputs={{
          driverSymbol: DEFAULT_DRIVER,
          valuationDate,
          volChangePoints: 0,
          selectedMove: DEFAULT_SELECTED_MOVE,
        }}
      />
    </TrialPositionsProvider>
  );
}
