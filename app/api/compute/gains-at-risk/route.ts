import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { todayET } from "@/lib/calendar/date-utils";
import { computeGainsAtRisk, GainsAtRiskInputError } from "@/lib/compute/gains-at-risk";
import { resolveGainsAtRiskInput } from "@/lib/compute/gains-at-risk-candidate-quotes";
import { gainsAtRiskAccountIds } from "@/lib/analysis/gains-at-risk-scope";
import { computeYearGain } from "@/lib/compute/year-gain";
import { getPositionsFreshness } from "@/lib/queries/positions-freshness";
import {
  gainsAtRiskBodyProblem,
  type GainsAtRiskBody,
  type GainsAtRiskResponse,
} from "@/lib/analysis/gains-at-risk-input";

/**
 * POST /api/compute/gains-at-risk — the book's profit or loss under a sweep
 * of moves of one driver index, at a valuation date. Read-only.
 *
 * Body: GainsAtRiskBody (lib/analysis/gains-at-risk-input.ts).
 * Answers { success: true, data: GainsAtRiskResponse }: the engine result for
 * the scope (both cases, the bar evidence and the ignored-figure count,
 * passed through untouched), the year's gain for EVERY account, and
 * freshness for every account and for the scope.
 *
 * Step 2: `trialPositions` (fixed at the click by the trial-entry route) are
 * shape-checked with the body (400) and passed to the engine. Securities are
 * NOT looked up here: a retained trial whose security has since become
 * unknown, an option or non-dollar, or whose expiry has passed, is returned
 * by the engine as a refused row with zero effect while every other position
 * computes (P11). The server-side security check is on the three routes that
 * create an entry, fetch a quote or fetch bars. Nothing about a trial is stored.
 *
 * Step 3: an optional `driver` (one stock or fund, P1) must be on the server's
 * own list, built with the body's trial underlyings; otherwise 400. Moves are
 * bounded per mode (P5). With no `driver` the engine input and the reply are
 * step 2's, byte for byte (P8).
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
    // "all" is every account; a scope word naming no account reads nothing (one rule, shared with the section).
    const accountIds = gainsAtRiskAccountIds(db, input.scope);
    const resolved = resolveGainsAtRiskInput(db, input, accountIds, today);
    if (!resolved.ok) {
      return NextResponse.json({ success: false, error: resolved.error }, { status: 400 });
    }
    const result = computeGainsAtRisk(db, resolved.input);
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
