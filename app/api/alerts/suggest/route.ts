import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  claimRegenerateSlot,
  generateSuggestionForAlert,
  regenerateSuggestionForAlert,
  releaseRegenerateSlot,
  generateSuggestionsForPendingAlerts,
} from "@/lib/alerts/generate-suggestion";

/**
 * POST /api/alerts/suggest?id=<alert id>
 *   Forces regeneration of that one row's stored advice (one AI call), behind a
 *   per-alert rate limit. 404 unknown alert, 429 too soon, 502 model failure
 *   (the old advice is kept).
 *
 * POST /api/alerts/suggest
 * Body: { alertId?: number, limit?: number }
 *   - If alertId is passed, generates (or regenerates) just that alert's suggestion.
 *   - Otherwise, fills in suggestions for up to `limit` (default 20) pending alerts
 *     that don't have one yet.
 */
export async function POST(request: NextRequest) {
  const idParam = request.nextUrl.searchParams.get("id");
  if (idParam !== null) {
    const id = Number(idParam);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ success: false, error: "id must be a positive integer" }, { status: 400 });
    }
    const claim = claimRegenerateSlot(id);
    if (!claim.ok) {
      const secs = Math.ceil(claim.retryAfterMs / 1000);
      return NextResponse.json(
        { success: false, error: `This advice was just regenerated. Try again in ${secs} seconds.` },
        { status: 429 }
      );
    }
    try {
      const r = await regenerateSuggestionForAlert(db, id);
      if (!r.ok) {
        releaseRegenerateSlot(id);
        return r.reason === "not_found"
          ? NextResponse.json({ success: false, error: "Alert not found" }, { status: 404 })
          : NextResponse.json(
              { success: false, error: "The AI request failed. The existing advice is unchanged." },
              { status: 502 }
            );
      }
      return NextResponse.json({ success: true, suggestion: r.suggestion });
    } catch (error) {
      releaseRegenerateSlot(id);
      const message = error instanceof Error ? error.message : "Unknown error";
      return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
  }

  try {
    const body = await request.json().catch(() => ({}));
    const { alertId, limit } = body as { alertId?: number; limit?: number };

    if (alertId) {
      const suggestion = await generateSuggestionForAlert(db, Number(alertId));
      if (suggestion === null) {
        return NextResponse.json(
          { success: false, error: "Suggestion generation failed or alert not found" },
          { status: 502 }
        );
      }
      return NextResponse.json({ success: true, suggestion });
    }

    const result = await generateSuggestionsForPendingAlerts(db, { limit });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
