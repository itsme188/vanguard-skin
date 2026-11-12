import { db } from "@/lib/db";
import { getRecentConversations } from "@/lib/queries/chat";
import { createConversation } from "@/lib/mutations/chat";
import { VALID_SCOPES, type ChatScope } from "@/lib/types";
import { chatModelLabel, invalidModelFamilyMessage, isChatModelFamily, readStoredChatFamily } from "@/lib/chat/model-choice";
import { resolveChatModel } from "@/lib/chat/model-resolve";

/**
 * The label each conversation shows: what its stored class resolves to NOW
 * (the same resolution the next turn uses), with the fallback said in plain
 * words. A conversation with no class shows none (null).
 */
function modelLabelFor(stored: string | null): string | null {
  const family = readStoredChatFamily(stored);
  if (family === null) return null;
  try {
    const r = resolveChatModel(family);
    return chatModelLabel({ modelId: r.resolved.modelId, fellBackFrom: r.fellBackFrom });
  } catch {
    return null;
  }
}

export async function GET() {
  const conversations = getRecentConversations(db, 20).map((c) => ({
    ...c,
    model_label: modelLabelFor(c.model_family),
  }));
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
  // Optional model class (2026-11-13), validated like the chat route does.
  const rawFamily =
    body !== null && typeof body === "object" ? (body as { modelFamily?: unknown }).modelFamily : undefined;
  if (rawFamily !== undefined && rawFamily !== null && !isChatModelFamily(rawFamily)) {
    return Response.json({ success: false, error: invalidModelFamilyMessage(rawFamily) }, { status: 400 });
  }
  const id = createConversation(db, scope, isChatModelFamily(rawFamily) ? rawFamily : null);
  return Response.json({ success: true, data: { id } });
}
