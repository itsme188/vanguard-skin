import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { classifySecurities, classifyUnresolvedWithClaude } from "@/lib/compute/classify-securities";
import {
  classifyOptionSectors,
  getUnsectoredOptionUnderlyings,
} from "@/lib/securities/classify-option-sectors";

/**
 * POST /api/compute/classify — Run security classification engine.
 * Applies static lookups, auto-classification, and option inheritance.
 * Falls back to a Claude AI pass for anything the static engine couldn't resolve.
 * Also sector-classifies blank-sector option underlyings (same self-heal that
 * auto-refresh Step 2.5 runs) so the manual button covers them too.
 * Idempotent — safe to run repeatedly.
 */
export async function POST() {
  try {
    const result = classifySecurities(db);
    const ai = await classifyUnresolvedWithClaude(db, result.unresolved);

    let optionSectors = { classified: 0, errors: [] as string[] };
    if (getUnsectoredOptionUnderlyings(db).length > 0) {
      optionSectors = await classifyOptionSectors(db);
    }

    return NextResponse.json({
      success: true,
      classified: result.classified + ai.classified,
      skipped: result.skipped,
      unresolvedCount: result.unresolved.length - ai.classified,
      aiErrors: [...ai.errors, ...optionSectors.errors],
      optionSectorsClassified: optionSectors.classified,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
