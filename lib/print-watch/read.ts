// One first-pass read, end to end (spec §4.4; Codex round 1 #9/#10/#17/#19/#29).
// The claim decides whether a model call happens; the heartbeat keeps a live
// claim fresh; the deadline aborts a hung call below the stale window; the
// finalisation is ONE immediate transaction (live token → callouts → done →
// supersede). Prose is validated against cites and sanitised BEFORE storage;
// callouts are verified against the same normalised text the evidence came
// from. Every stored or logged error passes through redactUrl, and every log
// line carries ids and an error CODE only — never prose, snippets or document
// text.
import type Database from "better-sqlite3";
import { generateObjectForFeature } from "@/lib/ai/generate";
import { getBogeysForEvent } from "@/lib/queries/earnings-bogeys";
import { compileContracts } from "./contracts";
import { redactUrl } from "./hardened-fetch";
import {
  buildFirstPassPrompt,
  buildDtoSync,
  fingerprintOf,
  validateCitedLines,
  allowedNumbersFor,
  sanitizeProseLines,
  type BuiltPrompt,
} from "./first-pass-prompt";
import {
  claimRead,
  heartbeatRead,
  finalizeReadDone,
  finalizeReadFailed,
  markReadSuperseded,
  revokeCalloutsForIneligibleDocs,
  type VerifiedCalloutInput,
} from "./read-store";
import {
  verifyCallout,
  vsBogeyText,
  evidenceSha256,
  extractGuidanceMetrics,
  sheetLineKeys,
  VERIFIER_VERSION,
} from "./callouts";
import type { CalloutProposal, ReadErrorCode, ReadProse } from "./first-pass-types";

export const READ_HEARTBEAT_EVERY_MS = 30_000;
/** Below read-store's 180 s stale-takeover window, so a hung call fails on our
 *  own terms before another worker can take the claim away from us. */
export const READ_MODEL_DEADLINE_MS = 150_000;

/** The prose shape the read is required to carry to be worth storing. */
const READ_LINES_MIN = 6;
const READ_LINES_MAX = 10;
const CALL_WATCH_LINES = 3;
const CAVEATS_MAX = 6;
const CALLOUT_PROPOSALS_MAX = 8;
const LABEL_MAX_CHARS = 80;
const VALUE_TEXT_MAX_CHARS = 40;

export interface ReadSeams {
  generate: (args: {
    system: string;
    prompt: string;
    schema: unknown;
    abortSignal: AbortSignal;
  }) => Promise<{ object: unknown; modelId: string | null }>;
  now: () => number;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

const DEFAULT_SEAMS: ReadSeams = {
  // The app's existing AI transport is the ONLY path to a model. The wrapper
  // resolves the model itself (with one reactive failover), so the id that
  // actually answered is read back off the SDK result and checked against the
  // id the fingerprint was built from (#9).
  generate: async (args) => {
    const res = await generateObjectForFeature("printWatchFirstPass", {
      system: args.system,
      prompt: args.prompt,
      schema: args.schema,
      abortSignal: args.abortSignal,
    } as never);
    const r = res as { object: unknown; response?: { modelId?: string } };
    return { object: r.object, modelId: r.response?.modelId ?? null };
  },
  now: () => Date.now(),
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
};

let seams: ReadSeams = { ...DEFAULT_SEAMS };
export function _setReadSeams(overrides: Partial<ReadSeams> | null): void {
  seams = overrides ? { ...seams, ...overrides } : { ...DEFAULT_SEAMS };
}

export type ReadRunOutcome =
  | { kind: "done"; readId: number; callouts: { verified: number; refused: number }; dropped: number }
  | {
      kind: "skipped";
      reason: "no_facts" | "already_generating" | "done_exists" | "failed_cap" | "backoff" | "drifted";
      readId: number | null;
    }
  | { kind: "failed"; readId: number; errorCode: ReadErrorCode; error: string };

/** #19: nothing derived from an exception reaches a column or a log line
 *  without passing through the URL redactor first. */
const errText = (e: unknown): string => redactUrl(e instanceof Error ? e.message : String(e));

function claimFor(db: Database.Database, printId: number, built: BuiltPrompt, regenerate?: boolean) {
  return claimRead(db, printId, {
    fingerprint: built.fingerprint,
    // #8: the claim transaction re-derives the fingerprint from the live
    // inputs. `texts` is keyed by immutable content hash, so replaying it
    // inside the transaction is sound and needs no file IO.
    recompute: () => {
      const r = buildDtoSync(db, printId, built.texts, built.dto.model_id);
      return r ? fingerprintOf(r.dto) : null;
    },
    nowMs: seams.now(),
    modelId: built.dto.model_id,
    regenerate,
  });
}

export async function runFirstPassRead(
  db: Database.Database,
  printId: number,
  opts: { regenerate?: boolean; existingClaim?: { readId: number; token: string; fingerprint: string } } = {},
): Promise<ReadRunOutcome> {
  revokeCalloutsForIneligibleDocs(db, printId, seams.now());
  let built = await buildFirstPassPrompt(db, printId);
  if (!built) {
    // A route's claim that no longer has inputs is retired, not failed.
    if (opts.existingClaim) markReadSuperseded(db, opts.existingClaim.readId, opts.existingClaim.token);
    return { kind: "skipped", reason: "no_facts", readId: null };
  }
  // Read the event id ONCE and reuse it for the bogeys and the sheet contracts.
  const eventId = (db.prepare(`SELECT event_id FROM print_watch_prints WHERE id = ?`).get(printId) as { event_id: number })
    .event_id;

  let readId: number;
  let token: string;
  if (opts.existingClaim) {
    if (built.fingerprint !== opts.existingClaim.fingerprint) {
      // #29: the inputs moved under the route's claim. Retire the row without a
      // failure — Task 7's reconcile schedules the NEW fingerprint.
      markReadSuperseded(db, opts.existingClaim.readId, opts.existingClaim.token);
      return { kind: "skipped", reason: "drifted", readId: opts.existingClaim.readId };
    }
    readId = opts.existingClaim.readId;
    token = opts.existingClaim.token;
  } else {
    let claim = claimFor(db, printId, built, opts.regenerate);
    if (claim.kind === "drifted") {
      // The inputs moved between building the DTO and asking for the claim.
      // Rebuild once and retry; a rebuild that finds no facts at all means the
      // inputs vanished — never claim on that (read-store hands back an empty
      // fingerprint for it).
      const rebuilt = await buildFirstPassPrompt(db, printId);
      if (!rebuilt) return { kind: "skipped", reason: "no_facts", readId: null };
      built = rebuilt;
      claim = claimFor(db, printId, built, opts.regenerate);
    }
    if (claim.kind === "drifted") return { kind: "skipped", reason: "drifted", readId: null };
    if (claim.kind !== "claimed") return { kind: "skipped", reason: claim.kind, readId: claim.row.id };
    readId = claim.row.id;
    token = claim.token;
  }

  // #17: a failed heartbeat must never kill a run that is otherwise fine — the
  // worst case is that the claim goes stale and someone else takes it over,
  // which the compare-and-set finalise already refuses safely.
  const beat = seams.setInterval(() => {
    try {
      heartbeatRead(db, readId, token, seams.now());
    } catch {
      /* a failed heartbeat must never kill the run */
    }
  }, READ_HEARTBEAT_EVERY_MS);
  const abort = new AbortController();
  let timedOut = false;
  // Armed BEFORE the call so an abort can fire the moment the call starts.
  const deadline = seams.setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, READ_MODEL_DEADLINE_MS);

  // #19: the ONE place a failure reaches a column, so the redaction lives here
  // and no call site can forget it. The log line never carries the message —
  // ids and the error CODE only.
  const fail = (errorCode: ReadErrorCode, rawError: string, retryable: boolean): ReadRunOutcome => {
    const error = redactUrl(rawError);
    finalizeReadFailed(db, { readId, token, error, errorCode, nowMs: seams.now(), retryable });
    console.warn(`[print-watch] first-pass read ${readId} for print ${printId} failed (${errorCode})`);
    return { kind: "failed", readId, errorCode, error };
  };

  try {
    let object: unknown;
    let modelId: string | null;
    try {
      ({ object, modelId } = await seams.generate({
        system: built.system,
        prompt: built.user,
        schema: built.schema,
        abortSignal: abort.signal,
      }));
    } catch (e) {
      return timedOut
        ? fail("timeout", "model call exceeded the deadline", true)
        : fail("model_error", `model call failed: ${errText(e)}`, true);
    }
    // Record who actually answered BEFORE judging the drift, so the row always
    // names the model whose output we are about to accept or refuse.
    if (modelId) {
      db.prepare(`UPDATE print_watch_reads SET model_id = ? WHERE id = ? AND claim_token = ?`).run(modelId, readId, token);
      if (modelId !== built.dto.model_id) {
        // #9: the fingerprint promises a model. A different one answering makes
        // this generation un-identifiable — terminal, so the reconcile re-queues
        // the NEW fingerprint rather than retrying this one.
        return fail("model_drift", `fingerprinted ${built.dto.model_id}, answered by ${modelId}`, false);
      }
    }

    const o = (object && typeof object === "object" ? object : {}) as Record<string, unknown>;

    // Callouts first: their keys ("callout:<label_norm>") are citable by the
    // prose, so they must be verified before the cited-line validation runs.
    const guidanceMetrics = extractGuidanceMetrics(
      getBogeysForEvent(db, eventId)
        .map((b) => b.guidance_notes ?? "")
        .filter(Boolean),
    );
    const lineKeys = sheetLineKeys(compileContracts(db, eventId, built.dto.symbol).contracts);
    const verified: VerifiedCalloutInput[] = [];
    let refused = 0;
    const proposals = Array.isArray(o.callouts) ? (o.callouts as unknown[]) : [];
    for (const p of proposals.slice(0, CALLOUT_PROPOSALS_MAX)) {
      const c = p as Partial<CalloutProposal>;
      if (
        typeof c.label !== "string" ||
        typeof c.value_text !== "string" ||
        typeof c.snippet !== "string" ||
        typeof c.doc_id !== "number"
      ) {
        refused++;
        continue;
      }
      // The verifier runs against slice D's NORMALISED document text — the same
      // text the evidence snippets were cut from — never the raw bytes.
      const doc = built.docTexts.get(c.doc_id);
      if (!doc) {
        refused++;
        continue;
      }
      const v = verifyCallout({ proposal: c as CalloutProposal, text: doc.text, guidanceMetrics, sheetLineKeys: lineKeys });
      if (!v.ok) {
        refused++;
        continue;
      }
      verified.push({
        label: c.label.trim().slice(0, LABEL_MAX_CHARS),
        label_norm: v.labelNorm,
        value: v.parsed.value,
        value_high: v.parsed.value_high,
        unit: v.parsed.unit,
        value_text: c.value_text.trim().slice(0, VALUE_TEXT_MAX_CHARS),
        snippet: c.snippet.trim(),
        doc_id: c.doc_id,
        doc_sha256: doc.doc_sha256,
        evidence_sha256: evidenceSha256(doc.text),
        verifier_version: VERIFIER_VERSION,
        vs_bogey_text: vsBogeyText(v.labelNorm, v.parsed, guidanceMetrics),
      });
    }

    const allowed = allowedNumbersFor(
      built.dto.facts,
      verified.map((c) => ({ key: `callout:${c.label_norm}`, value: c.value, value_high: c.value_high })),
    );
    const read = validateCitedLines(o.read, allowed, READ_LINES_MAX);
    const watch = validateCitedLines(o.call_watch, allowed, CALL_WATCH_LINES);
    const prose: ReadProse = { read: read.kept, call_watch: watch.kept, caveats: sanitizeProseLines(o.caveats, CAVEATS_MAX) };
    const dropped = read.dropped + watch.dropped;
    if (read.kept.length < READ_LINES_MIN || watch.kept.length !== CALL_WATCH_LINES) {
      return fail(
        dropped > 0 ? "cites" : "sanitisation",
        `prose failed validation: read ${read.kept.length}/${READ_LINES_MIN}+, call_watch ${watch.kept.length}/${CALL_WATCH_LINES}`,
        true,
      );
    }

    // #10: ONE transaction writes the callouts, supersedes the stale ones,
    // finalises the read and retires older generating rows.
    const fin = finalizeReadDone(db, { readId, token, facts: built.dto.facts, prose, callouts: verified, nowMs: seams.now() });
    if (!fin.ok) {
      console.warn(`[print-watch] first-pass read ${readId} for print ${printId} failed (takeover)`);
      return { kind: "failed", readId, errorCode: "takeover", error: "claim was taken over before finalisation" };
    }
    return { kind: "done", readId, callouts: { verified: verified.length, refused }, dropped };
  } finally {
    seams.clearInterval(beat);
    seams.clearTimeout(deadline);
  }
}
