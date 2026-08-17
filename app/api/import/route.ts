import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseImport, commitImport } from "@/lib/import/engine";
import type { CommitResult } from "@/lib/import/engine";
import { validateParsedResult } from "@/lib/import/validate";
import {
  commitDonations,
  type DonationCommitOutcome,
} from "@/lib/import/donations-commit";
import { createImportBatch } from "@/lib/mutations/import-batches";
import type { ParsedDonation } from "@/lib/import/types";
import { getSnapshotReconciliation } from "@/lib/queries/data-health";
import { classifySecurities } from "@/lib/compute/classify-securities";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";
import { detectNewTradeReviewPeriods } from "@/lib/compute/trade-roundtrips";
import { buildStatementKey, isR2Configured, uploadStatementPdf } from "@/lib/storage/r2";
import { setImportBatchR2Key } from "@/lib/mutations/import-batches";
import { undoImportWithRecovery } from "@/lib/import/recovery";
import {
  issueUndoToken,
  consumeUndoToken,
  checkUndoRateLimit,
  recordUndo,
} from "@/lib/import/undo-confirmation";
import type Database from "better-sqlite3";

/**
 * POST /api/import?mode=preview  — parse only, return preview JSON
 * POST /api/import?mode=commit   — parse and commit to database
 * DELETE /api/import?batchId=N   — undo an import batch
 *
 * Accepts multipart form data with one or more files.
 */

/** Internal sentinel used only to unwind the doomed transaction in previewDonations. */
class DonationPreviewRollback extends Error {}

export interface DonationsPreview {
  count: number;
  newCount: number;
  updatedCount: number;
  identityConflicts: { sourceKey: string; field: string }[];
  absentPriorRows: string[];
  unresolvedSymbols: string[];
}

/**
 * Preview-mode donation stats, computed via the SAME resolution logic as a
 * real commit (commitDonations) but with zero persisted side effects: the
 * whole thing runs inside a transaction that's unconditionally rolled back.
 * This is deliberate rather than a hand-duplicated read-only reimplementation
 * of commitDonations' identity-conflict/new-vs-updated logic — that logic
 * lives in lib/mutations/donations.ts (Task 2) and isn't exported for reuse
 * here, so re-deriving it would drift the moment that file changes.
 *
 * Exported (not just used internally) so tests can exercise the
 * never-persists invariant directly against an in-memory db — see
 * tests/api/import-donations-preview.test.ts.
 *
 * absentPriorRows is read straight off commitDonations' own outcome rather
 * than a second findAbsentPriorDonations(database, donations) call — that
 * helper is a pure read against `donations` + current DB state, so the value
 * commitDonations already computed mid-transaction is identical to a fresh
 * call made after it; recomputing it here would just be a redundant query
 * (review fix, Minor #3).
 */
export function previewDonations(
  database: Database.Database,
  donations: ParsedDonation[]
): DonationsPreview | undefined {
  if (donations.length === 0) return undefined;

  let outcome: DonationCommitOutcome | undefined;
  try {
    database.transaction(() => {
      const dryBatch = createImportBatch(database, "daf-contributions", "__preview__");
      outcome = commitDonations(database, donations, dryBatch.id);
      throw new DonationPreviewRollback();
    })();
  } catch (err) {
    if (!(err instanceof DonationPreviewRollback)) throw err;
  }

  return {
    count: donations.length,
    newCount: outcome!.newDonations,
    updatedCount: outcome!.updatedDonations,
    identityConflicts: outcome!.identityConflicts,
    absentPriorRows: outcome!.absentPriorRows,
    unresolvedSymbols: outcome!.unresolvedSymbols,
  };
}

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
    // Raw CommitResult objects (not the transformed `results` entries) — used
    // after the loop to decide whether the request carried any corporate
    // action activity, and if so, what the tax-lot replay found.
    const commitResultsRaw: CommitResult[] = [];

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
            corporateActions: {
              count: validatedResult.corporateActions.length,
              sample: validatedResult.corporateActions.slice(0, 5).map((ca) => ({
                symbol: ca.symbol,
                description: `${ca.ratioNumerator}:${ca.ratioDenominator} ${ca.actionType === "SPLIT" ? "split" : "reverse split"}`,
                effectiveDate: ca.effectiveDate,
              })),
            },
            donations: previewDonations(db, validatedResult.donations ?? []),
          },
          skippedRows: skippedRows.length > 0 ? skippedRows : undefined,
          errors: parsed.errors,
          warnings: validatedResult.warnings,
        });
        continue;
      }

      // Commit mode — write to DB
      const commitResult = commitImport(db, parsed);
      commitResultsRaw.push(commitResult);

      // Phase 3: archive source PDFs to R2 (fire-and-forget; never blocks).
      // Only PDFs are archived — CSVs are usually user-managed/version-tracked
      // and less likely to be lost.
      if (isPdf && Buffer.isBuffer(content) && isR2Configured()) {
        const key = buildStatementKey({
          sourceType: parsed.sourceType,
          filename: file.name,
        });
        uploadStatementPdf(key, content)
          .then((returnedKey) => {
            if (returnedKey) setImportBatchR2Key(db, commitResult.batchId, returnedKey);
          })
          .catch((err) => {
            console.warn(
              `[import] R2 archive failed for batch ${commitResult.batchId} (${file.name}):`,
              err instanceof Error ? err.message : err
            );
          });
      }

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
          newCorporateActions: commitResult.newCorporateActions,
          skippedDuplicates: commitResult.skippedDuplicates,
          totalRecords: commitResult.recordCount,
          unmatchedFactors: commitResult.unmatchedFactors,
        },
        errors: parsed.errors,
        // Parser-level warnings (e.g. skipped merger/malformed CA rows) plus
        // commit-time corporate-action warnings (unresolved symbol, ratio
        // collision) — both are meaningful post-commit, neither should be lost.
        warnings: [...parsed.warnings, ...commitResult.warnings],
      });
    }

    // Auto-classify and compute tax lots after commit. The route loops over
    // files calling commitImport per file, then runs these ONCE for the
    // whole request — so the replay status aggregates across every file.
    let replay: { status: "clean" | "mismatch" | "failed"; warnings: string[] } | null = null;
    if (mode === "commit") {
      try {
        classifySecurities(db);
      } catch {
        // Classification failure shouldn't block import
      }

      const hadCorporateActions = commitResultsRaw.some(
        (r) => (r.newCorporateActions ?? 0) > 0 || (r.warnings ?? []).length > 0,
      );
      try {
        const lotResult = computeTaxLots(db);
        if (hadCorporateActions) {
          replay =
            lotResult.replayWarnings.length > 0
              ? { status: "mismatch", warnings: lotResult.replayWarnings }
              : { status: "clean", warnings: [] };
        }
      } catch (err) {
        console.error("[import] tax-lot recompute failed:", err);
        if (hadCorporateActions) {
          replay = {
            status: "failed",
            warnings: ["Tax-lot recompute failed — reconcile status unknown"],
          };
        }
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
      replay,
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

export interface UndoRequestResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * DI-testable core of the undo DELETE (task 20, §G). Deliberate TWO-STEP so a
 * stray or replayed DELETE can't unwind a batch:
 *
 *   1. A DELETE with NO `confirm` returns a short-lived, single-use token
 *      bound to this batch (no deletion happens).
 *   2. A DELETE with a valid `confirm` token passes the rate limit, writes a
 *      recovery manifest BEFORE the destructive delete, then undoes the batch.
 *
 * The manifest is written to `manifestDir` (default data/undo-recovery/,
 * gitignored) atomically before any row is deleted, so undo is always
 * recoverable via scripts/restore-import-batch.ts.
 */
export function handleUndoRequest(
  database: Database.Database,
  params: { batchId: number; confirm?: string | null },
  opts: { manifestDir?: string; nowMs?: number } = {},
): UndoRequestResult {
  const now = opts.nowMs ?? Date.now();
  const { batchId, confirm } = params;
  const batchExists = () =>
    database.prepare("SELECT id FROM import_batches WHERE id = ?").get(batchId) != null;

  // Step 1 — no token yet: issue a confirmation challenge, delete nothing.
  if (!confirm) {
    if (!batchExists()) {
      return { status: 404, body: { success: false, error: `Import batch ${batchId} not found` } };
    }
    const { token, expiresAt } = issueUndoToken(batchId, now);
    return {
      status: 200,
      body: {
        success: false,
        requiresConfirmation: true,
        confirmToken: token,
        expiresAt,
        message: "Undo requires confirmation — resend the request with this confirmToken.",
      },
    };
  }

  // Step 2 — token present. Rate-limit destructive undos first (a throttled
  // attempt must not consume the token). The token is the security gate, so
  // it is validated BEFORE the batch-existence check — a replayed DELETE with
  // an already-consumed token is a 403, not a 404, even after the batch is gone.
  if (!checkUndoRateLimit(now)) {
    return {
      status: 429,
      body: { success: false, error: "Too many undo operations — please wait a moment and try again." },
    };
  }
  if (!consumeUndoToken(batchId, confirm, now)) {
    return {
      status: 403,
      body: { success: false, error: "Invalid or expired confirmation token — request a new confirmation." },
    };
  }
  if (!batchExists()) {
    return { status: 404, body: { success: false, error: `Import batch ${batchId} not found` } };
  }
  recordUndo(now);

  const { manifestPath } = undoImportWithRecovery(database, batchId, {
    manifestDir: opts.manifestDir,
  });

  return {
    status: 200,
    body: {
      success: true,
      message: `Import batch ${batchId} has been undone`,
      manifestPath,
    },
  };
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

    const confirm = request.nextUrl.searchParams.get("confirm");
    const result = handleUndoRequest(db, { batchId, confirm });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
