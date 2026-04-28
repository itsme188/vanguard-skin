import { db } from "@/lib/db";
import {
  sendEarningsPreview,
  sendEarningsRecap,
  EarningsEmailError,
} from "@/lib/digest/send-earnings-email";

export const dynamic = "force-dynamic";

/**
 * POST /api/earnings/email — Manual trigger for earnings preview / recap email.
 *
 * Body: { eventId: number, phase: "preview" | "recap", to?: string, footerNote?: string }
 *   - eventId: calendar_events.id of the earnings event.
 *   - phase: "preview" (~2h before) or "recap" (~2h after).
 *   - to: recipient email. Defaults to BRIEFING_EMAIL_TO env var.
 *   - footerNote: optional footer attribution.
 *
 * Localhost-only for Tier 1. Cron-authenticated routes will live at
 * /api/cron/earnings-{preview,recap} once Tier 3 wiring lands.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    eventId?: number;
    phase?: string;
    to?: string;
    footerNote?: string;
  };

  if (typeof body.eventId !== "number" || !Number.isInteger(body.eventId)) {
    return Response.json(
      { error: "Body field 'eventId' must be an integer." },
      { status: 400 },
    );
  }
  if (body.phase !== "preview" && body.phase !== "recap") {
    return Response.json(
      { error: "Body field 'phase' must be 'preview' or 'recap'." },
      { status: 400 },
    );
  }

  try {
    const opts = {
      recipient: body.to,
      footerNote: body.footerNote,
    };
    const result = body.phase === "preview"
      ? await sendEarningsPreview(db, body.eventId, opts)
      : await sendEarningsRecap(db, body.eventId, opts);
    return Response.json(result);
  } catch (err) {
    if (err instanceof EarningsEmailError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[earnings/email] Error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
