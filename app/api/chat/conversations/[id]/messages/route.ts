import { db } from "@/lib/db";
import { getConversationMessages } from "@/lib/queries/chat";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const messages = getConversationMessages(db, Number(id));
  return Response.json({ messages });
}
