import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { classifyFactors } from "@/lib/compute/classify-factors";

/**
 * POST /api/compute/classify-factors
 * Auto-classify security factor exposures using Claude API.
 */
export async function POST() {
  try {
    const result = await classifyFactors(db);

    return NextResponse.json({
      success: true,
      classified: result.classified,
      skipped: result.skipped,
      errors: result.errors,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
