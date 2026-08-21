import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getPrintByEventId, getSheet, markLineAccepted, clearLineAccepted } from "@/lib/print-watch/store";
import { saveManualActuals } from "@/lib/earnings/actuals";
import type { SaveManualActualsResult } from "@/lib/earnings/actuals";
import type { PrintWatchLine } from "@/lib/print-watch/types";

export const dynamic = "force-dynamic";

interface AcceptBody {
  eventId?: number;
  accept?: string[];
  unaccept?: string[];
  promoteHeadline?: boolean;
  force?: boolean;
}

type SaveManualActualsFailure = Extract<SaveManualActualsResult, { ok: false }>;

/** Thrown INSIDE the transaction to abort-and-rollback when the promotion
 *  write (saveManualActuals) refuses — better-sqlite3 rolls back every
 *  accept/unaccept write from the same request along with it, so a 409
 *  pre_print (or any other saveManualActuals refusal) leaves zero rows
 *  changed, matching the "validate the ENTIRE request, then ONE
 *  transaction" rule for the one case that can only be decided by actually
 *  calling saveManualActuals (the pre-print floor is now-dependent). */
class PromotionRefused extends Error {
  constructor(public readonly result: SaveManualActualsFailure) {
    super(result.error);
  }
}

// Ruling (progress.md, wave {10,11,12} dispatch note): single_source and
// flash accepts are the user overriding with their own eyes — allowed, the
// panel labels them. 'accepted' is included so re-accepting an
// already-accepted line is a harmless no-op rather than an error.
// conflict/pending are excluded on purpose — those need resolving or
// waiting, not overriding.
const ACCEPTABLE_ACCEPT_STATES = new Set(["agreed", "flash", "single_source", "blank", "accepted"]);

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as AcceptBody;

  const eventId = body.eventId;
  if (typeof eventId !== "number" || !Number.isInteger(eventId)) {
    return NextResponse.json(
      { success: false, error: "Body field 'eventId' must be an integer." },
      { status: 400 },
    );
  }

  if (body.accept !== undefined && !Array.isArray(body.accept)) {
    return NextResponse.json(
      { success: false, error: "Body field 'accept' must be an array of metric ids." },
      { status: 400 },
    );
  }
  if (body.unaccept !== undefined && !Array.isArray(body.unaccept)) {
    return NextResponse.json(
      { success: false, error: "Body field 'unaccept' must be an array of metric ids." },
      { status: 400 },
    );
  }

  const print = getPrintByEventId(db, eventId);
  if (!print) {
    return NextResponse.json(
      { success: false, error: `No print-watch record for event ${eventId}.` },
      { status: 404 },
    );
  }

  const acceptList = (body.accept ?? []) as string[];
  const unacceptList = (body.unaccept ?? []) as string[];
  const promoteHeadline = body.promoteHeadline === true;
  const force = body.force === true;

  const sheet = getSheet(db, print.id);
  const byMetric = new Map<string, PrintWatchLine>(sheet.map((l) => [l.metric_id, l]));

  // ── Step 1: validate the ENTIRE request before writing anything (Codex #14) ──

  for (const metricId of acceptList) {
    const line = byMetric.get(metricId);
    if (!line) {
      return NextResponse.json(
        { success: false, error: `Unknown metric "${metricId}" — no line on this print's sheet.` },
        { status: 400 },
      );
    }
    if (!ACCEPTABLE_ACCEPT_STATES.has(line.state)) {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot accept "${metricId}": its state is "${line.state}" — resolve the conflict, or wait for a source, before accepting.`,
        },
        { status: 400 },
      );
    }
  }

  for (const metricId of unacceptList) {
    if (!byMetric.has(metricId)) {
      return NextResponse.json(
        { success: false, error: `Unknown metric "${metricId}" — no line on this print's sheet.` },
        { status: 400 },
      );
    }
    if (acceptList.includes(metricId)) {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot both accept and unaccept "${metricId}" in the same request.`,
        },
        { status: 400 },
      );
    }
  }

  // Post-apply view: a metric counts as accepted-after-this-request if it's
  // being accepted now, NOT being unaccepted now, or (when neither list
  // mentions it) was already accepted — lets a single call combine
  // accept + promoteHeadline (the common "accept both, then promote" click).
  const acceptedAfter = (metricId: string): boolean => {
    if (acceptList.includes(metricId)) return true;
    if (unacceptList.includes(metricId)) return false;
    return byMetric.get(metricId)?.state === "accepted";
  };

  let epsBasis: "adj" | "gaap" | null = null;
  let epsLine: PrintWatchLine | undefined;
  let revLine: PrintWatchLine | undefined;

  if (promoteHeadline) {
    // Adj preferred over gaap (task brief) — name the basis in the response.
    if (acceptedAfter("eps_adj_q")) {
      epsBasis = "adj";
      epsLine = byMetric.get("eps_adj_q");
    } else if (acceptedAfter("eps_gaap_q")) {
      epsBasis = "gaap";
      epsLine = byMetric.get("eps_gaap_q");
    }

    const revAccepted = acceptedAfter("revenue_q");
    if (revAccepted) revLine = byMetric.get("revenue_q");

    if (!epsBasis || !revAccepted) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Promoting the headline needs a COMPLETE pair: an accepted EPS line (adjusted preferred, GAAP fallback) AND an accepted revenue_q. Promoting with only one would merge into the existing calendar_events actuals and leave the other field stale. Accept both lines, then promote.",
        },
        { status: 400 },
      );
    }
  }

  // ── Step 2: apply everything in ONE transaction ──

  let promotedActualValue: string | null = null;

  const applyTx = db.transaction(() => {
    for (const metricId of acceptList) {
      markLineAccepted(db, print.id, metricId);
    }
    for (const metricId of unacceptList) {
      clearLineAccepted(db, print.id, metricId);
    }

    if (promoteHeadline) {
      const result = saveManualActuals(db, {
        eventId,
        epsActual: epsLine!.value,
        revenueActualUsd: revLine!.value,
        force,
      });
      if (!result.ok) {
        throw new PromotionRefused(result);
      }
      promotedActualValue = result.actualValue;
    }
  });

  try {
    applyTx();
  } catch (err) {
    if (err instanceof PromotionRefused) {
      const r = err.result;
      const payload: { success: false; error: string; code?: string } = {
        success: false,
        error: r.error,
      };
      if ("code" in r) payload.code = r.code;
      return NextResponse.json(payload, { status: r.status });
    }
    throw err;
  }

  return NextResponse.json({
    success: true,
    data: {
      accepted: acceptList,
      unaccepted: unacceptList,
      promoted: promoteHeadline ? { basis: epsBasis, actualValue: promotedActualValue } : null,
    },
  });
}
