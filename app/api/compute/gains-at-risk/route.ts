import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { todayET } from "@/lib/calendar/date-utils";
import { computeGainsAtRisk, GainsAtRiskInputError } from "@/lib/compute/gains-at-risk";
import { resolveScope } from "@/lib/queries/accounts";
import type { AnalysisScope } from "@/lib/analysis/view-param";
import { computeYearGain } from "@/lib/compute/year-gain";
import { getPositionsFreshness } from "@/lib/queries/positions-freshness";
import {
  gainsAtRiskBodyProblem,
  type GainsAtRiskBody,
  type GainsAtRiskResponse,
} from "@/lib/analysis/gains-at-risk-input";

/**
 * The account ids to stress. "all" is every account (undefined). Any other
 * scope word reads only the accounts it names; a word that names no account
 * reads NOTHING ([]), never every account (`resolveScope` alone would answer
 * undefined there). Server-only: kept out of the shared input module.
 */
function gainsAtRiskAccountIds(scope: AnalysisScope): number[] | undefined {
  if (scope === "all") return undefined;
  return resolveScope(db, scope) ?? [];
}

/**
 * POST /api/compute/gains-at-risk — the book's profit or loss under a sweep
 * of moves of one driver index, at a valuation date. Read-only.
 *
 * Body: GainsAtRiskBody (lib/analysis/gains-at-risk-input.ts).
 * Answers { success: true, data: GainsAtRiskResponse }: the engine result for
 * the scope (both cases, the bar evidence and the ignored-figure count,
 * passed through untouched), the year's gain for EVERY account, and
 * freshness for every account and for the scope.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "The request body is not valid JSON." }, { status: 400 });
  }

  const today = todayET();
  const problem = gainsAtRiskBodyProblem(body, today);
  if (problem) {
    return NextResponse.json({ success: false, error: problem }, { status: 400 });
  }
  const input = body as GainsAtRiskBody;

  try {
    const accountIds = gainsAtRiskAccountIds(input.scope);
    const result = computeGainsAtRisk(db, {
      accountIds,
      driverSymbol: input.driverSymbol,
      valuationDate: input.valuationDate,
      moves: input.moves,
      volChangePoints: input.volChangePoints,
      priceOverrides: input.priceOverrides,
      // Keyed by the underlying identity's security id (C6); the engine counts unmatched keys.
      betaOverrides: input.betaOverrides,
      today,
    });
    const data: GainsAtRiskResponse = {
      result,
      yearGain: computeYearGain(db, { today }),
      yearGainFreshness: getPositionsFreshness(db, undefined, today),
      scopeFreshness: getPositionsFreshness(db, accountIds, today),
    };
    return NextResponse.json({ success: true, data });
  } catch (error) {
    // The caller's input (the body check refuses these first; this is the backstop).
    if (error instanceof GainsAtRiskInputError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    // Content-free log line: the message only, never the body or a figure.
    console.error("[gains-at-risk]", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ success: false, error: "Could not compute gains at risk." }, { status: 500 });
  }
}
