import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getIbApi } from "@/lib/tws/client";
import { checkTrialSecurity } from "@/lib/compute/gains-at-risk-trial";
import { expiryNotLiveProblem, quoteCandidates } from "@/lib/compute/gains-at-risk-candidate-quotes";
import { todayET } from "@/lib/calendar/date-utils";
import { trialSecurityRefusalSentence } from "@/lib/analysis/gains-at-risk-input";
import {
  cleanQuotesBody,
  quotesBodyProblem,
  quotesRefusalSentence,
  QUOTE_LOCK_BUSY_RETRY_AFTER_SECONDS,
  type QuotesBody,
} from "@/lib/analysis/gains-at-risk-candidates-input";

/**
 * POST /api/tws/option-candidates/quotes — call 1 of the candidate table
 * (Gains at risk step 3, P10, P13, D1, D2, D4, D6, D7, F2, F5). Broker quotes
 * for 1 to 15 contracts on ONE underlying, each named by its broker contract
 * id, and for every two-sided quote the entry solved once by security id.
 * Nothing is written.
 *
 * Order: the body (400); the underlying on the server, a non-option, US-dollar
 * security with a broker contract on file (422); the connection (503); then
 * the batch, which refuses before any broker request when a sync is running
 * (409), when the shared quote lock could not be had in time (503 with
 * Retry-After), or when
 * no quote slot is free (429 with Retry-After). Otherwise 200 { success: true,
 * data: QuotesResponse }: one row per contract, in request order; a contract
 * the batch refused is a 200 row with its sentence, never a model price.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "The request body is not valid JSON." }, { status: 400 });
  }
  const clickedAt = new Date();
  const problem =
    quotesBodyProblem(body, todayET(clickedAt)) ??
    expiryNotLiveProblem(
      (body as QuotesBody).contracts.map((c, i) => ({ field: `contracts[${i}].expiry`, expiry: c.expiry })),
      clickedAt,
    );
  if (problem) {
    return NextResponse.json({ success: false, error: problem }, { status: 400 });
  }
  const req = cleanQuotesBody(body as QuotesBody);

  try {
    const check = checkTrialSecurity(db, req.underlyingSecurityId, { requireContractId: true });
    if (!check.ok) {
      const symbol = check.reason === "not-found" ? null : symbolOf(req.underlyingSecurityId);
      return NextResponse.json({ success: false, error: trialSecurityRefusalSentence(check.reason, symbol) }, { status: 422 });
    }
    const api = getIbApi();
    if (!api) {
      return NextResponse.json({ success: false, error: quotesRefusalSentence("not-connected") }, { status: 503 });
    }

    // F9: one clock that advances (the batch's gap check and deadline read it), shared with every entry.
    const result = await quoteCandidates(db, req, { api, now: () => new Date() });
    if (!result.ok) {
      const error = quotesRefusalSentence(result.reason, result.retryAfterSeconds);
      switch (result.reason) {
        case "not-connected":
          return NextResponse.json({ success: false, error }, { status: 503 });
        case "no-underlying-contract":
          return NextResponse.json({ success: false, error }, { status: 422 });
        case "sync-running":
          return NextResponse.json({ success: false, error }, { status: 409 });
        case "broker-busy":
          return NextResponse.json(
            { success: false, error },
            { status: 503, headers: { "Retry-After": String(QUOTE_LOCK_BUSY_RETRY_AFTER_SECONDS) } },
          );
        case "rate-limit": {
          const retry = String(result.retryAfterSeconds ?? 60);
          return NextResponse.json({ success: false, error }, { status: 429, headers: { "Retry-After": retry } });
        }
      }
    }
    return NextResponse.json({ success: true, data: result.data });
  } catch {
    // Content-free log line: no symbol, no strike, no message.
    console.error("[option-candidates-quotes] failed");
    return NextResponse.json({ success: false, error: "Could not fetch the quotes." }, { status: 500 });
  }
}

function symbolOf(securityId: number): string | null {
  const row = db.prepare("SELECT symbol FROM securities WHERE id = ?").get(securityId) as { symbol: string } | undefined;
  return row?.symbol ?? null;
}
