import { db } from "@/lib/db";
import {
  extractBogeysFromUpload,
  resolveBogeysUploadMediaType,
  BogeysExtractionError,
} from "@/lib/earnings/extract-bogeys";
import { upsertBogey } from "@/lib/mutations/earnings-bogeys";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { addDays } from "@/lib/calendar/date-utils";
import { buildStatementKey, uploadStatementPdf } from "@/lib/storage/r2";
import type { CalendarEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_PDF_BYTES = 32 * 1024 * 1024;

/**
 * POST /api/earnings/bogeys/upload (multipart/form-data)
 *
 * Form fields:
 *   - file: a PDF or image (PNG/JPEG/WebP/GIF, ≤32 MB) — the multi-symbol
 *     earnings preview, e.g., TMT Breakout's weekly bogeys page or a phone
 *     screenshot of it.
 *   - weekOf: YYYY-MM-DD (Monday). Match window is [weekOf-3d, weekOf+10d].
 *   - sourceLabel: optional free-text label (e.g., "TMT Breakout 2026-04-28").
 *
 * Pipeline:
 *   1. Validate, optionally archive the PDF to R2 (graceful no-op when
 *      R2 env vars missing).
 *   2. Send to Claude with native PDF block — extracts per-symbol bogeys.
 *   3. Fan out: for each extracted symbol, look up matching earnings
 *      events in [weekOf-3d, weekOf+10d] (issuer-family aware), insert
 *      one earnings_bogeys row per match.
 *   4. Return a summary the UI can show.
 */
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  if (!form) {
    return Response.json({ error: "Expected multipart/form-data body." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "Form field 'file' must be a file." }, { status: 400 });
  }
  const mediaType = resolveBogeysUploadMediaType(file.name, file.type);
  if (!mediaType) {
    return Response.json(
      { error: "Only PDF or image files (PNG, JPEG, WebP, GIF) are accepted. iPhone photos in HEIC need converting first — screenshots are PNG and work directly." },
      { status: 400 },
    );
  }
  if (file.size > MAX_PDF_BYTES) {
    return Response.json({ error: "File exceeds 32 MB." }, { status: 400 });
  }

  const weekOf = form.get("weekOf");
  if (typeof weekOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) {
    return Response.json(
      { error: "Form field 'weekOf' must be YYYY-MM-DD." },
      { status: 400 },
    );
  }

  const sourceLabel = (() => {
    const v = form.get("sourceLabel");
    return typeof v === "string" && v.trim() ? v.trim() : `Upload ${new Date().toISOString().slice(0, 10)} ${file.name}`;
  })();

  const buffer = Buffer.from(await file.arrayBuffer());

  // ── Archive to R2 (best-effort) ───────────────────────────────────
  let r2Key: string | null = null;
  try {
    const key = buildStatementKey({
      sourceType: "earnings_bogeys_pdf",
      filename: `${weekOf}-${file.name}`,
    });
    r2Key = await uploadStatementPdf(key, buffer, mediaType);
  } catch (err) {
    // Disaster-recovery archival is non-blocking — log to response, keep going.
    console.warn("R2 upload failed during bogeys ingest:", err);
  }

  // ── Claude extraction ─────────────────────────────────────────────
  let extraction;
  try {
    extraction = await extractBogeysFromUpload(buffer, mediaType);
  } catch (err) {
    if (err instanceof BogeysExtractionError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    // Parse-shaped failures (non-JSON model output, no text block) carry no
    // upstream payload — their messages are safe and useful to show.
    console.error("Bogeys extraction failed:", err);
    return Response.json(
      {
        error: `Bogeys extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }

  // ── Fan-out match against calendar_events ─────────────────────────
  const startDate = addDays(weekOf, -3);
  const endDate = addDays(weekOf, 10);
  const candidateEvents = db
    .prepare(
      `SELECT id, symbol, event_date FROM calendar_events
        WHERE event_type = 'earnings'
          AND event_date >= ? AND event_date <= ?
          AND symbol IS NOT NULL`,
    )
    .all(startDate, endDate) as Pick<CalendarEvent, "id" | "symbol" | "event_date">[];

  const eventBySymbol = new Map<string, number>();
  for (const e of candidateEvents) {
    if (!e.symbol) continue;
    // ROW_NUMBER would be cleaner here, but the candidate set is small
    // (≤30 events for a typical week); first-write-wins is fine.
    if (!eventBySymbol.has(e.symbol.toUpperCase())) {
      eventBySymbol.set(e.symbol.toUpperCase(), e.id);
    }
  }

  const results: Array<{ symbol: string; eventId: number | null; bogeyId?: number }> = [];

  for (const bogey of extraction.bogeys) {
    const family = issuerSiblings(bogey.symbol);
    let matchedEventId: number | null = null;
    for (const sym of family) {
      const id = eventBySymbol.get(sym.toUpperCase());
      if (id != null) {
        matchedEventId = id;
        break;
      }
    }

    if (matchedEventId == null) {
      results.push({ symbol: bogey.symbol, eventId: null });
      continue;
    }

    const upsert = upsertBogey(db, {
      event_id: matchedEventId,
      source: "pdf_upload",
      source_label: sourceLabel,
      raw_pdf_r2_key: r2Key,
      eps_consensus: bogey.eps_consensus,
      eps_whisper: bogey.eps_whisper,
      revenue_consensus_usd: bogey.revenue_consensus_usd,
      revenue_whisper_usd: bogey.revenue_whisper_usd,
      expected_move_pct: bogey.expected_move_pct,
      segment_breakdown_json: bogey.segment_breakdown
        ? JSON.stringify(bogey.segment_breakdown)
        : null,
      guidance_notes: bogey.guidance_notes,
      notes: bogey.notes,
      ai_extraction_model: extraction.modelId,
    });
    results.push({ symbol: bogey.symbol, eventId: matchedEventId, bogeyId: upsert.id });
  }

  return Response.json({
    symbolsExtracted: extraction.bogeys.length,
    eventsMatched: results.filter((r) => r.eventId != null).length,
    eventsUnmatched: results.filter((r) => r.eventId == null).map((r) => r.symbol),
    r2Key,
    results,
  });
}
