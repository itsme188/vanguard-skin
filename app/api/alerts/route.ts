import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  getAlerts,
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

    const alerts = getAlerts(db, {
      response: response ?? undefined,
      securityId: securityId ? Number(securityId) : undefined,
      limit: limit ? Number(limit) : undefined,
    });

    // Enrich with security info for display
    const enriched = alerts.map((a) => {
      const sec = db
        .prepare("SELECT symbol, name FROM securities WHERE id = ?")
        .get(a.security_id) as { symbol: string; name: string | null } | undefined;
      const level = db
        .prepare("SELECT level_type, price, direction, source, source_author, thesis FROM security_levels WHERE id = ?")
        .get(a.level_id) as
        | {
            level_type: string;
            price: number;
            direction: string | null;
            source: string;
            source_author: string | null;
            thesis: string | null;
          }
        | undefined;
      return { ...a, symbol: sec?.symbol ?? null, security_name: sec?.name ?? null, level };
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
