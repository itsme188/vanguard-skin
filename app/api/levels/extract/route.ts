import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { extractLevelsFromNewArticles } from "@/lib/alerts/extract-newsletter-levels";

/**
 * POST /api/levels/extract
 *
 * Scans recent research articles that haven't been scanned yet, uses Claude to
 * propose `security_levels` rows for the user's held + watchlist symbols only.
 *
 * Body: { sinceDays?: number, batchSize?: number }
 *   - sinceDays: default 30. Only scans articles received within this window.
 *   - batchSize: default 10. Max articles per run (Claude cost/rate safety cap).
 *
 * Called automatically after research sync; also exposed for manual re-runs.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await extractLevelsFromNewArticles(db, {
      sinceDays: body.sinceDays,
      batchSize: body.batchSize,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
