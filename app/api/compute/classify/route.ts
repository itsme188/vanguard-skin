import { NextResponse } from "next/server";
import type Database from "better-sqlite3";
import { db } from "@/lib/db";
import { classifySecurities, classifyUnresolvedWithClaude } from "@/lib/compute/classify-securities";
import { CUT_OFF_MESSAGE } from "@/lib/compute/classify-batch";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { liveOptionExpirationSql } from "@/lib/compute/option-expiry";
import {
  classifyOptionSectors,
  getUnsectoredOptionUnderlyings,
  markOptionSectorsChecked,
} from "@/lib/securities/classify-option-sectors";
import { applyLeverageFactors } from "@/lib/securities/apply-leverage-factors";

/**
 * Securities held now: in a latest holdings row (a quantity-0 tombstone is
 * not held), or the underlying of a held, live option. The SAME rule as the
 * AI fallback's candidate filter (`heldNowSecurities` in
 * lib/compute/classify-securities.ts, not exported); the two are pinned to
 * agree by tests/api/compute-classify-held-counts-z.test.ts.
 */
function heldNowSecurityIds(database: Database.Database): Set<number> {
  const rows = database
    .prepare(
      `SELECT s.id FROM securities s
       WHERE s.id IN (
         SELECT h.security_id FROM holdings h WHERE ${latestHoldingsPredicate({})}
       )
       OR s.id IN (
         SELECT u.id FROM holdings h
         JOIN securities o ON o.id = h.security_id
         JOIN securities u ON u.symbol = o.underlying_symbol
         WHERE ${latestHoldingsPredicate({})}
           AND o.underlying_symbol IS NOT NULL
           AND ${liveOptionExpirationSql("o")}
       )`,
    )
    .all() as Array<{ id: number }>;
  return new Set(rows.map((r) => r.id));
}

/** How many of these securities still have no classification on record. */
function countStillUnclassified(database: Database.Database, ids: number[]): number {
  if (ids.length === 0) return 0;
  const stmt = database.prepare("SELECT classification_source FROM securities WHERE id = ?");
  let n = 0;
  for (const id of ids) {
    const row = stmt.get(id) as { classification_source: string | null } | undefined;
    if (row && !row.classification_source) n++;
  }
  return n;
}

/**
 * One AI error line in words for the toast. The batch runners write
 * `Batch N: …` lines; the batch number is how the work was split, not
 * something the user can act on, so it stays in the server log only.
 */
function userFacingAiError(raw: string): string {
  const body = raw
    .replace(/^Batch \d+:\s*/, "")
    .replace(/\s*\(retry, part \d+ of \d+\)$/, "");
  if (body === CUT_OFF_MESSAGE) {
    return "the AI's reply was too long and was cut off before it finished, so nothing from it was saved";
  }
  if (body === "AI refusal") return "the AI declined to answer";
  return body;
}

/**
 * POST /api/compute/classify — Run security classification engine.
 * Applies static lookups, auto-classification, and option inheritance.
 * Falls back to a Claude AI pass for anything the static engine couldn't
 * resolve AND is held now (the AI is never asked about a name not held).
 * Also derives the signed leverage factor of every leveraged or inverse fund
 * (auto-refresh Step 2.4) and sector-classifies blank-sector option
 * underlyings (Step 2.5), so the manual button covers both self-heals too.
 * Idempotent — safe to run repeatedly.
 *
 * The unresolved securities are reported as two counts: `heldUnresolvedCount`
 * (held now and still unclassified after the AI step) and
 * `notHeldSkippedCount` (not held now, so not sent to the AI; a click can
 * never clear these, so they are not reported as a failure).
 */
export async function POST() {
  try {
    const result = classifySecurities(db);
    // Deterministic leverage factors (theme T2) — same pass the TWS sync runs
    // at Step 2.4, so the button covers it too. No AI call.
    const leverage = applyLeverageFactors(db);
    const held = heldNowSecurityIds(db);
    const heldUnresolvedIds = result.unresolved.filter((s) => held.has(s.id)).map((s) => s.id);
    const notHeldSkippedCount = result.unresolved.length - heldUnresolvedIds.length;
    const ai = await classifyUnresolvedWithClaude(db, result.unresolved);
    // Read back rather than subtract: a reply that names a security twice
    // counts it twice in `ai.classified`.
    const heldUnresolvedCount = countStillUnclassified(db, heldUnresolvedIds);

    let optionSectors = { classified: 0, errors: [] as string[] };
    if (getUnsectoredOptionUnderlyings(db).length > 0) {
      optionSectors = await classifyOptionSectors(db);
    } else {
      // Checked, nothing to do: record the check (trust strip "Sectors classified").
      markOptionSectorsChecked(db);
    }

    const rawAiErrors = [...ai.errors, ...optionSectors.errors];
    for (const e of rawAiErrors) console.warn(`[classify] AI step: ${e}`);
    const aiErrors = [...new Set(rawAiErrors.map(userFacingAiError))];

    return NextResponse.json({
      success: true,
      classified: result.classified + ai.classified,
      skipped: result.skipped,
      heldUnresolvedCount,
      notHeldSkippedCount,
      aiErrors,
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
