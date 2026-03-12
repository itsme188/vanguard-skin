import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseImport, commitImport, undoImport } from "@/lib/import/engine";
import { classifySecurities } from "@/lib/compute/classify-securities";

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

      // Preview mode — return parsed summary
      if (mode === "preview") {
        results.push({
          filename: file.name,
          success: true,
          sourceType: parsed.sourceType,
          preview: {
            transactionCount: parsed.transactions.length,
            securityCount: parsed.securities.length,
            holdingCount: parsed.holdings.length,
            priceCount: parsed.prices.length,
            snapshotCount: parsed.snapshots.length,
            factorCount: parsed.factors?.length ?? 0,
          },
          errors: parsed.errors,
          warnings: parsed.warnings,
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

    // Auto-classify any new securities after commit
    if (mode === "commit") {
      try {
        classifySecurities(db);
      } catch {
        // Classification failure shouldn't block import
      }
    }

    return NextResponse.json({
      success: true,
      mode,
      fileCount: files.length,
      results,
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
