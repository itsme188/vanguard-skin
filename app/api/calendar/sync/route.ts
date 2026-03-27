import { db } from "@/lib/db";
import { fetchWshEvents } from "@/lib/tws/wsh";
import { parseWshEvents } from "@/lib/calendar/parse-wsh";
import { fetchMacroEvents } from "@/lib/calendar/macro-events";
import { upsertCalendarEvents } from "@/lib/mutations/calendar";
import { getIbApi } from "@/lib/tws/client";

/**
 * POST /api/calendar/sync — Pull calendar events for a week.
 *
 * Fetches company events from WSH (if TWS connected) and macro events
 * from Claude. Stores all events in calendar_events table.
 * Returns SSE stream with progress events.
 *
 * Body: { weekOf?: string }  — YYYY-MM-DD (Monday), defaults to upcoming Monday
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const weekOf = (body.weekOf as string) || getUpcomingMonday();

  // Compute the date range for the week (Monday through Sunday)
  const startDate = weekOf;
  const endDate = addDays(weekOf, 6);

  // YYYYMMDD format for WSH
  const wshStart = startDate.replace(/-/g, "");
  const wshEnd = endDate.replace(/-/g, "");

  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
        );
      };

      let wshCount = 0;
      let macroCount = 0;

      try {
        // ── Phase 1: WSH company events (if TWS connected) ──────
        const api = getIbApi();
        if (api) {
          send({
            progress: {
              phase: "wsh_fetch",
              message: "Fetching company events from TWS...",
            },
          });

          try {
            const wshJson = await fetchWshEvents({
              startDate: wshStart,
              endDate: wshEnd,
              fillPortfolio: true,
            });

            send({
              progress: {
                phase: "wsh_parse",
                message: "Parsing WSH event data...",
              },
            });

            const wshEvents = parseWshEvents(wshJson, weekOf, db);
            if (wshEvents.length > 0) {
              upsertCalendarEvents(db, wshEvents);
            }
            wshCount = wshEvents.length;

            send({
              progress: {
                phase: "wsh_done",
                message: `Found ${wshCount} company event${wshCount !== 1 ? "s" : ""}`,
              },
            });
          } catch (err) {
            const msg =
              err instanceof Error ? err.message : "Unknown WSH error";
            send({
              progress: {
                phase: "wsh_error",
                message: `WSH fetch failed: ${msg}. Continuing with macro events...`,
              },
            });
          }
        } else {
          send({
            progress: {
              phase: "wsh_skip",
              message:
                "TWS not connected — skipping company events. Connect TWS and re-sync to include earnings/analyst meetings.",
            },
          });
        }

        // ── Phase 2: Claude macro events ────────────────────────
        send({
          progress: {
            phase: "macro_fetch",
            message: "Researching macro events via Claude...",
          },
        });

        try {
          const macroEvents = await fetchMacroEvents(
            startDate,
            endDate,
            weekOf
          );
          if (macroEvents.length > 0) {
            upsertCalendarEvents(db, macroEvents);
          }
          macroCount = macroEvents.length;

          send({
            progress: {
              phase: "macro_done",
              message: `Found ${macroCount} macro event${macroCount !== 1 ? "s" : ""}`,
            },
          });
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "Unknown error";
          send({
            progress: {
              phase: "macro_error",
              message: `Macro event fetch failed: ${msg}`,
            },
          });
        }

        // ── Complete ────────────────────────────────────────────
        send({
          complete: true,
          data: {
            weekOf,
            startDate,
            endDate,
            wshEvents: wshCount,
            macroEvents: macroCount,
            totalSaved: wshCount + macroCount,
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

// ── Date utilities ────────────────────────────────────────────────

function getUpcomingMonday(): string {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, ...
  // If it's Monday-Thursday, use this Monday. If Fri-Sun, use next Monday.
  const daysUntilMonday = day === 0 ? 1 : day <= 4 ? 1 - day : 8 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + daysUntilMonday);
  return monday.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
