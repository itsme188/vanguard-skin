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
  const emailError = validateSenderEmail(body);
  if (emailError) {
    return Response.json({ error: emailError }, { status: 400 });
  }
  const id = createSource(db, body);
  return Response.json({ success: true, id });
}

/**
 * A malformed sender_email creates a permanently dead ACTIVE source — the
 * Gmail query becomes `from:<garbage>` and silently matches nothing on every
 * future sync. Validate the shape here because the modal has no <form>
 * wrapper, so the input's native type="email" constraint never fires.
 * Trims in place; empty string normalizes to undefined (sender_email is optional).
 */
function validateSenderEmail(body: {
  sender_email?: unknown;
}): string | null {
  if (body.sender_email == null) return null;
  if (typeof body.sender_email !== "string") {
    return "sender_email must be a string";
  }
  const trimmed = body.sender_email.trim();
  if (trimmed === "") {
    body.sender_email = undefined;
    return null;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return `"${trimmed}" is not a valid email address — this source would never match any Gmail message`;
  }
  body.sender_email = trimmed;
  return null;
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
  if ("sender_email" in updates) {
    const emailError = validateSenderEmail(updates);
    if (emailError) {
      return Response.json({ error: emailError }, { status: 400 });
    }
  }
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
