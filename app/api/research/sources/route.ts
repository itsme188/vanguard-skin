import { db } from "@/lib/db";
import { getResearchSources } from "@/lib/queries/research";
import { createSource, updateSource, deleteSource } from "@/lib/mutations/research";

/**
 * GET /api/research/sources — List all research sources with article counts.
 */
export async function GET() {
  const sources = getResearchSources(db);
  return Response.json({ success: true, data: sources });
}

/**
 * POST /api/research/sources — Create a new research source.
 * Body: { name, sender_email?, sender_pattern?, subject_pattern?, fetch_frequency?, max_age_days? }
 */
export async function POST(request: Request) {
  const body = await request.json();
  if (!body.name) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }
  const id = createSource(db, body);
  return Response.json({ success: true, id });
}

/**
 * PATCH /api/research/sources — Update a research source.
 * Body: { id, ...fields }
 */
export async function PATCH(request: Request) {
  const body = await request.json();
  if (!body.id) {
    return Response.json({ error: "id is required" }, { status: 400 });
  }
  const { id, ...updates } = body;
  if ("earnings_rank" in updates) {
    const r = updates.earnings_rank;
    if (r !== null && (!Number.isInteger(r) || r < 1)) {
      return Response.json(
        { error: "earnings_rank must be a positive integer or null" },
        { status: 400 }
      );
    }
  }
  if ("earnings_note" in updates) {
    const n = updates.earnings_note;
    if (n !== null && typeof n !== "string") {
      return Response.json(
        { error: "earnings_note must be a string or null" },
        { status: 400 }
      );
    }
    if (typeof n === "string") {
      const trimmed = n.trim();
      updates.earnings_note = trimmed === "" ? null : trimmed;
    }
  }
  updateSource(db, id, updates);
  return Response.json({ success: true });
}

/**
 * DELETE /api/research/sources — Delete a research source.
 * Body: { id }
 */
export async function DELETE(request: Request) {
  const body = await request.json();
  if (!body.id) {
    return Response.json({ error: "id is required" }, { status: 400 });
  }
  deleteSource(db, body.id);
  return Response.json({ success: true });
}
