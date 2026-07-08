import { db } from "@/lib/db";
import {
  getCallNoteForEvent,
  GUIDANCE_VALUES,
  type CallNoteGuidance,
} from "@/lib/queries/earnings-call-notes";
import { upsertCallNote } from "@/lib/mutations/earnings-call-notes";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const eventId = Number(url.searchParams.get("eventId"));
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return Response.json(
      { success: false, error: "Query param 'eventId' must be a positive integer." },
      { status: 400 }
    );
  }
  return Response.json({ success: true, data: getCallNoteForEvent(db, eventId) });
}

interface CallNoteBody {
  eventId?: unknown;
  guidance?: unknown;
  tone?: unknown;
  surprises?: unknown;
  followUps?: unknown;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as CallNoteBody;
  const eventId = body.eventId;
  if (typeof eventId !== "number" || !Number.isInteger(eventId) || eventId <= 0) {
    return Response.json(
      { success: false, error: "Body field 'eventId' must be a positive integer." },
      { status: 400 }
    );
  }
  const event = db
    .prepare("SELECT id, symbol, security_id FROM calendar_events WHERE id = ?")
    .get(eventId) as { id: number; symbol: string | null; security_id: number | null } | undefined;
  if (!event || !event.symbol) {
    return Response.json(
      { success: false, error: `No earnings event with id ${eventId}.` },
      { status: 404 }
    );
  }
  const guidance = body.guidance ?? null;
  if (guidance !== null && !GUIDANCE_VALUES.includes(guidance as CallNoteGuidance)) {
    return Response.json(
      { success: false, error: `'guidance' must be one of ${GUIDANCE_VALUES.join(", ")} or null.` },
      { status: 400 }
    );
  }
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  try {
    const note = upsertCallNote(db, {
      eventId,
      securityId: event.security_id,
      symbol: event.symbol,
      guidance: guidance as CallNoteGuidance | null,
      tone: str(body.tone),
      surprises: str(body.surprises),
      followUps: str(body.followUps),
    });
    return Response.json({ success: true, data: note });
  } catch (err) {
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : "Failed to save call note" },
      { status: 500 }
    );
  }
}
