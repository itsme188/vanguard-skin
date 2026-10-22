/**
 * The filing summary runner (spec §2, §3, §5, §7, §8, §11; Hardening 3, 4, 6,
 * 12; R10, R12, R13, R17): turns stored SEC filings into paid model calls.
 *
 * A run is one model choice over a frozen, ordered list of filings; each
 * filing is a section. One `runNextSection` call:
 *   claim (CAS token, attempts++) → the attempt cap and cancellation checks,
 *   with no call → read the stored documents and build the coverage list →
 *   the prompt (earlier done sections of the same run as context) → heartbeat
 *   → ONE call on the run's pinned model at the run's pinned effort →
 *   validate → evaluate → finalize with compare-and-set.
 *
 * Bounds: at most two attempts per section (the store counts claims; the cap
 * is checked here after each claim); refusal, truncation and a lost model are
 * never retried; the SDK's own retries are off in `generateObjectWithModel`,
 * so every request counts. A worker whose claim was taken over writes
 * nothing (`lost_claim`).
 *
 * Logging carries ids, error classes and counts only: never document text,
 * prompt text, error bodies or model output.
 */
import { randomUUID } from "node:crypto";
import { sendSummaryPushIfDue } from "./push";
import type Database from "better-sqlite3";
import { jsonSchema } from "ai";
import { getCachedModelCatalog } from "@/lib/ai/catalog-source";
import {
  AIModelUnavailableError,
  AIRefusalError,
  AITruncatedError,
  generateObjectWithModel,
} from "@/lib/ai/generate";
import { modelLabel, resolveFamilyModel } from "@/lib/ai/model-families";
import { buildBogeySnapshot } from "./bogey-snapshot";
import { blockText, extractDocText, EXTRACTOR_VERSION } from "./doc-text";
import { CHECKER_VERSION, evaluateSection } from "./evaluate";
import { readFilingDocument } from "./files";
import { easternClock } from "./poller";
import { buildSectionPrompt, PROMPT_VERSION } from "./prompt";
import { parseSectionOutput, SCHEMA_VERSION, SECTION_JSON_SCHEMA } from "./schema";
import {
  appendSection,
  claimNextSection,
  createRun,
  finalizeSection,
  getChoice,
  getEventState,
  heartbeatSection,
  listDocuments,
  listFilings,
  listRuns,
  listSections,
  requeueSection,
  type FilingRow,
  type RunRow,
  type SectionErrorClass,
  type SectionResult,
  type SectionRow,
} from "./store";
import type {
  BogeySnapshotFigure,
  CheckedClaim,
  CheckedSection,
  CoverageEntry,
  DocText,
  SummaryChoice,
} from "./types";

// ---------------------------------------------------------------- constants

/** Per-call input cap: characters of extracted text (≈400k tokens). */
export const INPUT_CAP_CHARS = 1_600_000;
export const OVER_INPUT_CAP = "over the input cap";
export const MAX_SECTION_ATTEMPTS = 2;
/**
 * Output cap per section call. Thinking tokens count against it, so it has to
 * hold the typed-figure JSON AND the model's reasoning: 32k truncated on a real
 * earnings 8-K at Opus high effort (2026-10-22 replay).
 */
export const SECTION_MAX_OUTPUT_TOKENS = 64_000;
/**
 * Wall-clock cap per section call (10 minutes). Longer than the store's
 * 5-minute stale window on purpose: the heartbeat below refreshes the claim
 * every minute while the call is open, so a live call is never taken over;
 * only a worker that died stops beating and goes stale.
 */
export const SECTION_CALL_TIMEOUT_MS = 600_000;
/** Kept well under the store's 5-minute stale window while a call is open. */
const HEARTBEAT_EVERY_MS = 60_000;
export const MODEL_GONE_TEXT = "model no longer available — re-run";
export const WAITS_FOR_RETRY_TEXT = "added after the run failed — runs on Retry";
const FILING_REJECTED_TEXT = "filing no longer matches the print";
const RUN_MISSING_TEXT = "run no longer exists";
const NOTHING_READ_TEXT = "no document of the filing could be read";

// ---------------------------------------------------------------- seams

export interface RunnerSeams {
  generate: typeof generateObjectWithModel;
  readDocument(path: string): string | null;
  now(): number;
  token(): string;
  onSectionDone(db: Database.Database, sectionId: number): Promise<void>;
}

/**
 * What happens after a section is finalized as done: the at-most-once push.
 * A push problem never fails the section; only ids and the reason are logged.
 */
async function defaultOnSectionDone(db: Database.Database, sectionId: number): Promise<void> {
  try {
    await sendSummaryPushIfDue(db, sectionId);
  } catch (err) {
    console.warn(
      `[filing-summary] push skipped for section ${sectionId}: ${err instanceof Error ? err.name : "error"}`,
    );
  }
}

export function defaultRunnerSeams(): RunnerSeams {
  return {
    generate: generateObjectWithModel,
    readDocument: readFilingDocument,
    now: () => Date.now(),
    token: () => randomUUID(),
    onSectionDone: defaultOnSectionDone,
  };
}

// ---------------------------------------------------------------- helpers

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function eventRow(
  db: Database.Database,
  eventId: number,
): { symbol: string | null; eventDate: string } | null {
  const r = db
    .prepare("SELECT symbol, event_date FROM calendar_events WHERE id = ?")
    .get(eventId) as { symbol: string | null; event_date: string } | undefined;
  return r ? { symbol: r.symbol, eventDate: r.event_date } : null;
}

/** The issuer's public name, when the securities table has it. */
function companyName(db: Database.Database, symbol: string): string | null {
  const r = db
    .prepare("SELECT name FROM securities WHERE UPPER(symbol) = UPPER(?) LIMIT 1")
    .get(symbol) as { name: string | null } | undefined;
  return r?.name ?? null;
}

/**
 * The frozen filing list: the accepted earnings filing, then accepted
 * companions by discovery order. An owner click (`manual_run`, `rerun`) may
 * also read an earnings filing whose time could not be confirmed when no
 * accepted one exists (controller ruling, Task 13 round 2); an automatic run
 * never does.
 */
function runFilingIds(filings: FilingRow[], trigger: "auto" | "rerun" | "manual_run"): number[] {
  const earnings =
    filings.find((f) => f.role === "earnings" && f.identityVerdict === "accepted") ??
    (trigger === "auto"
      ? undefined
      : filings.find((f) => f.role === "earnings" && f.identityVerdict === "time_unconfirmed"));
  if (!earnings) return [];
  const companions = filings
    .filter((f) => f.role === "companion" && f.identityVerdict === "accepted")
    .sort((a, b) => a.discoverySeq - b.discoverySeq);
  return [earnings.id, ...companions.map((f) => f.id)];
}

/** "2026-10-22 16:05" Eastern, from the stored acceptance instant. */
function acceptedAtEt(f: FilingRow): string {
  const ms = f.acceptedAt ? Date.parse(f.acceptedAt) : NaN;
  if (Number.isNaN(ms)) return "time unconfirmed";
  const { date, time } = easternClock(ms);
  return `${date} ${time.slice(0, 5)}`;
}

/** Claim ids are namespaced per section (`s<seq>.<id>`) so a correction names the right claim. */
function namespaceClaims(checked: CheckedSection, seq: number): CheckedSection {
  return {
    ...checked,
    claims: checked.claims.map((c) => ({ ...c, claimId: `s${seq}.${c.claimId}` })),
  };
}

function readUsage(usage: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!usage || typeof usage !== "object") return out;
  const u = usage as Record<string, unknown>;
  for (const k of ["inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens"]) {
    if (typeof u[k] === "number" && Number.isFinite(u[k])) out[k] = u[k] as number;
  }
  return out;
}

/** A failure class for a thrown call error. Never reads the error's text. */
function errorClassOf(err: unknown): SectionErrorClass {
  if (err instanceof AIRefusalError) return "refusal";
  if (err instanceof AITruncatedError) return "truncated";
  if (err instanceof AIModelUnavailableError) return "model_unavailable";
  const isTimeout = (e: unknown): boolean =>
    e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
  if (isTimeout(err) || (err instanceof Error && isTimeout(err.cause))) return "timeout";
  return "model_error";
}

const NEVER_RETRIED: ReadonlySet<SectionErrorClass> = new Set([
  "refusal",
  "truncated",
  "model_unavailable",
]);

function failedResult(
  run: RunRow | null,
  errorClass: SectionErrorClass,
  errorText: string | null,
  extra: Partial<SectionResult> = {},
): SectionResult {
  return {
    status: "failed",
    modelId: run?.modelId ?? null,
    effort: run?.effort ?? null,
    inputFingerprint: null,
    outputJson: null,
    checkedJson: null,
    coverageJson: null,
    incomplete: false,
    countsJson: null,
    usageJson: null,
    versionsJson: null,
    errorClass,
    errorText,
    ...extra,
  };
}

function warn(msg: string): void {
  console.warn(`[filing-summary] ${msg}`);
}

// ---------------------------------------------------------------- starting runs

export type StartRunResult =
  | { ok: true; runId: number; created: boolean }
  | { ok: false; reason: "no_filings" | "no_model" | "not_found" | "request_key_conflict" };

/**
 * Creates a run (or returns the run an earlier call with the same request key
 * created). The family resolves once, here (R12/R17); a down-ladder fallback
 * is recorded as `fallback_note`. The bogey snapshot and the filing list are
 * frozen into the run. Nothing is created when there is no accepted earnings
 * filing or no callable model.
 */
export function startRun(
  db: Database.Database,
  eventId: number,
  trigger: "auto" | "rerun" | "manual_run",
  opts: { choice?: SummaryChoice; requestKey?: string | null; catalogIds?: string[] } = {},
): StartRunResult {
  // One immediate transaction: the key lookup, the frozen inputs and the
  // insert are atomic (createRun nests as a savepoint).
  return db.transaction((): StartRunResult => startRunTx(db, eventId, trigger, opts)).immediate();
}

function startRunTx(
  db: Database.Database,
  eventId: number,
  trigger: "auto" | "rerun" | "manual_run",
  opts: { choice?: SummaryChoice; requestKey?: string | null; catalogIds?: string[] },
): StartRunResult {
  if (!eventRow(db, eventId)) return { ok: false, reason: "not_found" };
  const requestKey = opts.requestKey ?? null;

  if (requestKey !== null) {
    const existing = db
      .prepare("SELECT id, event_id FROM filing_summary_runs WHERE request_key = ?")
      .get(requestKey) as { id: number; event_id: number } | undefined;
    if (existing) {
      if (existing.event_id !== eventId) return { ok: false, reason: "request_key_conflict" };
      return { ok: true, runId: existing.id, created: false };
    }
  }

  const filingIds = runFilingIds(listFilings(db, eventId), trigger);
  if (filingIds.length === 0) return { ok: false, reason: "no_filings" };

  const choice = opts.choice ?? getChoice(db, eventId).choice;
  const resolved = resolveFamilyModel(choice.family, opts.catalogIds ?? getCachedModelCatalog());
  if (!resolved) return { ok: false, reason: "no_model" };
  const fallbackNote = resolved.fellBackFrom
    ? `${capitalise(resolved.fellBackFrom)} unavailable — ${modelLabel(resolved.modelId)} ran instead`
    : null;

  const bogeys = buildBogeySnapshot(db, eventId);
  const res = createRun(db, {
    eventId,
    trigger,
    choice,
    modelId: resolved.modelId,
    fallbackNote,
    requestKey,
    bogeySnapshotJson: JSON.stringify(bogeys),
    filingIds,
  });
  return { ok: true, runId: res.runId, created: res.created };
}

/**
 * R13: a companion found after a run started goes to the newest run that is
 * running or done; if the newest failed, to the newest done run; with none
 * done, to the newest failed run, where it waits for Retry (stored failed /
 * `awaiting_retry`, so nothing runs it before the click). Returns
 * the new section id, or null (no run yet, not the event's accepted filing,
 * or the run already has it).
 */
export function appendCompanion(
  db: Database.Database,
  eventId: number,
  filingId: number,
): number | null {
  const filing = listFilings(db, eventId).find((f) => f.id === filingId);
  if (!filing || filing.identityVerdict !== "accepted") return null;
  const runs = listRuns(db, eventId);
  const newest = runs[runs.length - 1];
  if (!newest) return null;
  let dest: RunRow = newest;
  let waitsForRetry = false;
  if (newest.status === "failed") {
    const done = [...runs].reverse().find((r) => r.status === "done");
    if (done) dest = done;
    else waitsForRetry = true;
  }
  return db.transaction(() => {
    const sectionId = appendSection(db, dest.id, filingId);
    if (sectionId === null || !waitsForRetry) return sectionId;
    db.prepare(
      `UPDATE filing_summary_sections
          SET status = 'failed', error_class = 'awaiting_retry', error_text = ?,
              finished_at = datetime('now')
        WHERE id = ?`,
    ).run(WAITS_FOR_RETRY_TEXT, sectionId);
    db.prepare(
      `UPDATE filing_summary_runs
          SET status = 'failed', finished_at = COALESCE(finished_at, datetime('now'))
        WHERE id = ?`,
    ).run(dest.id);
    return sectionId;
  })();
}

/**
 * Poller callback: an accepted earnings filing starts the automatic run, once
 * per filing. The deterministic key `auto:<eventId>:<filingId>` makes a
 * repeat (a re-arm, a second poll) return the existing run, while a NEW
 * accepted earnings filing (an earlier one was rejected) gets its own run.
 */
export function autoRunKey(eventId: number, filingId: number): string {
  return `auto:${eventId}:${filingId}`;
}

export function onEarningsAccepted(db: Database.Database, eventId: number): void {
  const state = getEventState(db, eventId)?.pollState;
  if (state === "manual_only" || state === "cancelled") return;
  const earnings = listFilings(db, eventId).find(
    (f) => f.role === "earnings" && f.identityVerdict === "accepted",
  );
  if (!earnings) return;
  const res = startRun(db, eventId, "auto", { requestKey: autoRunKey(eventId, earnings.id) });
  if (!res.ok) warn(`auto run for event ${eventId} not started: ${res.reason}`);
}

/** Poller callback: an accepted companion joins the right run (R13). */
export function onCompanionAccepted(db: Database.Database, eventId: number, filingId: number): void {
  appendCompanion(db, eventId, filingId);
}

export type RetryRunResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "event_cancelled" | "nothing_to_retry" };

/**
 * Retry on an explicit click: every failed section of the run (refusal,
 * truncation and `awaiting_retry` included) goes back to pending with its
 * attempts reset. A `model_unavailable` section is left alone: the pinned
 * model is gone and Re-run is the remedy. Refused while the event is
 * cancelled (disarmed). The run's `last_retry_key` makes a repeated click with
 * the same key a no-op that still answers ok.
 */
export function retryRunWithReason(
  db: Database.Database,
  runId: number,
  requestKey: string,
): RetryRunResult {
  return db.transaction((): RetryRunResult => {
    const run = db
      .prepare("SELECT event_id, last_retry_key FROM filing_summary_runs WHERE id = ?")
      .get(runId) as { event_id: number; last_retry_key: string | null } | undefined;
    if (!run) return { ok: false, reason: "not_found" };
    if (run.last_retry_key === requestKey) return { ok: true };
    if (getEventState(db, run.event_id)?.pollState === "cancelled") {
      return { ok: false, reason: "event_cancelled" };
    }
    const changes = db
      .prepare(
        `UPDATE filing_summary_sections
            SET status = 'pending', attempts = 0, claim_token = NULL, claimed_at = NULL,
                heartbeat_at = NULL, error_class = NULL, error_text = NULL, finished_at = NULL
          WHERE run_id = ? AND status = 'failed'
            AND (error_class IS NULL OR error_class <> 'model_unavailable')`,
      )
      .run(runId).changes;
    if (changes === 0) return { ok: false, reason: "nothing_to_retry" };
    db.prepare(
      `UPDATE filing_summary_runs SET status = 'running', finished_at = NULL, last_retry_key = ?
        WHERE id = ?`,
    ).run(requestKey, runId);
    return { ok: true };
  }).immediate();
}

/** `retryRunWithReason` as a boolean (true = applied now or by an earlier click with this key). */
export function retryRun(db: Database.Database, runId: number, requestKey: string): boolean {
  return retryRunWithReason(db, runId, requestKey).ok;
}

// ---------------------------------------------------------------- running a section

interface Coverage {
  entries: CoverageEntry[];
  docs: Array<{ fileName: string; docType: string; text: string; docText: DocText }>;
  overCap: boolean;
}

/** Every document of the filing, in sequence order, with the 1.6M-character cap applied. */
function buildCoverage(filing: FilingRow, readDocument: (p: string) => string | null, db: Database.Database): Coverage {
  const entries: CoverageEntry[] = [];
  const docs: Coverage["docs"] = [];
  let used = 0;
  let overCap = false;
  for (const d of listDocuments(db, filing.id)) {
    const base = { fileName: d.fileName, docType: d.docType };
    if (d.status !== "fetched") {
      entries.push({ ...base, status: d.status, reason: d.skipReason });
      continue;
    }
    if (overCap) {
      entries.push({ ...base, status: "skipped", reason: OVER_INPUT_CAP });
      continue;
    }
    const html = d.storedPath ? readDocument(d.storedPath) : null;
    if (html === null) {
      entries.push({ ...base, status: "failed", reason: "stored copy missing" });
      continue;
    }
    let docText: DocText;
    let text: string;
    try {
      docText = extractDocText(html);
      text = blockText(docText);
    } catch {
      entries.push({ ...base, status: "failed", reason: "could not be read" });
      continue;
    }
    if (used + text.length > INPUT_CAP_CHARS) {
      overCap = true;
      entries.push({ ...base, status: "skipped", reason: OVER_INPUT_CAP });
      continue;
    }
    used += text.length;
    docs.push({ ...base, text, docText });
    entries.push({ ...base, status: "read", reason: null });
  }
  return { entries, docs, overCap };
}

function parseChecked(json: string | null): CheckedSection | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as CheckedSection;
  } catch {
    return null;
  }
}

export type RunNextSectionResult = "ran" | "idle" | "lost_claim";

/** Thrown inside the finalize transaction to roll back when the claim is lost. */
class LostClaim extends Error {}

/**
 * Claims and runs the event's next section. "idle" = nothing to claim (or
 * another section is running); "lost_claim" = a takeover happened and this
 * worker wrote nothing; "ran" = the section was finalized or requeued.
 */
export async function runNextSection(
  db: Database.Database,
  eventId: number,
  seamOverrides: Partial<RunnerSeams> = {},
): Promise<RunNextSectionResult> {
  const seams: RunnerSeams = { ...defaultRunnerSeams(), ...seamOverrides };
  const token = seams.token();
  const section = claimNextSection(db, eventId, token, seams.now());
  if (!section) return "idle";

  const run = listRuns(db, eventId).find((r) => r.id === section.runId) ?? null;
  const filing = listFilings(db, eventId).find((f) => f.id === section.filingId) ?? null;
  /**
   * Compare-and-set finalize, in one transaction with two re-checks:
   *  - a done result whose filing was rejected while the call ran becomes
   *    failed / cancelled (its usage kept: the money was spent);
   *  - a model_unavailable result fails the run's other pending sections the
   *    same way (R17: the pinned model is gone for the whole run).
   * Returns the stored status, or null when the claim was lost (nothing written).
   */
  const finalizeTx = db.transaction((result: SectionResult): "done" | "failed" | null => {
    let r = result;
    if (r.status === "done") {
      const v = db
        .prepare("SELECT identity_verdict FROM filing_summary_filings WHERE id = ?")
        .get(section.filingId) as { identity_verdict: string } | undefined;
      if (!v || v.identity_verdict === "rejected") {
        r = failedResult(run, "cancelled", FILING_REJECTED_TEXT, {
          inputFingerprint: r.inputFingerprint,
          coverageJson: r.coverageJson,
          incomplete: r.incomplete,
          usageJson: r.usageJson,
          versionsJson: r.versionsJson,
        });
      }
    }
    if (r.status === "failed" && r.errorClass === "model_unavailable") {
      // Only while this worker still holds its claim; otherwise roll back below.
      db.prepare(
        `UPDATE filing_summary_sections
            SET status = 'failed', error_class = 'model_unavailable', error_text = ?,
                finished_at = datetime('now')
          WHERE run_id = ? AND status = 'pending' AND id <> ?`,
      ).run(MODEL_GONE_TEXT, section.runId, section.id);
    }
    if (!finalizeSection(db, section.id, token, r)) throw new LostClaim();
    return r.status;
  });
  const finalize = (result: SectionResult): RunNextSectionResult | "ran_failed" => {
    let status: "done" | "failed" | null;
    try {
      status = finalizeTx.immediate(result);
    } catch (err) {
      if (!(err instanceof LostClaim)) throw err;
      status = null;
    }
    if (status === null) {
      warn(`section ${section.id} lost its claim; nothing written`);
      return "lost_claim";
    }
    if (status === "failed") {
      warn(`section ${section.id} failed: ${result.status === "done" ? "cancelled" : result.errorClass}`);
      return "ran_failed";
    }
    return "ran";
  };
  const finalizeFailed = (result: SectionResult): RunNextSectionResult => {
    const out = finalize(result);
    return out === "ran_failed" ? "ran" : out;
  };

  // Ruling 2: the store counts claims; the cap is enforced here, with no call.
  // Past the cap at claim time means the previous attempt never finished
  // (a takeover: attempt 2 failing normally goes straight to attempt_cap).
  if (section.attempts > MAX_SECTION_ATTEMPTS) {
    return finalizeFailed(failedResult(run, "attempt_cap", "takeover"));
  }
  if (!run) return finalizeFailed(failedResult(run, "cancelled", RUN_MISSING_TEXT));
  if (!filing) return finalizeFailed(failedResult(run, "cancelled", FILING_REJECTED_TEXT));
  // Ruling 3: a filing the revalidation rejected is never sent to the model.
  if (filing.identityVerdict === "rejected") {
    return finalizeFailed(failedResult(run, "cancelled", FILING_REJECTED_TEXT));
  }
  if (!run.modelId) return finalizeFailed(failedResult(run, "model_unavailable", MODEL_GONE_TEXT));
  const ev = eventRow(db, eventId);
  if (!ev) return finalizeFailed(failedResult(run, "cancelled", FILING_REJECTED_TEXT));

  const coverage = buildCoverage(filing, seams.readDocument, db);
  const coverageJson = JSON.stringify(coverage.entries);
  const incomplete =
    filing.fetchState === "failed" || coverage.entries.some((e) => e.status !== "read");
  if (coverage.docs.length === 0) {
    return finalizeFailed(
      failedResult(run, coverage.overCap ? "input_too_large" : "cancelled", coverage.overCap ? OVER_INPUT_CAP : NOTHING_READ_TEXT, {
        coverageJson,
        incomplete: true,
      }),
    );
  }

  // Earlier sections of this run that are done, in order: the companion's context.
  const formOf = new Map(listFilings(db, eventId).map((f) => [f.id, f.form]));
  const prior = listSections(db, run.id)
    .filter((s) => s.seq < section.seq && s.status === "done")
    .map((s) => ({ s, checked: parseChecked(s.checkedJson) }))
    .filter((x): x is { s: SectionRow; checked: CheckedSection } => x.checked !== null);
  const priorClaims: CheckedClaim[] = prior.flatMap((x) => x.checked.claims);
  const priorSections = prior.map((x) => ({
    form: formOf.get(x.s.filingId) ?? "filing",
    headline: x.checked.headline,
    // The namespaced id leads each line so an 8-K/A can name the claim it corrects.
    claimTexts: x.checked.claims.map((c) => `[${c.claimId}] ${c.renderedText}`),
  }));

  let bogeys: BogeySnapshotFigure[];
  try {
    bogeys = JSON.parse(run.bogeySnapshotJson) as BogeySnapshotFigure[];
  } catch {
    bogeys = [];
  }
  const symbol = ev.symbol ?? "";
  const prompt = buildSectionPrompt({
    symbol,
    companyName: symbol ? companyName(db, symbol) : null,
    eventDate: ev.eventDate,
    filing: { form: filing.form, acceptedAtEt: acceptedAtEt(filing), role: filing.role },
    documents: coverage.docs.map((d) => ({ fileName: d.fileName, docType: d.docType, text: d.text })),
    bogeys,
    priorSections,
  });

  if (!heartbeatSection(db, section.id, token, seams.now())) {
    warn(`section ${section.id} lost its claim before the call`);
    return "lost_claim";
  }

  // A heartbeat that fails means another worker owns the section now: stop
  // paying for this call at once.
  const lost = new AbortController();
  const beat = setInterval(() => {
    if (!heartbeatSection(db, section.id, token, seams.now())) lost.abort();
  }, HEARTBEAT_EVERY_MS);
  (beat as { unref?: () => void }).unref?.();
  let object: unknown;
  let usage: unknown;
  let callError: SectionErrorClass | null = null;
  try {
    const res = await seams.generate(
      "printFilingSummary",
      { modelId: run.modelId, effort: run.effort, family: run.family },
      {
        schema: jsonSchema(SECTION_JSON_SCHEMA),
        system: prompt.system,
        prompt: prompt.user,
        maxOutputTokens: SECTION_MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.any([lost.signal, AbortSignal.timeout(SECTION_CALL_TIMEOUT_MS)]),
      },
    );
    object = res.object;
    usage = res.usage;
  } catch (err) {
    callError = errorClassOf(err);
    // A truncated or refused call was still billed: keep its usage for the cost line.
    if (err instanceof AITruncatedError || err instanceof AIRefusalError) usage = err.usage;
  } finally {
    clearInterval(beat);
  }
  if (lost.signal.aborted) {
    warn(`section ${section.id} lost its claim during the call; aborted`);
    return "lost_claim";
  }
  const usageJson = usage === undefined ? null : JSON.stringify(readUsage(usage));

  let parsed: ReturnType<typeof parseSectionOutput> | null = null;
  if (callError === null) {
    parsed = parseSectionOutput(object);
    if (!parsed.ok) callError = "invalid_output";
  }

  if (callError !== null || !parsed || !parsed.ok) {
    const cls: SectionErrorClass = callError ?? "invalid_output";
    const errorText = cls === "model_unavailable" ? MODEL_GONE_TEXT : null;
    if (NEVER_RETRIED.has(cls)) {
      return finalizeFailed(failedResult(run, cls, errorText, { coverageJson, incomplete, usageJson }));
    }
    if (section.attempts < MAX_SECTION_ATTEMPTS) {
      if (!requeueSection(db, section.id, token, cls, errorText)) {
        warn(`section ${section.id} lost its claim; nothing written`);
        return "lost_claim";
      }
      warn(`section ${section.id} attempt ${section.attempts} failed: ${cls}; requeued`);
      return "ran";
    }
    return finalizeFailed(failedResult(run, "attempt_cap", cls, { coverageJson, incomplete, usageJson }));
  }

  const checked = namespaceClaims(
    evaluateSection({
      output: parsed.value,
      docs: coverage.docs.map((d) => ({ fileName: d.fileName, text: d.docText })),
      cik: filing.cik,
      accession: filing.accession,
      eventDate: ev.eventDate,
      bogeys,
      priorClaims,
    }),
    section.seq,
  );
  const outcome = finalize({
    status: "done",
    modelId: run.modelId,
    effort: run.effort,
    inputFingerprint: prompt.fingerprint,
    outputJson: JSON.stringify(parsed.value),
    checkedJson: JSON.stringify(checked),
    coverageJson,
    incomplete,
    countsJson: JSON.stringify(checked.counts),
    usageJson,
    versionsJson: JSON.stringify({
      schema: SCHEMA_VERSION,
      prompt: PROMPT_VERSION,
      extractor: EXTRACTOR_VERSION,
      checker: CHECKER_VERSION,
    }),
    errorClass: null,
    errorText: null,
  });
  if (outcome === "ran_failed") return "ran"; // rejected mid-call: no hook
  if (outcome !== "ran") return outcome;
  try {
    await seams.onSectionDone(db, section.id);
  } catch {
    warn(`after-section hook failed for section ${section.id}`);
  }
  return "ran";
}
