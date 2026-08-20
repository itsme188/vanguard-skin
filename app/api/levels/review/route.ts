import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  getPendingReviewLevels,
  getPendingReviewCount,
} from "@/lib/queries/security-levels";
import { setLevelReviewStatus } from "@/lib/mutations/security-levels";
import { approveLevelGuarded } from "@/lib/alerts/approve";
import {
  LEVEL_PLAUSIBILITY_MAX_DISTANCE,
  scanRangeDistancePct,
} from "@/lib/levels/scan-range";
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
 *   Body: { id: number, status: "auto_approved" | "rejected" | "pending_review", force?: boolean }
 *   Approves (arms the level) or rejects (keeps row for audit but excludes
 *   from scans).
 *
 *   Approving goes through approveLevelGuarded, which refuses (409, no write)
 *   in two cases — both overridable with `force: true`:
 *     - 'would_fire_immediately': the trigger condition already holds at the
 *       current price, so arming fires a guaranteed false "hit" on the very
 *       next scan.
 *     - 'beyond_scan_range': the level sits outside the scanner's plausibility
 *       band (a mis-scaled level — SPX prices on SPY, per-contract vs
 *       per-share), so arming it buys coverage every scan pass skips.
 *   Both carry the same envelope: { success:false, error, code, currentPrice,
 *   effectivePrice }.
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      id?: number;
      status?: LevelReviewStatus;
      force?: boolean;
    };
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

    if (body.status === "auto_approved") {
      const result = approveLevelGuarded(db, body.id, { force: body.force === true });
      if (!result.ok) {
        const currentPrice = result.currentPrice as number;
        const effectivePrice = result.effectivePrice as number;
        // The beyond-band message carries no currency glyph: levels are stored
        // in the security's NATIVE currency, and this route has no FX context
        // to justify a "$". The distance comes from the band's own helper so
        // the figure can't disagree with the guard that produced it.
        const away = scanRangeDistancePct(effectivePrice, currentPrice);
        const error =
          result.code === "beyond_scan_range"
            ? `Level ${effectivePrice} is ${Math.abs(away ?? 0).toFixed(1)}% from the current price ${currentPrice} — beyond the scanner's ${LEVEL_PLAUSIBILITY_MAX_DISTANCE * 100}% range, so every scan would skip it and this level could never alert. Check for a mis-scaled price before arming.`
            : `Price $${currentPrice.toFixed(2)} is already past this level ($${effectivePrice.toFixed(2)}) — arming will fire an alert on the next scan.`;
        return NextResponse.json(
          {
            success: false,
            error,
            code: result.code,
            currentPrice,
            effectivePrice,
          },
          { status: 409 }
        );
      }
      return NextResponse.json({ success: true });
    }

    setLevelReviewStatus(db, body.id, body.status);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
