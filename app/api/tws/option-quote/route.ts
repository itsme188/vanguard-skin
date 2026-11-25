import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getIbApi } from "@/lib/tws/client";
import { checkTrialSecurity } from "@/lib/compute/gains-at-risk-trial";
import { fetchOptionQuote, takeOptionQuoteSlot, type OptionQuoteRequest } from "@/lib/tws/option-quote";
import { quoteSessionLabel } from "@/lib/calendar/market-session";
import { todayET } from "@/lib/calendar/date-utils";
import {
  optionQuoteBodyProblem,
  optionQuoteRefusalSentence,
  trialSecurityRefusalSentence,
  type OptionQuoteResponse,
} from "@/lib/analysis/gains-at-risk-input";

/**
 * POST /api/tws/option-quote — one option contract's bid, ask and last, and
 * the underlying's last, from the broker (Gains at risk step 2, rulings R8,
 * R10, P9, P10). One request per click; no polling; nothing is written.
 *
 * Order (P9): the body is checked (400); the underlying is checked on the
 * server: a non-option, US-dollar security with a broker contract on file
 * (422); only then is the broker asked. 503 when the broker is not connected;
 * 429 (Retry-After) beyond 30 quotes in a rolling 60 seconds, with no request.
 * Otherwise 200 { success: true, data: OptionQuoteResponse }: the request
 * echoed, the quote (a refusal such as "no-two-sided-quote" is a 200 with
 * `quote.ok: false`), and the session label at the click.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "The request body is not valid JSON." }, { status: 400 });
  }

  const problem = optionQuoteBodyProblem(body, todayET());
  if (problem) {
    return NextResponse.json({ success: false, error: problem }, { status: 400 });
  }
  const b = body as OptionQuoteRequest;
  const req: OptionQuoteRequest = { underlyingSecurityId: b.underlyingSecurityId, right: b.right, expiry: b.expiry, strike: b.strike };

  try {
    const check = checkTrialSecurity(db, req.underlyingSecurityId, { requireContractId: true });
    if (!check.ok) {
      const symbol = check.reason === "not-found" ? null : symbolOf(req.underlyingSecurityId);
      return NextResponse.json({ success: false, error: trialSecurityRefusalSentence(check.reason, symbol) }, { status: 422 });
    }

    const api = getIbApi();
    if (!api) {
      return NextResponse.json({ success: false, error: optionQuoteRefusalSentence("not-connected") }, { status: 503 });
    }
    // Per-process limit (OPTION_QUOTE_RATE_LIMIT in OPTION_QUOTE_RATE_WINDOW_MS): beyond it, no broker request.
    const slot = takeOptionQuoteSlot(Date.now());
    if (!slot.ok) {
      return NextResponse.json(
        { success: false, error: `Too many quotes in a minute. Try again in ${slot.retryAfterSeconds} seconds.` },
        { status: 429, headers: { "Retry-After": String(slot.retryAfterSeconds) } },
      );
    }
    const clickedAt = new Date();
    const quote = await fetchOptionQuote(db, req, { api, now: () => clickedAt });
    if (!quote.ok && quote.reason === "not-connected") {
      return NextResponse.json({ success: false, error: optionQuoteRefusalSentence("not-connected") }, { status: 503 });
    }
    const data: OptionQuoteResponse = { request: req, quote, session: quoteSessionLabel(clickedAt) };
    return NextResponse.json({ success: true, data });
  } catch {
    // Content-free log line: no symbol, no strike, no message.
    console.error("[option-quote] failed");
    return NextResponse.json({ success: false, error: "Could not fetch the quote." }, { status: 500 });
  }
}

function symbolOf(securityId: number): string | null {
  const row = db.prepare("SELECT symbol FROM securities WHERE id = ?").get(securityId) as { symbol: string } | undefined;
  return row?.symbol ?? null;
}
