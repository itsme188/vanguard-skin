import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { classifySecurities } from "@/lib/compute/classify-securities";

/**
 * POST /api/compute/classify — Run security classification engine.
 * Applies static lookups, auto-classification, and option inheritance.
 * Idempotent — safe to run repeatedly.
 */
export async function POST() {
  try {
    const result = classifySecurities(db);

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
