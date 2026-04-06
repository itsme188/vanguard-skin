import { db } from "@/lib/db";
import { getResearchSources } from "@/lib/queries/research";
import { createSource, updateSource } from "@/lib/mutations/research";

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
  updateSource(db, id, updates);
  return Response.json({ success: true });
}
