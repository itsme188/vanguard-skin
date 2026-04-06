import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseImport, commitImport, undoImport } from "@/lib/import/engine";
import { validateParsedResult } from "@/lib/import/validate";
import { getSnapshotReconciliation } from "@/lib/queries/data-health";
import { classifySecurities } from "@/lib/compute/classify-securities";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";
import { detectNewTradeReviewPeriods } from "@/lib/compute/trade-roundtrips";

/**
 * POST /api/import?mode=preview  — parse only, return preview JSON
 * POST /api/import?mode=commit   — parse and commit to database
 * DELETE /api/import?batchId=N   — undo an import batch
 *
 * Accepts multipart form data with one or more files.
 */

export async function POST(request: NextRequest) {
  try {
    const mode = request.nextUrl.searchParams.get("mode") ?? "preview";

    if (mode !== "preview" && mode !== "commit") {
      return NextResponse.json(
        { success: false, error: "Invalid mode. Use ?mode=preview or ?mode=commit" },
        { status: 400 }
      );
    }

    const formData = await request.formData();
    const files = formData.getAll("files") as File[];

    if (files.length === 0) {
      return NextResponse.json(
        { success: false, error: "No files provided. Send files as 'files' in form data." },
        { status: 400 }
      );
    }

    const results = [];

    for (const file of files) {
      const isPdf = file.type === "application/pdf" || file.name.endsWith(".pdf");
      let content: string | Buffer;

      if (isPdf) {
        const arrayBuffer = await file.arrayBuffer();
        content = Buffer.from(arrayBuffer);
      } else {
        content = await file.text();
      }

      // Parse
      const parsed = await parseImport(content, file.name);

      if (parsed.errors.length > 0 && parsed.sourceType === "unknown") {
        results.push({
          filename: file.name,
          success: false,
          error: parsed.errors.join("; "),
        });
        continue;
      }

      // Preview mode — run validation and return summary with any issues
      if (mode === "preview") {
        const { skippedRows, validatedResult } = validateParsedResult(parsed);
        results.push({
          filename: file.name,
          success: true,
          sourceType: parsed.sourceType,
          preview: {
            transactionCount: validatedResult.transactions.length,
            securityCount: validatedResult.securities.length,
            holdingCount: validatedResult.holdings.length,
            priceCount: validatedResult.prices.length,
            snapshotCount: validatedResult.snapshots.length,
            factorCount: validatedResult.factors?.length ?? 0,
          },
          skippedRows: skippedRows.length > 0 ? skippedRows : undefined,
          errors: parsed.errors,
          warnings: validatedResult.warnings,
        });
        continue;
      }

      // Commit mode — write to DB
      const commitResult = commitImport(db, parsed);

      results.push({
        filename: file.name,
        success: true,
        sourceType: parsed.sourceType,
        batchId: commitResult.batchId,
        committed: {
          newTransactions: commitResult.newTransactions,
          newHoldings: commitResult.newHoldings,
          newPrices: commitResult.newPrices,
          newSnapshots: commitResult.newSnapshots,
          newSecurities: commitResult.newSecurities,
          newFactors: commitResult.newFactors,
          skippedDuplicates: commitResult.skippedDuplicates,
          totalRecords: commitResult.recordCount,
          unmatchedFactors: commitResult.unmatchedFactors,
        },
        errors: parsed.errors,
        warnings: parsed.warnings,
      });
    }

    // Auto-classify and compute tax lots after commit
    if (mode === "commit") {
      try {
        classifySecurities(db);
      } catch {
        // Classification failure shouldn't block import
      }
      try {
        computeTaxLots(db);
      } catch {
        // Tax lot computation failure shouldn't block import
      }
      try {
        computeDailyValuations(db);
      } catch {
        // Valuation recompute failure shouldn't block import
      }
    }

    // Detect months with new trades that don't have reviews yet
    let newTradePeriods: { periodStart: string; periodEnd: string; tradeCount: number }[] = [];
    if (mode === "commit") {
      try {
        newTradePeriods = detectNewTradeReviewPeriods(db);
      } catch {
        // Trade review detection failure shouldn't block import
      }
    }

    // Check for reconciliation flags after commit
    let reconciliationFlags: { accountName: string; snapshotDate: string; diffPct: number }[] = [];
    if (mode === "commit") {
      try {
        const recon = getSnapshotReconciliation(db);
        reconciliationFlags = recon
          .filter((r) => r.diffPct !== null && Math.abs(r.diffPct) > 2)
          .map((r) => ({
            accountName: r.accountName,
            snapshotDate: r.snapshotDate,
            diffPct: r.diffPct!,
          }));
      } catch {
        // Reconciliation check failure shouldn't block import
      }
    }

    return NextResponse.json({
      success: true,
      mode,
      fileCount: files.length,
      results,
      newTradePeriods,
      reconciliationFlags: reconciliationFlags.length > 0 ? reconciliationFlags : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const batchIdParam = request.nextUrl.searchParams.get("batchId");

    if (!batchIdParam) {
      return NextResponse.json(
        { success: false, error: "Missing batchId parameter" },
        { status: 400 }
      );
    }

    const batchId = parseInt(batchIdParam, 10);
    if (isNaN(batchId)) {
      return NextResponse.json(
        { success: false, error: "Invalid batchId — must be a number" },
        { status: 400 }
      );
    }

    // Verify batch exists
    const batch = db
      .prepare("SELECT id FROM import_batches WHERE id = ?")
      .get(batchId);

    if (!batch) {
      return NextResponse.json(
        { success: false, error: `Import batch ${batchId} not found` },
        { status: 404 }
      );
    }

    undoImport(db, batchId);

    return NextResponse.json({
      success: true,
      message: `Import batch ${batchId} has been undone`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
