import { db } from "@/lib/db";
import { getRecentConversations } from "@/lib/queries/chat";
import { createConversation } from "@/lib/mutations/chat";

export async function GET() {
  const conversations = getRecentConversations(db, 20);
  return Response.json({ conversations });
}

export async function POST(req: Request) {
  const { scope = "all" } = await req.json();
  const id = createConversation(db, scope);
  return Response.json({ id });
}
