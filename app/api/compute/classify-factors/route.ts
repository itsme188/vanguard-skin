import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { classifyFactors, isFactorClassifySuccess } from "@/lib/compute/classify-factors";

/**
 * POST /api/compute/classify-factors
 * Auto-classify security factor exposures using Claude API.
 * Returns 502 (with success:false) only when nothing was classified AND errors occurred.
 */
export async function POST() {
  try {
    const result = await classifyFactors(db);
    const success = isFactorClassifySuccess(result);

    return NextResponse.json(
      { success, ...result, error: success ? undefined : (result.errors[0] ?? "Classification failed") },
      { status: success ? 200 : 502 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
