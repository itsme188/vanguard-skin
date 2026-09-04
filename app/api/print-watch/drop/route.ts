import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ingestDocument } from "@/lib/print-watch/watcher";
import { deliverFromUrl } from "@/lib/print-watch/roads";
import { getPrintByEventId } from "@/lib/print-watch/store";

/**
 * ~14MB of base64 TEXT decodes to ~10MB of binary (Codex #24) — checked
 * against the base64 STRING length, before any decode is attempted, so an
 * oversized/hostile drop never pays for the Buffer.from allocation.
 */
const MAX_BASE64_LENGTH = 14 * 1024 * 1024;

/** The two shapes this route accepts. Parsed UP FRONT (Codex #15) rather than
 *  validated field by field: the old order demanded `filename` immediately
 *  after `eventId`, so a perfectly good `{eventId, url}` body was refused
 *  before the URL branch could ever be reached. */
type DropRequest =
  | { kind: "url"; eventId: number; url: string }
  | { kind: "file"; eventId: number; filename: string; contentBase64: string };

interface DropBody {
  eventId?: unknown;
  filename?: unknown;
  contentBase64?: unknown;
  url?: unknown;
}

/** Exactly one of `url` or `filename + contentBase64`; everything else is a
 *  400 with a reason that says which half is missing. */
function parseDropBody(body: DropBody): DropRequest | { error: string } {
  const { eventId, filename, contentBase64, url } = body;
  if (typeof eventId !== "number" || !Number.isFinite(eventId)) {
    return { error: "Body field 'eventId' must be a number." };
  }
  const hasUrl = typeof url === "string" && url.trim().length > 0;
  const hasFile =
    (typeof filename === "string" && filename.trim().length > 0) ||
    (typeof contentBase64 === "string" && contentBase64.length > 0);
  if (hasUrl && hasFile) {
    return { error: "Send either 'url' or a file ('filename' + 'contentBase64'), not both." };
  }
  if (hasUrl) return { kind: "url", eventId, url: (url as string).trim() };
  if (typeof filename !== "string" || filename.trim().length === 0) {
    return { error: "Body field 'filename' is required for a file drop (or send 'url')." };
  }
  if (typeof contentBase64 !== "string" || contentBase64.length === 0) {
    return { error: "Body field 'contentBase64' is required for a file drop (or send 'url')." };
  }
  // Precheck BEFORE decode (Codex #24) — reject on the base64 string's own
  // length, so an oversized payload never reaches Buffer.from.
  if (contentBase64.length > MAX_BASE64_LENGTH) {
    return { error: "That file is too large to drop — print-watch accepts releases up to ~10MB." };
  }
  return { kind: "file", eventId, filename: filename.trim(), contentBase64 };
}

/**
 * POST /api/print-watch/drop — the panel's manual roads.
 * Body: `{eventId, filename, contentBase64}` (a dropped file) OR
 *       `{eventId, url}` (a pasted link).
 *
 * Both go through the SAME pipeline as the automated sources — a file as
 * `user-drop`, a link as `user-url` via `deliverFromUrl` — so a manual
 * delivery still passes the issuer/period gate and runs the full parse.
 * `ingestDocument` AWAITS that parse — this call can legitimately take
 * 15-30s (watcher.ts's own note) — and the route returns only once the sheet
 * has been updated (or the document recorded as gate-rejected).
 *
 * HTML, plain text and PDF are all readable now (Task 10). A `refused`
 * outcome means the FILE is unreadable — binary bytes, an encrypted or
 * image-only or oversize PDF, or poppler missing — and is a 400 carrying the
 * specific reason; a `rejected` outcome means the document is real but not
 * this event's, which is a 200 the panel explains.
 */
export async function POST(request: NextRequest) {
  try {
    const parsed = parseDropBody((await request.json().catch(() => ({}))) as DropBody);
    if ("error" in parsed) {
      return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
    }

    const print = getPrintByEventId(db, parsed.eventId);
    if (!print) {
      return NextResponse.json(
        {
          success: false,
          error: `No print-watch entry for event ${parsed.eventId} — arm the event before dropping a document or pasting a link.`,
        },
        { status: 404 },
      );
    }

    if (parsed.kind === "url") {
      const out = await deliverFromUrl(db, print.id, parsed.url);
      // `detail` is already redacted by `deliverFromUrl` — a raw link (and any
      // token it carries) never reaches a response body from this route.
      if (out.outcome === "refused" || out.outcome === "fetch_failed") {
        return NextResponse.json({ success: false, error: out.detail }, { status: 400 });
      }
      return NextResponse.json({ success: true, data: out });
    }

    const buf = Buffer.from(parsed.contentBase64, "base64");
    const { docId, isNew, outcome, rejectReason } = await ingestDocument(
      db,
      print.id,
      "user-drop",
      `user-drop:${parsed.filename}`,
      null,
      buf,
    );

    if (outcome === "refused") {
      return NextResponse.json(
        { success: false, error: rejectReason ?? "That file isn't readable here." },
        { status: 400 },
      );
    }

    // The verdict travels with the id (final fix wave): a gate rejection, a
    // duplicate and a failed parse are all HTTP 200 — the drop itself worked —
    // but they are NOT "parsing now", and only ingestDocument knows which of
    // them happened.
    return NextResponse.json({
      success: true,
      data: { road: "user-drop", docId, isNew, outcome, rejectReason: rejectReason ?? null },
    });
  } catch (error) {
    // Message only, never a URL or a body: `deliverFromUrl` propagates
    // infrastructure exceptions by ruling, and this is where they land.
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
