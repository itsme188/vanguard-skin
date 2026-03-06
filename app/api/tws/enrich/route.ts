import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { enrichSecurities } from "@/lib/tws/contracts";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const results = await enrichSecurities(db, body.securityIds);

    const totalEnriched = results.filter((r) => r.enriched).length;
    const totalErrors = results.filter((r) => r.error).length;

    return NextResponse.json({
      success: true,
      data: {
        securities: results.length,
        enriched: totalEnriched,
        errors: totalErrors,
        results,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
