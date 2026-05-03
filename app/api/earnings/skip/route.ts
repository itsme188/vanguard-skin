import { db } from "@/lib/db";
import {
  recordEarningsEmailSkip,
  unrecordEarningsEmailSkip,
} from "@/lib/mutations/earnings-skips";
import { getSkippedPhasesForEvents } from "@/lib/queries/earnings-skips";

export const dynamic = "force-dynamic";

/**
 * POST /api/earnings/skip — Mark a single (event, phase) as skipped.
 *
 * Body: { eventId: number, phase: "preview" | "recap" }
 *
 * The next /api/cron/earnings-sweep poll will exclude this row from the
 * candidate set. Idempotent — re-skipping is a no-op.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    eventId?: number;
    phase?: string;
  };

  if (typeof body.eventId !== "number" || !Number.isInteger(body.eventId)) {
    return Response.json({ error: "eventId must be an integer" }, { status: 400 });
  }
  if (body.phase !== "preview" && body.phase !== "recap") {
    return Response.json({ error: "phase must be 'preview' or 'recap'" }, { status: 400 });
  }

  const inserted = recordEarningsEmailSkip(db, body.eventId, body.phase);
  return Response.json({ ok: true, inserted });
}

/**
 * DELETE /api/earnings/skip?eventId=N&phase=preview — Undo a skip.
 *
 * Lets the user change their mind before the email window closes.
 */
export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const eventId = Number(url.searchParams.get("eventId"));
  const phase = url.searchParams.get("phase");

  if (!Number.isInteger(eventId)) {
    return Response.json({ error: "eventId must be an integer" }, { status: 400 });
  }
  if (phase !== "preview" && phase !== "recap") {
    return Response.json({ error: "phase must be 'preview' or 'recap'" }, { status: 400 });
  }

  const deleted = unrecordEarningsEmailSkip(db, eventId, phase);
  return Response.json({ ok: true, deleted });
}

/**
 * GET /api/earnings/skip?eventIds=1,2,3 — Read skip state for the EarningsHub.
 *
 * Returns: { [eventId]: { preview: boolean, recap: boolean } }
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("eventIds") ?? "";
  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

  return Response.json(getSkippedPhasesForEvents(db, ids));
}
