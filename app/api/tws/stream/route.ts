import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  startStreaming,
  stopStreaming,
  getQuotes,
  isStreaming,
  registerClient,
  snapshotToDb,
  type LiveQuote,
} from "@/lib/tws/streaming";

/**
 * GET /api/tws/stream
 * SSE endpoint for live quote streaming.
 * Starts streaming on first client connect, stops 30s after last client disconnects.
 */
export async function GET() {
  const encoder = new TextEncoder();
  let unregister: (() => void) | null = null;
  let closed = false;
  let updateInterval: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      function send(data: unknown) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Stream closed
          closed = true;
        }
      }

      // Register this client
      unregister = registerClient();

      // Start streaming if not already active
      if (!isStreaming()) {
        try {
          startStreaming(db);
          send({ type: "status", streaming: true, message: "Streaming started" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          send({ type: "error", message: msg });
          controller.close();
          return;
        }
      } else {
        send({ type: "status", streaming: true, message: "Already streaming" });
      }

      // Send current cache immediately
      const current = getQuotes();
      if (current.length > 0) {
        send({ type: "snapshot", quotes: current });
      }

      // Push updates every second (debounced batch)
      let lastSent = new Map<number, number>(); // securityId → last timestamp sent
      updateInterval = setInterval(() => {
        if (closed) return;

        const quotes = getQuotes();
        const updates: LiveQuote[] = [];

        for (const q of quotes) {
          const prevTs = lastSent.get(q.securityId) ?? 0;
          if (q.timestamp > prevTs) {
            updates.push(q);
            lastSent.set(q.securityId, q.timestamp);
          }
        }

        if (updates.length > 0) {
          send({ type: "update", quotes: updates });
        }
      }, 1000);
    },

    cancel() {
      closed = true;
      if (updateInterval) clearInterval(updateInterval);
      if (unregister) unregister();
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

/**
 * POST /api/tws/stream
 * Control endpoint for streaming.
 * Body: { action: "stop" | "snapshot" }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (body.action === "stop") {
      stopStreaming();
      return NextResponse.json({ success: true, message: "Streaming stopped" });
    }

    if (body.action === "snapshot") {
      const count = snapshotToDb(db);
      return NextResponse.json({ success: true, pricesSaved: count });
    }

    return NextResponse.json(
      { success: false, error: "Unknown action" },
      { status: 400 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
