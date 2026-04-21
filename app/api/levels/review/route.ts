import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  getPendingReviewLevels,
  getPendingReviewCount,
} from "@/lib/queries/security-levels";
import { setLevelReviewStatus } from "@/lib/mutations/security-levels";
import type { LevelReviewStatus } from "@/lib/types";

/**
 * GET /api/levels/review
 *   Returns the pending-review inbox: newsletter-extracted levels awaiting
 *   approval. Shape: { success, levels: PendingReviewLevel[], count }.
 *
 *   ?countOnly=true returns just the count (used by the header chip).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    if (searchParams.get("countOnly") === "true") {
      return NextResponse.json({ success: true, count: getPendingReviewCount(db) });
    }
    const levels = getPendingReviewLevels(db);
    return NextResponse.json({ success: true, levels, count: levels.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

/**
 * PATCH /api/levels/review
 *   Body: { id: number, status: "auto_approved" | "rejected" }
 *   Approves (arms the level) or rejects (keeps row for audit but excludes
 *   from scans).
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as { id?: number; status?: LevelReviewStatus };
    if (!body.id || !body.status) {
      return NextResponse.json(
        { success: false, error: "id and status required" },
        { status: 400 }
      );
    }
    if (!["auto_approved", "rejected", "pending_review"].includes(body.status)) {
      return NextResponse.json(
        { success: false, error: `invalid status: ${body.status}` },
        { status: 400 }
      );
    }
    setLevelReviewStatus(db, body.id, body.status);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
