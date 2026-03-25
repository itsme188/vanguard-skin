import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  fetchHistoricalPrices,
  getRateLimiterStatus,
} from "@/lib/tws/historical";
import { fetchSnapshotPrices } from "@/lib/tws/snapshot";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";
import type { PriceFetchMode } from "@/lib/tws/types";

/**
 * POST /api/tws/prices — Fetch prices from TWS.
 *
 * Supports two modes:
 * - "snapshot" (default): Quick Refresh via market data snapshots (~2 min)
 * - "historical": Full history via getHistoricalData with incremental logic
 *
 * Returns a Server-Sent Events stream with per-security progress events,
 * a final summary, and a [DONE] sentinel. Same SSE pattern as /api/chat.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const mode: PriceFetchMode = body.mode === "historical" ? "historical" : "snapshot";
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        if (mode === "snapshot") {
          const results = await fetchSnapshotPrices(db, {
            securityIds: body.securityIds,
            onProgress: (progress) => send({ progress }),
          });

          const pricesUpdated = results.filter((r) => r.price !== null).length;
          const totalErrors = results.filter((r) => r.error).length;

          // Auto-recompute daily valuations with fresh prices
          let valuationsRecomputed = false;
          if (pricesUpdated > 0) {
            try {
              computeDailyValuations(db);
              valuationsRecomputed = true;
            } catch {
              // Non-critical — prices are still saved
            }
          }

          send({
            complete: true,
            data: {
              mode: "snapshot",
              securities: results.length,
              pricesUpdated,
              errors: totalErrors,
              valuationsRecomputed,
            },
          });
        } else {
          // Historical mode with incremental logic
          const results = await fetchHistoricalPrices(db, {
            securityIds: body.securityIds,
            durationStr: body.duration,
            endDate: body.endDate,
            incremental: true,
            onProgress: (progress) => send({ progress }),
          });

          const totalInserted = results.reduce((s, r) => s + r.barsInserted, 0);
          const totalErrors = results.filter((r) => r.error).length;

          // Auto-recompute daily valuations
          let valuationsRecomputed = false;
          if (totalInserted > 0) {
            try {
              computeDailyValuations(db);
              valuationsRecomputed = true;
            } catch {
              // Non-critical
            }
          }

          send({
            complete: true,
            data: {
              mode: "historical",
              securities: results.length,
              totalPricesInserted: totalInserted,
              errors: totalErrors,
              rateLimiter: getRateLimiterStatus(),
              valuationsRecomputed,
            },
          });
        }
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
