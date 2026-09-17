import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  getEnrichedAlerts,
  getPendingAlertCount,
} from "@/lib/queries/security-levels";
import {
  respondToAlert,
  setAlertSuggestion,
} from "@/lib/mutations/security-levels";
import type { AlertResponse } from "@/lib/types";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const response = searchParams.get("response") as AlertResponse | null;
    const securityId = searchParams.get("securityId");
    const limit = searchParams.get("limit");
    const countOnly = searchParams.get("countOnly") === "true";

    if (countOnly) {
      return NextResponse.json({ success: true, pendingCount: getPendingAlertCount(db) });
    }

    // Enrichment (symbol/name + the level block, including its LIVE
    // effective_price) lives in the query layer so this route and any
    // in-process caller can't disagree about a level's effective price — the
    // card's `threshold_price ?? effective_price ?? price` fallback depends on
    // it. See getEnrichedAlerts.
    const enriched = getEnrichedAlerts(db, {
      response: response ?? undefined,
      securityId: securityId ? Number(securityId) : undefined,
      limit: limit ? Number(limit) : undefined,
    });

    return NextResponse.json({
      success: true,
      alerts: enriched,
      pendingCount: getPendingAlertCount(db),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, response, note, suggestedAction } = body;

    if (!id) {
      return NextResponse.json({ success: false, error: "id required" }, { status: 400 });
    }

    if (response) {
      respondToAlert(db, id, response as AlertResponse, note);
    }
    if (suggestedAction) {
      setAlertSuggestion(db, id, suggestedAction);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
