import { db } from "@/lib/db";
import { getConversationMessages } from "@/lib/queries/chat";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const conversationId = Number(id);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return Response.json({ success: false, error: "Invalid conversation id." }, { status: 400 });
  }
  const messages = getConversationMessages(db, conversationId);
  return Response.json({ success: true, data: { messages } });
}
