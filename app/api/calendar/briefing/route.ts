import { db } from "@/lib/db";
import { generateWeeklyBriefing } from "@/lib/calendar/briefing";
import { getBriefingByWeek, getLatestBriefing } from "@/lib/queries/calendar";

/**
 * GET /api/calendar/briefing?weekOf=YYYY-MM-DD — Fetch a stored briefing.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const weekOf = searchParams.get("weekOf");

  const briefing = weekOf
    ? getBriefingByWeek(db, weekOf)
    : getLatestBriefing(db);

  return Response.json({ briefing });
}

/**
 * POST /api/calendar/briefing — Generate a weekly research briefing.
 *
 * Uses Claude to analyze all events for a given week and produce
 * a comprehensive markdown briefing. Returns SSE stream with progress.
 *
 * Body: { weekOf: string }  — YYYY-MM-DD (Monday of the week)
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const weekOf = body.weekOf as string;

  if (!weekOf || !/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) {
    return Response.json(
      { error: "weekOf is required (YYYY-MM-DD format)" },
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
        const result = await generateWeeklyBriefing(db, weekOf, {
          onProgress: (message, current, total) => {
            send({ progress: { phase: "generating", message, current, total } });
          },
        });

        send({
          complete: true,
          data: {
            weekOf,
            eventCount: result.eventCount,
            contentLength: result.content.length,
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
