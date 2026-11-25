import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { todayET } from "@/lib/calendar/date-utils";
import { buildTrialEntry, checkTrialSecurity, lookupTrialSecurity, trialValuationPrice } from "@/lib/compute/gains-at-risk-trial";
import {
  cleanTrialEntryBody,
  trialEntryBodyProblem,
  trialEntryRefusalSentence,
  trialSecurityRefusalSentence,
  type TrialEntryBody,
  type TrialEntryResponse,
} from "@/lib/analysis/gains-at-risk-input";

/**
 * POST /api/compute/gains-at-risk/trial-entry — a trial position at the click
 * (Gains at risk step 2, rulings R1, R2, R10, P1, P8, P9, P11). Read-only:
 * nothing is stored and the broker is never asked.
 *
 * Body: TrialEntryBody (lib/analysis/gains-at-risk-input.ts).
 *   - `lookup`: a name the app already knows (non-option, US dollar), with its
 *     latest stored price and whether daily bars exist (P8).
 *   - `entry`: the fixed record (`buildTrialEntry`): for an option the
 *     volatility solved ONCE from the typed price and the underlying's price
 *     at the click; the per-account holdings snapshot; the price source and a
 *     stale-close date, all untouched; beside it `underlyingPriceSource`
 *     ("client-quote" when the client sent a quoted underlying price) and
 *     `appValuation`, the app's own price, date and source for the name.
 *     Called for a new entry only (a size-only edit makes no
 *     call, P1).
 * Answers 200 { success: true, data: TrialEntryResponse }; 400 for a body
 * problem; 422 with a sentence for a refusal.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "The request body is not valid JSON." }, { status: 400 });
  }

  const today = todayET();
  const problem = trialEntryBodyProblem(body, today);
  if (problem) {
    return NextResponse.json({ success: false, error: problem }, { status: 400 });
  }
  const input = cleanTrialEntryBody(body as TrialEntryBody);

  try {
    if (input.action === "lookup") {
      const symbol = input.symbol.trim().toUpperCase();
      const found = lookupTrialSecurity(db, symbol, { today });
      if (!found) {
        return NextResponse.json({ success: false, error: trialSecurityRefusalSentence("not-found", symbol) }, { status: 422 });
      }
      const check = checkTrialSecurity(db, found.securityId, { requireContractId: false });
      if (!check.ok) {
        return NextResponse.json({ success: false, error: trialSecurityRefusalSentence(check.reason, found.symbol) }, { status: 422 });
      }
      const data: TrialEntryResponse = { action: "lookup", security: found };
      return NextResponse.json({ success: true, data });
    }

    // buildTrialEntry looks the symbol up and checks the security (non-option, US dollar) before anything else.
    const entry = buildTrialEntry(db, input.request, { today, now: new Date() });
    if (!entry.ok) {
      return NextResponse.json({ success: false, error: trialEntryRefusalSentence(entry.reason, entry.symbol) }, { status: 422 });
    }
    // Where the underlying price came from, as the server can stand behind it: a quoted price
    // came from the client (the server did not fetch it). The app's own valuation price is
    // returned beside it either way. `entry` itself is buildTrialEntry's record, untouched.
    const securityId = entry.position.kind === "option" ? entry.position.underlyingSecurityId : entry.position.securityId;
    const data: TrialEntryResponse = {
      action: "entry",
      entry,
      underlyingPriceSource: entry.underlyingPriceSource === "quote" ? "client-quote" : entry.underlyingPriceSource,
      appValuation: trialValuationPrice(db, securityId, { today }),
    };
    return NextResponse.json({ success: true, data });
  } catch {
    // Content-free log line: no symbol, no figure, no message.
    console.error("[gains-at-risk-trial-entry] failed");
    return NextResponse.json({ success: false, error: "Could not prepare the trial position." }, { status: 500 });
  }
}
