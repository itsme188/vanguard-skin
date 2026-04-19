import { db } from "@/lib/db";
import { fetchWshEvents } from "@/lib/tws/wsh";
import { parseWshEvents } from "@/lib/calendar/parse-wsh";
import { fetchMacroEvents } from "@/lib/calendar/macro-events";
import { upsertCalendarEvents, deleteEventsForWeek } from "@/lib/mutations/calendar";
import { getIbApi, disconnectTws } from "@/lib/tws/client";
import { getCurrentMonday, addDays, validateWeekOf } from "@/lib/calendar/date-utils";

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
  const weekOf = (body.weekOf as string) || getCurrentMonday();

  // Validate weekOf is a real Monday
  const weekOfError = validateWeekOf(weekOf);
  if (weekOfError) {
    return Response.json({ error: weekOfError }, { status: 400 });
  }

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
      let wshNew = 0;
      let macroCount = 0;
      let macroNew = 0;

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
              const result = upsertCalendarEvents(db, wshEvents);
              wshNew = result.inserted;
            }
            wshCount = wshEvents.length;

            send({
              progress: {
                phase: "wsh_done",
                message: `Found ${wshCount} company event${wshCount !== 1 ? "s" : ""}${wshNew < wshCount ? ` (${wshNew} new)` : ""}`,
              },
            });
          } catch (err) {
            const msg =
              err instanceof Error ? err.message : "Unknown WSH error";

            // If WSH timed out, the connection is likely dead — auto-disconnect
            // so the status indicator updates and the user gets a clear signal
            if (msg.toLowerCase().includes("timeout")) {
              disconnectTws();
              send({
                progress: {
                  phase: "wsh_error",
                  message: "TWS connection appears dead — auto-disconnected. Reconnect via TWS panel to sync company events.",
                },
              });
            } else {
              send({
                progress: {
                  phase: "wsh_error",
                  message: `WSH fetch failed: ${msg}. Continuing with macro events...`,
                },
              });
            }
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
            // Clear stale macro rows for this week before inserting. The
            // source_key for FRED/non-FRED events includes the date, so
            // when a release gets rescheduled the next sync would otherwise
            // leave an orphaned row with the old (wrong) date. Deleting
            // first ensures the week reflects the latest source data.
            deleteEventsForWeek(db, weekOf, "claude_macro");
            const result = upsertCalendarEvents(db, macroEvents);
            macroNew = result.inserted;
          }
          macroCount = macroEvents.length;

          send({
            progress: {
              phase: "macro_done",
              message: `Found ${macroCount} macro event${macroCount !== 1 ? "s" : ""}${macroNew < macroCount ? ` (${macroNew} new)` : ""}`,
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
        const totalSaved = wshCount + macroCount;
        const newEvents = wshNew + macroNew;
        send({
          complete: true,
          data: {
            weekOf,
            startDate,
            endDate,
            wshEvents: wshCount,
            macroEvents: macroCount,
            totalSaved,
            newEvents,
            refreshedEvents: totalSaved - newEvents,
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

