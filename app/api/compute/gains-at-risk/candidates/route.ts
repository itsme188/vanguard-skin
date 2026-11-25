import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { todayET } from "@/lib/calendar/date-utils";
import { GainsAtRiskInputError } from "@/lib/compute/gains-at-risk";
import { computeGainsAtRiskCandidates } from "@/lib/compute/gains-at-risk-candidates";
import { candidatesProblem } from "@/lib/compute/gains-at-risk-candidate-check";
import { resolveGainsAtRiskInput } from "@/lib/compute/gains-at-risk-candidate-quotes";
import { gainsAtRiskAccountIds } from "@/lib/analysis/gains-at-risk-scope";
import { checkTrialSecurity } from "@/lib/compute/gains-at-risk-trial";
import { computeYearGain } from "@/lib/compute/year-gain";
import { getPositionsFreshness } from "@/lib/queries/positions-freshness";
import { trialSecurityRefusalSentence } from "@/lib/analysis/gains-at-risk-input";
import {
  candidatesBodyProblem,
  cleanCandidateItems,
  type CandidatesBody,
  type CandidatesResponse,
} from "@/lib/analysis/gains-at-risk-candidates-input";

/**
 * POST /api/compute/gains-at-risk/candidates — call 2 of the candidate table
 * (Gains at risk step 3, P10, P12, P13, D3, D9, D10). No broker; read-only.
 *
 * Body: the gains-at-risk body plus `budgetUsd` (whole cents), `selectedMove`
 * (one of moves) and 1 to 30 candidates as call 1 returned them. Order: the
 * body's shape (400), then the candidates' own validator (400 naming
 * `candidates[i].<field>`, D3/F4), both before any database read; then each
 * candidate's underlying on the server (422); then the single-name driver
 * against the server's list (400), as the compute route checks it. Then every
 * row is sized in exact units and priced on ONE engine run (the book loads
 * once). 200 { success: true, data: CandidatesResponse }: `result`,
 * `yearGain` and the two freshness readings equal the compute route's for the
 * same body; the rows follow. Nothing is stored.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "The request body is not valid JSON." }, { status: 400 });
  }
  const today = todayET();
  const problem = candidatesBodyProblem(body, today) ?? candidatesProblem((body as { candidates?: unknown }).candidates);
  if (problem) {
    return NextResponse.json({ success: false, error: problem }, { status: 400 });
  }
  const input = body as CandidatesBody;
  const candidates = cleanCandidateItems(input.candidates);

  try {
    for (const id of new Set(candidates.map((c) => c.underlyingSecurityId))) {
      const check = checkTrialSecurity(db, id, { requireContractId: false });
      if (!check.ok) {
        const symbol = check.reason === "not-found" ? null : symbolOf(id);
        return NextResponse.json({ success: false, error: trialSecurityRefusalSentence(check.reason, symbol) }, { status: 422 });
      }
    }

    // "all" is every account; a scope word naming no account reads nothing (one rule, shared with the section).
    const accountIds = gainsAtRiskAccountIds(db, input.scope);
    const resolved = resolveGainsAtRiskInput(db, input, accountIds, today);
    if (!resolved.ok) {
      return NextResponse.json({ success: false, error: resolved.error }, { status: 400 });
    }
    const { result, rows } = computeGainsAtRiskCandidates(db, resolved.input, {
      budgetUsd: input.budgetUsd,
      selectedMove: input.selectedMove,
      candidates,
    });
    const data: CandidatesResponse = {
      result,
      yearGain: computeYearGain(db, { today }),
      yearGainFreshness: getPositionsFreshness(db, undefined, today),
      scopeFreshness: getPositionsFreshness(db, accountIds, today),
      budgetUsd: input.budgetUsd,
      selectedMove: input.selectedMove,
      rows,
    };
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (error instanceof GainsAtRiskInputError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    // Content-free log line: a stage and an error class name, never the message, the body or a figure.
    console.error(`[gains-at-risk-candidates] compute failed: ${error instanceof Error ? error.constructor.name : typeof error}`);
    return NextResponse.json({ success: false, error: "Could not compute the candidates." }, { status: 500 });
  }
}

function symbolOf(securityId: number): string | null {
  const row = db.prepare("SELECT symbol FROM securities WHERE id = ?").get(securityId) as { symbol: string } | undefined;
  return row?.symbol ?? null;
}
