import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { todayET } from "@/lib/calendar/date-utils";
import { listCandidateUnderlyings, listSingleNameDrivers } from "@/lib/compute/gains-at-risk-drivers";
import { possibleTrialUnderlyings } from "@/lib/compute/gains-at-risk-candidate-quotes";
import {
  singleNameDriversBodyProblem,
  type SingleNameDriversBody,
  type SingleNameDriversResponse,
} from "@/lib/analysis/gains-at-risk-candidates-input";

/**
 * POST /api/compute/gains-at-risk/single-name-drivers — the names the page
 * may stress one at a time (Gains at risk step 3, P1, P21) and the names the
 * candidate section may pull a chain for (F8). Read-only; the broker is never
 * asked.
 *
 * Body: { trialUnderlyingIds } (the current trial positions' underlyings,
 * at most maxPositions). Answers 200 { success: true, data:
 * SingleNameDriversResponse }; 400 for a body problem.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "The request body is not valid JSON." }, { status: 400 });
  }
  const problem = singleNameDriversBodyProblem(body);
  if (problem) {
    return NextResponse.json({ success: false, error: problem }, { status: 400 });
  }
  const { trialUnderlyingIds } = body as SingleNameDriversBody;

  try {
    const today = todayET();
    // A trial underlying joins only when it is a possible trial underlying (checkTrialSecurity); the list applies the price rule.
    const drivers = listSingleNameDrivers(db, { trialUnderlyingIds: possibleTrialUnderlyings(db, trialUnderlyingIds), today });
    const data: SingleNameDriversResponse = { drivers, candidateUnderlyings: listCandidateUnderlyings(db, { drivers, today }) };
    return NextResponse.json({ success: true, data });
  } catch {
    // Content-free log line.
    console.error("[gains-at-risk-drivers] failed");
    return NextResponse.json({ success: false, error: "Could not list the names." }, { status: 500 });
  }
}
