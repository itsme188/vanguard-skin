import { db } from "@/lib/db";
import { getBogeysForEvent } from "@/lib/queries/earnings-bogeys";
import { upsertBogey, deleteBogey } from "@/lib/mutations/earnings-bogeys";

export const dynamic = "force-dynamic";

/**
 * GET  /api/earnings/bogeys?eventId=NN
 * POST /api/earnings/bogeys                — manual entry
 * PATCH /api/earnings/bogeys              — update (re-uses upsert via UNIQUE)
 * DELETE /api/earnings/bogeys?id=NN
 *
 * The upload route lives at /api/earnings/bogeys/upload.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const eventId = Number(url.searchParams.get("eventId"));
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return Response.json(
      { error: "Query param 'eventId' must be a positive integer." },
      { status: 400 },
    );
  }
  const bogeys = getBogeysForEvent(db, eventId);
  return Response.json({ bogeys });
}

interface ManualBogeyBody {
  event_id?: number;
  source_label?: string;
  eps_consensus?: number | null;
  eps_whisper?: number | null;
  revenue_consensus_usd?: number | null;
  revenue_whisper_usd?: number | null;
  guidance_notes?: string | null;
  notes?: string | null;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as ManualBogeyBody;
  if (typeof body.event_id !== "number" || !Number.isInteger(body.event_id)) {
    return Response.json(
      { error: "Body field 'event_id' must be an integer." },
      { status: 400 },
    );
  }

  const result = upsertBogey(db, {
    event_id: body.event_id,
    source: "manual",
    source_label: body.source_label ?? null,
    eps_consensus: body.eps_consensus ?? null,
    eps_whisper: body.eps_whisper ?? null,
    revenue_consensus_usd: body.revenue_consensus_usd ?? null,
    revenue_whisper_usd: body.revenue_whisper_usd ?? null,
    guidance_notes: body.guidance_notes ?? null,
    notes: body.notes ?? null,
  });

  return Response.json(result);
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json(
      { error: "Query param 'id' must be a positive integer." },
      { status: 400 },
    );
  }
  const ok = deleteBogey(db, id);
  return Response.json({ deleted: ok });
}
