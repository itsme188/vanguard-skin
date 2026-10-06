import { db } from "@/lib/db";
import {
  generateRecapForModal,
  recapFailureMessage,
  RecapGenerateAborted,
  type RecapProgress,
} from "@/lib/earnings/recap-modal-generate";

export const dynamic = "force-dynamic";

/**
 * POST /api/earnings/recap-modal — compose an earnings recap on demand and
 * return the rendered HTML for the in-app modal viewer.
 *
 * Body: { eventId: number, runEnrichmentFirst?: boolean }
 *   - eventId: calendar_events.id of the earnings event
 *   - runEnrichmentFirst: when true (default), run a single-event pass of
 *     the enrichment runner before composing — fetches actual_value from
 *     Finnhub + reaction_snapshot from Yahoo (TWS unavailable in this
 *     web-triggered path). Use false to skip if you already know the row
 *     is enriched.
 *
 * Responds as Server-Sent Events (in-app long work streams — same framing
 * as POST /api/trade-review: `data: <json>\n\n` lines, then `data: [DONE]`):
 *   - { progress: { phase, message, attempt?, maxAttempts? } } — phase is
 *     "enriching" | "generating" | "retrying". The AI step runs at most 2
 *     TOTAL attempts per click (one automatic retry), each announced.
 *   - { heartbeat: true } every 15s so the connection survives a long call.
 *   - terminal { complete: true, data } where `data` is exactly the JSON body
 *     this route used to return (the three shapes below), OR
 *   - terminal { error } with a plain-language message.
 * A client that aborts the request cancels the run: no retry, no terminal
 * event, and nothing was stored (this surface never writes a recap).
 *
 * `data` shapes:
 *   - { success, html, title, eventDate, symbol, phase: "recap",
 *           markdown, enriched: { actual, reaction } | null }
 *   - { success: false, prePrint: true, code: "pre_print", error,
 *     opensAt } when the enrichment runner refuses the row on the pre-print
 *     floor — clicking "Generate" before the print window opens must not
 *     fetch, write, or push. No force override is offered here: the row's
 *     actuals road (the bogeys modal "Save actuals", which owns the force
 *     confirm) is where a human asserts an early print, and nothing on this
 *     surface can. The refusal rides a `complete` for the same reason the
 *     no-actuals-yet guard below does: a click on a row whose window has
 *     not opened is a ROUTINE, expected click, and answering it 409 wrote a
 *     red error into the user's browser console and a loss-coloured toast
 *     onto the screen for a state that is merely early (QA 2026-09-07).
 *   - { success: false, notReady: true, error } when actual_value is still
 *     missing after the enrichment attempt (same routine-click reasoning).
 * A malformed body is still a plain JSON 400 — there is no run to stream.
 *
 * No email, no audit row — this is purely a preview surface for the
 * EarningsHub "Generate" button. Use POST /api/earnings/email when the
 * user wants to actually send the recap.
 *
 * In-app pattern: no X-Cron-Secret header required, mirroring
 * /api/earnings/skip and /api/earnings/actuals.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    eventId?: number;
    runEnrichmentFirst?: boolean;
  };

  if (typeof body.eventId !== "number" || !Number.isInteger(body.eventId)) {
    return Response.json(
      { error: "Body field 'eventId' must be an integer." },
      { status: 400 },
    );
  }
  const eventId = body.eventId;
  const runEnrichmentFirst = body.runEnrichmentFirst !== false;

  // One controller for the run: the client dropping the request and the
  // stream being cancelled both land here, and the generate flow checks it
  // between phases and hands it to the AI call.
  const run = new AbortController();
  const abortRun = () => run.abort();
  if (request.signal.aborted) run.abort();
  else request.signal.addEventListener("abort", abortRun, { once: true });

  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (data: unknown) => {
        // A cancelled stream rejects enqueue — a late event is just dropped.
        if (closed || run.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Heartbeat to keep SSE alive during the long AI call.
      const heartbeat = setInterval(() => {
        send({ heartbeat: true });
      }, 15000);

      try {
        const data = await generateRecapForModal(db, eventId, {
          runEnrichmentFirst,
          signal: run.signal,
          onProgress: (progress: RecapProgress) => send({ progress }),
        });
        send({ complete: true, data });
      } catch (err) {
        // A cancel has no terminal event: the client that asked for it is
        // gone, and nothing was stored.
        if (!(err instanceof RecapGenerateAborted)) {
          send({ error: recapFailureMessage(err, 1) });
        }
      } finally {
        clearInterval(heartbeat);
        request.signal.removeEventListener("abort", abortRun);
        if (!closed) {
          try {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch {
            // Already cancelled by the client — nothing left to close.
          }
        }
      }
    },
    cancel() {
      run.abort();
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
