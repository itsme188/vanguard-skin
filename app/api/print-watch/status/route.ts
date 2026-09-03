import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWatchStatus } from "@/lib/print-watch/watcher";
import { getSheet, listDocumentRoads, listDocuments } from "@/lib/print-watch/store";
import { getLatestDoneRead, getActiveRead, listCallouts } from "@/lib/print-watch/read-store";
import { sanitizeProseLines } from "@/lib/print-watch/first-pass-prompt";
import type { ReadRow } from "@/lib/print-watch/first-pass-types";

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
 *
 * `documents` is a doc-id → kind map (final fix wave). A conflict row's
 * candidates identify themselves only by `doc_id`, and "doc #12 vs doc #13"
 * tells the desk nothing about WHICH source to believe — "edgar-ex99 vs
 * user-drop" tells it everything. The map is sent alongside rather than
 * denormalized into each candidate so `TaggedCandidate` (a stored, reconciled
 * shape) keeps its schema.
 *
 * `documentRoads` is the same idea one level deeper (089/M13): identity is
 * CONTENT, so one document is now routinely delivered by several roads, and
 * the kind map can only name one of them. Two roads agreeing on the same bytes
 * is the strongest provenance the desk gets — and a road the gate REFUSED
 * (verdict `rejected`) is exactly what explains a stored document that never
 * parsed. Both are reads; the GET stays mutation-free.
 *
 * `read` / `activeRead` / `callouts` (Task 8, #15): `read` is the newest DONE
 * first-pass read — what the page shows on a plain refresh. `activeRead` is
 * the newest row ONLY when it is still generating or has failed (and is
 * therefore newer than any done row) — the panel's "updating…" / "failed"
 * line. Both come from `read-store` reads only; prose is sanitised again here
 * (render-side, M-D15) so every client of this route gets the same guarantee
 * regardless of what slipped past storage-time sanitisation.
 */
function parse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
function toReadDto(r: ReadRow | null) {
  if (!r) return null;
  const prose = parse(r.prose_json) as { read?: unknown; call_watch?: unknown; caveats?: unknown } | null;
  const facts = parse(r.facts_json);
  return {
    id: r.id, status: "done" as const, nonce: r.nonce, model_id: r.model_id, generated_at: r.generated_at,
    facts: Array.isArray(facts) ? facts : [],
    prose: { read: sanitizeProseLines(prose?.read, 10), call_watch: sanitizeProseLines(prose?.call_watch, 3), caveats: sanitizeProseLines(prose?.caveats, 6) },
  };
}
function toActiveDto(r: ReadRow | null) {
  if (!r) return null;
  return { id: r.id, status: r.status as "generating" | "failed", nonce: r.nonce, attempts: r.attempts, error_code: r.error_code, error: r.error, next_retry_at: r.next_retry_at, claimed_at: r.claimed_at };
}

export async function GET() {
  try {
    const prints = getWatchStatus(db).map((row) => {
      const docs = listDocuments(db, row.printId);
      // One read per print, indexed in memory — not one query per document.
      const roads = listDocumentRoads(db, row.printId);
      return {
        printId: row.printId,
        eventId: row.eventId,
        symbol: row.symbol,
        state: row.state,
        sources: row.sources,
        coverage: row.coverage,
        // Slice C's window fields. `getWatchStatus` already computed all four
        // (the once-only forced stamp, the stacked extension, the ONE
        // effective window and the latest durable go request), so this GET
        // stays the pure read the doc comment above promises.
        forcedOpenAt: row.forcedOpenAt,
        windowExtendedUntil: row.windowExtendedUntil,
        effectiveWindow: row.effectiveWindow,
        goRequest: row.goRequest,
        lines: getSheet(db, row.printId),
        documents: Object.fromEntries(docs.map((doc) => [doc.id, doc.kind])) as Record<
          number,
          string
        >,
        documentRoads: Object.fromEntries(
          docs.map((doc) => [
            doc.id,
            roads
              .filter((road) => road.document_id === doc.id)
              .map((road) => ({
                kind: road.kind,
                source: road.source,
                verdict: road.road_verdict,
              })),
          ]),
        ) as Record<number, Array<{ kind: string; source: string; verdict: string }>>,
        read: toReadDto(getLatestDoneRead(db, row.printId)),
        activeRead: toActiveDto(getActiveRead(db, row.printId)),
        callouts: listCallouts(db, row.printId),
      };
    });

    return NextResponse.json({ success: true, data: { prints } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
