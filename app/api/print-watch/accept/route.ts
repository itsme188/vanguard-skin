import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getPrintByEventId, getSheet, markLineAccepted, clearLineAccepted } from "@/lib/print-watch/store";
import { saveManualActuals } from "@/lib/earnings/actuals";
import type { SaveManualActualsResult } from "@/lib/earnings/actuals";
import type { PrintWatchLine, TaggedCandidate } from "@/lib/print-watch/types";

export const dynamic = "force-dynamic";

interface AcceptBody {
  eventId?: number;
  accept?: string[];
  unaccept?: string[];
  promoteHeadline?: boolean;
  force?: boolean;
  forceSuperseded?: boolean;
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

/**
 * Thrown INSIDE the transaction by any validation guard (fix wave, B-residual).
 *
 * The guards moved in there because each one reads DB state another process
 * can change; throwing is how a synchronous transaction says "refuse" without
 * giving up the rollback. The payload and status are exactly what the old
 * early-return produced, so no response shape changed — only when the state
 * behind it was read.
 */
class RequestRefused extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: { success: false; error: string; code?: string },
  ) {
    super(payload.error);
  }
}

// Ruling (progress.md, wave {10,11,12} dispatch note): single_source and
// flash accepts are the user overriding with their own eyes — allowed, the
// panel labels them. 'accepted' is included so re-accepting an
// already-accepted line is a harmless no-op rather than an error.
// conflict/pending are excluded on purpose — those need resolving or
// waiting, not overriding.
const ACCEPTABLE_ACCEPT_STATES = new Set(["agreed", "flash", "single_source", "blank", "accepted"]);

/**
 * Whether this line may be accepted.
 *
 * The state set above, PLUS the one 'pending' case that is not "still waiting
 * for a source": an un-accepted line. `clearLineAccepted` parks a line back on
 * 'pending' but LEAVES its verified value in place, while the reconciler never
 * produces a 'pending' line carrying a value (no value-candidate and no flash
 * → value null, every path). So `pending && value !== null` means exactly one
 * thing — this desk un-accepted the line and the watcher has not reconciled it
 * since — and refusing it made an accidental un-accept unrecoverable until the
 * next poll, which after the watch window closes never comes.
 *
 * A pending line with NO value is still refused, with the same message as
 * before: there is nothing to accept yet.
 *
 * ADMITTING that line is not the same as TRUSTING its number: the value is
 * residue from the earlier acceptance and the candidates under it have kept
 * moving, so the accept loop re-checks it against current evidence (the
 * supersession gate below) before letting it back in.
 */
function isAcceptableLine(line: PrintWatchLine): boolean {
  if (ACCEPTABLE_ACCEPT_STATES.has(line.state)) return true;
  return line.state === "pending" && line.value !== null;
}

/** Same relative tolerance the reconciler and the panel's re-verify chip use —
 *  two readings of the same printed number must agree to 1e-6. */
function valuesDiverge(accepted: number | null, fresh: number | null): boolean {
  if (accepted === null && fresh === null) return false;
  if (accepted === null || fresh === null) return true;
  const tolerance = Math.max(1e-9, Math.abs(accepted) * 1e-6);
  return Math.abs(accepted - fresh) > tolerance;
}

/**
 * Non-flash evidence on this line that disagrees with the number about to be
 * promoted — the server-side twin of the panel's "superseded — re-verify" chip
 * (fix wave, finding B).
 *
 * The panel could already SEE this (that is what the chip is), but the promote
 * path never rechecked it: a correction that landed after the line was
 * accepted — an 8-K/A, a corrected drop — left the stale EPS/revenue locked on
 * the sheet, and the promote wrote it straight into the recap scoreboard. The
 * chip is a rendering; this is the gate.
 *
 * Evidence is never removed from `candidates_json`, so a correcting candidate
 * lands ALONGSIDE the original agreeing ones — which is why this looks for any
 * single diverging candidate rather than re-running the reconciler (whose
 * strict unanimity would only ever call that pool a conflict).
 *
 * Flash candidates are excluded on purpose: a wire flash rounding differently
 * from the eventual document is expected noise, not a correction.
 */
function divergentCandidates(line: PrintWatchLine): TaggedCandidate[] {
  let candidates: TaggedCandidate[];
  try {
    const parsed: unknown = JSON.parse(line.candidates_json);
    if (!Array.isArray(parsed)) return [];
    candidates = parsed as TaggedCandidate[];
  } catch {
    return [];
  }

  return candidates.filter((c) => {
    if (c.representation === "flash") return false;
    if (c.not_disclosed || c.value === null) return false;
    return valuesDiverge(line.value, c.value) || valuesDiverge(line.value_high, c.value_high);
  });
}

/**
 * The "metric (accepted N, later evidence M)" fragment BOTH supersession gates
 * report — null when the evidence on this line still agrees with its number.
 *
 * Deliberately the single source of truth: the promote gate and the per-line
 * accept gate below must never drift into two different ideas of "newer
 * evidence disagrees", or the desk gets refused by one and waved through by
 * the other for the same sheet.
 */
function supersessionDetail(line: PrintWatchLine): string | null {
  const rivals = divergentCandidates(line);
  if (rivals.length === 0) return null;
  const values = Array.from(new Set(rivals.map((c) => String(c.value)))).slice(0, 3);
  return `${line.metric_id} (accepted ${line.value}, later evidence ${values.join(", ")})`;
}

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
  // Deliberately DISTINCT from `force` (the pre-print floor override): those
  // are two different risks and one confirm must never silently answer the
  // other. A desk that clicked through "the release time is in the future"
  // has said nothing about whether the number itself was later corrected.
  const forceSuperseded = body.forceSuperseded === true;

  // ── Validate AND apply inside ONE transaction (Codex #14, hardened by the
  //    fix wave's B-residual) ──
  //
  // Validation used to run against a snapshot read at request start, and the
  // transaction then applied decisions made from it. Every guard here is a
  // statement about DB state that ANOTHER PROCESS can change — the watcher
  // writes `candidates_json` on every reconcile, and a correction landing
  // between the snapshot and the write would be validated away: the
  // supersession recheck would pass on the clean snapshot while the row it
  // promoted already disagreed.
  //
  // better-sqlite3 transactions are SYNCHRONOUS, so a read taken inside one
  // cannot be overtaken: nothing else in this process runs until the
  // transaction ends, and `.immediate()` takes the write lock up front so no
  // other process can commit underneath it either. Reading the sheet here
  // makes the guards mean what they say.
  //
  // Refusals throw `RequestRefused`, which carries the exact status + body the
  // early returns used to produce — and better-sqlite3 rolls the transaction
  // back on the way out, so a refusal still writes nothing.

  let epsBasis: "adj" | "gaap" | null = null;
  let promotedActualValue: string | null = null;

  const applyTx = db.transaction(() => {
    const sheet = getSheet(db, print.id);
    const byMetric = new Map<string, PrintWatchLine>(sheet.map((l) => [l.metric_id, l]));

    for (const metricId of acceptList) {
      const line = byMetric.get(metricId);
      if (!line) {
        throw new RequestRefused(400, {
          success: false,
          error: `Unknown metric "${metricId}" — no line on this print's sheet.`,
        });
      }
      if (!isAcceptableLine(line)) {
        throw new RequestRefused(400, {
          success: false,
          error: `Cannot accept "${metricId}": its state is "${line.state}" — resolve the conflict, or wait for a source, before accepting.`,
        });
      }

      // RULE (Codex HIGH, per-line accept): an un-accepted line — the only
      // 'pending' line that can carry a number — is re-accepted ONLY if the
      // evidence now on the sheet still agrees with that number.
      //
      // The number on such a line is RESIDUE: `clearLineAccepted` flips state
      // and leaves `value` alone, while the reconciler kept refreshing
      // `candidates_json` underneath the accepted lock the whole time
      // (reconcile.ts rule 6). So a correction that landed while the line was
      // accepted — an 8-K/A, a corrected drop — leaves exactly the shape this
      // gate refuses: state 'pending', value stale, candidates newer. Without
      // it, un-accept then re-accept was a laundering path back to a number
      // the promote gate would have refused outright.
      //
      // Same comparison as the promote gate (`supersessionDetail`), same 409
      // `superseded` envelope, same `forceSuperseded` override. Lines whose
      // parsers agree (value == candidates) pass trivially: no rival, no
      // fragment. Every OTHER acceptable state is untouched — 'agreed',
      // 'flash', 'single_source' and 'blank' are the reconciler's own current
      // reading of the candidate pool, not residue, and re-accepting an
      // already-'accepted' line stays the harmless no-op it was.
      if (!forceSuperseded && line.state === "pending" && line.value !== null) {
        const detail = supersessionDetail(line);
        if (detail) {
          throw new RequestRefused(409, {
            success: false,
            code: "superseded",
            error: `Newer evidence disagrees with the un-accepted number on ${detail}. That figure is left over from the earlier acceptance — the sheet has taken in evidence contradicting it since. Let the line reconcile and accept the corrected figure, or send forceSuperseded to accept the value as it stands.`,
          });
        }
      }
    }

    for (const metricId of unacceptList) {
      if (!byMetric.has(metricId)) {
        throw new RequestRefused(400, {
          success: false,
          error: `Unknown metric "${metricId}" — no line on this print's sheet.`,
        });
      }
      if (acceptList.includes(metricId)) {
        throw new RequestRefused(400, {
          success: false,
          error: `Cannot both accept and unaccept "${metricId}" in the same request.`,
        });
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
        throw new RequestRefused(400, {
          success: false,
          error:
            "Promoting the headline needs a COMPLETE pair: an accepted EPS line (adjusted preferred, GAAP fallback) AND an accepted revenue_q. Promoting with only one would merge into the existing calendar_events actuals and leave the other field stale. Accept both lines, then promote.",
        });
      }

      // Accepted-ness is not the same as having a NUMBER (final fix wave). A
      // `blank` line ("not disclosed") is acceptable on purpose — the desk
      // confirming a metric wasn't given is real information — but it carries
      // value = null, and promoting it hands saveManualActuals an epsActual of
      // null. mergeFinnhubActual then merges a half-pair into the existing
      // calendar_events actuals and leaves the other field stale: EXACTLY the
      // failure the complete-pair rule above exists to prevent, arriving through
      // the door that rule doesn't watch. Same 400, same explanation.
      if (epsLine!.value === null || revLine!.value === null) {
        const missing = [
          epsLine!.value === null ? `${epsLine!.metric_id} (${epsLine!.state})` : null,
          revLine!.value === null ? `revenue_q (${revLine!.state})` : null,
        ]
          .filter(Boolean)
          .join(" and ");
        throw new RequestRefused(400, {
          success: false,
          error: `Promoting the headline needs a REPORTED value on both lines — ${missing} has no number. Promoting a blank would merge into the existing calendar_events actuals and leave the other field stale. Wait for the figure, or drop the release, before promoting.`,
        });
      }

      // Supersession recheck (fix wave, finding B) — LAST, against the same
      // in-transaction read as every other guard.
      if (!forceSuperseded) {
        const superseded: string[] = [];
        for (const line of [epsLine!, revLine!]) {
          const detail = supersessionDetail(line);
          if (detail) superseded.push(detail);
        }
        if (superseded.length > 0) {
          throw new RequestRefused(409, {
            success: false,
            code: "superseded",
            error: `Newer evidence disagrees with the accepted number on ${superseded.join(" and ")}. Re-verify against the release before promoting — un-accept the line, let it reconcile, and accept the corrected figure, or send forceSuperseded to promote the accepted value as it stands.`,
          });
        }
      }
    }

    // ── every guard has passed against state nothing can have changed: write ──

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
    // `.immediate()` — BEGIN IMMEDIATE, so the write lock is held from the
    // first read rather than upgraded halfway through.
    applyTx.immediate();
  } catch (err) {
    if (err instanceof RequestRefused) {
      return NextResponse.json(err.payload, { status: err.status });
    }
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
