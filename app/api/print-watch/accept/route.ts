import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  getPrintByEventId,
  getSheet,
  listDocuments,
  markLineAccepted,
  acceptLineCandidate,
  clearLineAccepted,
} from "@/lib/print-watch/store";
import { saveManualActuals } from "@/lib/earnings/actuals";
import type { SaveManualActualsResult } from "@/lib/earnings/actuals";
import type { PrintWatchLine, TaggedCandidate } from "@/lib/print-watch/types";
import { scheduleFirstPassRead } from "@/lib/print-watch/read-scheduler";
import { isRetiredMetricId } from "@/lib/print-watch/recompile";

export const dynamic = "force-dynamic";

/**
 * One entry of the `accept` array.
 *
 * A bare metric id is the original whole-line accept ("lock in whatever the
 * reconciler currently reads on this line"). The object form is the
 * PER-CANDIDATE accept (QA finding `…unaccept-after-supersede…`, user ruling
 * 2026-09-02): a conflict line has no top-level number by construction, so the
 * only honest way to accept one is to name the DOCUMENT whose figure the desk
 * verified. `representation` is optional and only needed to disambiguate two
 * readings of the SAME document that disagree.
 */
type AcceptEntry = string | { metric_id: string; doc_id: number; representation?: string };

interface AcceptBody {
  eventId?: number;
  accept?: AcceptEntry[];
  unaccept?: string[];
  promoteHeadline?: boolean;
  force?: boolean;
  forceSuperseded?: boolean;
}

/** A parsed, shape-validated `accept` entry. `docId === null` = whole-line. */
interface AcceptRequestItem {
  metricId: string;
  docId: number | null;
  representation: string | null;
}

/** The candidate a per-candidate accept resolved to, once validated. */
interface ResolvedCandidate {
  value: number | null;
  value_high: number | null;
  snippet: string | null;
  source_doc_id: number;
}

const REPRESENTATIONS = new Set(["repA", "repB", "flash"]);

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

/**
 * A retired line is a RECORD, not a live figure — refuse every per-line
 * mutation on it (R-F28, whole-branch review I1).
 *
 * `recompileContracts` retires a line by RENAMING it to
 * `<metric_id>~retired~<n>` and setting `state = 'retired'`: the reading is
 * kept verbatim under the definition it was actually measured against, and a
 * fresh line takes the base id. Turning that record back into an accepted
 * figure would publish a number nothing on the sheet still measures.
 *
 * WHY THE ID AND NOT `state`. `state` is not stable under the very mutation
 * this guards: the first accept flips it to 'accepted', after which a
 * state-based test waves through every later request AND — because only
 * `recompile.ts` keys on the retired marker while the panel keys on `state` —
 * the row renders as a normal full-opacity verified line forever, since
 * recompile never re-examines a retired key. The id is immutable and is the
 * row's real identity, so it is what the gate reads.
 *
 * Thrown as `RequestRefused` from inside the transaction, alongside every
 * other guard, so a refusal rolls back and writes nothing.
 *
 * The promote path needs no equivalent: it selects the hardcoded `eps_adj_q` /
 * `eps_gaap_q` / `revenue_q` ids, which a retired row can no longer carry.
 */
const RETIRED_LINE_ERROR =
  "This line was retired when its definition changed — it is a record of what was measured and cannot be accepted.";

function refuseIfRetired(metricId: string): void {
  if (!isRetiredMetricId(metricId)) return;
  throw new RequestRefused(409, { success: false, error: RETIRED_LINE_ERROR });
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
 * for a source": an un-accepted line that still carries a number. The
 * reconciler never produces a 'pending' line with a value (no value-candidate
 * and no flash → value null, every path), so `pending && value !== null` can
 * only be an un-accept — and refusing it made an accidental un-accept
 * unrecoverable until the next poll, which after the watch window closes never
 * comes.
 *
 * Since the QA fix `…unaccept-after-supersede…`, `clearLineAccepted`
 * RE-DERIVES the line, so it only leaves this shape behind for a line with NO
 * candidate evidence to re-derive from (plus rows parked this way before that
 * fix shipped). A pending line with NO value is still refused, with the same
 * message as before: there is nothing to accept yet.
 *
 * ADMITTING that line is not the same as TRUSTING its number: the value is
 * residue from the earlier acceptance and the candidates under it may have
 * kept moving, so the accept loop re-checks it against current evidence (the
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
 *
 * Document-order aware (defect fix): a PER-CANDIDATE accept
 * (`acceptLineCandidate`) sets `line.source_doc_id` to the chosen document
 * and deliberately keeps the rejected rival sitting in `candidates_json` — so
 * without an ordering check, the very next plain `{promoteHeadline: true}`
 * request (the panel's Promote button, no `accept` array) ran this gate and
 * 409'd on the older rival the desk had already out-verified by picking the
 * newer document. Once `source_doc_id` is a number, a candidate from that
 * document or an earlier one (`doc_id <= source_doc_id`) is never "later
 * evidence" — only a STRICTLY LATER document counts, same rule as
 * `candidateSupersessionDetail` below. A whole-line accept never sets
 * `source_doc_id` to a candidate-chosen document this way, so this only
 * narrows the per-candidate case.
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
    if (typeof line.source_doc_id === "number" && c.doc_id <= line.source_doc_id) return false;
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

// ── per-candidate accept ───────────────────────────────────────────────
//
// Why it exists (QA finding `…unaccept-after-supersede…`, user ruling
// 2026-09-02): un-accepting a superseded line now re-derives it, and a
// disagreeing pool re-derives to 'conflict' — a state that carries NO
// top-level number and that the whole-line accept refuses on purpose. Without
// a way to say "this figure, from this document", the desk's only remaining
// move on a corrected print would be to force the stale number back on.

/** Shape-validates `body.accept` without touching the DB. Returns a message
 *  instead of items when an entry is malformed (400 before any read). */
function parseAcceptEntries(entries: AcceptEntry[]): { items: AcceptRequestItem[] } | { error: string } {
  const items: AcceptRequestItem[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      items.push({ metricId: entry, docId: null, representation: null });
      continue;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return {
        error:
          "Each 'accept' entry must be a metric id, or an object { metric_id, doc_id } naming the candidate to lock in.",
      };
    }
    const record = entry as Record<string, unknown>;
    const metricId = record.metric_id;
    const docId = record.doc_id;
    const representation = record.representation;
    if (typeof metricId !== "string" || metricId.length === 0) {
      return { error: "Each 'accept' object entry needs a 'metric_id' string." };
    }
    if (typeof docId !== "number" || !Number.isInteger(docId)) {
      return {
        error: `Accept entry for "${metricId}" needs an integer 'doc_id' naming the document whose figure you verified.`,
      };
    }
    if (representation !== undefined && representation !== null) {
      if (typeof representation !== "string" || !REPRESENTATIONS.has(representation)) {
        return {
          error: `Accept entry for "${metricId}" has an unknown 'representation' — expected repA, repB or flash.`,
        };
      }
    }
    items.push({
      metricId,
      docId,
      representation: typeof representation === "string" ? representation : null,
    });
  }
  return { items };
}

function parseCandidates(line: PrintWatchLine): TaggedCandidate[] {
  try {
    const parsed: unknown = JSON.parse(line.candidates_json);
    return Array.isArray(parsed) ? (parsed as TaggedCandidate[]) : [];
  } catch {
    return [];
  }
}

/**
 * Resolves ONE per-candidate accept against the line's evidence, or throws the
 * refusal. Every failure is a 400 that names what the desk asked for and what
 * the sheet actually holds — never a silent fallback to another figure.
 */
function resolveCandidate(
  line: PrintWatchLine,
  item: AcceptRequestItem,
  documentIds: Set<number>,
): ResolvedCandidate {
  const docId = item.docId as number;
  const pool = parseCandidates(line).filter((c) => c.metric_id === line.metric_id);
  const named = pool.filter(
    (c) => c.doc_id === docId && (item.representation === null || c.representation === item.representation),
  );

  if (named.length > 0 && named.every((c) => c.representation === "flash")) {
    throw new RequestRefused(400, {
      success: false,
      error: `Cannot accept the wire flash for "${line.metric_id}": a flash has no document of record. Accept a document candidate, or accept the line itself if the flash is all there is.`,
    });
  }

  const usable = named.filter((c) => c.representation !== "flash");
  if (usable.length === 0) {
    const available = Array.from(new Set(pool.filter((c) => c.representation !== "flash").map((c) => c.doc_id)));
    throw new RequestRefused(400, {
      success: false,
      error: `No candidate from doc #${docId} on "${line.metric_id}"${
        available.length > 0 ? ` — this line's evidence came from doc ${available.map((d) => `#${d}`).join(", ")}.` : " — this line has no document evidence yet."
      }`,
    });
  }

  const withNumbers = usable.filter((c) => !c.not_disclosed && c.value !== null);
  if (withNumbers.length === 0) {
    throw new RequestRefused(400, {
      success: false,
      error: `Doc #${docId} reported "${line.metric_id}" as not disclosed — there is no number on it to lock in.`,
    });
  }

  // Two readings of the same document that disagree: the desk has to say which
  // one it read. Picking one here would be the system guessing at a figure it
  // is about to call verified.
  const first = withNumbers[0];
  const disagreeing = withNumbers.find(
    (c) => valuesDiverge(first.value, c.value) || valuesDiverge(first.value_high, c.value_high),
  );
  if (disagreeing) {
    const values = Array.from(new Set(withNumbers.map((c) => String(c.value)))).join(", ");
    throw new RequestRefused(400, {
      success: false,
      error: `Doc #${docId} has two readings of "${line.metric_id}" that disagree (${values}). Name the 'representation' (repA / repB) you verified.`,
    });
  }

  // A doc id that names no document row would be a foreign-key error on write.
  if (!documentIds.has(docId)) {
    throw new RequestRefused(400, {
      success: false,
      error: `Doc #${docId} is not a document of this print.`,
    });
  }

  return {
    value: first.value,
    value_high: first.value_high,
    snippet: first.snippet,
    source_doc_id: docId,
  };
}

/**
 * The per-candidate twin of `supersessionDetail` — null unless a document that
 * arrived AFTER the one being accepted disagrees with it.
 *
 * Deliberately narrower than the line-level gate, and this is the whole point
 * of the ruling: accepting the SUPERSEDING document IS the re-verify, so it
 * must not be refused for disagreeing with the document it supersedes. Only
 * reaching backwards — locking in an older figure while a later document says
 * otherwise — is a supersession the desk has to confirm.
 *
 * Doc ids are AUTOINCREMENT, so a higher id is a later-arriving document.
 */
function candidateSupersessionDetail(
  line: PrintWatchLine,
  chosen: ResolvedCandidate,
): string | null {
  const later = parseCandidates(line).filter((c) => {
    if (c.metric_id !== line.metric_id) return false;
    if (c.representation === "flash") return false;
    if (c.not_disclosed || c.value === null) return false;
    if (c.doc_id <= chosen.source_doc_id) return false;
    return valuesDiverge(chosen.value, c.value) || valuesDiverge(chosen.value_high, c.value_high);
  });
  if (later.length === 0) return null;
  const values = Array.from(new Set(later.map((c) => String(c.value)))).slice(0, 3);
  return `${line.metric_id} (doc #${chosen.source_doc_id} reads ${chosen.value}, later evidence ${values.join(", ")})`;
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

  const parsedAccept = parseAcceptEntries(body.accept ?? []);
  if ("error" in parsedAccept) {
    return NextResponse.json({ success: false, error: parsedAccept.error }, { status: 400 });
  }

  const print = getPrintByEventId(db, eventId);
  if (!print) {
    return NextResponse.json(
      { success: false, error: `No print-watch record for event ${eventId}.` },
      { status: 404 },
    );
  }

  const acceptItems = parsedAccept.items;
  // The metric ids being accepted — the response envelope, the both-lists
  // check and the promote view all speak metric ids, whether the desk named a
  // candidate or the whole line.
  const acceptList = acceptItems.map((i) => i.metricId);
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
    /** metric → the candidate a per-candidate accept resolved to, so the write
     *  phase and the promote view read the figure the desk actually picked
     *  rather than whatever the line still carried. */
    const resolved = new Map<string, ResolvedCandidate>();
    let documentIds: Set<number> | null = null;

    for (const item of acceptItems) {
      const metricId = item.metricId;
      const line = byMetric.get(metricId);
      if (!line) {
        throw new RequestRefused(400, {
          success: false,
          error: `Unknown metric "${metricId}" — no line on this print's sheet.`,
        });
      }

      // BEFORE the per-candidate branch, so it covers BOTH shapes of accept.
      refuseIfRetired(metricId);

      // ── per-candidate accept ──
      //
      // The line-state gate is deliberately SKIPPED here: naming a document is
      // how a 'conflict' line gets resolved, and refusing it would leave the
      // desk with no move but forcing the stale number back. What replaces the
      // gate is stricter in the way that matters — the figure has to exist, in
      // that document, unambiguously (`resolveCandidate`), and it may not be
      // an older reading that a later document contradicts (the 409 below).
      if (item.docId !== null) {
        if (documentIds === null) {
          documentIds = new Set(listDocuments(db, print.id).map((d) => d.id));
        }
        const chosen = resolveCandidate(line, item, documentIds);
        if (!forceSuperseded) {
          const detail = candidateSupersessionDetail(line, chosen);
          if (detail) {
            throw new RequestRefused(409, {
              success: false,
              code: "superseded",
              error: `A later document disagrees with the figure you picked on ${detail}. Accept the later document's candidate instead, or send forceSuperseded to lock in the one you chose.`,
            });
          }
        }
        resolved.set(metricId, chosen);
        continue;
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
      // The number on such a line is RESIDUE: an un-accept left `value` in
      // place while the reconciler kept refreshing `candidates_json` underneath
      // the accepted lock (reconcile.ts rule 6). Without this gate, un-accept
      // then re-accept was a laundering path back to a number the promote gate
      // would have refused outright.
      //
      // `clearLineAccepted` now re-derives instead of parking a stale figure,
      // so new rows reach this shape only with an EMPTY candidate pool (no
      // rivals, gate passes trivially). It still holds the line for rows parked
      // before that fix shipped — the laundering path has to stay closed for
      // them too.
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
      // Un-accept never passes through the accept loop above, so it needs its
      // own check: `clearLineAccepted` would otherwise re-derive a retired row
      // off a candidate pool measured under the retired definition.
      //
      // ORDER IS LOAD-BEARING — this must stay BELOW the unknown-metric check
      // (review M3). `unacceptList` is a cast (`body.unaccept as string[]`),
      // not an element-checked parse, so a non-string element would reach
      // `String.prototype.includes` inside `isRetiredMetricId` and surface as a
      // 500. It cannot today only because `byMetric.has()` above misses on any
      // non-string and refuses it as a 400 first. Reordering these two opens
      // that 500.
      refuseIfRetired(metricId);
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

    /** The number this request LEAVES on the line: a per-candidate accept
     *  replaces the line's figure in the same transaction, so the promote
     *  guards below (and the write itself) have to read the chosen candidate,
     *  not the pre-request value they would otherwise still see. */
    const effective = (line: PrintWatchLine): { value: number | null; value_high: number | null } => {
      const pick = resolved.get(line.metric_id);
      return pick ? { value: pick.value, value_high: pick.value_high } : { value: line.value, value_high: line.value_high };
    };

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
      if (effective(epsLine!).value === null || effective(revLine!).value === null) {
        const missing = [
          effective(epsLine!).value === null ? `${epsLine!.metric_id} (${epsLine!.state})` : null,
          effective(revLine!).value === null ? `revenue_q (${revLine!.state})` : null,
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
      //
      // A metric the desk just resolved by NAMING a candidate is skipped here
      // and only here: it has already passed the stricter, correct test for
      // that case (`candidateSupersessionDetail` — is there a LATER document
      // that disagrees?). The line-level test would refuse it for disagreeing
      // with the document it supersedes, i.e. refuse the corrected figure for
      // being a correction.
      if (!forceSuperseded) {
        const superseded: string[] = [];
        for (const line of [epsLine!, revLine!]) {
          if (resolved.has(line.metric_id)) continue;
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

    for (const item of acceptItems) {
      const chosen = resolved.get(item.metricId);
      if (item.docId !== null && chosen) {
        acceptLineCandidate(db, print.id, item.metricId, chosen);
      } else {
        markLineAccepted(db, print.id, item.metricId);
      }
    }
    for (const metricId of unacceptList) {
      clearLineAccepted(db, print.id, metricId);
    }

    if (promoteHeadline) {
      const result = saveManualActuals(db, {
        eventId,
        epsActual: effective(epsLine!).value,
        revenueActualUsd: effective(revLine!).value,
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

  // R-D21: the desk's accept is what makes a fact ACCEPTED, and the read's
  // facts are accepted-only — so the parse-time hook always skipped a fresh
  // print on `no_facts` and nothing else ever armed the first read. Every
  // successful POST re-arms the 5 s debounce, un-accepts included (they change
  // the fact set too); the debounce coalesces a burst into one run and the
  // runner skips on `no_facts` when the sheet ends up empty. Post-commit, never
  // inside the transaction.
  scheduleFirstPassRead(db, print.id);

  return NextResponse.json({
    success: true,
    data: {
      accepted: acceptList,
      unaccepted: unacceptList,
      promoted: promoteHeadline ? { basis: epsBasis, actualValue: promotedActualValue } : null,
    },
  });
}
