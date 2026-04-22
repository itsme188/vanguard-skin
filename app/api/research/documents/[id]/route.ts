import { db } from "@/lib/db";
import { getResearchDocument } from "@/lib/queries/research-documents";
import { deleteResearchDocument } from "@/lib/mutations/research-documents";

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
    target_prices: doc.target_prices ? JSON.parse(doc.target_prices) : [],
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
