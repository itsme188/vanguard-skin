import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  fetchHistoricalPrices,
  getRateLimiterStatus,
} from "@/lib/tws/historical";

/**
 * POST /api/tws/prices — Fetch historical prices from TWS.
 *
 * Returns a Server-Sent Events stream with per-security progress events,
 * a final summary, and a [DONE] sentinel. Same SSE pattern as /api/chat.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        const results = await fetchHistoricalPrices(db, {
          securityIds: body.securityIds,
          durationStr: body.duration,
          endDate: body.endDate,
          onProgress: (progress) => send({ progress }),
        });

        // Final summary
        const totalInserted = results.reduce((s, r) => s + r.barsInserted, 0);
        const totalErrors = results.filter((r) => r.error).length;
        send({
          complete: true,
          data: {
            securities: results.length,
            totalPricesInserted: totalInserted,
            errors: totalErrors,
            rateLimiter: getRateLimiterStatus(),
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
