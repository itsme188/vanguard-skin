import { getStaleTradeReviewIds } from "@/lib/queries/trade-review-pairings";
import { db } from "@/lib/db";
import {
  prepareTradeReview,
  generateTradeReview,
} from "@/lib/trade-review/generate";
import {
  getTradeReviews,
  getTradeReviewById,
  getTradeRoundtrips,
} from "@/lib/queries/trade-reviews";
import { getAvailableReviewPeriods } from "@/lib/compute/trade-roundtrips";
import { getTaxConventionState } from "@/lib/compute/tax-convention";
import {
  classifyAnthropicError,
  classifyAnthropicErrorMessage,
} from "@/lib/ai/classify-anthropic-error";
import { AISDKError } from "ai";
import { AIRefusalError } from "@/lib/ai/generate";

interface GroupedTradeResponse {
  saleTransactionId: number | null;
  symbol: string;
  securityType: string | null;
  exitDate: string;
  grade: string | null;
  assessment: string | null;
  whatWorked: string | null;
  whatDidnt: string | null;
  totalPnl: number;
  returnPct: number;
  avgEntryPrice: number;
  exitPrice: number;
  totalQuantity: number;
  maxHoldingDays: number;
  /**
   * True when the sale transaction is the engine-owned synthetic
   * RECONCILE_CLOSE row (never real broker activity — see
   * lib/compute/tax-lots.ts). Every lot in a group shares one
   * sale_transaction_id, so this is consistent across the whole trade.
   * Realized P&L on this trade is an estimate; the view labels it
   * (finding 1, number-trust durable fixes).
   */
  isSyntheticClose: boolean;
  isShort: boolean;
  pairingsStale: boolean;
  lots: Array<{
    id: number;
    entryDate: string;
    entryPrice: number;
    exitQuantity: number;
    holdingDays: number;
    realizedPnl: number;
    returnPct: number;
  }>;
}

/**
 * GET /api/trade-review — List reviews or get a single review with grouped trades.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // Single review detail — returns grouped trades
  const id = searchParams.get("id");
  if (id) {
    const review = getTradeReviewById(db, parseInt(id, 10));
    if (!review) {
      return Response.json({ error: "Review not found" }, { status: 404 });
    }
    const roundTrips = getTradeRoundtrips(db, review.id);

    // Group roundtrips by sale_transaction_id (new) or symbol+exit_date (legacy)
    const groupMap = new Map<string, typeof roundTrips>();
    for (const rt of roundTrips) {
      const key =
        rt.sale_transaction_id != null
          ? `tx:${rt.sale_transaction_id}`
          : `${rt.symbol}:${rt.exit_date}`;
      const group = groupMap.get(key) || [];
      group.push(rt);
      groupMap.set(key, group);
    }

    const pairingsStale = getStaleTradeReviewIds(db, [review.id]).has(review.id);
    const groupedTrades: GroupedTradeResponse[] = Array.from(
      groupMap.values()
    ).map((lots) => {
      const totalQty = lots.reduce((s, l) => s + l.exit_quantity, 0);
      const totalCost = lots.reduce(
        (s, l) => s + l.entry_cost,
        0
      );
      const totalPnl = lots.reduce((s, l) => s + l.realized_pnl, 0);

      // Columns mean what their names say (migration 047; legacy scrambled
      // columns dropped in 075):
      //   assessment      — AI's overall trade assessment
      //   what_went_well  — AI's "what worked"
      //   what_went_wrong — AI's "what didn't work"
      const lot0 = lots[0];
      const assessmentVal = lot0.assessment ?? null;
      const whatWorkedVal = lot0.what_went_well ?? null;
      const whatDidntVal = lot0.what_went_wrong ?? null;

      return {
        saleTransactionId: lot0.sale_transaction_id ?? null,
        symbol: lot0.symbol,
        securityType: lot0.security_type ?? null,
        exitDate: lot0.exit_date,
        grade: lot0.grade,
        isShort: lots.every((l) => l.is_short),
        pairingsStale,
        assessment: assessmentVal,
        whatWorked: whatWorkedVal,
        whatDidnt: whatDidntVal,
        totalPnl,
        returnPct: totalCost > 0 ? totalPnl / totalCost * 100 : 0,
        avgEntryPrice: totalQty > 0 ? lots.reduce((sum, l) => sum + l.entry_price * l.exit_quantity, 0) / totalQty : 0,
        exitPrice: lots[0].exit_price,
        totalQuantity: totalQty,
        maxHoldingDays: totalQty > 0
          ? Math.round(
              lots.reduce(
                (s, l) =>
                  s + (l.is_short ? Math.abs(l.holding_days) : Math.max(0, l.holding_days)) * l.exit_quantity,
                0
              ) / totalQty
            )
          : 0,
        isSyntheticClose: lot0.is_synthetic_close ?? false,
        lots: lots.map((l) => ({
          id: l.id,
          entryDate: l.entry_date,
          entryPrice: l.entry_price,
          exitQuantity: l.exit_quantity,
          holdingDays: l.is_short ? Math.abs(l.holding_days) : l.holding_days,
          realizedPnl: l.realized_pnl,
          returnPct: l.return_pct,
        })),
      };
    });

    // WS1 pending-state contract: whether the CURRENT tax-lot convention
    // state is pending a recompute. This is a live check, independent of
    // when this review's snapshot was generated — it tells the user the
    // underlying dollar figures may need a fresh recompute to trust fully.
    const conventionPending = !getTaxConventionState(db).recomputeCurrent;

    return Response.json({ review, groupedTrades, conventionPending });
  }

  // Available periods for an account
  if (searchParams.get("periods") === "true") {
    const accountId = searchParams.get("accountId");
    if (!accountId) {
      return Response.json(
        { error: "accountId required" },
        { status: 400 }
      );
    }
    const periods = getAvailableReviewPeriods(db, parseInt(accountId, 10));
    return Response.json({ periods });
  }

  // List reviews for account
  const accountId = searchParams.get("accountId");
  if (!accountId) {
    return Response.json(
      { error: "accountId is required" },
      { status: 400 }
    );
  }
  const year = searchParams.get("year");
  const reviews = getTradeReviews(
    db,
    parseInt(accountId, 10),
    year ? parseInt(year, 10) : undefined
  );
  return Response.json({ reviews });
}

/**
 * A failure inside the review pipeline is one of two very different things,
 * and they need opposite handling (QA 2026-09-22 review of 49ce6ffb):
 *
 *  - an UPSTREAM/vendor failure — an Anthropic `APIError`, or the AI SDK's
 *    `APICallError`/`AIRefusalError` wrapper around one. Its text is vendor
 *    prose (`tool_choice: type "tool" and "any" are not supported for this
 *    model.`, a request_id, a model id) and says nothing a user can act on,
 *    so it is classified into plain language and the raw text stays in the
 *    server log.
 *  - a DOMAIN error this pipeline raised on purpose: "No closed trades found
 *    for this account in …", "No fully-tracked trades found for this period…",
 *    the 3-attempt empty-review guard with its remediation steps. Those
 *    sentences were WRITTEN for this user and already say what to do.
 *    Classifying them turns every one into "Couldn't generate the review.
 *    Try again." — wrong advice for a month that has no closed trades, which
 *    will never generate however many times it is retried.
 */
function vendorFailureMessage(error: unknown, message: string): string | null {
  // Original Anthropic SDK error (status + parsed body available).
  const classified = classifyAnthropicError(error);
  if (classified) return classified.userMessage;

  // AI SDK wrapper (`APICallError`, `NoObjectGeneratedError`, …) or our own
  // refusal wrapper: vendor-side, and `message` is upstream prose or carries
  // a model id — classify what is recognizable, never echo the remainder.
  if (AISDKError.isInstance(error) || error instanceof AIRefusalError) {
    return (
      classifyAnthropicErrorMessage(message)?.userMessage ??
      "The AI service failed on this request. Try again in a minute."
    );
  }

  // Not vendor-shaped by class, but the message may still BE an Anthropic
  // envelope that some layer preserved as a plain Error — a leak guard.
  // Returns null for ordinary prose, which is what our domain errors are.
  return classifyAnthropicErrorMessage(message)?.userMessage ?? null;
}

/**
 * POST /api/trade-review — Two-phase generation (SSE stream).
 *
 * Phase 1 (no answers): Prepare data + generate questions → streams questions
 * Phase 2 (with answers): Generate full review with user context
 *
 * Body: { accountId, periodStart, periodEnd, answers?: [{tradeNumber, answer}] }
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const { accountId, periodStart, periodEnd, answers } = body as {
    accountId?: number;
    periodStart?: string;
    periodEnd?: string;
    answers?: Array<{ tradeNumber: number; answer: string }>;
  };

  if (!accountId || !periodStart || !periodEnd) {
    return Response.json(
      { error: "accountId, periodStart, and periodEnd are required" },
      { status: 400 }
    );
  }

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(periodStart) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)
  ) {
    return Response.json(
      { error: "Dates must be in YYYY-MM-DD format" },
      { status: 400 }
    );
  }

  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
        );
      };

      // Heartbeat to keep SSE alive during long API calls
      const heartbeat = setInterval(() => {
        send({ heartbeat: true });
      }, 15000);

      // `generateTradeReview` writes to the DB only in its LAST step
      // ("Saving review to database…", step 5 of 5 — lib/trade-review/
      // generate.ts). So a failure reported before that step definitively
      // left nothing saved, and one reported after it may have saved a row.
      // The client words the banner off this flag instead of claiming
      // "nothing was saved" in both cases. `prepareTradeReview` never writes,
      // so only the generating phase feeds it.
      let saveStepStarted = false;
      const onGenerateProgress = (
        message: string,
        current?: number,
        total?: number
      ) => {
        if (
          typeof current === "number" &&
          typeof total === "number" &&
          current >= total
        ) {
          saveStepStarted = true;
        }
        send({ progress: { phase: "generating", message, current, total } });
      };

      try {
        if (!answers) {
          // Phase 1: Prepare data and generate questions
          const prepared = await prepareTradeReview(
            db,
            { accountId, periodStart, periodEnd },
            {
              onProgress: (message, current, total) => {
                send({
                  progress: { phase: "preparing", message, current, total },
                });
              },
            }
          );

          if (prepared.questions.length > 0) {
            // Send questions to client — pause for answers
            send({
              questions: prepared.questions,
              tradeCount: prepared.groupedTrades.length,
              accountName: prepared.accountName,
            });
          } else {
            // No questions — go straight to review generation
            const result = await generateTradeReview(
              db,
              { accountId, periodStart, periodEnd },
              prepared,
              undefined,
              { onProgress: onGenerateProgress }
            );

            send({
              complete: true,
              data: {
                reviewId: result.review.id,
                tradeCount: result.tradeCount,
                totalPnl: result.review.total_realized_pnl,
                winRate: result.review.win_rate,
              },
            });
          }
        } else {
          // Phase 2: Generate review with answers
          const prepared = await prepareTradeReview(
            db,
            { accountId, periodStart, periodEnd },
            {
              onProgress: (message, current, total) => {
                send({
                  progress: { phase: "preparing", message, current, total },
                });
              },
            }
          );

          const result = await generateTradeReview(
            db,
            { accountId, periodStart, periodEnd },
            prepared,
            answers,
            { onProgress: onGenerateProgress }
          );

          send({
            complete: true,
            data: {
              reviewId: result.review.id,
              tradeCount: result.tradeCount,
              totalPnl: result.review.total_realized_pnl,
              winRate: result.review.win_rate,
            },
          });
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        // Raw vendor prose never reaches the client — the model layer can throw
        // things like `tool_choice: type "tool" and "any" are not supported for
        // this model.`, which says nothing to a user about their trade review.
        // Classify those into plain domain language and keep the real text
        // server-side; our OWN domain errors are already plain language and go
        // through untouched (see vendorFailureMessage).
        console.error("[trade-review] generation failed:", message);
        send({
          error: vendorFailureMessage(error, message) ?? message,
          savedUnknown: saveStepStarted,
        });
      } finally {
        clearInterval(heartbeat);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
