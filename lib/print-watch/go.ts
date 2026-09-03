/**
 * The "print is live" action (spec §4.3 "Durable request").
 *
 * A press is a ROW, not a call. `requestGo` persists everything the desk
 * handed us — the arm, the once-only forced-window stamp, a pasted file
 * staged content-addressed, a pasted link stored verbatim — and inserts a
 * queued request BEFORE acknowledging, so a crash after the ack loses
 * nothing. Whoever holds the watcher lease claims the row by compare-and-set
 * (`runGoRequest`): the input road first, then one fan-out pass over the
 * wire/EDGAR/IR roads, with the per-road outcomes landing in `result_json`
 * for the panel to show.
 *
 * ORDER IS THE CONTRACT (Codex round 1, findings #2/#3/#4):
 *   1. validate the input        — a refused press changes nothing at all
 *   2. resolve the event by id   — missing/superseded refuses, still nothing
 *   3. stage bytes               — content-addressed, unlinked on rollback
 *   4. ONE immediate transaction — arm + prepare rows + print + stamp + row
 *   5. post-commit side effects  — prepare pass, outbox drain, scheduler wake
 *
 * Step 5 can fail WITHOUT failing the press: the row is already durable and a
 * later dispatcher tick picks it up, so a wake that throws comes back as
 * `wakeError` on the ack instead of an error the desk cannot act on. Nothing
 * in step 5 is linked to an acquisition pass's AbortSignal (ruling R-C8) — a
 * settling pass aborts its signal, and a press must not be cancelled by it.
 *
 * No static import of ./watcher: the watcher's go dispatcher imports
 * `runGoRequest` from here, and a static import in both directions is an
 * evaluation-order cycle. The watcher is reached through `GoSeams`, whose
 * defaults import it lazily inside the function bodies.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { enqueuePrepareSteps, runPrepareSteps } from "@/lib/earnings/prepare-armed-event";
import { attemptPostCommitDrain } from "@/lib/earnings/cloud-outbox";
import type { EventMergeContext, EventMergeTableResult } from "@/lib/earnings/event-merge";
import { validatePublicUrl } from "./ssrf";
import { redactUrl, REDACTED_QUERY_KEYS } from "./hardened-fetch";
import { classifyBytes, URL_FETCH_MAX_BYTES, type hardenedFetchBytes } from "./url-fetch";
import { sha256Hex } from "./delivery";
import {
  upsertPrint,
  getPrintByEventId,
  getPrintById,
  stampForcedOpen,
  extendPrintWindow,
  insertGoRequest,
  getGoRequest,
  claimGoRequest,
  heartbeatGoRequest,
  requeueGoRequest,
  finalizeGoRequest,
  movePrintGoState,
  GO_MAX_ATTEMPTS,
  GO_CLAIM_STALE_MS,
} from "./store";
import { effectiveWindow, extendedUntil, windowToIso } from "./window";
import type { GoInputKind, GoRequestRow, RoadReport } from "./types";

/** A press the desk can fix: bad input, or an event that cannot be pressed. → HTTP 400. */
export class GoRefused extends Error {}

export interface GoInput {
  url?: string;
  /** What the browser called the file. Accepted and DISCARDED: migration 090
   *  has no column for it, and it is never used to build a path — the stored
   *  extension follows the CLASSIFIED shape of the bytes, so a claimed name
   *  can never steer where they land. */
  filename?: string;
  contentBase64?: string;
}

export interface GoRequestAck {
  requestId: number;
  printId: number;
  forcedOpenAt: string;
  newlyArmed: boolean;
  /** Post-commit trouble (the prepare kick, the outbox drain, or the wake).
   *  The press SUCCEEDED — the row is durable and the dispatcher owns it. */
  wakeError: string | null;
}

export interface GoSeams {
  now: () => number;
  /** The event by id: `null` for a missing, non-earnings, or SUPERSEDED row
   *  — any date. The watch horizon is NOT a gate here: the desk pressing go
   *  IS the evidence that this print is happening now. */
  resolveEvent: (
    db: Database.Database,
    eventId: number,
  ) => Promise<{ symbol: string; eventDate: string; releaseTimeEt: string | null } | null>;
  /** Content-addressed write under a directory key (`GO_STAGING_DIR_KEY` for a
   *  press, whose print id does not exist yet). Default: the watcher's
   *  `writeAcquiredBytes` (lazy import). */
  writeBytes: (dirKey: number | string, sha: string, ext: string, buf: Buffer) => Promise<string>;
  /** Re-read staged bytes at claim time. Default: `fs.promises.readFile`. */
  readBytes: (path: string) => Promise<Buffer>;
  /** Remove staged bytes nothing owns. Default: `fs.promises.unlink`. */
  unlink: (path: string) => Promise<void>;
  /** Default: the watcher's `wakePrintWatch` = ensurePrintWatch + scheduler.wake. */
  wake: (db: Database.Database, printId: number) => Promise<void>;
  /** A's prepare pass + the cloud-outbox drain, AFTER the commit. */
  postCommit: (db: Database.Database, eventId: number) => Promise<void>;
  /** Default: the watcher's `ingestDocument` (lazy import). */
  ingest: (
    db: Database.Database,
    printId: number,
    kind: "user-drop",
    source: string,
    url: string | null,
    buf: Buffer,
  ) => Promise<{ outcome: string; rejectReason?: string; docId: number }>;
  /** Default: `roads.deliverFromUrl`, fetching through the scheduler's
   *  per-host throttle (finding #9). `signal` aborts when the claim is lost
   *  mid-fetch — it is `runGoRequest`'s OWN controller, never a scheduler
   *  pass signal (R-C8). */
  deliverUrl: (
    db: Database.Database,
    printId: number,
    url: string,
    signal?: AbortSignal,
  ) => Promise<{ outcome: string; detail: string }>;
  /** Default: the watcher's `runForcedPass` (lazy import) — one fan-out pass
   *  NOW, returning one RoadReport per road. Same `signal` contract as
   *  `deliverUrl`. */
  acquire: (db: Database.Database, printId: number, signal?: AbortSignal) => Promise<RoadReport[]>;
}

/** Bytes are staged here because a first press has no print id yet: the row's
 *  `input_bytes_path` is the durable audit of what the desk handed us, and
 *  `ingestDocument` makes its own content-addressed copy under the print's
 *  directory. The staged file is deliberately NOT moved afterwards — a rename
 *  would strand every retry that re-reads the path off the row. */
export const GO_STAGING_DIR_KEY = "staging";

export const PRINT_WATCH_GO_MERGE_HANDLER_NAME = "print-watch-go";

// ---------------------------------------------------------------------------
// error text
// ---------------------------------------------------------------------------

/**
 * Scrub anything that could carry a signed URL or a local path before it is
 * persisted, returned, or logged (finding #16). Every URL goes through
 * `redactUrl`; absolute home/system paths become `<path>`; the whole message
 * is capped so one runaway error cannot fill `result_json`.
 */
export function safeErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/https?:\/\/[^\s"')]+/g, (m) => redactUrl(m))
    .replace(/\/(?:Users|home|private|var|tmp|opt)\/[^\s"')]+/g, "<path>")
    .slice(0, 500);
}

// ---------------------------------------------------------------------------
// the watcher, lazily (never a static import — see the module header)
// ---------------------------------------------------------------------------

/** Task 6's exports, optional until it lands so this module type-checks alone. */
interface WatcherGoExports {
  writeAcquiredBytes?: (dirKey: number | string, sha: string, ext: string, buf: Buffer) => Promise<string>;
  wakePrintWatch?: (db: Database.Database, printId: number) => Promise<void>;
  runForcedPass?: (db: Database.Database, printId: number, signal?: AbortSignal) => Promise<RoadReport[]>;
  throttledFetchBytes?: typeof hardenedFetchBytes;
}

async function watcherModule(): Promise<typeof import("./watcher") & WatcherGoExports> {
  return (await import("./watcher")) as typeof import("./watcher") & WatcherGoExports;
}

function requireWatcherExport<T>(fn: T | undefined, name: string): T {
  if (!fn) throw new Error(`print-watch/go: the watcher does not export ${name} yet (Task 6 not landed)`);
  return fn;
}

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------

const DEFAULT_SEAMS: GoSeams = {
  now: () => Date.now(),

  resolveEvent: async (db, eventId) => {
    // The event row itself — not the armed set: the press is what arms it.
    // The securities join mirrors `getArmedWorksheetEvents` so the DTO the
    // watcher builds here is the same one the sweep would build.
    const row = db
      .prepare(
        `SELECT ce.id                                   AS eventId,
                ce.symbol                               AS symbol,
                ce.event_date                           AS event_date,
                ce.event_type                           AS event_type,
                ce.event_time                           AS event_time,
                ce.raw_json                             AS raw_json,
                COALESCE(s.ib_con_id, ce.ib_con_id)     AS con_id,
                s.id                                    AS security_id,
                s.name                                  AS issuer_name,
                COALESCE(ce.superseded, 0)              AS superseded
           FROM calendar_events ce
           LEFT JOIN securities s
                  ON s.id = COALESCE(
                       ce.security_id,
                       (SELECT id FROM securities WHERE UPPER(symbol) = UPPER(ce.symbol) LIMIT 1)
                     )
          WHERE ce.id = ?`,
      )
      .get(eventId) as
      | {
          eventId: number;
          symbol: string | null;
          event_date: string;
          event_type: string;
          event_time: string | null;
          raw_json: string | null;
          con_id: number | null;
          security_id: number | null;
          issuer_name: string | null;
          superseded: number;
        }
      | undefined;
    if (!row || row.superseded === 1 || row.event_type !== "earnings" || !row.symbol) return null;
    // Release time via the watcher's own derivation (resolveEarningsReleaseTime
    // + the BMO/AMC slot floor + the TAS null) — never re-implemented here.
    const dto = (await watcherModule()).buildArmedEventDto(db, { ...row, symbol: row.symbol });
    return { symbol: dto.symbol, eventDate: dto.eventDate, releaseTimeEt: dto.releaseTimeEt };
  },

  writeBytes: async (dirKey, sha, ext, buf) =>
    requireWatcherExport((await watcherModule()).writeAcquiredBytes, "writeAcquiredBytes")(dirKey, sha, ext, buf),

  readBytes: (path) => fsp.readFile(path),

  unlink: (path) => fsp.unlink(path),

  wake: async (db, printId) =>
    requireWatcherExport((await watcherModule()).wakePrintWatch, "wakePrintWatch")(db, printId),

  postCommit: async (db, eventId) => {
    // Detached on purpose: a prepare pass can take minutes (model calls), and
    // the desk is holding a button. Its own errors are logged, never thrown.
    void runPrepareSteps(db, { eventId }).catch((e) =>
      console.warn("[print-watch/go] prepare pass failed:", safeErrorText(e)),
    );
    // Hands the new armed generation to the Worker; capped and never throws.
    await attemptPostCommitDrain(db);
  },

  ingest: async (db, printId, kind, source, url, buf) =>
    (await watcherModule()).ingestDocument(db, printId, kind, source, url, buf),

  deliverUrl: async (db, printId, url, signal) => {
    const { deliverFromUrl } = await import("./roads");
    // Finding #9: the pasted-link road is fetched under the scheduler's
    // per-host throttle, exactly like every automatic road. The signal is the
    // CLAIM's, composed with the fetcher's own budget — a go press is never
    // cancelled by a settling acquisition pass (R-C8).
    const throttled = requireWatcherExport((await watcherModule()).throttledFetchBytes, "throttledFetchBytes");
    return deliverFromUrl(db, printId, url, {
      fetchBytes: (u, opts) => throttled(u, { ...opts, signal }),
    });
  },

  acquire: async (db, printId, signal) =>
    requireWatcherExport((await watcherModule()).runForcedPass, "runForcedPass")(db, printId, signal),
};

// ---------------------------------------------------------------------------
// input validation
// ---------------------------------------------------------------------------

/** A base64 string longer than this cannot decode to <= 10 MB — a cheap gate
 *  so an absurd payload is refused before it is decoded into memory. The
 *  DECODED length is what actually decides (a 4/3 estimate is not exact). */
const BASE64_MAX_CHARS = Math.ceil(URL_FETCH_MAX_BYTES / 3) * 4 + 4;

interface ParsedInput {
  kind: GoInputKind;
  /** What the row stores AND what the claim fetches — one string, by
   *  construction: a link that could not be stored safely in full is refused
   *  at the press rather than stored in a form we would then not fetch. */
  url: string | null;
  bytes: Buffer | null;
  ext: "html" | "txt" | "pdf" | null;
}

/**
 * The three things `redactUrl` would REMOVE from a link — userinfo, the
 * fragment, and a secret-bearing query key (review I1). A pasted link is the
 * one URL this subsystem stores unredacted, because the claim fetches the
 * stored string; so instead of storing a redacted copy we make the two
 * identical: the fragment is stripped (it never reaches a server, so the fetch
 * target is unchanged), and the other two are REFUSED at the press.
 *
 * What `redactUrl` would only TRUNCATE (its 200-character cap) is a DISPLAY
 * concern, not a storage one: a long link with no secret in it is accepted and
 * stored in full (review M3). Any surface that shows `input_url` still renders
 * it through `redactUrl`, which by then can only shorten it.
 *
 * LIMIT worth knowing (review M4): "secret-bearing" is only as wide as
 * `REDACTED_QUERY_KEYS`. A credential under a key that family does not name
 * (`?jwt=`, `?t=`) is stored in plaintext. This is the same blind spot the
 * whole subsystem's redaction has — not a stronger promise made here.
 */
function storableUrl(raw: string): string {
  const url = new URL(raw); // `validatePublicUrl` has already parsed it
  if (url.username || url.password) {
    throw new GoRefused(
      "Link refused: it carries embedded credentials — paste the plain link, or download the release and drop the file instead.",
    );
  }
  const secretKey = Array.from(url.searchParams.keys()).find((k) => REDACTED_QUERY_KEYS.test(k));
  if (secretKey) {
    throw new GoRefused(
      "Link refused: it carries a secret-bearing query parameter — download the release and drop the file instead.",
    );
  }
  url.hash = "";
  return url.toString();
}

function parseInput(input: GoInput): ParsedInput {
  const hasUrl = typeof input.url === "string" && input.url.trim() !== "";
  const hasFile = typeof input.contentBase64 === "string" && input.contentBase64 !== "";
  if (hasUrl && hasFile) throw new GoRefused("Send one of a link or a file, not both.");

  if (hasUrl) {
    const trimmed = input.url!.trim();
    const verdict = validatePublicUrl(trimmed);
    if (!verdict.ok) throw new GoRefused(`Link refused: ${verdict.reason}.`);
    // The stored form: fragment stripped, userinfo and secret query keys
    // refused (user decision (a)). What comes back is both what the row keeps
    // and what the claim fetches.
    return { kind: "url", url: storableUrl(trimmed), bytes: null, ext: null };
  }

  if (hasFile) {
    if (input.contentBase64!.length > BASE64_MAX_CHARS) throw new GoRefused("File refused: larger than 10 MB.");
    const bytes = Buffer.from(input.contentBase64!, "base64");
    if (bytes.length > URL_FETCH_MAX_BYTES) throw new GoRefused("File refused: larger than 10 MB.");
    if (bytes.length === 0) throw new GoRefused("File refused: it is empty.");
    const shape = classifyBytes(bytes);
    if (shape === "binary") {
      throw new GoRefused("File refused: binary content — print-watch reads HTML, plain text, or PDF.");
    }
    return { kind: "file", url: null, bytes, ext: shape === "html" ? "html" : shape === "pdf" ? "pdf" : "txt" };
  }

  return { kind: "none", url: null, bytes: null, ext: null };
}

/** True when some row still points at these staged bytes — a rollback must
 *  never delete an earlier press's evidence, or a document's own copy. */
function stagedBytesInUse(db: Database.Database, path: string, sha: string): boolean {
  const byPath = db
    .prepare(`SELECT 1 FROM print_watch_go_requests WHERE input_bytes_path = ? LIMIT 1`)
    .get(path);
  if (byPath) return true;
  return db.prepare(`SELECT 1 FROM print_watch_documents WHERE sha256 = ? LIMIT 1`).get(sha) !== undefined;
}

// ---------------------------------------------------------------------------
// the press
// ---------------------------------------------------------------------------

export async function requestGo(
  db: Database.Database,
  eventId: number,
  input: GoInput,
  seams: Partial<GoSeams> = {},
): Promise<GoRequestAck> {
  const s: GoSeams = { ...DEFAULT_SEAMS, ...seams };

  // 1. validate — a refused press changes nothing.
  const parsed = parseInput(input);

  // 2. resolve by id — missing/superseded refuses, still nothing changed.
  const ev = await s.resolveEvent(db, eventId);
  if (!ev) throw new GoRefused("No earnings event with that id, or it has been superseded.");

  // 3. stage bytes content-addressed (before the write lock is taken).
  let sha: string | null = null;
  let bytesPath: string | null = null;
  if (parsed.bytes) {
    sha = sha256Hex(parsed.bytes);
    bytesPath = await s.writeBytes(GO_STAGING_DIR_KEY, sha, parsed.ext ?? "txt", parsed.bytes);
  }

  // 4. ONE immediate transaction: the arm, its prepare rows, the print, the
  //    once-only stamp and the request row commit together or not at all.
  //    `armWorksheet`'s own transaction nests as a savepoint, and the armed-
  //    events outbox row it writes rides inside this same commit.
  const nowIso = new Date(s.now()).toISOString();
  let committed: { requestId: number; printId: number; forcedOpenAt: string; newlyArmed: boolean };
  try {
    committed = db
      .transaction(() => {
        const newlyArmed = armWorksheet(db, eventId);
        enqueuePrepareSteps(db, eventId);
        const printId = upsertPrint(db, eventId, ev.symbol, ev.eventDate, ev.releaseTimeEt);
        const forcedOpenAt = stampForcedOpen(db, printId, nowIso);
        if (forcedOpenAt === null) throw new Error(`print-watch/go: print ${printId} vanished mid-press`);
        const requestId = insertGoRequest(db, {
          printId,
          inputKind: parsed.kind,
          inputUrl: parsed.url,
          inputSha256: sha,
          inputBytesPath: bytesPath,
          requestedAt: nowIso,
        });
        return { requestId, printId, forcedOpenAt, newlyArmed };
      })
      .immediate();
  } catch (err) {
    if (bytesPath && sha && !stagedBytesInUse(db, bytesPath, sha)) {
      await s.unlink(bytesPath).catch(() => {});
    }
    throw err;
  }

  // 5. post-commit. The row is durable: nothing below may fail the press —
  //    a dispatcher tick owns the request whether or not the wake lands.
  let wakeError: string | null = null;
  try {
    await s.postCommit(db, eventId);
  } catch (err) {
    wakeError = safeErrorText(err);
  }
  try {
    await s.wake(db, committed.printId);
  } catch (err) {
    const text = safeErrorText(err);
    wakeError = wakeError ? `${wakeError}; ${text}` : text;
  }
  return { ...committed, wakeError };
}

// ---------------------------------------------------------------------------
// the claim/run loop (the watcher's 2-second dispatcher calls this)
// ---------------------------------------------------------------------------

/** How often the claim is renewed while a phase runs — a third of the stale
 *  window, so two consecutive missed beats still leave the claim live. */
export const GO_CLAIM_HEARTBEAT_MS = Math.floor(GO_CLAIM_STALE_MS / 3);

/** The claim went away mid-run (a takeover, or a merge that re-homed the row).
 *  Never a failure of THIS request: the new owner is running it. */
class GoClaimLost extends Error {}

/** Await `work`, but give up the moment the claim does (review I2). The
 *  underlying promise may still settle later — what matters is that this
 *  worker stops waiting on it, writes nothing, and burns no attempt. */
function whileClaimed<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new GoClaimLost("claim lost"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new GoClaimLost("claim lost"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export async function runGoRequest(
  db: Database.Database,
  requestId: number,
  seams: Partial<GoSeams> = {},
): Promise<GoRequestRow | null> {
  const s: GoSeams = { ...DEFAULT_SEAMS, ...seams };
  const token = randomUUID();
  if (!claimGoRequest(db, requestId, token, s.now())) return null;
  /** Renews `claimed_at` AND proves this token still owns the row (finding
   *  #7): a merge that re-homed the request invalidated the claim, and a
   *  worker that kept writing would land its report on someone else's print. */
  const owns = () => heartbeatGoRequest(db, requestId, token, s.now());

  // Review I2: `owns()` between phases is not enough. One phase is an EDGAR
  // fetch plus an IR fetch plus, on the drop road, a PDF ingest with model
  // calls — minutes against a 60-second stale window, so a second dispatcher
  // tick would take the row mid-fetch, run the same fan-out against the same
  // print, and burn one of three attempts. This ticking renewal is what
  // `heartbeatGoRequest` was written for; when it reports the claim GONE it
  // aborts the in-flight work through our OWN controller (never a scheduler
  // pass signal — R-C8) so the new owner runs alone.
  //
  // The callback NEVER throws (re-review). `heartbeatGoRequest` is a
  // synchronous better-sqlite3 UPDATE, so a locked handle (SQLITE_BUSY past
  // the busy timeout) or a closed one (shutdown while this run is detached)
  // raises — and an exception out of a timer callback is an UNCAUGHT
  // exception: the dispatcher's `void runGoRequest(...).catch(...)` cannot
  // see it and this repo registers no `uncaughtException` handler, so the
  // server would die in the minute the desk pressed "print is live". A
  // heartbeat we cannot RUN is a claim we cannot PROVE we hold, so a throw
  // ends the run exactly like a `false` does — the same verdict the watcher's
  // own lease renewal reaches (`watcher.ts`, `renew` inside `pass`).
  const claim = new AbortController();
  const beat: ReturnType<typeof setInterval> = setInterval(() => {
    const lose = (reason: Error) => {
      clearInterval(beat); // stop beating on a handle we already know is gone
      claim.abort(reason);
    };
    try {
      if (!owns()) lose(new Error("go claim lost"));
    } catch (err) {
      lose(err instanceof Error ? err : new Error(String(err)));
    }
  }, GO_CLAIM_HEARTBEAT_MS);
  beat.unref?.(); // a press must never hold the process open

  let req = getGoRequest(db, requestId)!;
  const reports: RoadReport[] = [];
  try {
    if (req.input_kind === "file" && req.input_bytes_path && req.input_sha256) {
      const bytes = await whileClaimed(s.readBytes(req.input_bytes_path), claim.signal);
      // Finding #14: the row is the authority on WHAT was pressed. Bytes that
      // no longer hash to it are a different document, not this request's.
      if (sha256Hex(bytes) !== req.input_sha256) {
        throw new Error("input bytes changed on disk since the press");
      }
      if (!owns()) return null;
      const r = await whileClaimed(
        s.ingest(db, req.print_id, "user-drop", `go:${req.input_sha256}`, null, bytes),
        claim.signal,
      );
      reports.push({ road: "user-drop", outcome: r.outcome, detail: r.rejectReason ?? "" });
    } else if (req.input_kind === "url" && req.input_url) {
      if (!owns()) return null;
      // The stored url IS the fetch target: `storableUrl` stripped the
      // fragment at the press and refused userinfo and every query key the
      // redaction family names (its own doc states that family's limit).
      const r = await whileClaimed(
        s.deliverUrl(db, req.print_id, req.input_url, claim.signal),
        claim.signal,
      );
      reports.push({ road: "user-url", outcome: r.outcome, detail: r.detail });
    } else if (req.input_kind !== "none") {
      // Review M5: migration 090's CHECK allows an empty-string path, and a
      // row that matches neither branch would otherwise finalise `done` with
      // the desk's own document silently never ingested.
      throw new Error(`go request ${requestId}: incoherent ${req.input_kind} row — input not usable`);
    }
    if (!owns()) return null;
    // Re-read: a merge may have re-homed the row (finding #8). The `owns()`
    // above would already have failed in that case, so this is the benign
    // re-read of a row we still hold.
    req = getGoRequest(db, requestId)!;
    reports.push(...(await whileClaimed(s.acquire(db, req.print_id, claim.signal), claim.signal)));
  } catch (err) {
    // A lost claim is not this request's failure: the row belongs to someone
    // else now, so write NOTHING — no report, no requeue, no attempt spent.
    if (err instanceof GoClaimLost || claim.signal.aborted) return null;
    reports.push({ road: "system", outcome: "failed", detail: safeErrorText(err) });
    const attempts = getGoRequest(db, requestId)?.attempts ?? GO_MAX_ATTEMPTS;
    if (attempts < GO_MAX_ATTEMPTS) {
      // Below the cap: back to queued with the partial reports kept, so the
      // next dispatcher tick retries and the panel can say what went wrong.
      if (!requeueGoRequest(db, requestId, token, JSON.stringify(reports))) return null;
      return getGoRequest(db, requestId);
    }
    if (!finalizeGoRequest(db, requestId, token, "failed", JSON.stringify(reports), s.now())) return null;
    return getGoRequest(db, requestId);
  } finally {
    clearInterval(beat); // every exit path — an uncleared interval outlives the run
  }
  if (!finalizeGoRequest(db, requestId, token, "done", JSON.stringify(reports), s.now())) return null;
  return getGoRequest(db, requestId);
}

// ---------------------------------------------------------------------------
// extend
// ---------------------------------------------------------------------------

/**
 * "Extend 30 min": `max(now, current end) + 30m`; presses stack. Read,
 * compute and write happen inside ONE immediate transaction (finding #5) so
 * two presses landing together cannot both read the same end and write the
 * same extension.
 *
 * The ROUTE (Task 7) calls `wakePrintWatch(db, printId)` after this returns,
 * so a loop that had stopped at the old end resumes at once.
 */
export function extendGoWindow(
  db: Database.Database,
  eventId: number,
  nowMs: number = Date.now(),
): { printId: number; windowExtendedUntil: string; effectiveWindow: { start: string; end: string } | null } {
  return db
    .transaction(() => {
      const print = getPrintByEventId(db, eventId);
      if (!print) {
        throw new GoRefused("No print-watch row for this event — arm it (or press Print is live) first.");
      }
      const until = extendedUntil(effectiveWindow(print), nowMs);
      extendPrintWindow(db, print.id, until);
      return {
        printId: print.id,
        windowExtendedUntil: until,
        effectiveWindow: windowToIso(effectiveWindow(getPrintById(db, print.id)!)),
      };
    })
    .immediate();
}

// ---------------------------------------------------------------------------
// C's event-merge handler
// ---------------------------------------------------------------------------

/**
 * Registered BEFORE slice B's handler (`register.ts`). B deletes the donor
 * print row at the end of a both-prints merge, and `print_watch_go_requests`
 * references `print_watch_prints(id)` with NO cascade on purpose — a go row
 * must never vanish silently. Running first is what keeps that FK satisfiable.
 *
 * Re-home (the target has no print of its own) is a NO-OP here: B moves the
 * donor print row itself, so the go rows are already attached to the print
 * that survives.
 */
export function mergePrintWatchGoState(ctx: EventMergeContext): EventMergeTableResult[] {
  const donor = getPrintByEventId(ctx.db, ctx.donorEventId);
  const target = getPrintByEventId(ctx.db, ctx.targetEventId);
  if (!donor || !target) return [];
  const out = movePrintGoState(ctx.db, donor.id, target.id);
  return [
    { table: "print_watch_go_requests", moved: out.moved, merged: 0, deleted: 0, notes: [] },
    {
      table: "print_watch_prints",
      moved: 0,
      merged: 1,
      deleted: 0,
      notes: [
        `forced_open_at=${out.forcedOpenAt ?? "null"} window_extended_until=${out.windowExtendedUntil ?? "null"} carried to the target print`,
      ],
    },
  ];
}
