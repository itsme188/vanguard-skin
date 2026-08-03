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
  avgEntryPrice: number;
  exitPrice: number;
  totalQuantity: number;
  maxHoldingDays: number;
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

    const groupedTrades: GroupedTradeResponse[] = Array.from(
      groupMap.values()
    ).map((lots) => {
      const totalQty = lots.reduce((s, l) => s + l.exit_quantity, 0);
      const totalCost = lots.reduce(
        (s, l) => s + l.entry_price * l.entry_quantity,
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
        assessment: assessmentVal,
        whatWorked: whatWorkedVal,
        whatDidnt: whatDidntVal,
        totalPnl,
        avgEntryPrice: totalQty > 0 ? totalCost / totalQty : 0,
        exitPrice: lots[0].exit_price,
        totalQuantity: totalQty,
        maxHoldingDays: totalQty > 0
          ? Math.round(
              lots.reduce(
                (s, l) =>
                  s + Math.max(0, l.holding_days) * l.exit_quantity,
                0
              ) / totalQty
            )
          : 0,
        lots: lots.map((l) => ({
          id: l.id,
          entryDate: l.entry_date,
          entryPrice: l.entry_price,
          exitQuantity: l.exit_quantity,
          holdingDays: l.holding_days,
          realizedPnl: l.realized_pnl,
          returnPct: l.return_pct,
        })),
      };
    });

    return Response.json({ review, groupedTrades });
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
              {
                onProgress: (message, current, total) => {
                  send({
                    progress: {
                      phase: "generating",
                      message,
                      current,
                      total,
                    },
                  });
                },
              }
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
            {
              onProgress: (message, current, total) => {
                send({
                  progress: {
                    phase: "generating",
                    message,
                    current,
                    total,
                  },
                });
              },
            }
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
        send({ error: message });
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
