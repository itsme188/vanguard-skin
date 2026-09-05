import { db } from "@/lib/db";
import { getBogeysForEvent } from "@/lib/queries/earnings-bogeys";
import {
  saveBogeyWithRecompile,
  deleteBogeyWithRecompile,
} from "@/lib/mutations/earnings-bogeys";
import { parseExtraMetrics, detectExtraMetricConflicts } from "@/lib/print-watch/extra-metrics";

export const dynamic = "force-dynamic";

/**
 * GET    /api/earnings/bogeys?eventId=NN
 * POST   /api/earnings/bogeys           — manual entry (+ live-sheet recompile)
 * DELETE /api/earnings/bogeys?id=NN     — (+ live-sheet recompile)
 *
 * Thin by the API pattern: auth is the proxy's (human by default), this file
 * parses and delegates. Every write, and the recompile it implies, lives in
 * ONE library transaction (lib/mutations/earnings-bogeys.ts).
 *
 * The envelope is ADDITIVE: `success` joins the keys this route already
 * returned (it predates the {success} convention, and BogeysEditModal reads
 * `bogeys` / `deleted` / `id` by name), and a failure is
 * `{ success: false, error }` at the SAME status it used before.
 *
 * The upload route lives at /api/earnings/bogeys/upload.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const eventId = Number(url.searchParams.get("eventId"));
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return Response.json(
      { success: false, error: "Query param 'eventId' must be a positive integer." },
      { status: 400 },
    );
  }
  const bogeys = getBogeysForEvent(db, eventId);

  // Conflict detection walks the rows in ROWID order, which is the order
  // compileContracts merges in — so the modal's banner names exactly the ids
  // the compiler refused, and cannot disagree with the sheet. (getBogeysForEvent
  // is deliberately newest-issue-first for the composer; that ordering is right
  // for prose and wrong for merge semantics.)
  const byRowid = [...bogeys].sort((a, b) => a.id - b.id);
  const extraMetricConflicts = detectExtraMetricConflicts(
    byRowid.map((b) => ({ id: b.id, specs: parseExtraMetrics(b.extra_metrics_json).specs })),
  );

  // Each row republishes its PARSED specs so the modal can edit them WITHOUT
  // re-minting ids (Codex 1) — a re-minted id would retire a live line and
  // start a new one, losing its continuity. An unreadable stored value reports
  // itself rather than vanishing.
  const withSpecs = bogeys.map((b) => {
    const { specs, errors } = parseExtraMetrics(b.extra_metrics_json);
    return { ...b, extraMetrics: specs, extraMetricErrors: errors };
  });

  return Response.json({ success: true, bogeys: withSpecs, extraMetricConflicts });
}

interface ManualBogeyBody {
  event_id?: number;
  source_label?: string;
  eps_consensus?: number | null;
  eps_whisper?: number | null;
  revenue_consensus_usd?: number | null;
  revenue_whisper_usd?: number | null;
  /** Absolute percent (±6% → 6) — sheet/analyst expected earnings move. */
  expected_move_pct?: number | null;
  guidance_notes?: string | null;
  notes?: string | null;
  /** Desk-defined extra metric lines (spec §4.7), as a JSON string. */
  extra_metrics_json?: string | null;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as ManualBogeyBody;
  if (typeof body.event_id !== "number" || !Number.isInteger(body.event_id)) {
    return Response.json(
      { success: false, error: "Body field 'event_id' must be an integer." },
      { status: 400 },
    );
  }

  let extraMetricsJson: string | null = null;
  if (body.extra_metrics_json !== undefined && body.extra_metrics_json !== null) {
    if (typeof body.extra_metrics_json !== "string") {
      return Response.json(
        { success: false, error: "Body field 'extra_metrics_json' must be a JSON string." },
        { status: 400 },
      );
    }
    // The SAME parser the modal validates with. The client check is a fast,
    // identical refusal; this one is the only one that decides.
    const { errors } = parseExtraMetrics(body.extra_metrics_json);
    if (errors.length > 0) {
      return Response.json({ success: false, error: errors.join(" ") }, { status: 400 });
    }
    extraMetricsJson = body.extra_metrics_json.trim() === "" ? null : body.extra_metrics_json;
  }

  const { result, recompile } = saveBogeyWithRecompile(db, {
    event_id: body.event_id,
    source: "manual",
    source_label: body.source_label ?? null,
    eps_consensus: body.eps_consensus ?? null,
    eps_whisper: body.eps_whisper ?? null,
    revenue_consensus_usd: body.revenue_consensus_usd ?? null,
    revenue_whisper_usd: body.revenue_whisper_usd ?? null,
    expected_move_pct:
      typeof body.expected_move_pct === "number" &&
      Number.isFinite(body.expected_move_pct) &&
      body.expected_move_pct > 0
        ? body.expected_move_pct
        : null,
    guidance_notes: body.guidance_notes ?? null,
    notes: body.notes ?? null,
    extra_metrics_json: extraMetricsJson,
  });

  return Response.json({ success: true, ...result, ...(recompile ? { recompiled: recompile } : {}) });
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json(
      { success: false, error: "Query param 'id' must be a positive integer." },
      { status: 400 },
    );
  }
  const { deleted, recompile } = deleteBogeyWithRecompile(db, id);
  return Response.json({ success: true, deleted, ...(recompile ? { recompiled: recompile } : {}) });
}
