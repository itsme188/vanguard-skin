import { db } from "@/lib/db";
import { getResearchDocument } from "@/lib/queries/research-documents";
import {
  deleteResearchDocument,
  updateResearchDocumentTags,
} from "@/lib/mutations/research-documents";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const docId = Number(id);
  if (!Number.isFinite(docId) || docId <= 0) {
    return Response.json({ error: "Invalid id" }, { status: 400 });
  }
  const doc = getResearchDocument(db, docId);
  if (!doc) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json({
    ...doc,
    key_points: doc.key_points ? JSON.parse(doc.key_points) : [],
    mentioned_symbols: doc.mentioned_symbols
      ? JSON.parse(doc.mentioned_symbols)
      : [],
    tags: doc.tags ? JSON.parse(doc.tags) : [],
    target_prices: doc.target_prices ? JSON.parse(doc.target_prices) : [],
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const docId = Number(id);
  if (!Number.isFinite(docId) || docId <= 0) {
    return Response.json({ error: "Invalid id" }, { status: 400 });
  }
  const existing = getResearchDocument(db, docId);
  if (!existing) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Body must be an object" }, { status: 400 });
  }
  const { tags } = body as { tags?: unknown };
  if (tags === undefined) {
    return Response.json(
      { error: "Body must include 'tags' (array of strings)." },
      { status: 400 },
    );
  }
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === "string")) {
    return Response.json(
      { error: "'tags' must be an array of strings." },
      { status: 400 },
    );
  }
  updateResearchDocumentTags(db, docId, tags);
  const updated = getResearchDocument(db, docId);
  return Response.json({
    id: updated!.id,
    tags: updated!.tags ? JSON.parse(updated!.tags) : [],
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const docId = Number(id);
  if (!Number.isFinite(docId) || docId <= 0) {
    return Response.json({ error: "Invalid id" }, { status: 400 });
  }
  const deleted = deleteResearchDocument(db, docId);
  if (!deleted) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
