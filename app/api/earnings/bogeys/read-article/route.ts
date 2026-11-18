import { db } from "@/lib/db";
import { readArticleForEvent, ReadArticleRefusedError } from "@/lib/earnings/unread-previews";
import { accountFailureOf, aiUnavailableForClick } from "@/lib/earnings/ai-unavailable";

export const dynamic = "force-dynamic";

function fail(error: string, status: number) {
  return Response.json({ success: false, error }, { status });
}

function positiveId(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/**
 * POST /api/earnings/bogeys/read-article (bogey intake 2026-11-18, Task D).
 *
 * Body `{ eventId, articleId }`. One owner click, one AI call: reads one
 * listed preview for this print's bogeys (`readArticleForEvent`) and answers
 * `{ success: true, data: { bogeysStored, status, recompiled } }`.
 *
 * Errors: 400 bad body; 409 the article is not waiting to be read for this
 * print, is already being read, or does not name the ticker; 503 the AI
 * account is unavailable (nothing booked); 502 any other failed read.
 * Logs ids only, never article text or model output.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const eventId = positiveId(body?.eventId);
  const articleId = positiveId(body?.articleId);
  if (eventId === null || articleId === null) {
    return fail("Body must be { eventId, articleId } with positive whole numbers.", 400);
  }

  try {
    const data = await readArticleForEvent(db, eventId, articleId);
    return Response.json({ success: true, data });
  } catch (err) {
    if (err instanceof ReadArticleRefusedError) return fail(err.message, 409);
    const account = accountFailureOf(err);
    if (account) return fail(aiUnavailableForClick(account), 503);
    console.error(`Bogey read failed for event ${eventId} article ${articleId}: ${err instanceof Error ? err.name : "error"}`);
    return fail("The AI read failed; try again.", 502);
  }
}
