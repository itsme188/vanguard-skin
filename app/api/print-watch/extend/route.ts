import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { extendGoWindow, GoRefused, safeErrorText } from "@/lib/print-watch/go";
import { wakePrintWatch } from "@/lib/print-watch/watcher";

export const dynamic = "force-dynamic";

/**
 * POST /api/print-watch/extend { eventId } — the panel's "Extend 30 min"
 * (spec §4.3): `window_extended_until = max(now, current end) + 30m`, so
 * presses stack rather than overwrite. The max() and the read-compute-write
 * transaction both live in `extendGoWindow`; this route is the HTTP shell.
 *
 * The wake AFTER the write is what makes an extension felt immediately: a
 * watcher loop that had already stopped at the old end has no reason to look
 * again until something tells it to. It is deliberately outside the success
 * contract — the new end is durable the moment `extendGoWindow` returns, so a
 * wake that throws comes back as `data.wakeError` on a 200 (Codex round 1,
 * finding #5) and the next dispatcher tick picks the window up anyway.
 *
 * `human` route by the proxy's DEFAULT classification (session + CSRF +
 * trusted Origin) — no lib/auth/route-policy.ts entry.
 */
export async function POST(req: NextRequest) {
  let body: { eventId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ success: false, error: "Body must be JSON." }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ success: false, error: "Body must be a JSON object." }, { status: 400 });
  }

  const eventId = body.eventId;
  if (typeof eventId !== "number" || !Number.isInteger(eventId) || eventId <= 0) {
    return NextResponse.json(
      { success: false, error: "Body field 'eventId' must be a positive integer." },
      { status: 400 },
    );
  }

  let out: ReturnType<typeof extendGoWindow>;
  try {
    out = extendGoWindow(db, eventId);
  } catch (err) {
    if (err instanceof GoRefused) {
      return NextResponse.json({ success: false, error: err.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: safeErrorText(err) }, { status: 500 });
  }

  let wakeError: string | null = null;
  try {
    await wakePrintWatch(db, out.printId);
  } catch (err) {
    wakeError = safeErrorText(err);
  }
  return NextResponse.json({ success: true, data: { ...out, wakeError } });
}
