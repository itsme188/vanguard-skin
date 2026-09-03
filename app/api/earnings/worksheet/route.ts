import { db } from "@/lib/db";
import {
  armWorksheet,
  disarmWorksheet,
} from "@/lib/mutations/earnings-worksheet-flags";
import { getWorksheetFlagsForEvents } from "@/lib/queries/earnings-worksheet-flags";
import { printWorksheetNow } from "@/lib/earnings/worksheet";
import { attemptPostCommitDrain } from "@/lib/earnings/cloud-outbox";
import {
  enqueuePrepareSteps,
  runPrepareSteps,
  getPrepareStepRows,
  type PrepareStepRow,
} from "@/lib/earnings/prepare-armed-event";

export const dynamic = "force-dynamic";

/**
 * Earnings worksheet flags + printing (feedback #6). In-app only (no cron
 * auth — same family as /api/earnings/skip).
 *
 * POST body { eventId, action: "arm" | "disarm" | "print" }:
 *   - arm    → auto-print at the preview tick (once; re-arm re-prints)
 *   - disarm → cancel (also clears the printed stamp)
 *   - print  → compose + lp immediately, no stamp involved
 * GET ?eventIds=1,2,3 → { flags: { [id]: { armed, printedAt } },
 *                       data: { prepare: { [id]: PrepareStepRow[] } } }
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    eventId?: number;
    action?: string;
  };
  if (typeof body.eventId !== "number" || !Number.isInteger(body.eventId)) {
    return Response.json({ success: false, error: "eventId must be an integer" }, { status: 400 });
  }
  const row = db
    .prepare(`SELECT event_type, symbol FROM calendar_events WHERE id = ?`)
    .get(body.eventId) as { event_type: string; symbol: string | null } | undefined;
  if (!row) {
    return Response.json({ success: false, error: `Event ${body.eventId} not found` }, { status: 404 });
  }
  // Worksheets are per-EARNINGS-print artifacts — a symbol-less macro row
  // would loop fail-prints in the auto pass (loadWorksheetInputs → null).
  if (row.event_type !== "earnings" || !row.symbol) {
    return Response.json(
      { success: false, error: "Worksheets are only available for symbol-bearing earnings events." },
      { status: 400 },
    );
  }

  switch (body.action) {
    case "arm": {
      const armed = armWorksheet(db, body.eventId);
      // v2 slice A: armed is as good as held — enqueue the prepare steps this
      // event now qualifies for. Idempotent, so a re-arm adds nothing.
      const enqueued = enqueuePrepareSteps(db, body.eventId);
      // D6: kick the pass, never await it — model calls take tens of seconds;
      // the sweep tick is the durable retry.
      void runPrepareSteps(db, { eventId: body.eventId }).catch((err) =>
        console.warn("[worksheet] prepare pass failed:", err),
      );
      // v2 slice A: hand the new armed-events generation to the Worker. The
      // whole wait is capped (2s), after which the push continues in the
      // background and the 15-minute sweep is the backstop.
      await attemptPostCommitDrain(db);
      // D11: `armed` stays top-level (the Today client reads it); new fields
      // ride under `data`.
      return Response.json({
        success: true,
        armed,
        data: { enqueued, prepare: getPrepareStepRows(db, body.eventId) },
      });
    }
    case "disarm": {
      const disarmed = disarmWorksheet(db, body.eventId);
      await attemptPostCommitDrain(db);
      return Response.json({ success: true, disarmed });
    }
    case "print":
      try {
        const r = await printWorksheetNow(db, body.eventId);
        return Response.json({ success: true, printed: r.symbol, road: r.road });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json(
          { success: false, error: `Print failed: ${msg}` },
          { status: 500 },
        );
      }
    default:
      return Response.json(
        { success: false, error: 'action must be "arm", "disarm", or "print"' },
        { status: 400 },
      );
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ids = (url.searchParams.get("eventIds") ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const map = getWorksheetFlagsForEvents(db, ids);
  const flags: Record<number, { armed: boolean; printedAt: string | null }> = {};
  for (const [id, v] of map) flags[id] = { armed: v.armed, printedAt: v.printedAt };
  // v2 slice A: the prepare-step rows for the same ids. READ-ONLY — no
  // enqueue, no reconcile, no pass kicked from a GET (SameSite=Lax GET-CSRF).
  const prepare: Record<number, PrepareStepRow[]> = {};
  for (const id of ids) prepare[id] = getPrepareStepRows(db, id);
  return Response.json({ success: true, flags, data: { prepare } });
}
