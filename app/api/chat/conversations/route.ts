import { db } from "@/lib/db";
import { getRecentConversations } from "@/lib/queries/chat";
import { createConversation } from "@/lib/mutations/chat";
import { VALID_SCOPES, type ChatScope } from "@/lib/types";

export async function GET() {
  const conversations = getRecentConversations(db, 20);
  return Response.json({ success: true, data: { conversations } });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { success: false, error: "The request body is not valid JSON." },
      { status: 400 },
    );
  }
  const raw =
    body !== null && typeof body === "object" ? (body as { scope?: unknown }).scope : undefined;
  const scope = raw === undefined ? "all" : raw;
  // A stored scope outside VALID_SCOPES makes every later send in that
  // conversation answer 400 "Invalid scope", so refuse it here.
  if (typeof scope !== "string" || !VALID_SCOPES.includes(scope as ChatScope)) {
    return Response.json(
      { success: false, error: `Unknown scope. Use one of: ${VALID_SCOPES.join(", ")}.` },
      { status: 400 },
    );
  }
  const id = createConversation(db, scope);
  return Response.json({ success: true, data: { id } });
}
