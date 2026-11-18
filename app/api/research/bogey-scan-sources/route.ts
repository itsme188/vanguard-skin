import { db } from "@/lib/db";
import {
  isBogeyScanMode,
  listBogeyScanSources,
  setBogeyScanMode,
  UnknownBogeyScanSourceError,
} from "@/lib/earnings/bogey-scan-eligibility";

/**
 * GET /api/research/bogey-scan-sources: every newsletter source with its
 * bogey-scan mode ("off" | "all" | "previews"). Owner ruling 2026-11-18.
 */
export async function GET() {
  return Response.json({ success: true, data: { sources: listBogeyScanSources(db) } });
}

/**
 * PUT /api/research/bogey-scan-sources  body `{ sourceId, mode }`.
 * 400 for a bad body, 404 for an unknown source. The change is prospective:
 * nothing is re-read now; the automatic readers follow it on their next run.
 */
export async function PUT(request: Request) {
  const body = (await request.json().catch(() => null)) as { sourceId?: unknown; mode?: unknown } | null;
  if (!body || typeof body !== "object") {
    return Response.json({ success: false, error: "Send a JSON body with sourceId and mode." }, { status: 400 });
  }
  const { sourceId, mode } = body;
  if (typeof sourceId !== "number" || !Number.isSafeInteger(sourceId) || sourceId <= 0) {
    return Response.json({ success: false, error: "sourceId must be a positive whole number." }, { status: 400 });
  }
  if (!isBogeyScanMode(mode)) {
    return Response.json(
      { success: false, error: 'mode must be "off", "all" or "previews".' },
      { status: 400 },
    );
  }
  try {
    setBogeyScanMode(db, sourceId, mode);
  } catch (err) {
    if (err instanceof UnknownBogeyScanSourceError) {
      return Response.json({ success: false, error: err.message }, { status: 404 });
    }
    throw err;
  }
  return Response.json({ success: true, data: { sourceId, mode } });
}
