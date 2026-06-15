import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getArmedLevels } from "@/lib/queries/security-levels";

export const dynamic = "force-dynamic";

/**
 * GET /api/levels/armed — every currently-armed level (auto-approved, active,
 * unexpired) enriched with symbol, effective threshold, current price, and
 * distance-to-trigger, sorted nearest-first. Powers the Alerts-inbox "Armed" view.
 */
export async function GET() {
  try {
    const levels = getArmedLevels(db);
    return NextResponse.json({ success: true, levels, count: levels.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
