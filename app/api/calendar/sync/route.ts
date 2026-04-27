import { db } from "@/lib/db";
import {
  syncCalendarForWeek,
  SyncCalendarValidationError,
} from "@/lib/calendar/sync";
import { getCurrentMonday } from "@/lib/calendar/date-utils";

/**
 * POST /api/calendar/sync — Pull calendar events for a week.
 *
 * Body: { weekOf?: string }  — YYYY-MM-DD (Monday), defaults to upcoming Monday
 *
 * Three-phase ingest (WSH → Claude macro → Finnhub) implemented in
 * lib/calendar/sync.ts. This route bridges the library's progress
 * callback to an SSE stream so the Calendar UI can render phase-by-phase
 * progress. The same library is invoked in-process by sendBriefingEmail
 * to ensure Sunday's briefing has fresh week-ahead data.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const weekOf = (body.weekOf as string) || getCurrentMonday();

  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        const result = await syncCalendarForWeek(db, weekOf, {
          onProgress: (event) => send({ progress: event }),
        });

        send({
          complete: true,
          data: {
            weekOf: result.weekOf,
            startDate: result.startDate,
            endDate: result.endDate,
            wshEvents: result.wshEvents,
            macroEvents: result.macroEvents,
            finnhubEvents: result.finnhubEvents,
            totalSaved: result.totalSaved,
            newEvents: result.newEvents,
            refreshedEvents: result.refreshedEvents,
          },
        });
      } catch (error) {
        if (error instanceof SyncCalendarValidationError) {
          send({ error: error.message });
        } else {
          const message = error instanceof Error ? error.message : "Unknown error";
          send({ error: message });
        }
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
