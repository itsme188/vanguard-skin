import { db } from "@/lib/db";
import {
  resolveBogeysUploadMediaType,
  BogeysExtractionError,
  type BogeysInput,
} from "@/lib/earnings/extract-bogeys";
import {
  readBogeysForEvent,
  ReadBogeysEventNotFoundError,
} from "@/lib/earnings/read-bogeys-for-event";
import { accountFailureOf, aiUnavailableReason } from "@/lib/earnings/ai-unavailable";

export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 32 * 1024 * 1024;

function fail(error: string, status: number) {
  return Response.json({ success: false, error }, { status });
}

/**
 * POST /api/earnings/bogeys/read (multipart/form-data) — bogey intake 2026-11-18.
 *
 * Form fields:
 *   - eventId: the earnings print to read for.
 *   - file: a PDF or image (PNG/JPEG/WebP/GIF, ≤32 MB), OR
 *   - text: pasted preview text (up to MAX_PASTE_CHARS).
 *   Exactly one of file / text.
 *
 * Answers `{ success: true, data: ReadBogeysResult }`. WRITES NOTHING: the
 * edit box shows the figures and the owner saves them through the existing
 * Save. One owner click, one AI call; nothing calls this on page load.
 *
 * Errors: 400 bad body, 404 unknown event, an extraction error's own status,
 * 503 when the AI account (not the input) is at fault.
 */
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  if (!form) return fail("Expected multipart/form-data body.", 400);

  const rawEventId = form.get("eventId");
  const eventId = typeof rawEventId === "string" && /^\d+$/.test(rawEventId.trim()) ? Number(rawEventId.trim()) : NaN;
  if (!Number.isSafeInteger(eventId) || eventId <= 0) {
    return fail("Form field 'eventId' must be a positive whole number.", 400);
  }

  const file = form.get("file");
  const text = form.get("text");
  const hasFile = file instanceof File && file.size > 0;
  const hasText = typeof text === "string" && text.trim() !== "";
  if (hasFile === hasText) {
    return fail(
      hasFile ? "Send a file or pasted text, not both." : "Choose a file or paste some preview text first.",
      400,
    );
  }

  let input: BogeysInput;
  let sourceName: string | undefined;
  if (hasFile) {
    const f = file as File;
    const mediaType = resolveBogeysUploadMediaType(f.name, f.type);
    if (!mediaType) {
      return fail(
        "Only PDF or image files (PNG, JPEG, WebP, GIF) are accepted. iPhone photos in HEIC need converting first — screenshots are PNG and work directly.",
        400,
      );
    }
    if (f.size > MAX_FILE_BYTES) return fail("File exceeds 32 MB.", 400);
    input = { kind: "file", bytes: new Uint8Array(await f.arrayBuffer()), mediaType };
    sourceName = f.name;
  } else {
    input = { kind: "text", text: text as string };
  }

  try {
    const data = await readBogeysForEvent(db, eventId, input, { sourceName });
    return Response.json({ success: true, data });
  } catch (err) {
    if (err instanceof ReadBogeysEventNotFoundError) return fail(err.message, 404);
    const account = accountFailureOf(err);
    if (account) return fail(aiUnavailableReason(account), 503);
    if (err instanceof BogeysExtractionError) return fail(err.message, err.status);
    // Counts and names only: never the input or the model's output.
    console.error(`Bogeys read failed for event ${eventId}: ${err instanceof Error ? err.name : "error"}`);
    return fail("The AI read failed; try again.", 502);
  }
}
