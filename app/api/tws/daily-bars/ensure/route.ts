import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getIbApi } from "@/lib/tws/client";
import { checkTrialSecurity } from "@/lib/compute/gains-at-risk-trial";
import { ensureDailyBarsForSecurity, type DailyBarIneligibleReason } from "@/lib/tws/daily-bar-capture";
import {
  ensureBarsBodyProblem,
  trialSecurityRefusalSentence,
  type EnsureBarsResponse,
} from "@/lib/analysis/gains-at-risk-input";

/**
 * POST /api/tws/daily-bars/ensure — make sure one security has daily bars
 * (Gains at risk step 2, rulings R9 and P9): runs the daily-bar capture's own
 * per-security body for that one name (`ensureDailyBarsForSecurity`), under
 * the same limiter and rules. Writes only `ohlcv_bars`.
 *
 * Order (P9): body { securityId } checked (400); the security checked on the
 * server: non-option, US dollar, broker contract on file (422); only then the
 * broker. Answers: 200 { success: true, data: EnsureBarsResponse } for
 * succeeded / exhausted / already-today; 503 not connected; 409 while a sync
 * batch runs; 422 not-found / no-contract-id / ineligible; 429 while a name
 * that just failed cools down (Retry-After set); 502 failed (and after the
 * third failure of the day).
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "The request body is not valid JSON." }, { status: 400 });
  }

  const problem = ensureBarsBodyProblem(body);
  if (problem) {
    return NextResponse.json({ success: false, error: problem }, { status: 400 });
  }
  const securityId = (body as { securityId: number }).securityId;
  const fail = (status: number, error: string, headers?: Record<string, string>) =>
    NextResponse.json({ success: false, error }, { status, headers });

  try {
    const check = checkTrialSecurity(db, securityId, { requireContractId: true });
    if (!check.ok) {
      const symbol = check.reason === "not-found" ? null : symbolOf(securityId);
      return fail(422, trialSecurityRefusalSentence(check.reason, symbol));
    }
    const symbol = check.symbol;

    const api = getIbApi();
    if (!api) return fail(503, "Connect the broker to fetch daily prices.");

    const result = await ensureDailyBarsForSecurity(db, api, securityId);
    if (result.ok) {
      const data: EnsureBarsResponse = { securityId, result };
      return NextResponse.json({ success: true, data });
    }
    switch (result.reason) {
      case "not-connected":
        return fail(503, "Connect the broker to fetch daily prices.");
      case "batch-running":
        return fail(409, "The daily price sync is running; try again in a moment.");
      case "not-found":
        return fail(422, trialSecurityRefusalSentence("not-found", null));
      case "no-contract-id":
        return fail(422, trialSecurityRefusalSentence("no-contract-id", symbol));
      case "ineligible": {
        const why = ineligibleWhy(result.ineligibleReason);
        return fail(422, why === null ? CANNOT_FETCH : `Daily prices are not fetched for ${symbol}: ${why}.`);
      }
      case "cooling-down": {
        const minutes = Math.max(1, Math.ceil(result.retryAfterSeconds / 60));
        return fail(
          429,
          `Fetching daily prices for ${symbol} failed a moment ago. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
          { "Retry-After": String(result.retryAfterSeconds) },
        );
      }
      case "failed-today":
        return fail(502, `The broker did not send daily prices for ${symbol} after several tries today. Try again tomorrow.`);
      case "failed":
        return fail(502, `The broker did not send daily prices for ${symbol}. Try again later.`);
      default:
        // A refusal this route does not know yet: never guess its reason.
        return fail(422, CANNOT_FETCH);
    }
  } catch {
    // Content-free log line: no symbol, no message.
    console.error("[daily-bars-ensure] failed");
    return fail(500, "Could not fetch daily prices.");
  }
}

const CANNOT_FETCH = "This security cannot be fetched.";

/** The plain reason for a known eligibility refusal; null when the reason is missing or unknown. */
function ineligibleWhy(reason: DailyBarIneligibleReason | undefined): string | null {
  return reason !== undefined && Object.prototype.hasOwnProperty.call(INELIGIBLE_WHY, reason) ? INELIGIBLE_WHY[reason] : null;
}

const INELIGIBLE_WHY: Record<DailyBarIneligibleReason, string> = {
  option: "it is an option",
  "mutual-fund": "it is a mutual fund, priced once a day",
  "bond-fund": "it is a bond fund",
  "bond-or-cash": "it is a bond or a cash holding",
  "no-contract-id": "its broker contract is not on file",
  "not-us-session": "it does not trade in the US session",
};

function symbolOf(securityId: number): string | null {
  const row = db.prepare("SELECT symbol FROM securities WHERE id = ?").get(securityId) as { symbol: string } | undefined;
  return row?.symbol ?? null;
}
