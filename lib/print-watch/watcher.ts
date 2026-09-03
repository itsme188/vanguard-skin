/**
 * The print-watch watcher (Task 9) — the integration heart of the subsystem.
 *
 * It owns everything between "the user armed this earnings event" and "the
 * sheet has values": which prints have open windows, which sources are polled
 * for them, which acquired bytes are allowed to become candidates, and when
 * the reconciled line states are written back.
 *
 * SHAPE (and why)
 *
 *  - ONE OWNER, DB-LEASED (Codex #7). `ensurePrintWatch` is the only entry
 *    point that starts work, and it starts nothing without
 *    `acquireWatcherLease`. Two processes routinely have this module loaded
 *    (the always-on Electron server and a launchd sweep tick); the lease is
 *    what stops both from polling the SEC and the DJ wire in parallel.
 *
 *  - SERIALIZED LOOPS, NEVER setInterval (Codex #8). Each print gets exactly
 *    one `while (live) { await pollOnce(); await sleep(cadence) }` task. A
 *    timer-driven poll would stack a second DJ/EDGAR round on top of a slow
 *    one and blow the per-host budgets; awaiting the body makes overlap
 *    structurally impossible. The same reasoning gives the ingest pipeline a
 *    per-print promise chain: ONE document parses at a time, in doc-id order.
 *
 *  - THE GATE COMES BEFORE THE PARSE (Codex #1). Bytes only become candidates
 *    after the gate agrees the document is this issuer's release for this
 *    period AND at least one road that delivered it is trusted for this event.
 *    A failing document is still STORED (it is evidence of what the wire
 *    served) with its verdict in `gate_verdict`/`road_verdict`; the parse
 *    queue simply never sees it. Slice B moved that decision out of the
 *    source string and into `recordDelivery` (lib/print-watch/delivery.ts),
 *    which is now the ONE way bytes enter the store.
 *
 *  - IDENTITY IS CONTENT, NOT ROAD (089/M13). The same bytes arriving by
 *    EDGAR and by a drop are ONE document with TWO roads — one extraction,
 *    one honest `single_source`. The parse itself is claimed by token
 *    (compare-and-set) so two processes never parse one document twice, and a
 *    crashed worker's claim is taken over after PARSE_CLAIM_STALE_MS.
 *
 *  - EXPECTED VALUES NEVER TOUCH EXTRACTION. `compileContracts` returns
 *    contracts and a PARALLEL expected map; only `contracts` is ever passed to
 *    `extractCandidates`, and the expected map goes straight onto the line
 *    rows. The seam signature has no slot for it, so a leak takes a
 *    deliberate edit, not an accident.
 *
 *  - EVERYTHING EXTERNAL IS A SEAM. TWS, EDGAR, the IR feed, the model call,
 *    the clock, sleep and the storage root are all injected through
 *    `_setTestSeams`, so the whole state machine is exercised by tests with no
 *    network, no TWS socket, and no model spend.
 *
 * LIMITATION worth knowing (v1, accepted): a short-lived caller (the 15-minute
 * launchd sweep tick) can take the lease when the long-lived server let it
 * lapse — the server has no armed window open, so nothing was renewing it —
 * and then exit. The lease's 60s TTL bounds that to one minute of nobody
 * polling; the next `ensurePrintWatch` from the panel or the sweep takes over.
 */

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";

import { addDays, todayET } from "@/lib/calendar/date-utils";
import { normalizeEarningsHour } from "@/lib/calendar/release-times";
import { resolveDbDir } from "@/lib/db/db-path";
import { resolveEarningsReleaseTime } from "@/lib/earnings/wire-times";
import {
  getArmedWorksheetEvents,
  type ArmedWorksheetEventRow,
} from "@/lib/queries/earnings-worksheet-flags";

import { compileContracts } from "./contracts";
import { effectiveWindow, windowToIso, type EffectiveWindow } from "./window";
import { acquisitionScheduler, type PassReason } from "./scheduler";
import { runGoRequest, safeErrorText } from "./go";
import {
  createDjPollState,
  formatTwsDateTime,
  pollDjNews,
  type DjPollOutput,
  type DjPollState,
  type IBApiLike,
} from "./dj-adapter";
import { pollEdgar, resolveCik, type EdgarFiling } from "./edgar-adapter";
import { extractCandidates, extractCandidatesFromPdf } from "./extract";
import { irBaselineFingerprint } from "./ir-baseline-step";
import { isAllowedIrLinkHost, pollIrPage, type IrPageConfig } from "./ir-page-adapter";
import { IR_RSS_CONFIGS, pollIrRss, type IrRssConfig } from "./ir-rss-adapter";
import { reconcile } from "./reconcile";
import { htmlToRawText, htmlToTablesRepresentation } from "./representations";
import {
  acquireWatcherLease,
  failCappedGoRequests,
  getPrintById,
  latestGoRequest,
  listForcedLivePrints,
  listTakeableGoRequests,
  ELIGIBLE_SQL,
  isDocumentEligible,
  claimDocumentParse,
  finalizeDocumentParse,
  getDocument,
  getSheet,
  hasParsableDocuments,
  listActivePrints,
  listDocuments,
  listParseQueue,
  listTodaysExpiredPrints,
  setPrintState,
  upsertLines,
  upsertPrint,
  getPrintWatchSource,
  hasIrBaseline,
  listIrSeenLinks,
  recordIrSeenLinks,
  PARSE_CLAIM_STALE_MS,
} from "./store";
import { recordDelivery, sha256Hex, type DeliveryInput } from "./delivery";
import { classifyBytes, hardenedFetchBytes } from "./url-fetch";
import { redactUrl } from "./hardened-fetch";
import {
  checkPdfBytes,
  checkPdfText,
  resolvePdftotextPath,
  runPdftotext,
  textPathFor,
  PdfEncryptedError,
  PdfToolMissingError,
  PDFTOTEXT_SETTING_KEY,
} from "./pdf";
import type { FetchLike } from "./hardened-fetch";
import type {
  DocumentRow,
  GoRequestStatus,
  LineContract,
  ExpectedValue,
  ParseCandidate,
  PrintRow,
  PrintWatchDocKind,
  PrintWatchLine,
  PrintWatchState,
  RoadReport,
  TaggedCandidate,
} from "./types";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

// The window itself now lives in ONE place (`./window.ts`, spec §4.3):
// scheduled ± forced ± extension, pooled over whichever terms the print ROW
// carries. Nothing here recomputes it — `windowForPrint` re-reads the row on
// every pass, so a go press or an extension written by ANOTHER process is
// honoured with no cache to invalidate.

/** In-window poll cadence (spec §4.2). Exported for the tests. */
export const CADENCE_MS = 10_000;

const LEASE_TTL_MS = 60_000;
export const LEASE_RENEW_MS = 20_000;
const LEASE_SETTINGS_KEY = "print_watch_lease";

/**
 * How long ONE road of a pass may take before it is CANCELLED. The former
 * `SOURCE_TIMEOUT_MS`, unchanged in value — what changed is that the deadline
 * now aborts the road's signal (so `hardenedFetchBytes` closes the socket and
 * the throttle slot comes back) instead of merely walking away from it.
 */
export const ROAD_TIMEOUT_MS = 15_000;

/** How often the lease owner sweeps for go requests ANY process queued. */
export const GO_DISPATCH_MS = 2_000;

/**
 * A failed parse is retried, but never on the very next tick: three retries
 * inside 30 seconds all fail for the SAME transient reason (a model 529, a
 * half-written file) and would burn the document's whole retry budget in half
 * a minute (review round 1, minor #5). Attempts are spaced instead, and the
 * count cap survives as the model-budget guard.
 */
const PARSE_RETRY_SPACING_MS = 30_000;
const MAX_PARSE_ATTEMPTS = 5;

/** Booked on a document whose LAST claim was abandoned by a dead worker —
 *  the terminal state that lets a person's re-delivery revive it. */
const ABANDONED_CLAIM_ERROR = "abandoned claim at the attempt cap";

/**
 * Flash candidates come off the DJ wire, which produces no document — but
 * `TaggedCandidate.doc_id` is a required number. They carry this sentinel
 * through reconciliation (so `byLowestDocId` still works) and the resulting
 * line's `source_doc_id` is nulled before it reaches the store: that column is
 * a real FK to `print_watch_documents(id)` and 0 is not a row.
 */
const FLASH_DOC_ID = 0;

// ---------------------------------------------------------------------------
// public types
// ---------------------------------------------------------------------------

export interface ArmedEventDto {
  eventId: number;
  symbol: string;
  eventDate: string;
  conId: number | null;
  /** The securities row behind the event, when there is one. An armed event on
   *  an UNHELD name arrives with `conId === null` — contract enrichment only
   *  ever walked HELD securities — and this is the handle the DJ lane uses to
   *  ask TWS for the missing contract id (the 2026-09-02 SNOW miss). */
  securityId: number | null;
  cik: string | null;
  /**
   * The BMO/AMC slot default backstops a missing resolution (Codex #19), with
   * ONE exception (review round 1, minor #8): a TAS row — "during trading",
   * a genuinely different category from BMO/AMC — that resolves to nothing
   * stays null. Guessing 16:15 for it would open a window at the wrong hour
   * and quietly claim coverage the watcher does not have; a null here means
   * "no auto window, drop-zone only".
   */
  releaseTimeEt: string | null;
}

export interface WatchStatusRow {
  printId: number;
  /** The calendar_events.id this print was armed from — POST /accept and
   *  POST /drop both key on this, not printId. */
  eventId: number;
  symbol: string;
  state: PrintWatchState;
  /** Per-source last outcome, plain short strings for the panel's ladder. */
  sources: Record<string, string>;
  /** Static capability notes (Codex #23) — what CAN and cannot fire tonight. */
  coverage: string[];
  /** ISO UTC of the FIRST go press, or null — the once-only forced stamp. */
  forcedOpenAt: string | null;
  /** ISO UTC end an "Extend 30 min" press wrote, or null. */
  windowExtendedUntil: string | null;
  /** The ONE window (`effectiveWindow`), as ISO UTC — null for an unresolved
   *  TAS row nobody pressed (drop-zone only). */
  effectiveWindow: { start: string; end: string } | null;
  /** The most recent durable go request for this print, if any. */
  goRequest: {
    id: number;
    status: GoRequestStatus;
    attempts: number;
    requestedAt: string;
    result: RoadReport[] | null;
  } | null;
}

/**
 * What actually happened to a set of acquired bytes — the drop route forwards
 * this verbatim so the panel can say something true and final.
 *
 *  - `parsed`    — the document is eligible and its parse was awaited and
 *                  landed on the sheet.
 *  - `rejected`  — stored as evidence, with the gate's verdict on the row
 *                  (content) or on the delivering road; never parsed.
 *  - `duplicate` — these exact bytes are already this print's; nothing re-ran.
 *  - `queued`    — stored and eligible, but the parse did NOT run: another
 *                  process holds the watcher lease, so the drain deferred to
 *                  the owner (fix wave, finding C). Saying "parsed" here was a
 *                  lie the desk could not see through — the sheet had not
 *                  moved and nothing on screen said so.
 *  - `refused`   — NOTHING was stored (plan M11): the bytes are not a document
 *                  this subsystem can read at all — binary, or a PDF that is
 *                  encrypted, oversize, over 60 pages, image-only, or that
 *                  poppler is not installed to read. A refusal is about the
 *                  FILE, so there is no document row to point at and `docId`
 *                  is 0.
 *  - `parse_failed` — stored and eligible, the parse ATTEMPT ran and failed
 *                  (M15). `rejectReason` carries the durable
 *                  `parse_last_error`, and the document is queued for another
 *                  attempt unless its budget is spent.
 */
export type IngestOutcome =
  | "parsed"
  | "rejected"
  | "duplicate"
  | "queued"
  | "refused"
  | "parse_failed";

export interface IngestResult {
  /** 0 on `refused` — nothing was stored, so there is no row to name. */
  docId: number;
  isNew: boolean;
  outcome: IngestOutcome;
  /** Present on `rejected` (the gate's plain-language reason), on `refused`
   *  (why the file is unreadable) and on `parse_failed` (`parse_last_error`). */
  rejectReason?: string;
}

import { validateDocForEvent, type DocGateContext, type DocGateVerdict } from "./gate";
export { validateDocForEvent };
export type { DocGateContext, DocGateVerdict };

export interface WatcherSeams {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Root of the acquired-bytes tree; `<root>/<printId>/<sha256>.<ext>`. */
  storageRoot: () => string;
  twsConnection: () => Promise<{ up: boolean; ib: IBApiLike | null }>;
  /** The RAW fetch the acquisition scheduler wraps (`fetchFor`). Injected so a
   *  test can hand the SEC lane an abort-aware fake and never open a socket. */
  fetchImpl: FetchLike;
  pollDjNews: (
    ib: IBApiLike,
    conId: number,
    windowStartUtc: string,
    nowUtc: string,
    state: DjPollState,
    nowMs: number,
    signal?: AbortSignal,
  ) => Promise<DjPollOutput>;
  resolveCik: (symbol: string, fetchFn?: FetchLike) => Promise<string | null>;
  /** Ask TWS for a security's IB contract id (and persist it). Null = TWS
   *  answered but knows no contract for this row. */
  resolveConId: (db: Database.Database, securityId: number) => Promise<number | null>;
  pollEdgar: (
    cik: string,
    windowStartIso: string,
    windowEndIso: string,
    seenAccessions: Set<string>,
    fetchFn?: FetchLike,
  ) => Promise<EdgarFiling[]>;
  pollIrRss: (
    cfg: IrRssConfig,
    seenLinks: Set<string>,
    baseline: boolean,
    fetchFn?: FetchLike,
  ) => Promise<Array<{ title: string; link: string; html: string }>>;
  /** The SSRF-hardened reader for the stored IR page road — the newsroom page
   *  itself and every release link followed off it. The lane always wraps this
   *  with its `allowHost` predicate before handing it on (M17). */
  fetchBytes: typeof hardenedFetchBytes;
  extractCandidates: (contracts: LineContract[], representationText: string) => Promise<ParseCandidate[]>;
  /** Reading ONE of a PDF: poppler's text layer for the file at `pdfPath`.
   *  Takes the db because WHERE poppler lives is a setting. */
  pdfToText: (db: Database.Database, pdfPath: string) => Promise<string>;
  /** Reading TWO of a PDF: the bytes themselves, as a Claude document block. */
  extractCandidatesFromPdf: (contracts: LineContract[], bytes: Buffer) => Promise<ParseCandidate[]>;
}

// ---------------------------------------------------------------------------
// seams
// ---------------------------------------------------------------------------

/**
 * The app's ONE TWS connection, reached the same way `lib/tws/wsh.ts` does
 * (IBApiNext keeps the raw IBApi on a `private readonly api` field that
 * TypeScript, not the runtime, protects). Imported lazily so neither tests nor
 * the sweep pull @stoqey/ib in just by importing this module.
 */
async function defaultTwsConnection(): Promise<{ up: boolean; ib: IBApiLike | null }> {
  try {
    const client = await import("@/lib/tws/client");
    if (client.getTwsStatus().state !== "connected") return { up: false, ib: null };
    const next = client.getIbApi();
    if (!next) return { up: false, ib: null };
    const raw = (next as unknown as { api?: IBApiLike }).api ?? null;
    return { up: raw !== null, ib: raw };
  } catch {
    return { up: false, ib: null };
  }
}

/**
 * The conId backfill for an armed-but-unheld name. `enrichSecurities` is the
 * app's ONE contract-details resolver (it persists `ib_con_id` on the row), so
 * this asks it for exactly this security and then re-reads what it stored —
 * no second resolver, and the fix sticks for intel and the reaction snapshot
 * too. Imported lazily for the same reason as `defaultTwsConnection`: nothing
 * should pull @stoqey/ib in just by importing this module.
 */
async function defaultResolveConId(
  db: Database.Database,
  securityId: number,
): Promise<number | null> {
  const { enrichSecurities } = await import("@/lib/tws/contracts");
  await enrichSecurities(db, [securityId]);
  const row = db.prepare(`SELECT ib_con_id FROM securities WHERE id = ?`).get(securityId) as
    | { ib_con_id: number | null }
    | undefined;
  return row?.ib_con_id ?? null;
}

const DEFAULT_SEAMS: WatcherSeams = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  storageRoot: () => path.join(resolveDbDir(), "print-watch"),
  twsConnection: defaultTwsConnection,
  fetchImpl: (url, init) => fetch(url, init),
  pollDjNews: (ib, conId, windowStartUtc, nowUtc, state, nowMs, signal) =>
    pollDjNews(ib, conId, windowStartUtc, nowUtc, state, nowMs, signal),
  resolveCik: (symbol, fetchFn) => resolveCik(symbol, fetchFn),
  resolveConId: (db, securityId) => defaultResolveConId(db, securityId),
  pollEdgar: (cik, startIso, endIso, seen, fetchFn) => pollEdgar(cik, startIso, endIso, seen, fetchFn),
  pollIrRss: (cfg, seenLinks, baseline, fetchFn) => pollIrRss(cfg, seenLinks, fetchFn ?? fetch, { baseline }),
  fetchBytes: (url, opts) => hardenedFetchBytes(url, opts),
  extractCandidates: (contracts, text) => extractCandidates(contracts, text),
  pdfToText: async (db, pdfPath) => {
    const binary = resolvePdftotextPath(db);
    if (!binary) {
      throw new PdfToolMissingError(
        `pdftotext not found — install poppler (brew install poppler) or set settings.${PDFTOTEXT_SETTING_KEY}`,
      );
    }
    return runPdftotext(binary, pdfPath);
  },
  extractCandidatesFromPdf: (contracts, bytes) => extractCandidatesFromPdf(contracts, bytes),
};

let seams: WatcherSeams = { ...DEFAULT_SEAMS };

/**
 * TEST SEAM. Replaces the injected adapters/clock/storage AND resets every
 * piece of module state (running loops, queues, caches, the lease note) — call
 * it in `beforeEach`/`afterEach` so no loop from one test leaks into the next.
 * `null` (or `{}`) restores the production seams.
 */
export function _setTestSeams(overrides: Partial<WatcherSeams> | null): void {
  resetWatcherState();
  seams = { ...DEFAULT_SEAMS, ...(overrides ?? {}) };
}

// ---------------------------------------------------------------------------
// module state
// ---------------------------------------------------------------------------

interface PrintRuntime {
  printId: number;
  dto: ArmedEventDto;
  issuerName: string | null;
  /** The ONE effective window, re-read from the print ROW on every pass so a
   *  go/extend written by another process is honoured. `null` = no window at
   *  all (an unresolvable TAS row nobody pressed) — drop-zone only. */
  window: EffectiveWindow | null;
  live: boolean;
  burst: boolean;
  loop: Promise<void> | null;
  djState: DjPollState;
  seenAccessions: Set<string>;
  seenIrLinks: Set<string>;
  /** False until the IR feed's first (baseline) poll of this watch has come
   *  back: until then every item already in the feed is history, not evidence
   *  (fix wave, finding A). A failed first poll leaves it false, so the
   *  baseline happens on the first poll that actually reads the feed. */
  irBaselineDone: boolean;
  /** Stored-IR-page road only: link -> how many times acquiring it has been
   *  refused. A refusal is not evidence of anything, so the link is retried;
   *  at IR_REFUSAL_LIMIT it is retired (marked seen) so one poison anchor
   *  cannot spend every poll of the window re-fetching itself. */
  irRefusals: Map<string, number>;
  flashHeadlines: string[];
  seenFlashKeys: Set<string>;
  cikAttempted: boolean;
  /** Set only by a COMPLETED lookup with TWS up — a lookup skipped because
   *  TWS was down is not an attempt, and is retried when it comes back. */
  conIdAttempted: boolean;
  /** True once this print's conId came from the TWS backfill rather than the
   *  DB, so the coverage note can say where the wire got its contract. */
  conIdViaTws: boolean;
  /** Why a completed lookup failed, when it threw rather than answering. */
  conIdError: string | null;
  /** Last observed TWS state, so a coverage refresh between polls doesn't
   *  briefly drop the "TWS offline" note the panel is showing. */
  lastTwsUp: boolean | null;
}

interface PrintStatus {
  sources: Record<string, string>;
  coverage: string[];
}

const runtimes = new Map<number, PrintRuntime>();
const statuses = new Map<number, PrintStatus>();
/** printId -> the in-flight tail of that print's write chain (self-clearing). */
const queues = new Map<number, Promise<unknown>>();
/** docId -> parse attempt bookkeeping (count + when the last one started). */
const parseAttempts = new Map<number, { attempts: number; lastAtMs: number }>();
/** symbol -> resolved CIK (null = looked up and genuinely absent). */
const cikCache = new Map<string, string | null>();
/** print ids whose go request this process is running right now — one claim
 *  per print at a time, however often the dispatcher ticks. */
const goInFlight = new Set<number>();

let leaseNote: string | null = null;
let leaseRenewedAtMs = 0;
/** Does THIS process hold the watcher lease? Set by `claimLease`, cleared on
 *  every path that gives it up — the go dispatcher and `runForcedPass` both
 *  refuse to act without it. */
let leaseHeld = false;
let tmpCounter = 0;

function resetWatcherState(): void {
  for (const rt of runtimes.values()) rt.live = false;
  runtimes.clear();
  statuses.clear();
  queues.clear();
  parseAttempts.clear();
  cikCache.clear();
  goInFlight.clear();
  stopGoDispatcher();
  acquisitionScheduler.reset();
  leaseNote = null;
  leaseRenewedAtMs = 0;
  leaseHeld = false;
}

function statusFor(printId: number): PrintStatus {
  let s = statuses.get(printId);
  if (!s) {
    s = { sources: {}, coverage: [] };
    statuses.set(printId, s);
  }
  return s;
}

function errText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

// ---------------------------------------------------------------------------
// lease
// ---------------------------------------------------------------------------

function watcherHolder(): string {
  return `${process.pid}@${process.env.PORT ?? "3000"}`;
}

function readLeaseHolder(db: Database.Database): string {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(LEASE_SETTINGS_KEY) as
      | { value: string }
      | undefined;
    if (!row) return "another process";
    const parsed = JSON.parse(row.value) as { holder?: unknown };
    return typeof parsed.holder === "string" ? parsed.holder : "another process";
  } catch {
    return "another process";
  }
}

function stopAllLoops(): void {
  for (const rt of runtimes.values()) rt.live = false;
}

/**
 * Take (or renew) the lease and report whether this process may act. Used both
 * as the loop's periodic renewal and as the guard immediately before any sheet
 * write — a process that lost the lease during a model call must not write the
 * snapshot it read minutes ago over another owner's fresher work (review round
 * 1, critical #1).
 */
function claimLease(db: Database.Database): boolean {
  const nowMs = seams.now();
  if (!acquireWatcherLease(db, watcherHolder(), nowMs, LEASE_TTL_MS)) {
    leaseNote = `watcher owned by ${readLeaseHolder(db)}`;
    leaseHeld = false;
    stopAllLoops();
    stopGoDispatcher();
    return false;
  }
  leaseNote = null;
  leaseRenewedAtMs = nowMs;
  leaseHeld = true;
  // The dispatcher runs for the LIFE OF THE LEASE (Codex round 1, finding #1),
  // not just while somebody is calling `ensurePrintWatch`: a go request queued
  // by another process — the panel's route in a second server, a sweep tick —
  // has to be claimed by whoever owns the watcher, idle or not.
  ensureGoDispatcher(db);
  return true;
}

/** Does this process own the watcher right now? */
function holdsLease(): boolean {
  return leaseHeld;
}

/** Renewal is due every 20s. Called between sources, not just once per tick,
 *  so one slow source can't push the renewal past the 60s TTL. */
function renewLeaseIfDue(db: Database.Database): boolean {
  if (seams.now() - leaseRenewedAtMs < LEASE_RENEW_MS) return true;
  return claimLease(db);
}

// ---------------------------------------------------------------------------
// armed events -> DTO
// ---------------------------------------------------------------------------

/** BMO/AMC slot, mirroring `wire-times.ts::deriveKnownSlot` (not exported there):
 *  an explicit event_time wins, else the vendor's `raw_json.entry.hour`. */
function deriveSlot(row: { event_time: string | null; raw_json: string | null }): "bmo" | "amc" | null {
  const explicit = row.event_time?.trim().toUpperCase();
  if (explicit === "BMO") return "bmo";
  if (explicit === "AMC") return "amc";
  if (!row.raw_json) return null;
  try {
    const parsed = JSON.parse(row.raw_json) as { entry?: { hour?: unknown } };
    const hour = normalizeEarningsHour(parsed.entry?.hour);
    return hour === "bmo" || hour === "amc" ? hour : null;
  } catch {
    return null;
  }
}

export function buildArmedEventDto(db: Database.Database, row: ArmedWorksheetEventRow): ArmedEventDto {
  const resolved = resolveEarningsReleaseTime(db, {
    event_type: row.event_type,
    event_time: row.event_time,
    raw_json: row.raw_json,
    symbol: row.symbol,
  });
  const slot = deriveSlot(row);
  const isTas = row.event_time?.trim().toUpperCase() === "TAS";
  // Codex #19: a window needs a time, so the slot default is the last line of
  // defence — BMO lands on 08:00, everything else on the 16:15 convention
  // already used by earningsHourToReleaseTime. EXCEPT an unresolvable TAS row
  // (review round 1, minor #8): "during trading" is its own category, and the
  // cascade already refuses to consult the symbol's BMO/AMC history for it —
  // inventing 16:15 here would open a window at an hour nobody predicted.
  const releaseTimeEt =
    resolved && /^\d{2}:\d{2}$/.test(resolved)
      ? resolved
      : isTas
        ? null
        : slot === "bmo"
          ? "08:00"
          : "16:15";

  return {
    eventId: row.eventId,
    symbol: row.symbol,
    eventDate: row.event_date,
    conId: row.con_id ?? null,
    securityId: row.security_id ?? null,
    cik: cikCache.get(row.symbol.toUpperCase()) ?? null,
    releaseTimeEt,
  };
}

/**
 * The ONE window (spec §4.3): scheduled ± forced ± extension, read from the
 * print ROW rather than from the DTO — so a go press or an "Extend 30 min"
 * written by ANOTHER process is seen at the very next pass (M-C2), with no
 * cache to invalidate and no message to miss.
 */
function windowForPrint(db: Database.Database, printId: number): EffectiveWindow | null {
  const row = getPrintById(db, printId);
  return row ? effectiveWindow(row) : null;
}

// ---------------------------------------------------------------------------
// local reads (store.ts is task-1-owned; these are watcher-local lookups)
// ---------------------------------------------------------------------------

function readPrintRow(db: Database.Database, printId: number): PrintRow | null {
  const row = db.prepare(`SELECT * FROM print_watch_prints WHERE id = ?`).get(printId) as
    | PrintRow
    | undefined;
  return row ?? null;
}

function readIssuerName(db: Database.Database, symbol: string): string | null {
  const row = db
    .prepare(`SELECT name FROM securities WHERE UPPER(symbol) = UPPER(?) LIMIT 1`)
    .get(symbol) as { name: string | null } | undefined;
  return row?.name ?? null;
}

/**
 * The identity the gate judges a document against. No `kind` any more: the
 * CONTENT verdict is about the bytes and must be the same whichever road
 * carried them (089/M13 — one document, many roads), and the per-road verdict
 * is computed by `recordDelivery` from the kind it was handed.
 */
function gateContextFor(db: Database.Database, print: PrintRow): DocGateContext {
  const rt = runtimes.get(print.id);
  return {
    symbol: print.symbol,
    issuerName: rt ? rt.issuerName : readIssuerName(db, print.symbol),
    eventDate: print.event_date,
  };
}

// ---------------------------------------------------------------------------
// reconcile: armed events <-> prints
// ---------------------------------------------------------------------------

function pendingLines(
  contracts: LineContract[],
  expected: Record<string, ExpectedValue>,
): PrintWatchLine[] {
  return contracts.map((contract) => ({
    metric_id: contract.metric_id,
    contract,
    expected: expected[contract.metric_id] ?? null,
    state: "pending",
    value: null,
    value_high: null,
    snippet: null,
    source_doc_id: null,
    candidates_json: "[]",
  }));
}

function desiredState(current: PrintWatchState, nowMs: number, rt: PrintRuntime): PrintWatchState {
  // No window (unresolvable TAS): the print never opens and never expires on
  // a clock — it waits at `scheduled` for a drop.
  if (!rt.window) {
    return current === "acquired" || current === "parsed" ? current : "scheduled";
  }
  if (nowMs > rt.window.endMs) return current === "parsed" ? "parsed" : "expired";
  if (current === "acquired" || current === "parsed") return current;
  return nowMs >= rt.window.startMs ? "window_open" : "scheduled";
}

/** Never downgrade evidence: a document that landed after the window still
 *  moves the print forward, but a disarmed print stays disarmed. */
function advanceState(db: Database.Database, printId: number, next: "acquired" | "parsed"): void {
  const row = readPrintRow(db, printId);
  if (!row) return;
  if (row.state === "disarmed") return;
  if (row.state === "parsed" && next === "acquired") return;
  if (row.state !== next) setPrintState(db, printId, next);
}

function refreshCoverage(db: Database.Database, rt: PrintRuntime, twsUp: boolean | null): void {
  if (twsUp !== null) rt.lastTwsUp = twsUp;

  // No window means no source ever polls for this print — say exactly that
  // rather than listing capabilities that will never fire (review round 1,
  // minor #8).
  if (!rt.window) {
    statusFor(rt.printId).coverage = [
      "TAS — release time unknown; drop-zone only",
      "drop: HTML/text/PDF, or a pasted link",
    ];
    return;
  }

  const notes: string[] = [];
  notes.push(`DJ: ${djNote(rt)}`);
  if (rt.lastTwsUp === false) notes.push("TWS offline");
  if (rt.dto.cik) notes.push(`EDGAR: CIK ${rt.dto.cik}`);
  else notes.push(rt.cikAttempted ? "EDGAR: CIK unresolved" : "EDGAR: CIK pending");
  // Read fresh rather than cached on the runtime: a PUT /sources mid-window
  // must show up on the panel without restarting the app, and the lane itself
  // re-reads the row on every poll for the same reason.
  if (irConfigFor(rt.dto.symbol)) notes.push(`RSS: ${rt.dto.symbol} IR feed`);
  else notes.push(irPageNote(db, rt.dto.symbol));
  notes.push("drop: HTML/text/PDF, or a pasted link");
  statusFor(rt.printId).coverage = notes;
}

/** What the stored-IR-page road can do for this symbol, in one phrase. */
function irPageNote(db: Database.Database, symbol: string): string {
  const source = getPrintWatchSource(db, symbol);
  if (!source) return "IR: none configured";
  try {
    return `IR: ${new URL(source.ir_page_url).hostname}`;
  } catch {
    // A stored row that no longer parses is a configuration fault, not a
    // crash: say so on the panel instead of throwing out of a status refresh.
    return "IR: stored page is not a URL";
  }
}

/**
 * What the DJ lane can actually do for this print, in one phrase — shared by
 * the coverage list and `sources.dj` so the panel can never show two different
 * stories about the same wire.
 */
function djNote(rt: PrintRuntime): string {
  if (rt.dto.conId !== null) {
    return rt.conIdViaTws ? "wire armed (conId resolved via TWS)" : "wire armed";
  }
  if (rt.conIdAttempted) {
    return rt.conIdError
      ? `no conId — TWS lookup failed for ${rt.dto.symbol}: ${rt.conIdError}, wire off`
      : `no conId — TWS could not resolve ${rt.dto.symbol}, wire off`;
  }
  if (rt.dto.securityId === null) return "no conId — wire off";
  if (rt.lastTwsUp === false) return "no conId — TWS offline, wire off";
  return "no conId — TWS lookup pending, wire off";
}

function irConfigFor(symbol: string): IrRssConfig | null {
  return IR_RSS_CONFIGS.find((c) => c.symbol.toUpperCase() === symbol.toUpperCase()) ?? null;
}

/**
 * The idempotent reconciler — the ONE function callers touch. Every run:
 * takes/renews the lease, diffs armed events against prints (new armed →
 * print + pending sheet; no longer armed → `disarmed`; past the window →
 * `expired`), and makes sure exactly the in-window prints have a live loop.
 * Safe to call as often as the panel likes; it never starts a second loop for
 * a print that already has one.
 */
export function ensurePrintWatch(db: Database.Database): void {
  if (!claimLease(db)) return;

  const nowMs = seams.now();
  const today = todayET(new Date(nowMs));
  const dates = [addDays(today, -1), today, addDays(today, 1)];
  const armed = getArmedWorksheetEvents(db, dates);

  // A print whose FORCED window is live is reconciled whatever its event date
  // (Codex round 1, finding #18): the desk pressing "print is live" IS the
  // evidence, and a stale calendar date must not strand the watch that press
  // opened. Their events are fetched by date the same way the armed set is.
  const forcedPrints = listForcedLivePrints(db, nowMs);
  const forcedEventIds = new Set(forcedPrints.map((p) => p.event_id));
  const forcedPrintIds = new Set(forcedPrints.map((p) => p.id));
  const extraDates = Array.from(new Set(forcedPrints.map((p) => p.event_date))).filter(
    (d) => !dates.includes(d),
  );
  if (extraDates.length > 0) {
    const known = new Set(armed.map((r) => r.eventId));
    for (const row of getArmedWorksheetEvents(db, extraDates)) {
      if (!known.has(row.eventId) && forcedEventIds.has(row.eventId)) armed.push(row);
    }
  }
  const armedEventIds = new Set(armed.map((r) => r.eventId));

  const armedPrintIds = new Set<number>(forcedPrintIds);
  /** Prints with no live loop of their own — see drainStrandedPrints. */
  const strandedPrintIds = new Set<number>();

  for (const row of armed) {
    const dto = buildArmedEventDto(db, row);

    const printId = upsertPrint(db, dto.eventId, dto.symbol, dto.eventDate, dto.releaseTimeEt);
    armedPrintIds.add(printId);
    // The window comes from the ROW, AFTER the upsert — it pools the scheduled
    // term with the forced stamp and any extension. A print with no window at
    // all still EXISTS: the drop zone is the road for it, and the panel needs a
    // row to drop onto.
    const window = windowForPrint(db, printId);

    // Recompile while the sheet is still untouched — bogeys are usually
    // curated AFTER arming, and a pre-print re-arm should pick up new
    // consensus/segments. The moment any evidence exists the sheet is left
    // alone: rewriting it here would reset reconciled states to `pending`.
    const sheet = getSheet(db, printId);
    const untouched =
      sheet.length === 0 || sheet.every((l) => l.state === "pending" && l.candidates_json === "[]");
    if (untouched) {
      const { contracts, expected } = compileContracts(db, dto.eventId, dto.symbol);
      upsertLines(db, printId, pendingLines(contracts, expected));
    }

    let rt = runtimes.get(printId);
    if (!rt) {
      rt = {
        printId,
        dto,
        issuerName: row.issuer_name,
        window,
        live: false,
        burst: false,
        loop: null,
        djState: createDjPollState(),
        seenAccessions: new Set(),
        // Seeded from the DURABLE seen-set (the ir_baseline step's snapshot of
        // what the newsroom already held, plus anything a previous process
        // ingested). A fresh process that started with an empty set would read
        // last quarter's permanently-parked post as tonight's print.
        seenIrLinks: new Set(listIrSeenLinks(db, dto.eventId).map((l) => l.link)),
        irBaselineDone: false,
        irRefusals: new Map(),
        flashHeadlines: [],
        seenFlashKeys: new Set(),
        cikAttempted: false,
        conIdAttempted: false,
        conIdViaTws: false,
        conIdError: null,
        lastTwsUp: null,
      };
      runtimes.set(printId, rt);
    } else {
      // Keep the runtime's learned CIK and conId; everything else re-derives.
      // (The backfill persists `ib_con_id`, so `dto.conId` normally already
      // carries it — this covers the sweep that races the write.)
      rt.dto = { ...dto, cik: rt.dto.cik ?? dto.cik, conId: dto.conId ?? rt.dto.conId };
      rt.issuerName = row.issuer_name;
      rt.window = window;
    }

    const current = readPrintRow(db, printId)?.state ?? "scheduled";
    const next = desiredState(current, nowMs, rt);
    if (next !== current) setPrintState(db, printId, next);

    const inWindow =
      rt.window !== null && nowMs >= rt.window.startMs && nowMs <= rt.window.endMs;
    if (inWindow && next !== "expired") startLoop(db, rt);
    else rt.live = false;

    // A drop-zone-only (TAS) print never gets a loop, so a document queued
    // behind a lease it lost has nothing else to come back for it.
    if (rt.window === null) strandedPrintIds.add(printId);

    refreshCoverage(db, rt, null);
  }

  for (const print of listActivePrints(db)) {
    if (armedEventIds.has(print.event_id)) continue;
    // An unarmed print with a LIVE forced window is treated as armed for this
    // pass — the press armed it, and disarming it here would close the watch
    // the desk just opened (finding #18).
    if (forcedEventIds.has(print.event_id)) continue;
    // An active print with no armed flag is either a genuine disarm or a
    // leftover whose day has passed (the app was closed through its window) —
    // call the stale one `expired`, which is what actually happened to it.
    setPrintState(db, print.id, print.event_date < today ? "expired" : "disarmed");
    // Stand the loop down but KEEP the runtime (review round 1, important #2):
    // deleting it while its task is mid-await means a re-arm — a user flap, or
    // a calendar sync flipping `superseded` under us — builds a SECOND runtime
    // and a second loop, with a fresh djState that re-emits every flash. The
    // runtime is dropped later, by retireFinishedRuntimes, once its task has
    // actually exited.
    const rt = runtimes.get(print.id);
    if (rt) rt.live = false;
  }

  // Today's expired prints keep their drop road open (getWatchStatus still
  // lists them) but have no loop: this is the pass that parses whatever they
  // acquired while somebody else held the lease.
  for (const print of listTodaysExpiredPrints(db, today)) strandedPrintIds.add(print.id);
  drainStrandedPrints(db, strandedPrintIds);

  retireFinishedRuntimes(db, armedPrintIds);

  // Slice C: go requests queued by ANY process are claimed here, by the lease
  // owner (M-C3). The 2-second dispatcher `claimLease` armed above keeps doing
  // it for the life of the lease; this call is the immediate one, so a press
  // that reached this process is acted on now rather than a tick from now.
  void dispatchGoRequests(db);
}

/**
 * Drop the in-memory state of prints that are no longer armed AND whose loop
 * has exited and whose write chain has drained (review round 1, minor #9).
 * Nothing here touches the DB rows — this is purely the process-local
 * bookkeeping that would otherwise grow for the life of the server.
 */
function retireFinishedRuntimes(db: Database.Database, armedPrintIds: Set<number>): void {
  for (const [printId, rt] of Array.from(runtimes.entries())) {
    if (armedPrintIds.has(printId)) continue;
    if (rt.loop !== null || queues.has(printId)) continue; // still winding down

    runtimes.delete(printId);
    statuses.delete(printId);
    try {
      for (const doc of listDocuments(db, printId)) parseAttempts.delete(doc.id);
    } catch {
      // Bookkeeping only — a failed read here must never break the sweep.
    }
  }
}

/**
 * Read-only status for the panel (Codex #9 — the GET route must not mutate).
 *
 * Returns the ACTIVE prints plus today's EXPIRED ones (final fix wave). An
 * expired print is not a finished print: the window closing means the wire
 * never delivered, which is precisely when the desk reaches for the drop zone
 * — and a row that has vanished from the panel cannot be dropped onto. The
 * whole manual road stays open behind it: `getPrintByEventId` (the drop
 * route's lookup) has no state filter, and `advanceState` refuses only
 * `disarmed`, so an expired print still moves expired → acquired → parsed on a
 * drop. Today's date is the cutoff — yesterday's misses are history, not work.
 *
 * The widening lives HERE and not in `listActivePrints` on purpose: that query
 * also feeds `ensurePrintWatch`'s stale-print pass, which would re-walk every
 * expired row through the disarm/expire branch on each sweep.
 */
export function getWatchStatus(db: Database.Database): WatchStatusRow[] {
  const todayEt = todayET(new Date(seams.now()));
  const prints = [...listActivePrints(db), ...listTodaysExpiredPrints(db, todayEt)].sort(
    (a, b) => a.event_date.localeCompare(b.event_date) || a.id - b.id,
  );
  return prints.map((print) => {
    const status = statuses.get(print.id);
    const sources = { ...(status?.sources ?? {}) };
    if (leaseNote) sources.watcher = leaseNote;
    return {
      printId: print.id,
      eventId: print.event_id,
      symbol: print.symbol,
      state: print.state,
      sources,
      coverage: status?.coverage ?? [],
      forcedOpenAt: print.forced_open_at,
      windowExtendedUntil: print.window_extended_until,
      effectiveWindow: windowToIso(effectiveWindow(print)),
      goRequest: latestGoRequestFor(db, print.id),
    };
  });
}

/** The latest durable go request for a print, with its per-road reports
 *  decoded. A `result_json` that will not parse reads as "no reports yet"
 *  rather than taking a read-only status route down. */
function latestGoRequestFor(
  db: Database.Database,
  printId: number,
): WatchStatusRow["goRequest"] {
  const g = latestGoRequest(db, printId);
  if (!g) return null;
  let result: RoadReport[] | null = null;
  try {
    const parsed: unknown = g.result_json ? JSON.parse(g.result_json) : null;
    result = Array.isArray(parsed) ? (parsed as RoadReport[]) : null;
  } catch {
    result = null;
  }
  return {
    id: g.id,
    status: g.status,
    attempts: g.attempts,
    requestedAt: g.requested_at,
    result,
  };
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

function startLoop(db: Database.Database, rt: PrintRuntime): void {
  // A task that exists — even one parked in its cadence sleep after being
  // told to stop — is RESUMED rather than replaced. Starting a second task
  // alongside a winding-down one is the only way this design could ever run
  // two overlapping polls for a print (lease-loss immediately followed by a
  // re-acquire is the realistic path there).
  if (rt.loop) {
    rt.live = true;
    return;
  }
  rt.live = true;

  const task = (async () => {
    let reason: PassReason = "cadence";
    while (rt.live) {
      try {
        // The scheduler owns pass coalescing: one pass at a time per print, and
        // a pass requested while one runs is remembered ONCE and runs after.
        await acquisitionScheduler.runPass(rt.printId, (signal) => pass(db, rt, signal), reason);
      } catch (err) {
        statusFor(rt.printId).sources.loop = errText(err);
      }
      if (!rt.live) break;
      if (rt.burst) {
        // A hit on any road makes the others worth re-reading NOW.
        rt.burst = false;
        reason = "burst";
        continue;
      }
      const woke = await cadenceWait(rt.printId);
      reason = woke === "timeout" ? "cadence" : woke;
      if (woke !== "timeout") {
        // R-C10: the reported reason is INFORMATIONAL ONLY — the scheduler
        // keeps the FIRST remembered reason, so a burst remembered ahead of a
        // user's go press surfaces as "burst". Every wake therefore does both
        // things a go needs: it runs a dispatcher tick, and the pass below
        // re-reads the print row's effective window.
        void dispatchGoRequests(db);
      }
    }
  })();

  // The task itself must never reject unhandled, and `rt.loop` must be cleared
  // no matter how it ends — a crashed loop that left a stale handle behind
  // could never be restarted (review round 1, minor #10).
  const guarded: Promise<void> = task
    .catch((err) => {
      console.warn(`[print-watch] watch loop for print ${rt.printId} crashed:`, err);
      statusFor(rt.printId).sources.loop = `loop crashed: ${errText(err)}`;
    })
    .finally(() => {
      if (rt.loop !== guarded) return; // already superseded
      rt.loop = null;
      // A resume that landed in the gap between the while-exit and this
      // callback would otherwise leave the print live with no task running.
      if (rt.live) startLoop(db, rt);
    });
  rt.loop = guarded;
}

/**
 * The loop's cadence sleep: `CADENCE_MS`, ended EARLY by an explicit wake (a go
 * press, an extension) so the desk never waits out a tick it just cancelled.
 *
 * The WAKE comes from the scheduler; the DEADLINE runs on the watcher's own
 * `sleep` seam, which is what keeps the cadence injectable (a replay drill runs
 * on a real clock and caps every sleep at a few milliseconds — a hard-coded ten
 * seconds there would be ten seconds of wall time per pass).
 *
 * When the deadline wins it DRAINS its own parked waiter with a `wake`: a wake
 * delivered to a parked waiter is consumed, never remembered, so leaving an
 * abandoned waiter behind would let it swallow the next go press.
 */
async function cadenceWait(printId: number): Promise<PassReason | "timeout"> {
  let woken = false;
  const wake = acquisitionScheduler.waitForWake(printId, CADENCE_MS).then((reason) => {
    woken = true;
    return reason;
  });
  const deadline = seams.sleep(CADENCE_MS).then(() => {
    if (!woken) acquisitionScheduler.wake(printId, "cadence");
    return "timeout" as const;
  });
  const first = await Promise.race([wake, deadline]);
  // The deadline's own `wake` resolves the wait branch with "cadence"; report
  // it as the timeout it actually is.
  return first === "cadence" ? "timeout" : first;
}

/** The three automatic roads, in the order every report lists them. */
const ROADS = ["dj", "edgar", "ir"] as const;
type RoadName = (typeof ROADS)[number];

/**
 * One acquisition pass (spec §4.3 "Scheduler").
 *
 * The three roads run in PARALLEL under `Promise.allSettled`, each on its own
 * linked `AbortSignal` with a per-road timer, so a stalled EDGAR never delays a
 * DJ ingest and a hung request is CANCELLED rather than merely abandoned. Lease
 * renewal rides a timer for the whole pass — started BEFORE the parse drain,
 * which is the long phase (a model call is minutes, not seconds) — and losing
 * the lease aborts every road at once.
 *
 * Returns one `RoadReport` per road: what a go request records, built from
 * outcomes observed in THIS pass, never from a previous one.
 */
async function pass(db: Database.Database, rt: PrintRuntime, signal: AbortSignal): Promise<RoadReport[]> {
  const status = statusFor(rt.printId);
  if (!renewLeaseIfDue(db)) return skippedReports("lease lost");

  // A go/extend written by ANOTHER process changes the ROW, not our memory.
  rt.window = windowForPrint(db, rt.printId);
  const window = rt.window;
  if (!window) {
    rt.live = false; // drop-zone-only print: nothing to poll
    return skippedReports("no window");
  }
  if (seams.now() > window.endMs) {
    rt.live = false;
    const current = readPrintRow(db, rt.printId)?.state;
    if (current && current !== "parsed" && current !== "disarmed") {
      setPrintState(db, rt.printId, "expired");
    }
    return skippedReports("window closed");
  }

  const passController = new AbortController();
  const passSignal = AbortSignal.any([signal, passController.signal]);
  // Armed before ANY awaited work (Codex round 1, finding #11): the drain below
  // can outlast the 60s lease TTL on its own. A renewal that THROWS aborts the
  // pass exactly like one that returns false — it must never escape a timer
  // callback and take the process down.
  const renew = setInterval(() => {
    try {
      if (!renewLeaseIfDue(db)) passController.abort(new Error("watcher lease lost mid-pass"));
    } catch (err) {
      passController.abort(err instanceof Error ? err : new Error(String(err)));
    }
  }, LEASE_RENEW_MS);

  const notes: Record<RoadName, string> = { dj: "", edgar: "", ir: "" };
  // The RSS lane keeps its own ladder key (the panel labels it "RSS"), but it
  // IS the IR road as far as a go report is concerned (finding #12).
  const irKey = irConfigFor(rt.dto.symbol) ? "rss" : "ir";
  const keyFor = (road: RoadName) => (road === "ir" ? irKey : road);
  let twsUp: boolean | null = null;
  try {
    // Crash recovery (Codex #6): anything a previous process acquired but never
    // parsed gets drained on every pass, not just at ingest time.
    await runQueue(db, rt.printId);

    const settled = await Promise.allSettled([
      withRoad("dj", passSignal, async (s) => {
        twsUp = await pollDjSource(db, rt, window, s);
      }),
      withRoad("edgar", passSignal, (s) => pollEdgarSource(db, rt, window, s)),
      withRoad("ir", passSignal, (s) => pollIrSource(db, rt, s)),
    ]);

    const reports: RoadReport[] = ROADS.map((road, i) => {
      const outcome = settled[i];
      if (outcome.status === "rejected") {
        notes[road] = errText(outcome.reason);
        status.sources[keyFor(road)] = notes[road];
        return { road, outcome: "failed", detail: safeErrorText(outcome.reason) };
      }
      // The lane wrote its own note during THIS pass (one pass runs at a time
      // per print), so reading it back is reading this pass's own outcome.
      notes[road] = status.sources[keyFor(road)] ?? "";
      return { road, outcome: roadOutcome(notes[road]), detail: notes[road] };
    });

    refreshCoverage(db, rt, twsUp);
    return reports;
  } catch (err) {
    // Not a road at all: the parse drain, the coverage refresh, the window read.
    return [{ road: "system", outcome: "failed", detail: safeErrorText(err) }];
  } finally {
    clearInterval(renew);
  }
}

/**
 * How a lane's plain-language note reads as a go-report outcome.
 *
 *  - `ok …` / `baseline …` — the road ran and answered;
 *  - "TWS offline", "no conId … wire off", "CIK unresolved", "no IR page
 *    configured" — the road could not run at all, which is NOT a failure the
 *    desk should chase (spec §7);
 *  - anything else — it tried and failed.
 */
function roadOutcome(note: string): string {
  if (note === "") return "skipped";
  if (/^(ok|baseline|no baseline)\b/i.test(note)) return "ok";
  if (/offline|no conId|wire off|none configured|no IR page|CIK unresolved|no window|lease lost/i.test(note)) {
    return "skipped";
  }
  return "failed";
}

function skippedReports(detail: string): RoadReport[] {
  return ROADS.map((road) => ({ road, outcome: "skipped", detail }));
}

/**
 * Run ONE road on its own linked signal.
 *
 * The per-road timer ABORTS the road (so `hardenedFetchBytes` / the throttled
 * SEC fetch close their sockets and hand back their scheduler slot) AND stops
 * waiting on it: an adapter that ignores its signal must not be able to park
 * the whole pass past the lease renewal. The pass signal reaches the road the
 * same way, so a lost lease cancels all three at once.
 */
async function withRoad<T>(
  label: string,
  parent: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ac = new AbortController();
  const signal = AbortSignal.any([parent, ac.signal]);
  const abortText = () => {
    const reason: unknown = signal.reason;
    return reason instanceof Error ? reason.message : `${label} aborted`;
  };
  let onAbort: (() => void) | null = null;
  const timer = setTimeout(
    () => ac.abort(new Error(`${label} timed out after ${ROAD_TIMEOUT_MS / 1000}s`)),
    ROAD_TIMEOUT_MS,
  );
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error(abortText()));
        return;
      }
      onAbort = () => reject(new Error(abortText()));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([run(signal), cancelled]);
  } catch (err) {
    if (signal.aborted) throw new Error(abortText());
    throw err;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Abandon a call that has stopped answering, so the pass keeps its renewal
 * cadence. Still used by the conId backfill, which reaches TWS through
 * `enrichSecurities` and takes no AbortSignal — the roads themselves are
 * cancelled properly by `withRoad` (finding #10).
 */
async function withSourceTimeout<T>(label: string, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ROAD_TIMEOUT_MS / 1000}s`)),
          ROAD_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** @returns whether TWS was up (null when DJ is off for this print). */
async function pollDjSource(
  db: Database.Database,
  rt: PrintRuntime,
  window: EffectiveWindow,
  signal: AbortSignal,
): Promise<boolean | null> {
  const status = statusFor(rt.printId);
  if (rt.dto.conId === null) {
    const twsUp = await backfillConId(db, rt);
    if (rt.dto.conId === null) {
      status.sources.dj = djNote(rt);
      return twsUp;
    }
  }
  try {
    const conn = await seams.twsConnection();
    if (!conn.up || !conn.ib) {
      status.sources.dj = "tws offline";
      return false;
    }
    const out = await seams.pollDjNews(
      conn.ib,
      rt.dto.conId,
      // The EFFECTIVE start: on a forced open that is press − 60m, so a wire
      // item that printed before the desk pressed go is still in range (M-C10).
      formatTwsDateTime(new Date(window.startMs)),
      formatTwsDateTime(new Date(seams.now())),
      rt.djState,
      seams.now(),
      signal,
    );

    for (const release of out.completedReleases) {
      rt.burst = true;
      await ingestDocument(
        db,
        rt.printId,
        "dj-release",
        `dj:${release.headline.slice(0, 120)}`,
        null,
        Buffer.from(release.stitchedText, "utf8"),
      );
      // Marked ONLY once the bytes are ingested (fix wave, finding F). An
      // ingest that throws leaves these unmarked, so the adapter keeps the
      // part group and re-emits the whole release next poll — and the sha256
      // dedupe makes a later successful re-ingest a no-op.
      for (const id of release.articleIds) rt.djState.seenArticleIds.add(id);
    }

    let freshFlashes = 0;
    const flashIds: string[] = [];
    for (const flash of out.flashes) {
      flashIds.push(flash.articleId);
      const key = `${flash.time}|${flash.headline}`;
      if (rt.seenFlashKeys.has(key)) continue;
      rt.seenFlashKeys.add(key);
      rt.flashHeadlines.push(flash.headline);
      freshFlashes += 1;
    }
    if (freshFlashes > 0) {
      rt.burst = true;
      await runFlashLane(db, rt);
    }
    // A flash is CONSUMED the moment its text joins `flashHeadlines`: the lane
    // re-reads that whole batch every time it runs, so the bullet survives a
    // failed lane run. Marking here rather than in the adapter keeps the rule
    // uniform — nothing is retired until the caller has it in hand.
    for (const id of flashIds) rt.djState.seenArticleIds.add(id);

    status.sources.dj = `ok — ${out.completedReleases.length} release(s), ${rt.flashHeadlines.length} flash(es)`;
    return true;
  } catch (err) {
    // A cancelled wire read is a deadline, not a wire fault (finding #10).
    status.sources.dj = isAbortError(err) ? "timed out — aborted" : errText(err);
    return null;
  }
}

/** An `AbortError` from any layer: the DOM-shaped one the fetch stack throws,
 *  and the scheduler's own `AbortedError`. */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Backfill a missing IB contract id for an armed print, ONCE per print per
 * process (the `cikAttempted` pattern next door).
 *
 * WHY THIS EXISTS: contract enrichment only ever selects securities that JOIN
 * holdings, so an armed earnings event on a name the desk does not own has
 * `ib_con_id IS NULL` — and a null conId turns the Dow Jones wire lane off
 * entirely. That is exactly what happened to SNOW on 2026-09-02: the panel
 * read "DJ: no conId — wire off" and the print was missed.
 *
 * TWS DOWN IS NOT AN ATTEMPT. The flag is set only after a lookup that
 * actually reached TWS, so a print armed while the socket is down still gets
 * its wire the moment the connection returns.
 *
 * @returns the observed TWS state, or null when no lookup was possible at all
 *          (already attempted, or there is no securities row to ask about).
 */
async function backfillConId(db: Database.Database, rt: PrintRuntime): Promise<boolean | null> {
  if (rt.conIdAttempted) return null;
  const securityId = rt.dto.securityId;
  if (securityId === null) return null;

  const conn = await seams.twsConnection();
  if (!conn.up) {
    rt.lastTwsUp = false;
    return false;
  }
  rt.conIdAttempted = true;
  try {
    const conId = await withSourceTimeout("conId lookup", () =>
      seams.resolveConId(db, securityId),
    );
    if (conId !== null) {
      rt.dto.conId = conId;
      rt.conIdViaTws = true;
    }
  } catch (err) {
    // Left ATTEMPTED on purpose: a resolver that throws would otherwise be
    // re-run every 10s for the whole window, and each run is a real
    // contract-details round trip to TWS.
    rt.conIdError = errText(err);
  }
  return true;
}

async function pollEdgarSource(
  db: Database.Database,
  rt: PrintRuntime,
  window: EffectiveWindow,
  signal: AbortSignal,
): Promise<void> {
  const status = statusFor(rt.printId);
  // ONE throttled fetch for the whole lane: the SEC family's 2/s budget is
  // shared across every CIK by the scheduler, and the pass signal rides every
  // request — so no hand-rolled host spacer, and a cancelled pass closes the
  // socket instead of leaving it to the runtime.
  const fetchFn = acquisitionScheduler.fetchFor(signal, seams.fetchImpl);
  try {
    if (rt.dto.cik === null && !rt.cikAttempted) {
      rt.cikAttempted = true;
      const cached = cikCache.get(rt.dto.symbol.toUpperCase());
      if (cached !== undefined) {
        rt.dto.cik = cached;
      } else {
        const cik = await seams.resolveCik(rt.dto.symbol, fetchFn);
        cikCache.set(rt.dto.symbol.toUpperCase(), cik);
        rt.dto.cik = cik;
      }
    }
    if (rt.dto.cik === null) {
      status.sources.edgar = "CIK unresolved";
      return;
    }

    const cik = rt.dto.cik;
    const filings = await seams.pollEdgar(
      cik,
      // The EFFECTIVE start, same as the wire's.
      new Date(window.startMs).toISOString(),
      new Date(seams.now()).toISOString(),
      rt.seenAccessions,
      fetchFn,
    );

    let exhibits = 0;
    for (const filing of filings) {
      for (const exhibit of filing.exhibits) {
        rt.burst = true;
        exhibits += 1;
        await ingestDocument(
          db,
          rt.printId,
          "edgar-ex99",
          `edgar:${filing.accession}:${exhibit.name}`,
          exhibit.url,
          Buffer.from(exhibit.html, "utf8"),
        );
      }
      // Marked seen HERE, not in the adapter (fix wave, finding F): the
      // accession retires only once its exhibits have actually been ingested.
      // A poll this loop abandoned on the source timeout, or an ingest that
      // threw, leaves it unmarked and the next poll picks the filing up again
      // (the sha256 dedupe makes a re-ingest a no-op).
      rt.seenAccessions.add(filing.accession);
    }
    status.sources.edgar = `ok — ${filings.length} filing(s), ${exhibits} exhibit(s)`;
  } catch (err) {
    status.sources.edgar = errText(err);
  }
}

/**
 * The IR road. Exactly one of two lanes runs for a symbol: the hardcoded RSS
 * feed if there is one (v1's NVDA newsroom, which has a real feed and a
 * curated title pattern), otherwise the per-company page the desk stored.
 * RSS keeps precedence — a stored page for NVDA would be a second, weaker
 * reading of the same newsroom.
 */
async function pollIrSource(db: Database.Database, rt: PrintRuntime, signal: AbortSignal): Promise<void> {
  const rss = irConfigFor(rt.dto.symbol);
  if (rss) return pollIrRssSource(db, rt, rss, signal);
  return pollIrPageSource(db, rt, signal);
}

/** v1's NVDA-feed lane, unchanged. */
async function pollIrRssSource(
  db: Database.Database,
  rt: PrintRuntime,
  cfg: IrRssConfig,
  signal: AbortSignal,
): Promise<void> {
  const status = statusFor(rt.printId);
  try {
    // The FIRST poll of a watch is a baseline pass: it fetches no article at
    // all, it just records what the feed already held (fix wave, finding A).
    // The flag flips only after the poll returns, so a first poll that fails
    // does not consume the baseline.
    const baseline = !rt.irBaselineDone;
    // The feed and every article it follows go through the scheduler's per-host
    // throttle, on the pass signal (finding #9) — no hand-rolled spacer.
    const items = await seams.pollIrRss(
      cfg,
      rt.seenIrLinks,
      baseline,
      acquisitionScheduler.fetchFor(signal, seams.fetchImpl),
    );
    rt.irBaselineDone = true;

    for (const item of items) {
      rt.burst = true;
      await ingestDocument(
        db,
        rt.printId,
        "ir-page",
        `ir-rss:${item.title.slice(0, 120)}`,
        item.link,
        Buffer.from(item.html, "utf8"),
      );
      // Marked seen only after the bytes are in hand and ingested (finding F).
      rt.seenIrLinks.add(item.link);
    }
    status.sources.rss = baseline
      ? `baseline — ${rt.seenIrLinks.size} existing item(s) ignored`
      : `ok — ${items.length} item(s)`;
  } catch (err) {
    status.sources.rss = errText(err);
  }
}

/** A refused or thrown link is retried on later polls; at this many refusals
 *  it is retired (marked seen) with the reason in the lane's note (M17). */
const IR_REFUSAL_LIMIT = 3;

/**
 * The stored-IR-page lane (spec section 4.2).
 *
 * THE WATCHER NEVER BASELINES (plan M5). Only the `ir_baseline` prepare step
 * does, before the window opens. Two consequences the tests pin:
 *
 *  - with a baseline, `print_watch_ir_seen` already holds last quarter's
 *    posts, so the only links this lane follows are ones that appeared AFTER
 *    arming — which is what "tonight's print" means on a newsroom page;
 *  - with NO baseline (armed late, or the step never ran), every matching link
 *    is a candidate and the strict `ir-page` period gate is what separates
 *    tonight's release from the parked one. A late go must never re-baseline:
 *    that would mark tonight's release "already there" and blind the road.
 *
 * The page is read with a SCRATCH seen-set so the adapter reports every
 * allowed matching link on the page (the count the panel shows, so a newsroom
 * that changes shape reads as "0 matching links" under the panel's own IR
 * label rather than as a quiet night); the runtime's real seen-set then
 * decides which of those are new. One fetch either way.
 */
async function pollIrPageSource(
  db: Database.Database,
  rt: PrintRuntime,
  signal: AbortSignal,
): Promise<void> {
  const status = statusFor(rt.printId);
  // Re-read every poll: a PUT /sources during the window must take effect
  // without a restart, and clearing the row must stop the lane.
  const source = getPrintWatchSource(db, rt.dto.symbol);
  if (!source) {
    status.sources.ir = "no IR page configured";
    return;
  }

  const cfg: IrPageConfig = {
    symbol: source.symbol,
    irPageUrl: source.ir_page_url,
    linkMustContain: source.link_must_contain,
  };
  let irHost: string;
  try {
    irHost = new URL(cfg.irPageUrl).hostname;
  } catch {
    status.sources.ir = `stored IR page is not a URL (${redactUrl(cfg.irPageUrl)})`;
    return;
  }

  // M17: the fixed-host policy rides on the page fetch AND on every hop of
  // every link fetch — `hardenedFetchBytes` re-checks `allowHost` after each
  // redirect, so a 302 off the allowlist is refused rather than followed.
  const allowHost = (h: string) => isAllowedIrLinkHost(`https://${h}/`, irHost);
  // Every read of this lane — the newsroom page AND each release link, hops
  // included — carries the M17 host policy, the pass signal, and the
  // scheduler's per-host slot (finding #9).
  const fetchBytes: typeof hardenedFetchBytes = (url, opts) =>
    throttledFetchBytes(url, { ...opts, allowHost, signal });

  const refusals: string[] = [];
  try {
    const baselined = hasIrBaseline(db, rt.dto.eventId, irBaselineFingerprint(cfg.irPageUrl));
    const scratch = new Set<string>();
    const matching = await pollIrPage(cfg, scratch, fetchBytes, { baseline: false });
    const items = matching.filter((item) => !rt.seenIrLinks.has(item.link));

    let durable = 0;
    for (const item of items) {
      try {
        new URL(item.link);
      } catch {
        // Unreachable via the adapter (it resolves and filters by host first),
        // but a link we cannot even name must not take the whole poll down.
        refusals.push(noteIrRefusal(db, rt, item.link, "unparseable link"));
        continue;
      }
      let result: IngestResult;
      try {
        const fetched = await fetchBytes(item.link, { label: "IR page link" });
        // The road records the FINAL url (a hop may have moved it WITHIN the
        // allowlist), redacted — a stored newsroom URL can carry a token.
        result = await ingestDocument(
          db,
          rt.printId,
          "ir-page",
          `ir-page:${item.title.slice(0, 120)}`,
          redactUrl(fetched.finalUrl),
          fetched.bytes,
        );
      } catch (err) {
        refusals.push(noteIrRefusal(db, rt, item.link, errText(err)));
        continue;
      }
      if (result.outcome === "refused") {
        // Nothing was stored (plan M11) — there is no durable record that we
        // ever saw this link, so it is NOT seen.
        refusals.push(noteIrRefusal(db, rt, item.link, result.rejectReason ?? "refused"));
        continue;
      }
      // Every other outcome — parsed / duplicate / rejected / queued /
      // parse_failed — means a document row exists for these bytes. THAT is
      // what makes the link safe to retire: re-fetching it could only produce
      // the same row again.
      //
      // Burst is set HERE and not at the fetch: it means "evidence landed, so
      // re-read the other sources now", and it skips the cadence sleep. A
      // refusal that set it would put the lane in a tight re-fetch loop and
      // spend all three of a bad link's strikes inside one second, instead of
      // retrying it on later polls the way the budget intends.
      rt.burst = true;
      rt.seenIrLinks.add(item.link);
      recordIrSeenLinks(db, rt.dto.eventId, [item.link], false);
      durable += 1;
    }

    const head = baselined
      ? "ok"
      : "no baseline (armed late) — period gate filtering";
    // A per-poll refusal note is gone by the next poll, but GIVING UP on a
    // link is a durable fact about tonight's coverage — the desk has to keep
    // seeing that the road stopped trying, not just a quiet "0 new".
    const retired = [...rt.irRefusals.values()].filter((n) => n >= IR_REFUSAL_LIMIT).length;
    // No "IR: " prefix: the panel renders this lane under its own IR label
    // (LADDER_LABELS), so carrying one here printed "IR: ok — IR: 3 matching…".
    const summary =
      `${head} — ${matching.length} matching links, ${durable} new` +
      (retired > 0 ? ` (${retired} link(s) retired after ${IR_REFUSAL_LIMIT} refusals)` : "");
    status.sources.ir = [summary, ...refusals].join("; ");
  } catch (err) {
    // A page-level failure (refused, 503, timed out) leaves every link
    // unseen, so the next poll simply tries again.
    status.sources.ir = [errText(err), ...refusals].join("; ");
  }
}

/** Count a refusal against a link's budget, retiring it at the limit, and
 *  return the note the lane's status line carries for it. */
function noteIrRefusal(
  db: Database.Database,
  rt: PrintRuntime,
  link: string,
  reason: string,
): string {
  const n = (rt.irRefusals.get(link) ?? 0) + 1;
  rt.irRefusals.set(link, n);
  if (n >= IR_REFUSAL_LIMIT) {
    rt.seenIrLinks.add(link);
    recordIrSeenLinks(db, rt.dto.eventId, [link], false);
  }
  return `link refused (${n}/${IR_REFUSAL_LIMIT}): ${reason}`;
}

/**
 * `hardenedFetchBytes` under the acquisition scheduler's per-host-family
 * budget. The old hand-rolled `spaceHost` governor is gone: one scheduler now
 * paces every outbound request the subsystem makes, across prints and across
 * lanes, and it is the same object the SEC lane's `fetchFor` uses.
 *
 * Exported for `go.ts`'s pasted-link road, which passes NO signal on purpose —
 * a press must not be cancelled by a settling acquisition pass (R-C8).
 *
 * Residual (documented in DECISIONS): redirect hops INSIDE `hardenedFetchBytes`
 * share the one outer slot (max 3 hops), and the DJ wire keeps the TWS
 * adapter's own pacing — TWS is not an HTTP host.
 */
export const throttledFetchBytes: typeof hardenedFetchBytes = async (url, opts) => {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // Not a URL we can even name: let the hardened fetch refuse it properly
    // rather than throwing out of the throttle with a worse message.
    return seams.fetchBytes(url, opts);
  }
  const release = await acquisitionScheduler.throttle(host, opts.signal);
  try {
    return await seams.fetchBytes(url, opts);
  } finally {
    release();
  }
};

// ---------------------------------------------------------------------------
// acquisition + pipeline
// ---------------------------------------------------------------------------

/**
 * Temp file + atomic rename under `<storageRoot>/<dirKey>/` — the packaged
 * app's cwd is a read-only signed bundle, so this anchors at the DB dir.
 *
 * `dirKey` is a print id for acquired bytes and the literal `"staging"` for a
 * go press, whose print id does not exist yet (`go.ts`'s `GO_STAGING_DIR_KEY`)
 * — which is why this is exported rather than private.
 */
export async function writeAcquiredBytes(
  dirKey: number | string,
  sha: string,
  ext: string,
  buf: Buffer,
): Promise<string> {
  const dir = path.join(seams.storageRoot(), String(dirKey));
  await fsp.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, `${sha}.${ext}`);
  tmpCounter += 1;
  const tmpPath = `${finalPath}.tmp-${process.pid}-${tmpCounter}`;
  await fsp.writeFile(tmpPath, buf);
  await fsp.rename(tmpPath, finalPath);
  return finalPath;
}

/**
 * Store acquired bytes for a print and (when they are eligible) parse them.
 *
 * Idempotent on CONTENT (089/M13): the same bytes down a second road return
 * the same document id, add a road, and parse nothing. A gate failure is
 * recorded, never thrown — the caller acquired a real document, it simply
 * isn't this event's.
 *
 * Returns its VERDICT, not just an id (final fix wave). The outcomes are
 * genuinely different things to tell the desk — the sheet just moved, the
 * document was refused as another issuer's/period's, these exact bytes were
 * already in hand, the parse is waiting on the process that owns the watcher,
 * the file is not readable at all, or the parse ran and failed — and only this
 * function knows which happened. Callers that guessed from `isNew` alone had
 * to say something vague and permanent ("parsing now…") that no later poll
 * could ever correct.
 */
export async function ingestDocument(
  db: Database.Database,
  printId: number,
  kind: PrintWatchDocKind,
  source: string,
  url: string | null,
  buf: Buffer,
): Promise<IngestResult> {
  const print = readPrintRow(db, printId);
  if (!print) throw new Error(`print-watch: print ${printId} not found`);

  // A REFUSAL is not a rejection (plan M11). A rejected document is real
  // evidence of what a road served and is kept; bytes we cannot read at all
  // are not a document, so nothing is stored and there is no id to return.
  const shape = classifyBytes(buf);
  if (shape === "binary") {
    return {
      docId: 0,
      isNew: false,
      outcome: "refused",
      rejectReason: "binary content — print-watch reads HTML, plain text, or PDF",
    };
  }
  if (shape === "pdf") return ingestPdf(db, print, kind, source, url, buf);

  const sha = sha256Hex(buf);
  const ext = shape === "html" ? "html" : "txt";
  const text = buf.toString("utf8");
  const bytesPath = await writeAcquiredBytes(printId, sha, ext, buf);
  return finishIngest(db, print, kind, source, url, buf, {
    bytesPath,
    text,
    gateCtx: gateContextFor(db, print),
  });
}

/**
 * The PDF road (Task 10). A PDF becomes a document only once poppler has
 * produced a text layer we can actually gate and read: the gate runs on that
 * TEXT, not on the bytes, and the text is persisted beside the bytes so the
 * parse (and Task 13's merge) never re-spawns poppler for the same file.
 *
 * REFUSALS LEAVE NOTHING BEHIND (plan M11/M14). The bytes have to be on disk
 * before poppler can read them, so a refusal that happens after that write
 * removes both files: no row references them, and a later delivery of the
 * same bytes rewrites them content-addressed. Each refusal keeps its own
 * message — encrypted, oversize, too many pages, image-only, poppler missing
 * — because they are four different things for the desk to do about it.
 */
async function ingestPdf(
  db: Database.Database,
  print: PrintRow,
  kind: PrintWatchDocKind,
  source: string,
  url: string | null,
  buf: Buffer,
): Promise<IngestResult> {
  const bytesCheck = checkPdfBytes(buf);
  if (!bytesCheck.ok) {
    return { docId: 0, isNew: false, outcome: "refused", rejectReason: bytesCheck.reason };
  }

  const sha = sha256Hex(buf);
  const bytesPath = await writeAcquiredBytes(print.id, sha, "pdf", buf);
  const refused = async (reason: string): Promise<IngestResult> => {
    // ONLY when nothing owns these bytes. The path is content-addressed, so a
    // RE-delivery of a PDF already in hand (poppler since uninstalled, a
    // pdftotext timeout) writes the very file an existing document row points
    // at — deleting it there would strand that row's bytes and its text, and
    // every later re-parse of it would ENOENT.
    const owner = db
      .prepare(`SELECT id FROM print_watch_documents WHERE print_id = ? AND sha256 = ?`)
      .get(print.id, sha) as { id: number } | undefined;
    if (!owner) {
      await fsp.rm(bytesPath, { force: true });
      await fsp.rm(textPathFor(bytesPath), { force: true });
    }
    return { docId: 0, isNew: false, outcome: "refused", rejectReason: reason };
  };

  let text: string;
  try {
    text = await seams.pdfToText(db, bytesPath);
  } catch (err) {
    if (err instanceof PdfToolMissingError || err instanceof PdfEncryptedError) {
      return refused(err.message);
    }
    return refused(`could not read the PDF's text layer: ${errText(err)}`);
  }

  const textCheck = checkPdfText(text);
  if (!textCheck.ok) return refused(textCheck.reason);

  // Temp file + atomic rename, same as the bytes: a half-written text file
  // would parse as a truncated release, which is worse than no file at all.
  const textPath = textPathFor(bytesPath);
  tmpCounter += 1;
  const tmpTextPath = `${textPath}.tmp-${process.pid}-${tmpCounter}`;
  await fsp.writeFile(tmpTextPath, text, "utf8");
  await fsp.rename(tmpTextPath, textPath);

  return finishIngest(db, print, kind, source, url, buf, {
    bytesPath,
    text,
    gateCtx: gateContextFor(db, print),
  });
}

/**
 * The shared tail of every ingest: record the delivery (one transaction —
 * document by content, road by (kind, source), both verdicts), then parse only
 * if a parse is actually owed.
 *
 * The bytes are on disk BEFORE this runs, on purpose: `recordDelivery` holds a
 * write lock and must never wait on a syscall, and a rolled-back transaction
 * must never leave a `bytes_path` pointing at a file that was never written.
 */
async function finishIngest(
  db: Database.Database,
  print: PrintRow,
  kind: PrintWatchDocKind,
  source: string,
  url: string | null,
  buf: Buffer,
  input: DeliveryInput,
): Promise<IngestResult> {
  const delivery = recordDelivery(db, print.id, kind, source, url, buf, input);
  const status = statusFor(print.id);
  // Guarded at the CALL site, not just inside: every other delivery — the
  // overwhelming majority — then adds no await at all to the ingest chain.
  if (delivery.matchedBy === "text") await dropOrphanBytes(db, delivery, input.bytesPath);

  if (!delivery.contentVerdict.ok) {
    status.sources.gate = `doc ${delivery.id} rejected: ${delivery.contentVerdict.reason}`;
    return {
      docId: delivery.id,
      isNew: delivery.isNew,
      outcome: "rejected",
      rejectReason: delivery.contentVerdict.reason,
    };
  }
  if (!delivery.eligible) {
    // Content is this event's, but no road we trust has carried it yet — an
    // IR newsroom post that names no quarter is the live case. The same bytes
    // down an accepting road (a drop) make it eligible with no re-store.
    const reason = delivery.roadVerdict.ok ? "no accepting road yet" : delivery.roadVerdict.reason;
    status.sources.gate = `doc ${delivery.id} road ${kind} rejected: ${reason}`;
    return { docId: delivery.id, isNew: delivery.isNew, outcome: "rejected", rejectReason: reason };
  }
  if (!delivery.needsParse) {
    return { docId: delivery.id, isNew: delivery.isNew, outcome: "duplicate" };
  }

  // A parse is genuinely owed for THIS document right now — it is new, it just
  // became eligible, or a person re-delivered it after its budget ran out (the
  // only case `recordDelivery` re-queues). In every one of those the durable
  // budget is what governs; the process-local retry SPACING is a cool-down on a
  // document nobody asked about again, and a fresh delivery IS that ask. Left
  // in place it would answer a person's "try it again" with a 30-second no-op.
  parseAttempts.delete(delivery.id);

  advanceState(db, print.id, "acquired");
  const drain = await runQueue(db, print.id);
  // The drain can END without parsing: another process owns the watcher, so
  // the parse belongs to it, not us (fix wave, finding C). Reporting that as
  // `parsed` told the desk the sheet had moved when it had not — and for an
  // expired or TAS print there is no loop coming back to correct it, which is
  // why ensurePrintWatch now drains those explicitly.
  if (drain === "lease_blocked") {
    return { docId: delivery.id, isNew: delivery.isNew, outcome: "queued" };
  }

  // M15: report the DURABLE state of this document after the drain — never the
  // drain's return value, which only says the pass ran. The pass may have
  // parsed a DIFFERENT document, or this one may have failed while another
  // worker's claim was live.
  const after = getDocument(db, delivery.id);
  if (after?.parse_state === "parsed") {
    return { docId: delivery.id, isNew: delivery.isNew, outcome: "parsed" };
  }
  if (after?.parse_state === "claimed") {
    return { docId: delivery.id, isNew: delivery.isNew, outcome: "queued" };
  }
  return {
    docId: delivery.id,
    isNew: delivery.isNew,
    outcome: "parse_failed",
    rejectReason: after?.parse_last_error ?? "the parse did not complete",
  };
}

/**
 * Text identity (M13) can dedupe the bytes we just wrote onto an EXISTING
 * document whose `bytes_path` points somewhere else — a re-saved PDF, a text
 * wrapper of the same release. Nothing then references the file this delivery
 * wrote: no row, no re-parse, no retention rule ever reads it again, so it is
 * a private release left on disk forever. Delete it (and its poppler text)
 * here, where the outcome is known.
 *
 * ONLY when the survivor's path DIFFERS. The paths are content-addressed, so a
 * byte-identical re-delivery writes the very file the surviving row points at
 * — deleting that would strand the document's own bytes and ENOENT every later
 * re-parse (the same rule `ingestPdf`'s refusal cleanup follows).
 */
async function dropOrphanBytes(
  db: Database.Database,
  delivery: { id: number; matchedBy: "new" | "bytes" | "text" },
  writtenPath: string,
): Promise<void> {
  if (delivery.matchedBy !== "text") return;
  const survivor = getDocument(db, delivery.id);
  if (!survivor || survivor.bytes_path === writtenPath) return;
  await fsp.rm(writtenPath, { force: true });
  if (writtenPath.endsWith(".pdf")) await fsp.rm(textPathFor(writtenPath), { force: true });
}

/**
 * THE serializer for a print's sheet (Codex #8, hardened by review round 1,
 * critical #1). Every writer — the document pipeline AND the flash lane —
 * chains here, because each of them is a read-modify-write around a model call
 * that takes seconds: they read the accumulated candidates off
 * `candidates_json`, go away to the model, then write the whole set back. Two
 * of those interleaving means the slower one's stale snapshot silently ERASES
 * the faster one's candidates, and since the document is already
 * `parsed_at`-stamped it never re-parses — a green line just reverts.
 *
 * Chaining (rather than a boolean "busy" flag) also preserves doc-id order for
 * documents that land together.
 */
function enqueueWrite<T>(printId: number, task: () => Promise<T>): Promise<T> {
  const prev: Promise<unknown> = queues.get(printId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  queues.set(printId, next);
  // Self-clearing tail, so an idle print holds no entry and
  // retireFinishedRuntimes can tell "drained" from "still working".
  void next
    .catch(() => {})
    .finally(() => {
      if (queues.get(printId) === next) queues.delete(printId);
    });
  return next;
}

/**
 * What a drain pass actually managed to do (fix wave, finding C).
 *  - `drained`      — nothing left this pass could parse.
 *  - `lease_blocked` — a parsable document is still sitting there, but this
 *                      process no longer owns the watcher, so the parse was
 *                      deferred to whoever does.
 */
type DrainOutcome = "drained" | "lease_blocked";

function runQueue(db: Database.Database, printId: number): Promise<DrainOutcome> {
  return enqueueWrite(printId, () => drainQueue(db, printId));
}

/**
 * Is this document worth a parse attempt right now?
 *
 * The BUDGET is read off the row (M15): `claimDocumentParse` increments
 * `parse_attempts` durably, so a crash, a restart or a takeover by another
 * process can never hand a document a fresh five attempts. Only the SPACING
 * — "not again for 30s" — is process-local, because it exists to stop one
 * transient failure (a model 529, a half-written file) from burning the whole
 * budget inside half a minute, and a brand-new process has no reason to
 * inherit another one's cool-down.
 *
 * Ineligible documents (gate-rejected, no accepting road) never reach here:
 * `listParseQueue` filters them in SQL.
 */
function parseEligible(doc: DocumentRow, nowMs: number): boolean {
  if (doc.parse_attempts >= MAX_PARSE_ATTEMPTS) return false;
  const record = parseAttempts.get(doc.id);
  if (!record) return true;
  return nowMs - record.lastAtMs >= PARSE_RETRY_SPACING_MS;
}

/**
 * Claims older than PARSE_CLAIM_STALE_MS belong to a worker that died holding
 * one. The takeover decision lives HERE rather than in the store so there is
 * exactly ONE place that decides a claim is abandoned — `listParseQueue` stays
 * the honest "nobody holds this" read. Eligibility still applies (a stale claim
 * is worth nothing on a document the gate has since withdrawn), and it is the
 * store's `ELIGIBLE_SQL` verbatim rather than a second copy of the rule: the
 * two drifted once already, and a takeover reading a stale definition would
 * hand the model a document `listParseQueue` refuses to show it.
 */
function listStaleClaims(db: Database.Database, printId: number, nowMs: number): DocumentRow[] {
  return db
    .prepare(
      `SELECT d.* FROM print_watch_documents d
        WHERE d.print_id = ? AND d.parse_state = 'claimed'
          AND datetime(d.parse_claimed_at) < datetime(?)
          AND ${ELIGIBLE_SQL}
        ORDER BY d.id`,
    )
    .all(printId, new Date(nowMs - PARSE_CLAIM_STALE_MS).toISOString()) as DocumentRow[];
}

async function drainQueue(db: Database.Database, printId: number): Promise<DrainOutcome> {
  const attemptedThisPass = new Set<number>();
  for (;;) {
    const nowMs = seams.now();
    const pending = listParseQueue(db, printId).filter(
      (doc) => !attemptedThisPass.has(doc.id) && parseEligible(doc, nowMs),
    );
    // A stale claim is worth taking either to RETRY the document or — once its
    // budget is spent — purely to CLOSE it (the reap below).
    const stale = listStaleClaims(db, printId, nowMs).filter(
      (doc) =>
        !attemptedThisPass.has(doc.id) &&
        (doc.parse_attempts >= MAX_PARSE_ATTEMPTS || parseEligible(doc, nowMs)),
    );
    const candidates = [...pending, ...stale];
    if (candidates.length === 0) return "drained";

    const doc = candidates[0];
    attemptedThisPass.add(doc.id);

    // Don't even spend a model call — let alone an attempt — when this
    // process no longer owns the watcher; the owner will drain the document.
    if (!claimLease(db)) {
      statusFor(printId).sources.pipeline = "lease lost — parsing deferred to the owner";
      return "lease_blocked";
    }

    const token = crypto.randomUUID();
    if (!claimDocumentParse(db, doc.id, token, nowMs)) continue; // another worker got there first

    // REAP an abandoned claim (fix round 1, finding 1). A document whose LAST
    // attempt was claimed by a process that then died sits `claimed` forever:
    // no retry can take it (its budget is gone), `recordDelivery` re-queues
    // only `failed` rows so a person's re-drop returns `duplicate` with nothing
    // to explain it, and `hasParsableDocuments` keeps counting it as work, so
    // every reconcile kicks a drain that can do nothing. Taking the claim only
    // to book it `failed` closes all three: the row reaches the one state a
    // human can clear, and the drain goes quiet. No model call — there is no
    // attempt left to spend on one.
    if (doc.parse_attempts >= MAX_PARSE_ATTEMPTS) {
      statusFor(printId).sources.pipeline = `doc ${doc.id}: ${ABANDONED_CLAIM_ERROR}`;
      recordFinalize(db, printId, doc.id, token, "failed", ABANDONED_CLAIM_ERROR);
      continue;
    }

    // The claim incremented `parse_attempts` durably; read the count BACK
    // rather than adding one to the snapshot we listed — between the two,
    // another process may have taken an attempt of its own and handed the row
    // back. The in-memory map now carries only the retry SPACING.
    const attempts = getDocument(db, doc.id)?.parse_attempts ?? doc.parse_attempts + 1;
    parseAttempts.set(doc.id, { attempts, lastAtMs: nowMs });

    let pass: ParsePassResult;
    try {
      pass = await processDocument(db, printId, doc);
    } catch (err) {
      const message = errText(err);
      statusFor(printId).sources.pipeline = `doc ${doc.id}: ${message}`;
      pass = { state: "queued", error: message };
    }
    // A pass that did not parse and has spent the budget is booked `failed`
    // (M15) — NOT left `queued` at five attempts, which no retry would ever
    // pick up again and which `recordDelivery` would refuse to re-queue on a
    // person's re-delivery. `failed` is the state a human can clear.
    const terminal = pass.state !== "parsed" && attempts >= MAX_PARSE_ATTEMPTS;
    recordFinalize(
      db,
      printId,
      doc.id,
      token,
      pass.state === "parsed" ? "parsed" : terminal ? "failed" : "queued",
      pass.error,
    );
  }
}

/**
 * Finalize under the claim token and SAY SO when the token no longer matches.
 * A refused finalize means this worker's claim was taken over while it was
 * running: its result was discarded, and the row the panel is showing belongs
 * to whoever holds the document now. Swallowing that boolean left the desk
 * looking at a document whose note claimed an error that was never recorded.
 */
function recordFinalize(
  db: Database.Database,
  printId: number,
  docId: number,
  token: string,
  state: "parsed" | "queued" | "failed",
  error: string | null,
): void {
  if (finalizeDocumentParse(db, docId, token, state, error)) return;
  statusFor(printId).sources.pipeline =
    `doc ${docId}: claim was taken over mid-parse — this result was discarded`;
}

/**
 * Drain documents stranded on prints that have NO loop left to drain them
 * (fix wave, finding C): today's expired prints and drop-zone-only (TAS)
 * prints. Both are exactly where a `queued` ingest lands — a drop onto an
 * expired print while another process held the lease — and neither has a
 * polling loop whose next tick would pick the document back up.
 *
 * One kick per print per reconcile run, fire-and-forget: `drainQueue` itself
 * walks every eligible document, the print's write chain keeps it serialized
 * against any other writer, and `parseEligible` still spaces the retries.
 */
function drainStrandedPrints(db: Database.Database, printIds: Iterable<number>): void {
  for (const printId of printIds) {
    let parsable = false;
    try {
      parsable = hasParsableDocuments(db, printId);
    } catch {
      // A failed read here must never break the sweep.
      continue;
    }
    if (!parsable) continue;
    void runQueue(db, printId).catch(() => {});
  }
}

function tag(
  candidates: ParseCandidate[],
  docId: number,
  representation: TaggedCandidate["representation"],
  weakPair: boolean,
  /** Only PDF readings carry one today — written ONLY when present, so a
   *  non-PDF candidate's JSON keeps exactly the shape it always had. */
  pairNote?: TaggedCandidate["pair_note"],
): TaggedCandidate[] {
  return candidates.map((c) => ({
    ...c,
    doc_id: docId,
    representation,
    weak_pair: weakPair,
    ...(pairNote ? { pair_note: pairNote } : {}),
  }));
}

/** Everything this print has ever produced, read back off the sheet — the
 *  reconciler is cross-document by design and must never see one document's
 *  candidates in isolation (Codex #4). */
function collectCandidates(db: Database.Database, printId: number): TaggedCandidate[] {
  const out: TaggedCandidate[] = [];
  for (const line of getSheet(db, printId)) {
    try {
      const parsed: unknown = JSON.parse(line.candidates_json);
      if (Array.isArray(parsed)) out.push(...(parsed as TaggedCandidate[]));
    } catch {
      // A corrupt candidates_json costs this metric its history, never the run.
    }
  }
  return out;
}

/**
 * Reconcile the whole candidate pool and write the sheet.
 *
 * Guarded by the lease (review round 1, critical #1): the caller read this
 * snapshot BEFORE a model call that may have taken a minute. If the lease
 * changed hands in the meantime, another process is the authority on this
 * sheet and our snapshot is stale — refuse rather than overwrite. The caller
 * leaves the document unparsed, so the new owner picks it up.
 *
 * @returns false when the write was refused.
 */
function writeLines(
  db: Database.Database,
  printId: number,
  eventId: number,
  symbol: string,
  all: TaggedCandidate[],
): boolean {
  if (!claimLease(db)) {
    statusFor(printId).sources.pipeline = "lease lost mid-parse — sheet write refused";
    return false;
  }
  const { contracts, expected } = compileContracts(db, eventId, symbol);
  const accepted = getSheet(db, printId).filter((l) => l.state === "accepted");
  const lines = reconcile(contracts, expected, all, accepted).map((line) =>
    line.source_doc_id === FLASH_DOC_ID ? { ...line, source_doc_id: null } : line,
  );
  upsertLines(db, printId, lines);
  return true;
}

/**
 * What one parse pass produced, for the CAS finalize. `parsed` stamps the
 * document; `queued` returns it with a durable reason, which is what the panel
 * and the next attempt both read.
 */
type ParsePassResult =
  | { state: "parsed"; error: null }
  | { state: "queued"; error: string };

/**
 * The two readings of one PDF: poppler's persisted text through the ordinary
 * text extractor, and the PDF bytes themselves as a Claude document block.
 *
 * BOTH are tagged `weak_pair` with `pair_note: "pdf-weak"` — the gate
 * pre-registered in `docs/DECISIONS.md` (2026-09-02). Nothing has measured
 * whether these two readings fail independently, so agreement between them is
 * NOT the independent corroboration the reconciler greens on: a PDF alone
 * caps at single_source and can only green by agreeing with a DIFFERENT
 * document. Flipping either flag needs the holdout in that decision record.
 */
async function pdfCandidates(
  contracts: LineContract[],
  doc: DocumentRow,
): Promise<TaggedCandidate[]> {
  const text = await fsp.readFile(textPathFor(doc.bytes_path), "utf8");
  const fromText = await seams.extractCandidates(contracts, text);
  const bytes = await fsp.readFile(doc.bytes_path);
  const fromNative = await seams.extractCandidatesFromPdf(contracts, bytes);
  return [
    ...tag(fromText, doc.id, "pdfText", true, "pdf-weak"),
    ...tag(fromNative, doc.id, "pdfNative", true, "pdf-weak"),
  ];
}

async function processDocument(
  db: Database.Database,
  printId: number,
  doc: DocumentRow,
): Promise<ParsePassResult> {
  const print = readPrintRow(db, printId);
  if (!print) return { state: "queued", error: "the print row vanished mid-parse" };

  const { contracts } = compileContracts(db, print.event_id, print.symbol);

  const fresh: TaggedCandidate[] = [];
  if (doc.bytes_path.endsWith(".pdf")) {
    fresh.push(...(await pdfCandidates(contracts, doc)));
  } else {
    const raw = await fsp.readFile(doc.bytes_path, "utf8");
    if (doc.bytes_path.endsWith(".html")) {
      // Two genuinely different readings of the same bytes — the pair reconcile
      // treats as independent (different representation, weak_pair false).
      const repA = await seams.extractCandidates(contracts, htmlToTablesRepresentation(raw));
      fresh.push(...tag(repA, doc.id, "repA", false));
      const repB = await seams.extractCandidates(contracts, htmlToRawText(raw));
      fresh.push(...tag(repB, doc.id, "repB", false));
    } else {
      // Plain text has ONE reading. Parsing it twice with the same prompt would
      // be a correlated pair, so it gets a single call and can only ever green
      // by agreeing with ANOTHER document (reconcile rule 3).
      const only = await seams.extractCandidates(contracts, raw);
      fresh.push(...tag(only, doc.id, "repB", false));
    }
  }

  // A CLAIM OUTLIVES A GATE FLIP (Task 8 handoff note 2). We have been at the
  // model for up to a few minutes; in that window a corrected event date could
  // have re-fingerprinted the gate into a rejection, or the last accepting
  // road could have been withdrawn — and `recordDelivery` would already have
  // RETRACTED this document's earlier evidence. Writing now would re-green
  // exactly what was just retracted, so drop the reading instead. The document
  // stays `queued`, which is invisible to the queue while it is ineligible and
  // parses again by itself the moment a road accepts it.
  const still = getDocument(db, doc.id);
  if (!still || !isDocumentEligible(db, doc.id)) {
    const note = `doc ${doc.id}: the gate withdrew this document mid-parse — reading dropped`;
    statusFor(printId).sources.pipeline = note;
    return { state: "queued", error: "the gate withdrew this document mid-parse" };
  }

  const existing = collectCandidates(db, printId).filter((c) => c.doc_id !== doc.id);
  const written = writeLines(db, printId, print.event_id, print.symbol, [...existing, ...fresh]);
  // Only stamp the document parsed if its candidates actually landed —
  // stamping a refused write would strand the document forever.
  if (!written) return { state: "queued", error: "sheet write refused — lease lost" };
  advanceState(db, printId, "parsed");
  return { state: "parsed", error: null };
}

/**
 * The flash lane: DJ bullets are provisional evidence with no document of
 * record. All accumulated flashes are re-read as one text each time the batch
 * grows, and the previous flash candidates are REPLACED (never appended) so
 * the pool cannot fill with re-reads of the same bullets.
 *
 * No document-to-event gate here, on purpose: a flash is not a document to
 * validate — it arrived from a windowed news query for THIS print's conId, and
 * the reconciler already refuses to let a flash green a line or override a
 * real document's value (rule 5).
 *
 * Runs INSIDE the print's write chain (review round 1, critical #1): it is a
 * read-modify-write around a model call exactly like the document pipeline, so
 * the two must never interleave.
 */
function runFlashLane(db: Database.Database, rt: PrintRuntime): Promise<void> {
  return enqueueWrite(rt.printId, async () => {
    const print = readPrintRow(db, rt.printId);
    if (!print) return;
    const { contracts } = compileContracts(db, print.event_id, print.symbol);
    try {
      const parsed = await seams.extractCandidates(contracts, rt.flashHeadlines.join("\n"));
      const flashCandidates = tag(parsed, FLASH_DOC_ID, "flash", false);
      const existing = collectCandidates(db, rt.printId).filter(
        (c) => c.representation !== "flash",
      );
      writeLines(db, rt.printId, print.event_id, print.symbol, [
        ...existing,
        ...flashCandidates,
      ]);
    } catch (err) {
      statusFor(rt.printId).sources.flash = errText(err);
    }
  });
}

// ---------------------------------------------------------------------------
// the go road (slice C): the wake, the forced pass, the dispatcher
// ---------------------------------------------------------------------------

/**
 * The in-process go wake (M-C3). Called by `requestGo` after its transaction
 * commits and by the extend route after it writes.
 *
 * Three things, in order: reconcile (so a press that ARMED an event builds the
 * runtime and opens the loop), end the loop's cadence sleep, and run one
 * dispatcher tick so the request just queued is claimed NOW rather than up to
 * `GO_DISPATCH_MS` from now. Safe to call when no watcher runs here at all —
 * the wake is remembered, and the dispatcher declines without the lease.
 */
export async function wakePrintWatch(db: Database.Database, printId: number): Promise<void> {
  ensurePrintWatch(db);
  acquisitionScheduler.wake(printId, "go");
  await dispatchGoRequests(db);
}

/**
 * One fan-out pass NOW for a print THIS process runs, with per-road reports —
 * what a claimed go request records in `result_json`.
 *
 * A print this process does not own (no runtime, or the lease is elsewhere)
 * gets three `skipped` reports naming the reason, never a silent empty list:
 * the desk has to be able to tell "nothing was found" from "nobody looked".
 *
 * `signal` (R-C11) is the CALLER's cancellation — `runGoRequest`'s own claim
 * controller, never a scheduler pass signal (R-C8). It is linked into the pass
 * so a request whose claim is taken over mid-acquire cancels its roads instead
 * of racing the new owner. CAVEAT: the scheduler coalesces passes per print, so
 * a call that JOINS a pass already in flight cannot cancel that pass — its
 * signal reaches only a pass this call actually starts.
 */
export async function runForcedPass(
  db: Database.Database,
  printId: number,
  signal?: AbortSignal,
): Promise<RoadReport[]> {
  const rt = runtimes.get(printId);
  if (!holdsLease()) return skippedReports(leaseNote ?? "watcher lease held by another process");
  if (!rt) return skippedReports("watcher not live in this process");
  return acquisitionScheduler.runPass<RoadReport[]>(
    printId,
    (passSignal) => pass(db, rt, signal ? AbortSignal.any([passSignal, signal]) : passSignal),
    "go",
  );
}

/** The 2-second sweep, armed while this process holds the lease. */
let goDispatcher: ReturnType<typeof setInterval> | null = null;

/**
 * Claim every takeable go request for a print THIS process runs, and run it.
 *
 * The claim itself is the store's compare-and-set inside `runGoRequest`; this
 * only decides WHO tries. Two guards: a print whose runtime lives in another
 * process is left to that process's dispatcher, and a print already running a
 * request here is skipped — one claim per print at a time, however often the
 * tick fires. Returns how many it claimed (exported for the tests).
 */
export async function dispatchGoRequests(db: Database.Database): Promise<number> {
  if (!holdsLease()) return 0;
  const now = seams.now();
  let takeable: ReturnType<typeof listTakeableGoRequests>;
  try {
    failCappedGoRequests(db, now);
    takeable = listTakeableGoRequests(db, now);
  } catch (err) {
    // A dispatcher tick must never take the process down (a closed handle, a
    // locked DB): the next tick tries again.
    console.warn("[print-watch] go dispatcher tick failed:", errText(err));
    return 0;
  }
  let claimed = 0;
  for (const row of takeable) {
    if (!runtimes.has(row.print_id)) continue;
    if (goInFlight.has(row.print_id)) continue;
    goInFlight.add(row.print_id);
    claimed += 1;
    void runGoRequest(db, row.id)
      .catch((err) => console.warn(`[print-watch] go request ${row.id} failed:`, errText(err)))
      .finally(() => goInFlight.delete(row.print_id));
  }
  return claimed;
}

/**
 * Arm the dispatcher for the LIFE OF THE LEASE (Codex round 1, finding #1).
 *
 * It deliberately does not stop when it finds nothing: a request queued by
 * another process an hour into an idle evening still has to be claimed within
 * `GO_DISPATCH_MS`, and an idle-stop would mean the owner only notices when
 * somebody happens to call `ensurePrintWatch` again.
 */
function ensureGoDispatcher(db: Database.Database): void {
  if (goDispatcher) return;
  const timer = setInterval(() => {
    void dispatchGoRequests(db);
  }, GO_DISPATCH_MS);
  // Never hold the process open for this (the sweep is a short-lived caller).
  timer.unref?.();
  goDispatcher = timer;
}

/** Stops on lease loss, on `_setTestSeams`, and on shutdown. */
function stopGoDispatcher(): void {
  if (!goDispatcher) return;
  clearInterval(goDispatcher);
  goDispatcher = null;
}
