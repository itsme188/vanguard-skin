import { db } from "@/lib/db";
import { deleteConversation } from "@/lib/mutations/chat";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const conversationId = Number(id);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return Response.json({ success: false, error: "Invalid conversation id." }, { status: 400 });
  }
  const deleted = deleteConversation(db, conversationId);
  if (!deleted) {
    return Response.json(
      { success: false, error: "That conversation no longer exists." },
      { status: 404 },
    );
  }
  return Response.json({ success: true, data: { deleted: true } });
}
