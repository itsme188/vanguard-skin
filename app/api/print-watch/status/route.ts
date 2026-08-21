import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWatchStatus } from "@/lib/print-watch/watcher";
import { getSheet } from "@/lib/print-watch/store";

/**
 * GET /api/print-watch/status — the panel's poll loop (Task 10).
 *
 * A PURE READ, on purpose (Codex #9): the session cookie is SameSite=Lax, so
 * it rides along on a plain cross-site GET navigation/prefetch — a GET
 * handler that starts or advances watcher work would be a CSRF hole with no
 * token required. This handler calls ONLY `getWatchStatus` (store reads,
 * in-memory source/coverage notes) and `getSheet` (the reconciled lines) —
 * never `ensurePrintWatch` or any other mutator. That starts on
 * POST /api/print-watch/ensure instead. tests/api/no-state-changing-get.test.ts
 * enforces this repo-wide via a static scan of every GET body; this route's
 * own test in print-watch-routes.test.ts mirrors that scan narrowly against
 * this file's source.
 *
 * Flash lines carry `source_doc_id: null` (no document of record) —
 * serialized as-is, no massaging.
 */
export async function GET() {
  try {
    const prints = getWatchStatus(db).map((row) => ({
      printId: row.printId,
      eventId: row.eventId,
      symbol: row.symbol,
      state: row.state,
      sources: row.sources,
      coverage: row.coverage,
      lines: getSheet(db, row.printId),
    }));

    return NextResponse.json({ success: true, data: { prints } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
