import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  generateSuggestionForAlert,
  generateSuggestionsForPendingAlerts,
} from "@/lib/alerts/generate-suggestion";

/**
 * POST /api/alerts/suggest
 *
 * Body: { alertId?: number, limit?: number }
 *   - If alertId is passed, generates (or regenerates) just that alert's suggestion.
 *   - Otherwise, fills in suggestions for up to `limit` (default 20) pending alerts
 *     that don't have one yet.
 */
export async function POST(request: NextRequest) {
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
