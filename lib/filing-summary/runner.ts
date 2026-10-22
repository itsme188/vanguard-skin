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
export const SECTION_MAX_OUTPUT_TOKENS = 32_000;
export const SECTION_CALL_TIMEOUT_MS = 300_000;
/** Kept well under the store's 5-minute stale window while a call is open. */
const HEARTBEAT_EVERY_MS = 60_000;
export const MODEL_GONE_TEXT = "model no longer available — re-run";
export const WAITS_FOR_RETRY_TEXT = "added after the run failed — runs on Retry";
const FILING_REJECTED_TEXT = "filing no longer matches the print";
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
 * What happens after a section is finalized as done. A no-op until Task 11
 * wires the push here; this is the one place the default is replaced.
 */
async function defaultOnSectionDone(): Promise<void> {}

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

/** The frozen filing list: the accepted earnings filing, then accepted companions by discovery order. */
function runFilingIds(filings: FilingRow[]): number[] {
  const earnings = filings.find((f) => f.role === "earnings" && f.identityVerdict === "accepted");
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

  const filingIds = runFilingIds(listFilings(db, eventId));
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
  if (!res.created) {
    // A concurrent call with the same key won the insert: same rule as above.
    const owner = db
      .prepare("SELECT event_id FROM filing_summary_runs WHERE id = ?")
      .get(res.runId) as { event_id: number } | undefined;
    if (owner?.event_id !== eventId) return { ok: false, reason: "request_key_conflict" };
  }
  return { ok: true, runId: res.runId, created: res.created };
}

/**
 * R13: a companion found after a run started goes to the newest run that is
 * running or done; if the newest failed, to the newest done run; with none
 * done, to the newest failed run, where it waits for Retry (stored failed /
 * cancelled with that reason, so nothing runs it before the click). Returns
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
          SET status = 'failed', error_class = 'cancelled', error_text = ?,
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

/** Poller callback: the accepted earnings filing starts the automatic run, once. */
export function onEarningsAccepted(db: Database.Database, eventId: number): void {
  const state = getEventState(db, eventId)?.pollState;
  if (state === "manual_only" || state === "cancelled") return;
  if (listRuns(db, eventId).length > 0) return;
  const res = startRun(db, eventId, "auto");
  if (!res.ok) warn(`auto run for event ${eventId} not started: ${res.reason}`);
}

/** Poller callback: an accepted companion joins the right run (R13). */
export function onCompanionAccepted(db: Database.Database, eventId: number, filingId: number): void {
  appendCompanion(db, eventId, filingId);
}

/**
 * Retry on an explicit click: every failed section of the run (refusal and
 * truncation included) goes back to pending with its attempts reset. The
 * request key makes a repeated click a no-op (recorded in `settings`).
 * False when the run does not exist or had nothing to retry.
 */
export function retryRun(db: Database.Database, runId: number, requestKey: string): boolean {
  return db.transaction(() => {
    const run = db.prepare("SELECT id FROM filing_summary_runs WHERE id = ?").get(runId);
    if (!run) return false;
    const key = `filing_summary_retry:${requestKey}`;
    const seen = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    if (seen) return seen.value === String(runId);
    const changes = db
      .prepare(
        `UPDATE filing_summary_sections
            SET status = 'pending', attempts = 0, claim_token = NULL, claimed_at = NULL,
                heartbeat_at = NULL, error_class = NULL, error_text = NULL, finished_at = NULL
          WHERE run_id = ? AND status = 'failed'`,
      )
      .run(runId).changes;
    if (changes === 0) return false;
    db.prepare(
      "UPDATE filing_summary_runs SET status = 'running', finished_at = NULL WHERE id = ?",
    ).run(runId);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, String(runId));
    return true;
  }).immediate();
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
  const finalize = (result: SectionResult): RunNextSectionResult => {
    if (!finalizeSection(db, section.id, token, result)) {
      warn(`section ${section.id} lost its claim; nothing written`);
      return "lost_claim";
    }
    if (result.status === "failed") {
      warn(`section ${section.id} failed: ${result.errorClass}`);
    }
    return "ran";
  };

  // Ruling 2: the store counts claims; the cap is enforced here, with no call.
  if (section.attempts > MAX_SECTION_ATTEMPTS) {
    const last = section.errorClass ?? "takeover";
    return finalize(failedResult(run, "attempt_cap", last));
  }
  if (!run || !filing) return finalize(failedResult(run, "cancelled", FILING_REJECTED_TEXT));
  // Ruling 3: a filing the revalidation rejected is never sent to the model.
  if (filing.identityVerdict === "rejected") {
    return finalize(failedResult(run, "cancelled", FILING_REJECTED_TEXT));
  }
  if (!run.modelId) return finalize(failedResult(run, "model_unavailable", MODEL_GONE_TEXT));
  const ev = eventRow(db, eventId);
  if (!ev) return finalize(failedResult(run, "cancelled", FILING_REJECTED_TEXT));

  const coverage = buildCoverage(filing, seams.readDocument, db);
  const coverageJson = JSON.stringify(coverage.entries);
  const incomplete =
    filing.fetchState === "failed" || coverage.entries.some((e) => e.status !== "read");
  if (coverage.docs.length === 0) {
    return finalize(
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

  const beat = setInterval(() => {
    heartbeatSection(db, section.id, token, seams.now());
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
        abortSignal: AbortSignal.timeout(SECTION_CALL_TIMEOUT_MS),
      },
    );
    object = res.object;
    usage = res.usage;
  } catch (err) {
    callError = errorClassOf(err);
  } finally {
    clearInterval(beat);
  }

  let parsed: ReturnType<typeof parseSectionOutput> | null = null;
  if (callError === null) {
    parsed = parseSectionOutput(object);
    if (!parsed.ok) callError = "invalid_output";
  }

  if (callError !== null || !parsed || !parsed.ok) {
    const cls: SectionErrorClass = callError ?? "invalid_output";
    const errorText = cls === "model_unavailable" ? MODEL_GONE_TEXT : null;
    if (NEVER_RETRIED.has(cls)) {
      return finalize(failedResult(run, cls, errorText, { coverageJson, incomplete }));
    }
    if (section.attempts < MAX_SECTION_ATTEMPTS) {
      if (!requeueSection(db, section.id, token, cls, errorText)) {
        warn(`section ${section.id} lost its claim; nothing written`);
        return "lost_claim";
      }
      warn(`section ${section.id} attempt ${section.attempts} failed: ${cls}; requeued`);
      return "ran";
    }
    return finalize(failedResult(run, "attempt_cap", cls, { coverageJson, incomplete }));
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
    usageJson: JSON.stringify(readUsage(usage)),
    versionsJson: JSON.stringify({
      schema: SCHEMA_VERSION,
      prompt: PROMPT_VERSION,
      extractor: EXTRACTOR_VERSION,
      checker: CHECKER_VERSION,
    }),
    errorClass: null,
    errorText: null,
  });
  if (outcome !== "ran") return outcome;
  try {
    await seams.onSectionDone(db, section.id);
  } catch {
    warn(`after-section hook failed for section ${section.id}`);
  }
  return "ran";
}
