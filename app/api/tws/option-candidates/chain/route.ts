import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getIbApi } from "@/lib/tws/client";
import { fetchOptionChain } from "@/lib/tws/option-chain-reader";
import { checkTrialSecurity, trialValuationPrice } from "@/lib/compute/gains-at-risk-trial";
import { todayET } from "@/lib/calendar/date-utils";
import { expiryNotLiveProblem } from "@/lib/compute/gains-at-risk-candidate-quotes";
import { trialSecurityRefusalSentence } from "@/lib/analysis/gains-at-risk-input";
import {
  chainBodyProblem,
  chainRefusalSentence,
  cleanChainBody,
  defaultCandidateStrikes,
  type ChainBody,
  type ChainResponse,
} from "@/lib/analysis/gains-at-risk-candidates-input";

/**
 * POST /api/tws/option-candidates/chain — the option chain of one underlying
 * for the candidate table (Gains at risk step 3, P11, D1, D7). Nothing is
 * written.
 *
 * Order: the body (400); the underlying on the server, a non-option, US-dollar
 * security with a broker contract on file (422); the connection (503); then
 * the reader, which takes its own request bound before any broker request
 * (429 with Retry-After, nothing sent). A broker timeout is 504, a broker
 * error 502. Without `expiries`: 200 with the expiries. With 1 to 3: 200 with
 * each expiry's standard contracts and its default five out-of-the-money
 * strikes against the app's own valuation price.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "The request body is not valid JSON." }, { status: 400 });
  }
  const clickedAt = new Date();
  const today = todayET(clickedAt);
  const problem =
    chainBodyProblem(body, today) ??
    expiryNotLiveProblem(
      ((body as ChainBody).expiries ?? []).map((expiry, i) => ({ field: `expiries[${i}]`, expiry })),
      clickedAt,
    );
  if (problem) {
    return NextResponse.json({ success: false, error: problem }, { status: 400 });
  }
  const req = cleanChainBody(body as ChainBody);

  try {
    const check = checkTrialSecurity(db, req.underlyingSecurityId, { requireContractId: true });
    if (!check.ok) {
      const symbol = check.reason === "not-found" ? null : symbolOf(req.underlyingSecurityId);
      return NextResponse.json({ success: false, error: trialSecurityRefusalSentence(check.reason, symbol) }, { status: 422 });
    }
    const api = getIbApi();
    if (!api) {
      return NextResponse.json({ success: false, error: chainRefusalSentence("not-connected") }, { status: 503 });
    }

    const chain = await fetchOptionChain(db, req, { api, now: () => new Date() });
    if (!chain.ok) {
      const error = chainRefusalSentence(chain.reason, chain.retryAfterSeconds);
      switch (chain.reason) {
        case "rate-limit": {
          const retry = String(chain.retryAfterSeconds ?? 60);
          return NextResponse.json({ success: false, error }, { status: 429, headers: { "Retry-After": retry } });
        }
        case "not-connected":
          return NextResponse.json({ success: false, error }, { status: 503 });
        case "no-underlying-contract":
          return NextResponse.json({ success: false, error }, { status: 422 });
        case "timeout":
          return NextResponse.json({ success: false, error }, { status: 504 });
        case "broker-error":
          return NextResponse.json({ success: false, error }, { status: 502 });
      }
    }

    let data: ChainResponse;
    if (chain.kind === "expiries") {
      data = { kind: "expiries", underlyingSecurityId: req.underlyingSecurityId, right: req.right, expiries: chain.expiries };
    } else {
      const valuation = trialValuationPrice(db, req.underlyingSecurityId, { today });
      const valuationPrice = valuation?.price ?? null;
      data = {
        kind: "strikes",
        underlyingSecurityId: req.underlyingSecurityId,
        right: req.right,
        valuationPrice,
        valuationPriceDate: valuation?.date ?? null,
        valuationPriceSource: valuation?.source ?? null,
        byExpiry: chain.byExpiry.map((e) => {
          const defaults = new Set(defaultCandidateStrikes(e.contracts, valuationPrice, req.right));
          return {
            expiry: e.expiry,
            contracts: e.contracts,
            defaultConIds: e.contracts.filter((c) => defaults.has(c.strike)).map((c) => c.conId),
            droppedNonStandard: e.droppedNonStandard,
            droppedAmbiguous: e.droppedAmbiguous,
          };
        }),
      };
    }
    return NextResponse.json({ success: true, data });
  } catch {
    // Content-free log line: no symbol, no strike, no message.
    console.error("[option-candidates-chain] failed");
    return NextResponse.json({ success: false, error: "Could not fetch the option chain." }, { status: 500 });
  }
}

function symbolOf(securityId: number): string | null {
  const row = db.prepare("SELECT symbol FROM securities WHERE id = ?").get(securityId) as { symbol: string } | undefined;
  return row?.symbol ?? null;
}
