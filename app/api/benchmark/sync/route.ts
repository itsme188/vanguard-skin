import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { fetchBenchmarkPrices } from "@/lib/tws/benchmark";

/**
 * POST /api/benchmark/sync
 * Fetch benchmark prices from TWS. Returns SSE progress stream.
 * Body: { symbols?: string[], duration?: string }
 */
export async function POST(request: NextRequest) {
  let body: { symbols?: string[]; duration?: string } = {};
  try {
    body = await request.json();
  } catch {
    // empty body is fine — use defaults
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(data: unknown) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      try {
        const results = await fetchBenchmarkPrices(db, {
          symbols: body.symbols,
          durationStr: body.duration,
          incremental: true,
          onProgress: (progress) => send({ progress }),
        });

        send({ complete: true, data: results });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ error: message });
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
