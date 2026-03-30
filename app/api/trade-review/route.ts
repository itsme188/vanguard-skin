import { db } from "@/lib/db";
import { generateTradeReview } from "@/lib/trade-review/generate";
import {
  getTradeReviews,
  getTradeReviewById,
  getTradeRoundtrips,
} from "@/lib/queries/trade-reviews";
import { getAvailableReviewPeriods } from "@/lib/compute/trade-roundtrips";

/**
 * GET /api/trade-review — List reviews or get a single review with roundtrips.
 *
 * Query params:
 *   ?accountId=&year=         — list reviews for account (year optional)
 *   ?id=                      — single review with roundtrips
 *   ?periods=true&accountId=  — available review periods for account
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // Single review detail
  const id = searchParams.get("id");
  if (id) {
    const review = getTradeReviewById(db, parseInt(id, 10));
    if (!review) {
      return Response.json({ error: "Review not found" }, { status: 404 });
    }
    const roundTrips = getTradeRoundtrips(db, review.id);
    return Response.json({ review, roundTrips });
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
 * POST /api/trade-review — Generate a trade review (SSE stream).
 *
 * Body: { accountId: number, periodStart: string, periodEnd: string }
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const { accountId, periodStart, periodEnd } = body as {
    accountId?: number;
    periodStart?: string;
    periodEnd?: string;
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

      try {
        const result = await generateTradeReview(
          db,
          { accountId, periodStart, periodEnd },
          {
            onProgress: (message, current, total) => {
              send({
                progress: { phase: "generating", message, current, total },
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
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        send({ error: message });
      } finally {
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
