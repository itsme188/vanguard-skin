import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ingestDocument } from "@/lib/print-watch/watcher";
import { getPrintByEventId } from "@/lib/print-watch/store";

/**
 * ~14MB of base64 TEXT decodes to ~10MB of binary (Codex #24) — checked
 * against the base64 STRING length, before any decode is attempted, so an
 * oversized/hostile drop never pays for the Buffer.from allocation.
 */
const MAX_BASE64_LENGTH = 14 * 1024 * 1024;

const PDF_REJECT_MESSAGE =
  "PDFs aren't supported for drops yet — open the release page and press ⌘S to save it as HTML, then drop that file instead.";

/** PDF signature ("%PDF-") — the one binary shape v1 explicitly refuses.
 *  Everything else (HTML, plain text) passes through; `ingestDocument`
 *  itself sniffs HTML vs. plain text to pick the stored extension. */
function isPdf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

interface DropBody {
  eventId?: unknown;
  filename?: unknown;
  contentBase64?: unknown;
}

/**
 * POST /api/print-watch/drop — the panel's manual drop zone.
 * Body: `{eventId, filename, contentBase64}`.
 *
 * Ingests through the SAME pipeline as the automated sources
 * (`ingestDocument(..., kind: "user-drop", ...)`), so a manual drop still
 * passes the issuer/period gate and runs the full parse. `ingestDocument`
 * AWAITS that parse — this call can legitimately take 15-30s
 * (watcher.ts's own note) — the route awaits it and returns only once the
 * sheet has been updated (or the doc recorded as gate-rejected).
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as DropBody;
    const { eventId, filename, contentBase64 } = body;

    if (typeof eventId !== "number" || !Number.isFinite(eventId)) {
      return NextResponse.json(
        { success: false, error: "Body field 'eventId' must be a number." },
        { status: 400 },
      );
    }
    if (typeof filename !== "string" || filename.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: "Body field 'filename' is required." },
        { status: 400 },
      );
    }
    if (typeof contentBase64 !== "string" || contentBase64.length === 0) {
      return NextResponse.json(
        { success: false, error: "Body field 'contentBase64' is required." },
        { status: 400 },
      );
    }

    // Precheck BEFORE decode (Codex #24) — reject on the base64 string's
    // own length, so an oversized payload never reaches Buffer.from.
    if (contentBase64.length > MAX_BASE64_LENGTH) {
      return NextResponse.json(
        {
          success: false,
          error: "That file is too large to drop — print-watch accepts releases up to ~10MB.",
        },
        { status: 400 },
      );
    }

    const print = getPrintByEventId(db, eventId);
    if (!print) {
      return NextResponse.json(
        {
          success: false,
          error: `No print-watch entry for event ${eventId} — arm the event before dropping a document.`,
        },
        { status: 404 },
      );
    }

    const buf = Buffer.from(contentBase64, "base64");

    if (isPdf(buf)) {
      return NextResponse.json({ success: false, error: PDF_REJECT_MESSAGE }, { status: 400 });
    }

    const { docId, isNew, outcome, rejectReason } = await ingestDocument(
      db,
      print.id,
      "user-drop",
      `user-drop:${filename}`,
      null,
      buf,
    );

    // The verdict travels with the id (final fix wave): a gate rejection and a
    // duplicate are both HTTP 200 — the drop itself worked — but they are NOT
    // "parsing now", and only ingestDocument knows which of the three happened.
    return NextResponse.json({
      success: true,
      data: { docId, isNew, outcome, rejectReason: rejectReason ?? null },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
