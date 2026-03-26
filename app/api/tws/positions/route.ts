import { db } from "@/lib/db";
import { syncPortfolio } from "@/lib/tws/positions";

/**
 * POST /api/tws/positions — Sync live portfolio from TWS.
 *
 * Fetches positions and account summary via the IBKR API, upserts
 * holdings/securities/prices, inserts a snapshot, and recomputes
 * daily valuations. Returns SSE stream with progress events.
 */
export async function POST() {
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        const result = await syncPortfolio(db, {
          onProgress: (progress) => send({ progress }),
        });

        send({ complete: true, data: result });
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
