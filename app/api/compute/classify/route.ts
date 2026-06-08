import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { classifySecurities, classifyUnresolvedWithClaude } from "@/lib/compute/classify-securities";

/**
 * POST /api/compute/classify — Run security classification engine.
 * Applies static lookups, auto-classification, and option inheritance.
 * Falls back to a Claude AI pass for anything the static engine couldn't resolve.
 * Idempotent — safe to run repeatedly.
 */
export async function POST() {
  try {
    const result = classifySecurities(db);
    const ai = await classifyUnresolvedWithClaude(db, result.unresolved);

    return NextResponse.json({
      success: true,
      classified: result.classified + ai.classified,
      skipped: result.skipped,
      unresolvedCount: result.unresolved.length - ai.classified,
      aiErrors: ai.errors,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
