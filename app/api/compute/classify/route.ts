import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { classifySecurities, classifyUnresolvedWithClaude } from "@/lib/compute/classify-securities";
import {
  classifyOptionSectors,
  getUnsectoredOptionUnderlyings,
  markOptionSectorsChecked,
} from "@/lib/securities/classify-option-sectors";
import { applyLeverageFactors } from "@/lib/securities/apply-leverage-factors";

/**
 * POST /api/compute/classify — Run security classification engine.
 * Applies static lookups, auto-classification, and option inheritance.
 * Falls back to a Claude AI pass for anything the static engine couldn't resolve.
 * Also derives the signed leverage factor of every leveraged or inverse fund
 * (auto-refresh Step 2.4) and sector-classifies blank-sector option
 * underlyings (Step 2.5), so the manual button covers both self-heals too.
 * Idempotent — safe to run repeatedly.
 */
export async function POST() {
  try {
    const result = classifySecurities(db);
    // Deterministic leverage factors (theme T2) — same pass the TWS sync runs
    // at Step 2.4, so the button covers it too. No AI call.
    const leverage = applyLeverageFactors(db);
    const ai = await classifyUnresolvedWithClaude(db, result.unresolved);

    let optionSectors = { classified: 0, errors: [] as string[] };
    if (getUnsectoredOptionUnderlyings(db).length > 0) {
      optionSectors = await classifyOptionSectors(db);
    } else {
      // Checked, nothing to do: record the check (trust strip "Sectors classified").
      markOptionSectorsChecked(db);
    }

    return NextResponse.json({
      success: true,
      classified: result.classified + ai.classified,
      skipped: result.skipped,
      unresolvedCount: result.unresolved.length - ai.classified,
      aiErrors: [...ai.errors, ...optionSectors.errors],
      optionSectorsClassified: optionSectors.classified,
      leverageFactorsWritten: leverage.factorsWritten,
      leverageFactorsCleared: leverage.factorsCleared,
      leverageSectorsCorrected: leverage.sectorsRewritten,
      leveragedFundsWithoutFactor: leverage.unsigned.map((u) => u.symbol),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
