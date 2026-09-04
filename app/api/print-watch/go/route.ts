import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requestGo, GoRefused, safeErrorText, type GoInput } from "@/lib/print-watch/go";
import { getGoRequest } from "@/lib/print-watch/store";
import { redactUrl } from "@/lib/print-watch/hardened-fetch";
import type { RoadReport } from "@/lib/print-watch/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/print-watch/go — "print is live" (spec §4.3).
 *
 * Deliberately thin: shape-check the body, hand it to `requestGo`, map the
 * domain refusal to a 400. Every rule about WHAT may be pressed — one input
 * not two, https-only and SSRF-safe links, no embedded credentials, no
 * secret-bearing query key, readable (non-binary) bytes under 10 MB, an
 * earnings event that still exists — lives in `lib/print-watch/go.ts`, which
 * is also what the in-process callers use. The route never re-validates
 * (a second copy of a rule is a second place for it to drift) and never
 * decodes the payload itself: `requestGo` refuses an oversize base64 string
 * on its LENGTH, before any `Buffer.from` allocation.
 *
 * A press is a ROW. Once `requestGo` returns, the request is durable and the
 * dispatcher owns it — so post-commit trouble (the prepare kick, the outbox
 * drain, the scheduler wake) comes back as `data.wakeError` on a 200, never
 * as a 500 the desk cannot act on (Codex round 1, findings #4/#5).
 *
 * `human` route by the proxy's DEFAULT classification (session + CSRF +
 * trusted Origin on unsafe methods) — no lib/auth/route-policy.ts entry, and
 * none is wanted.
 */
export async function POST(req: NextRequest) {
  let body: { eventId?: unknown; url?: unknown; filename?: unknown; contentBase64?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ success: false, error: "Body must be JSON." }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ success: false, error: "Body must be a JSON object." }, { status: 400 });
  }

  const eventId = body.eventId;
  if (typeof eventId !== "number" || !Number.isInteger(eventId) || eventId <= 0) {
    return NextResponse.json(
      { success: false, error: "Body field 'eventId' must be a positive integer." },
      { status: 400 },
    );
  }

  const input: GoInput = {};
  if (body.url !== undefined) {
    if (typeof body.url !== "string") {
      return NextResponse.json({ success: false, error: "'url' must be a string." }, { status: 400 });
    }
    input.url = body.url;
  }
  if (body.contentBase64 !== undefined) {
    if (typeof body.contentBase64 !== "string") {
      return NextResponse.json({ success: false, error: "'contentBase64' must be a string." }, { status: 400 });
    }
    input.contentBase64 = body.contentBase64;
    // Accepted and discarded by `requestGo` (there is no column for it, and it
    // never steers where the bytes land) — forwarded only so a future use has
    // it at the seam rather than needing a wire change.
    if (typeof body.filename === "string") input.filename = body.filename;
  }

  try {
    const ack = await requestGo(db, eventId, input);
    return NextResponse.json({ success: true, data: ack });
  } catch (err) {
    // A `GoRefused` is something the desk can fix — bad input, or an event
    // that cannot be pressed. Everything else is ours, and its text is
    // scrubbed of links and local paths before it leaves the process.
    if (err instanceof GoRefused) {
      return NextResponse.json({ success: false, error: err.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: safeErrorText(err) }, { status: 500 });
  }
}

/**
 * GET /api/print-watch/go?requestId=N — one request row, for the panel to
 * follow a press to its per-road verdicts.
 *
 * A PURE READ (tests/api/no-state-changing-get.test.ts scans this body): the
 * session cookie is SameSite=Lax, so a GET that advanced watcher work would
 * be reachable from a hostile page with no token. Starting work is what POST
 * is for.
 *
 * Two things never leave the process: `input_bytes_path`, which names a file
 * on this machine's disk, and `claim_token`, which is the lease. The pasted
 * link goes out through `redactUrl` — the one way a URL reaches a response
 * body in this subsystem.
 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("requestId");
  const id = raw === null || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json(
      { success: false, error: "Query 'requestId' must be a positive integer." },
      { status: 400 },
    );
  }

  const row = getGoRequest(db, id);
  if (!row) {
    return NextResponse.json({ success: false, error: `No go request ${id}.` }, { status: 404 });
  }

  // A `result_json` that will not parse reads as "no reports yet" rather than
  // taking a read-only route down.
  let result: RoadReport[] | null = null;
  try {
    const parsed: unknown = row.result_json ? JSON.parse(row.result_json) : null;
    result = Array.isArray(parsed) ? (parsed as RoadReport[]) : null;
  } catch {
    result = null;
  }

  return NextResponse.json({
    success: true,
    data: {
      request: {
        id: row.id,
        printId: row.print_id,
        status: row.status,
        attempts: row.attempts,
        requestedAt: row.requested_at,
        finishedAt: row.finished_at,
        inputKind: row.input_kind,
        inputUrl: row.input_url === null ? null : redactUrl(row.input_url),
        result,
      },
    },
  });
}
