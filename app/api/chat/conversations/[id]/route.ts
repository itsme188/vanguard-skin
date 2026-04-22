import { db } from "@/lib/db";
import { deleteConversation } from "@/lib/mutations/chat";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const conversationId = Number(id);
  if (!Number.isFinite(conversationId) || conversationId <= 0) {
    return Response.json({ error: "Invalid id" }, { status: 400 });
  }
  const deleted = deleteConversation(db, conversationId);
  if (!deleted) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
