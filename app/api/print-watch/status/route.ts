import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWatchStatus } from "@/lib/print-watch/watcher";
import { getSheet, listDocumentRoads, listDocuments } from "@/lib/print-watch/store";
import { getLatestDoneRead, getGeneratingRead, getLastFailedAttempt, listCallouts } from "@/lib/print-watch/read-store";
import { sanitizeProseLines } from "@/lib/print-watch/first-pass-format";
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
 * `read` / `activeRead` / `lastAttempt` / `callouts` (Task 8, #15; F10): `read`
 * is the newest DONE first-pass read — what the page shows on a plain refresh.
 * `activeRead` is LIVE WORK ONLY: the newest `generating` row, which is what
 * lets the panel say "reading…". `lastAttempt` is the newest FAILED row, but
 * only when it came AFTER the read on display — a failure a later good read
 * already answered is history, not status — and it carries `capped` (the run
 * gave up) plus the attempt total the cap actually counted. Before F10 a
 * terminal failure sat in `activeRead` forever, so the block read
 * "read failed — attempt_cap" and showed nothing else. All three come from
 * `read-store` reads only; prose is sanitised again here (render-side, M-D15)
 * so every client of this route gets the same guarantee regardless of what
 * slipped past storage-time sanitisation.
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
  return { id: r.id, status: "generating" as const, nonce: r.nonce, attempts: r.attempts, claimed_at: r.claimed_at };
}
function toLastAttemptDto(a: { row: ReadRow; capped: boolean; totalAttempts: number } | null, doneReadId: number | null) {
  // A failure older than the read on display has already been answered by that
  // read — surfacing it would leave "update failed" on screen forever.
  if (!a || (doneReadId !== null && a.row.id < doneReadId)) return null;
  return {
    id: a.row.id, nonce: a.row.nonce,
    // Attempts ACROSS every row for this fingerprint — what the cap counts, and
    // what "gave up after N attempts" has to mean to be true.
    attempts: a.totalAttempts,
    error_code: a.row.error_code, error: a.row.error, next_retry_at: a.row.next_retry_at,
    capped: a.capped, claimed_at: a.row.claimed_at,
  };
}

export async function GET() {
  try {
    const prints = getWatchStatus(db).map((row) => {
      const docs = listDocuments(db, row.printId);
      const doneRead = getLatestDoneRead(db, row.printId);
      // One read per print, indexed in memory — not one query per document.
      const roads = listDocumentRoads(db, row.printId);
      return {
        printId: row.printId,
        eventId: row.eventId,
        symbol: row.symbol,
        state: row.state,
        sources: row.sources,
        coverage: row.coverage,
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
        read: toReadDto(doneRead),
        activeRead: toActiveDto(getGeneratingRead(db, row.printId)),
        lastAttempt: toLastAttemptDto(getLastFailedAttempt(db, row.printId), doneRead?.id ?? null),
        callouts: listCallouts(db, row.printId),
      };
    });

    return NextResponse.json({ success: true, data: { prints } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
