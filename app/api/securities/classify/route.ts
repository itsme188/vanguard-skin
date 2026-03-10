import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * PUT /api/securities/classify — Manually classify a security.
 * Sets classification_source = 'manual' so it won't be overwritten by auto-classify.
 *
 * Body: { security_id, fund_category, geography?, market_cap_category?, style? }
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { security_id, fund_category, geography, market_cap_category, style } = body;

    if (!security_id || !fund_category) {
      return NextResponse.json(
        { success: false, error: "security_id and fund_category are required" },
        { status: 400 }
      );
    }

    db.prepare(`
      UPDATE securities SET
        fund_category = ?,
        geography = ?,
        market_cap_category = ?,
        style = ?,
        classification_source = 'manual'
      WHERE id = ?
    `).run(
      fund_category,
      geography ?? null,
      market_cap_category ?? null,
      style ?? null,
      security_id
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
