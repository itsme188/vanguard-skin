/**
 * POST/DELETE /api/donations/lots/:acquisitionTransactionId/basis-verified —
 * mark, or stop marking, a donated lot's basis as verified against a source
 * document (owner request 2026-10-07). Thin wrapper: every rule lives in
 * lib/mutations/lot-basis-verifications.ts.
 *
 * POST body: { sourceNote: string } — what the basis was checked against,
 * 1 to 200 characters after trimming. Marking again replaces the marker.
 * DELETE takes no body. Deleting a marker that is not there is a 200 with
 * { removed: false }.
 *
 * These routes need NO ledger-recompute acknowledgement, unlike the other
 * Giving write routes (links, lots, reverse, resolve-security). Those change
 * a tax input and end in a recompute of the whole tax-lot ledger. A marker
 * changes no tax input: it writes one row that only the Giving page reads,
 * to decide whether a flagged gift counts toward "Gain avoided". No
 * transaction, tax lot or tax figure moves, and nothing is recomputed.
 *
 * Status codes: 400 a bad id, body or note; 404 an unknown transaction;
 * 409 a transaction that is not a lot or that no donation draws on, and 409
 * while the tax-lot ledger is waiting on a recompute (the basis shown may be
 * out of date, so there is nothing settled to verify). That 409 only asks
 * the owner to recompute elsewhere first; this route still recomputes nothing.
 */

import { db } from "@/lib/db";
import {
  markLotBasisVerified,
  unmarkLotBasisVerified,
  LotBasisVerificationError,
  type LotBasisVerificationErrorCode,
} from "@/lib/mutations/lot-basis-verifications";

const STATUS_BY_CODE: Record<LotBasisVerificationErrorCode, number> = {
  invalid_id: 400,
  invalid_note: 400,
  not_found: 404,
  not_acquisition: 409,
  not_donated: 409,
  ledger_pending: 409,
  no_lot: 409,
};

type Params = { params: Promise<{ acquisitionTransactionId: string }> };

/** A positive whole number written in plain digits, or null. */
function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function failure(error: unknown): Response {
  if (error instanceof LotBasisVerificationError) {
    return Response.json({ success: false, error: error.message }, { status: STATUS_BY_CODE[error.code] });
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  return Response.json({ success: false, error: message }, { status: 500 });
}

export async function POST(request: Request, { params }: Params) {
  const { acquisitionTransactionId: raw } = await params;
  const acquisitionTransactionId = parseId(raw);
  if (acquisitionTransactionId == null) {
    return Response.json({ success: false, error: "Invalid ID" }, { status: 400 });
  }

  let sourceNote: unknown;
  try {
    const parsed: unknown = await request.json();
    // `null`, a number or a string is valid JSON but not a request body.
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }
    sourceNote = (parsed as { sourceNote?: unknown }).sourceNote;
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof sourceNote !== "string") {
    return Response.json({ success: false, error: "sourceNote must be text" }, { status: 400 });
  }

  try {
    const saved = markLotBasisVerified(db, { acquisitionTransactionId, sourceNote });
    return Response.json({ success: true, data: { verified: true, ...saved } });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const { acquisitionTransactionId: raw } = await params;
  const acquisitionTransactionId = parseId(raw);
  if (acquisitionTransactionId == null) {
    return Response.json({ success: false, error: "Invalid ID" }, { status: 400 });
  }

  try {
    const removed = unmarkLotBasisVerified(db, acquisitionTransactionId);
    return Response.json({ success: true, data: { removed } });
  } catch (error) {
    return failure(error);
  }
}
