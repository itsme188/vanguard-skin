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
 *    after `validateDocForEvent` agrees the document is this issuer's release
 *    for this period. A failing document is still STORED (it is evidence of
 *    what the wire served) but under the source `rejected:<reason>`, and the
 *    pipeline skips those forever.
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
import { composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";
import { resolveDbDir } from "@/lib/db/db-path";
import { resolveEarningsReleaseTime } from "@/lib/earnings/wire-times";
import {
  getArmedWorksheetEvents,
  type ArmedWorksheetEventRow,
} from "@/lib/queries/earnings-worksheet-flags";

import { compileContracts } from "./contracts";
import {
  createDjPollState,
  formatTwsDateTime,
  pollDjNews,
  type DjPollOutput,
  type DjPollState,
  type IBApiLike,
} from "./dj-adapter";
import { pollEdgar, resolveCik, type EdgarFiling } from "./edgar-adapter";
import { extractCandidates } from "./extract";
import { IR_RSS_CONFIGS, pollIrRss, type IrRssConfig } from "./ir-rss-adapter";
import { reconcile } from "./reconcile";
import { htmlToRawText, htmlToTablesRepresentation } from "./representations";
import {
  acquireWatcherLease,
  getSheet,
  insertDocument,
  listActivePrints,
  listDocuments,
  listTodaysExpiredPrints,
  listUnparsedDocuments,
  markDocumentParsed,
  setPrintState,
  upsertLines,
  upsertPrint,
} from "./store";
import type {
  DocumentRow,
  LineContract,
  ExpectedValue,
  ParseCandidate,
  PrintRow,
  PrintWatchDocKind,
  PrintWatchLine,
  PrintWatchState,
  TaggedCandidate,
} from "./types";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** Window opens T−10m and closes T+45m around the resolved release time (spec §4.2). */
const WINDOW_PRE_MS = 10 * 60_000;
const WINDOW_POST_MS = 45 * 60_000;
/** In-window poll cadence (spec §4.2). */
const CADENCE_MS = 10_000;

const LEASE_TTL_MS = 60_000;
const LEASE_RENEW_MS = 20_000;
const LEASE_SETTINGS_KEY = "print_watch_lease";

/** Minimal per-host governor (accepted deviation (c) — ≤3 simultaneous prints). */
const SEC_HOST = "sec.gov";
const SEC_SPACING_MS = 300;
const DEFAULT_SPACING_MS = 200;

/**
 * A failed parse is retried, but never on the very next tick: three retries
 * inside 30 seconds all fail for the SAME transient reason (a model 529, a
 * half-written file) and would burn the document's whole retry budget in half
 * a minute (review round 1, minor #5). Attempts are spaced instead, and the
 * count cap survives as the model-budget guard.
 */
const PARSE_RETRY_SPACING_MS = 30_000;
const MAX_PARSE_ATTEMPTS = 5;

/**
 * A stalled socket must not park `pollOnce` past the lease renewal — a 60s
 * lease expiring under a hung EDGAR fetch is a split-brain invitation (review
 * round 1, important #3). NOTE: this abandons the wait, it does not cancel the
 * request; neither adapter takes an AbortSignal today, so a hung fetch keeps
 * its socket until the runtime drops it.
 */
const SOURCE_TIMEOUT_MS = 15_000;

const REJECTED_PREFIX = "rejected:";

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
}

/**
 * What actually happened to a set of acquired bytes — the drop route forwards
 * this verbatim so the panel can say something true and final.
 *
 *  - `parsed`    — new document, passed the issuer/period gate, parse awaited.
 *  - `rejected`  — stored as evidence under `rejected:<reason>`, never parsed.
 *  - `duplicate` — these exact bytes are already this print's; nothing re-ran.
 *  - `queued`    — stored and gate-passed, but the parse did NOT run: another
 *                  process holds the watcher lease, so the drain deferred to
 *                  the owner (fix wave, finding C). Saying "parsed" here was a
 *                  lie the desk could not see through — the sheet had not
 *                  moved and nothing on screen said so.
 */
export type IngestOutcome = "parsed" | "rejected" | "duplicate" | "queued";

export interface IngestResult {
  docId: number;
  isNew: boolean;
  outcome: IngestOutcome;
  /** Present only on `rejected` — the gate's own plain-language reason. */
  rejectReason?: string;
}

export interface DocGateContext {
  symbol: string;
  issuerName: string | null;
  eventDate: string;
  /**
   * Which source produced the bytes. Only `ir-page` changes the verdict (fix
   * wave, finding A): an IR newsroom article is the one input whose ARRIVAL
   * carries no period evidence at all — EDGAR filings passed an acceptance-
   * window filter and DJ items came from a windowed news query for this
   * conId, but a newsroom feed serves last quarter's release from the same
   * URL space, matching the same title regex, forever. Omitted (or any other
   * kind) keeps the historical, generous behaviour.
   */
  kind?: PrintWatchDocKind;
}

export type DocGateVerdict = { ok: true } | { ok: false; reason: string };

export interface WatcherSeams {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Root of the acquired-bytes tree; `<root>/<printId>/<sha256>.<ext>`. */
  storageRoot: () => string;
  twsConnection: () => Promise<{ up: boolean; ib: IBApiLike | null }>;
  pollDjNews: (
    ib: IBApiLike,
    conId: number,
    windowStartUtc: string,
    nowUtc: string,
    state: DjPollState,
    nowMs: number,
  ) => Promise<DjPollOutput>;
  resolveCik: (symbol: string) => Promise<string | null>;
  /** Ask TWS for a security's IB contract id (and persist it). Null = TWS
   *  answered but knows no contract for this row. */
  resolveConId: (db: Database.Database, securityId: number) => Promise<number | null>;
  pollEdgar: (
    cik: string,
    windowStartIso: string,
    windowEndIso: string,
    seenAccessions: Set<string>,
  ) => Promise<EdgarFiling[]>;
  pollIrRss: (
    cfg: IrRssConfig,
    seenLinks: Set<string>,
    baseline: boolean,
  ) => Promise<Array<{ title: string; link: string; html: string }>>;
  extractCandidates: (contracts: LineContract[], representationText: string) => Promise<ParseCandidate[]>;
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
  pollDjNews: (ib, conId, windowStartUtc, nowUtc, state, nowMs) =>
    pollDjNews(ib, conId, windowStartUtc, nowUtc, state, nowMs),
  resolveCik: (symbol) => resolveCik(symbol),
  resolveConId: (db, securityId) => defaultResolveConId(db, securityId),
  pollEdgar: (cik, startIso, endIso, seen) => pollEdgar(cik, startIso, endIso, seen),
  pollIrRss: (cfg, seenLinks, baseline) => pollIrRss(cfg, seenLinks, fetch, { baseline }),
  extractCandidates: (contracts, text) => extractCandidates(contracts, text),
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

interface PrintWindow {
  startMs: number;
  endMs: number;
}

interface PrintRuntime {
  printId: number;
  dto: ArmedEventDto;
  issuerName: string | null;
  /** null = no auto window (an unresolvable TAS row) — drop-zone only. */
  window: PrintWindow | null;
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
/** host -> epoch ms of the last outbound request (the per-host spacer). */
const lastRequestAt = new Map<string, number>();

let leaseNote: string | null = null;
let leaseRenewedAtMs = 0;
let tmpCounter = 0;

function resetWatcherState(): void {
  for (const rt of runtimes.values()) rt.live = false;
  runtimes.clear();
  statuses.clear();
  queues.clear();
  parseAttempts.clear();
  cikCache.clear();
  lastRequestAt.clear();
  leaseNote = null;
  leaseRenewedAtMs = 0;
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
    stopAllLoops();
    return false;
  }
  leaseNote = null;
  leaseRenewedAtMs = nowMs;
  return true;
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

function windowFor(dto: ArmedEventDto): PrintWindow | null {
  if (!dto.releaseTimeEt) return null;
  const instant = composeReleaseInstant(dto.eventDate, dto.releaseTimeEt);
  if (!instant) return null;
  const t = instant.getTime();
  return { startMs: t - WINDOW_PRE_MS, endMs: t + WINDOW_POST_MS };
}

// ---------------------------------------------------------------------------
// document-to-event gate (Codex #1)
// ---------------------------------------------------------------------------

const CORPORATE_SUFFIXES =
  /\b(incorporated|inc|corporation|corp|company|co|holdings|holding|group|plc|ltd|limited|sa|nv|ag|technologies|systems)\b\.?/gi;

const QUARTER_WORD_RE = /\b(first|second|third|fourth)\s+quarter\b|\bq[1-4]\b/i;
const FISCAL_YEAR_RE = /\bfiscal(\s+year)?\s+20\d\d\b|\bfy\s?20\d\d\b/i;
const ORDINALS = ["", "first", "second", "third", "fourth"];

/** Company name reduced to its distinctive head ("NVIDIA Corporation" ->
 *  "nvidia"). Returns null when nothing distinctive survives, so a name like
 *  "Holdings Inc" can never match every document on earth. */
function issuerNeedle(issuerName: string | null): string | null {
  if (!issuerName) return null;
  const stripped = issuerName
    .replace(/[,.]/g, " ")
    .replace(CORPORATE_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return stripped.length >= 3 ? stripped : null;
}

/** Calendar quarter of the event date, plus the preceding one: a print on
 *  2026-08-26 is nearly always ABOUT the quarter that just ended. */
function candidateQuarters(eventDate: string): Array<{ q: number; year: number }> {
  const [y, m] = eventDate.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return [];
  const q = Math.floor((m - 1) / 3) + 1;
  const prev = q === 1 ? { q: 4, year: y - 1 } : { q: q - 1, year: y };
  return [{ q, year: y }, prev];
}

/**
 * The gate a document must pass before a single one of its numbers is allowed
 * near a contract line: it must NAME this issuer (ticker or company head) and
 * state a plausible fiscal period.
 *
 * The period rule is deliberately generous on the FISCAL side (the CRWD
 * lesson: a release printed in June 2026 legitimately says "First Quarter
 * Fiscal Year 2027", which matches no calendar-quarter token at all). Once the
 * symbol itself appears, any "fiscal 20xx" + quarter-word pairing counts. The
 * narrow guards that keep this honest live upstream: EDGAR filings already
 * passed the acceptance-window filter, and DJ items came from a windowed news
 * query for this conId.
 *
 * EXCEPT for `ir-page` documents (fix wave, finding A). A newsroom feed has no
 * upstream guard at all: last quarter's results announcement sits in it
 * permanently and matches the same title regex, so the loose branch would wave
 * through a months-old article and green LAST quarter's numbers as tonight's
 * print. An IR page must therefore match one of the strict expected-quarter
 * branches derived from the event date; the any-fiscal-year fallback is not
 * available to it.
 */
export function validateDocForEvent(text: string, ctx: DocGateContext): DocGateVerdict {
  const lower = text.toLowerCase();

  // Dots survive (BRK.B) but are escaped — an unescaped "." would make the
  // ticker a wildcard and match half the document.
  const symbolPattern = ctx.symbol.replace(/[^A-Za-z0-9.]/g, "").replace(/\./g, "\\.");
  const symbolRe = new RegExp(`\\b${symbolPattern}\\b`, "i");
  const symbolMatched = symbolRe.test(text);
  const needle = issuerNeedle(ctx.issuerName);
  const issuerMatched = needle !== null && lower.includes(needle);

  if (!symbolMatched && !issuerMatched) {
    return { ok: false, reason: `issuer not named (${ctx.symbol})` };
  }

  for (const { q, year } of candidateQuarters(ctx.eventDate)) {
    if (new RegExp(`\\bq${q}\\b[^\\n]{0,24}${year}`, "i").test(lower)) return { ok: true };
    if (new RegExp(`${year}[^\\n]{0,24}\\bq${q}\\b`, "i").test(lower)) return { ok: true };
    // The ordinal branch carries the same year requirement as the Qn branches
    // (review round 1, minor #6) — "second quarter" on its own appears in
    // prior-year comparatives and in last year's release just as readily.
    if (lower.includes(`${ORDINALS[q]} quarter`) && new RegExp(`\\b${year}\\b`).test(lower)) {
      return { ok: true };
    }
  }

  if (ctx.kind === "ir-page") {
    return {
      ok: false,
      reason: "IR page does not name this event's quarter (an older newsroom post?)",
    };
  }

  if (symbolMatched && FISCAL_YEAR_RE.test(lower) && QUARTER_WORD_RE.test(lower)) {
    return { ok: true };
  }

  return { ok: false, reason: "no fiscal-period token for this event" };
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

function gateContextFor(
  db: Database.Database,
  print: PrintRow,
  kind: PrintWatchDocKind,
): DocGateContext {
  const rt = runtimes.get(print.id);
  return {
    symbol: print.symbol,
    issuerName: rt ? rt.issuerName : readIssuerName(db, print.symbol),
    eventDate: print.event_date,
    kind,
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

function refreshCoverage(rt: PrintRuntime, twsUp: boolean | null): void {
  if (twsUp !== null) rt.lastTwsUp = twsUp;

  // No window means no source ever polls for this print — say exactly that
  // rather than listing capabilities that will never fire (review round 1,
  // minor #8).
  if (!rt.window) {
    statusFor(rt.printId).coverage = [
      "TAS — release time unknown; drop-zone only",
      "drop: HTML/text",
    ];
    return;
  }

  const notes: string[] = [];
  notes.push(`DJ: ${djNote(rt)}`);
  if (rt.lastTwsUp === false) notes.push("TWS offline");
  if (rt.dto.cik) notes.push(`EDGAR: CIK ${rt.dto.cik}`);
  else notes.push(rt.cikAttempted ? "EDGAR: CIK unresolved" : "EDGAR: CIK pending");
  notes.push(irConfigFor(rt.dto.symbol) ? `RSS: ${rt.dto.symbol} IR feed` : "RSS: NVDA only");
  notes.push("drop: HTML/text");
  statusFor(rt.printId).coverage = notes;
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
  const armedEventIds = new Set(armed.map((r) => r.eventId));

  const armedPrintIds = new Set<number>();
  /** Prints with no live loop of their own — see drainStrandedPrints. */
  const strandedPrintIds = new Set<number>();

  for (const row of armed) {
    const dto = buildArmedEventDto(db, row);
    // A print with no resolvable window still EXISTS — the drop zone is the
    // road for it, and the panel needs a row to drop onto.
    const window = windowFor(dto);

    const printId = upsertPrint(db, dto.eventId, dto.symbol, dto.eventDate, dto.releaseTimeEt);
    armedPrintIds.add(printId);

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
        seenIrLinks: new Set(),
        irBaselineDone: false,
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

    refreshCoverage(rt, null);
  }

  for (const print of listActivePrints(db)) {
    if (armedEventIds.has(print.event_id)) continue;
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
    };
  });
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
    while (rt.live) {
      try {
        await pollOnce(db, rt);
      } catch (err) {
        statusFor(rt.printId).sources.loop = errText(err);
      }
      if (!rt.live) break;
      if (rt.burst) {
        // A hit on any source makes the others worth re-reading NOW.
        rt.burst = false;
        continue;
      }
      await seams.sleep(CADENCE_MS);
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

async function pollOnce(db: Database.Database, rt: PrintRuntime): Promise<void> {
  // Lease renewal rides the loop rather than its own timer: the loop is the
  // only thing the lease protects, so a lost renewal must stop exactly it.
  // It is re-checked BETWEEN sources, so one slow source can't push the
  // renewal past the 60s TTL and hand out a second owner.
  if (!renewLeaseIfDue(db)) return;

  const window = rt.window;
  if (!window) {
    rt.live = false; // drop-zone-only print: nothing to poll
    return;
  }
  if (seams.now() > window.endMs) {
    rt.live = false;
    const current = readPrintRow(db, rt.printId)?.state;
    if (current && current !== "parsed" && current !== "disarmed") {
      setPrintState(db, rt.printId, "expired");
    }
    return;
  }

  // Crash recovery (Codex #6): anything a previous process acquired but never
  // parsed gets drained on every tick, not just at ingest time.
  await runQueue(db, rt.printId);

  if (!renewLeaseIfDue(db)) return;
  const twsUp = await pollDjSource(db, rt, window);
  if (!renewLeaseIfDue(db)) return;
  await pollEdgarSource(db, rt, window);
  if (!renewLeaseIfDue(db)) return;
  await pollIrSource(db, rt);
  refreshCoverage(rt, twsUp);
}

/**
 * Abandon a source that has stopped answering, so the loop keeps its renewal
 * cadence (review round 1, important #3). The underlying request is NOT
 * cancelled — neither adapter accepts an AbortSignal — it is simply no longer
 * waited on.
 */
async function withSourceTimeout<T>(label: string, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${SOURCE_TIMEOUT_MS / 1000}s`)),
          SOURCE_TIMEOUT_MS,
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
  window: PrintWindow,
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
      formatTwsDateTime(new Date(window.startMs)),
      formatTwsDateTime(new Date(seams.now())),
      rt.djState,
      seams.now(),
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
    status.sources.dj = errText(err);
    return null;
  }
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
  window: PrintWindow,
): Promise<void> {
  const status = statusFor(rt.printId);
  try {
    if (rt.dto.cik === null && !rt.cikAttempted) {
      rt.cikAttempted = true;
      const cached = cikCache.get(rt.dto.symbol.toUpperCase());
      if (cached !== undefined) {
        rt.dto.cik = cached;
      } else {
        await spaceHost(SEC_HOST);
        const cik = await withSourceTimeout("EDGAR CIK lookup", () =>
          seams.resolveCik(rt.dto.symbol),
        );
        cikCache.set(rt.dto.symbol.toUpperCase(), cik);
        rt.dto.cik = cik;
      }
    }
    if (rt.dto.cik === null) {
      status.sources.edgar = "CIK unresolved";
      return;
    }

    await spaceHost(SEC_HOST);
    const cik = rt.dto.cik;
    const filings = await withSourceTimeout("EDGAR poll", () =>
      seams.pollEdgar(
        cik,
        new Date(window.startMs).toISOString(),
        new Date(seams.now()).toISOString(),
        rt.seenAccessions,
      ),
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

async function pollIrSource(db: Database.Database, rt: PrintRuntime): Promise<void> {
  const status = statusFor(rt.printId);
  const cfg = irConfigFor(rt.dto.symbol);
  if (!cfg) {
    status.sources.rss = "no IR feed for this symbol";
    return;
  }
  try {
    await spaceHost(cfg.host);
    // The FIRST poll of a watch is a baseline pass: it fetches no article at
    // all, it just records what the feed already held (fix wave, finding A).
    // The flag flips only after the poll returns, so a first poll that fails
    // does not consume the baseline.
    const baseline = !rt.irBaselineDone;
    const items = await withSourceTimeout("IR feed poll", () =>
      seams.pollIrRss(cfg, rt.seenIrLinks, baseline),
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

/**
 * Minimal per-host governor (Codex #21, accepted deviation (c)): SEC 300ms,
 * everything else 200ms. Module-level so simultaneous prints share the budget
 * — three NVDA/CRWD/other loops hitting EDGAR still queue behind one another.
 */
async function spaceHost(host: string): Promise<void> {
  const minGap = host === SEC_HOST ? SEC_SPACING_MS : DEFAULT_SPACING_MS;
  const last = lastRequestAt.get(host) ?? 0;
  const wait = last + minGap - seams.now();
  if (wait > 0) await seams.sleep(wait);
  lastRequestAt.set(host, seams.now());
}

// ---------------------------------------------------------------------------
// acquisition + pipeline
// ---------------------------------------------------------------------------

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Cheap sniff — decides the stored extension, which in turn decides whether
 *  the pipeline builds two representations or one. */
function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 2048).trimStart().toLowerCase();
  return head.startsWith("<") || head.includes("<html") || head.includes("<table");
}

/** Temp file + atomic rename under `<storageRoot>/<printId>/` — the packaged
 *  app's cwd is a read-only signed bundle, so this anchors at the DB dir. */
async function writeBytes(printId: number, sha: string, ext: string, buf: Buffer): Promise<string> {
  const dir = path.join(seams.storageRoot(), String(printId));
  await fsp.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, `${sha}.${ext}`);
  tmpCounter += 1;
  const tmpPath = `${finalPath}.tmp-${process.pid}-${tmpCounter}`;
  await fsp.writeFile(tmpPath, buf);
  await fsp.rename(tmpPath, finalPath);
  return finalPath;
}

/**
 * Store acquired bytes for a print and (when they pass the gate) parse them.
 *
 * Idempotent on (print, kind, sha256): re-dropping the same file returns the
 * existing document and parses nothing. A gate failure is recorded, never
 * thrown — the caller acquired a real document, it simply isn't this event's.
 *
 * Returns its VERDICT, not just an id (final fix wave). The outcomes are
 * genuinely different things to tell the desk — the sheet just moved, the
 * document was refused as another issuer's/period's, these exact bytes were
 * already in hand, or the parse is waiting on the process that owns the
 * watcher — and only this function knows which happened. Callers that guessed
 * from `isNew` alone had to say something vague and permanent ("parsing now…")
 * that no later poll could ever correct.
 *
 * `parsed` means the document passed the gate and its parse was awaited. A
 * parse that then failed inside the pipeline leaves the document unparsed for
 * a later retry and reports itself through the `pipeline` source note, which
 * the panel's ladder already renders.
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

  const text = buf.toString("utf8");
  const sha = sha256(buf);
  const ext = looksLikeHtml(text) ? "html" : "txt";
  const bytesPath = await writeBytes(printId, sha, ext, buf);

  const verdict = validateDocForEvent(text, gateContextFor(db, print, kind));
  const storedSource = verdict.ok ? source : `${REJECTED_PREFIX}${verdict.reason}`;
  const { id, isNew } = insertDocument(db, printId, kind, storedSource, url, sha, bytesPath);

  if (!verdict.ok) {
    statusFor(printId).sources.gate = `doc ${id} rejected: ${verdict.reason}`;
    return { docId: id, isNew, outcome: "rejected", rejectReason: verdict.reason };
  }

  if (!isNew) return { docId: id, isNew, outcome: "duplicate" };

  advanceState(db, printId, "acquired");
  const drain = await runQueue(db, printId);
  // The drain can END without parsing: another process owns the watcher, so
  // the parse belongs to it, not us (fix wave, finding C). Reporting that as
  // `parsed` told the desk the sheet had moved when it had not — and for an
  // expired or TAS print there is no loop coming back to correct it, which is
  // why ensurePrintWatch now drains those explicitly.
  if (drain === "lease_blocked") return { docId: id, isNew, outcome: "queued" };
  return { docId: id, isNew, outcome: "parsed" };
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

/** Is this document eligible for a parse attempt right now? Rejected docs
 *  never are; a doc that just failed waits out PARSE_RETRY_SPACING_MS so its
 *  budget isn't spent on three ticks of the same transient failure. */
function parseEligible(doc: DocumentRow, nowMs: number): boolean {
  if (doc.source.startsWith(REJECTED_PREFIX)) return false;
  const record = parseAttempts.get(doc.id);
  if (!record) return true;
  if (record.attempts >= MAX_PARSE_ATTEMPTS) return false;
  return nowMs - record.lastAtMs >= PARSE_RETRY_SPACING_MS;
}

async function drainQueue(db: Database.Database, printId: number): Promise<DrainOutcome> {
  const attemptedThisPass = new Set<number>();
  for (;;) {
    const nowMs = seams.now();
    const pending = listUnparsedDocuments(db, printId).filter(
      (doc) => !attemptedThisPass.has(doc.id) && parseEligible(doc, nowMs),
    );
    if (pending.length === 0) return "drained";

    const doc = pending[0];
    attemptedThisPass.add(doc.id);

    // Don't even spend a model call — let alone an attempt — when this
    // process no longer owns the watcher; the owner will drain the document.
    if (!claimLease(db)) {
      statusFor(printId).sources.pipeline = "lease lost — parsing deferred to the owner";
      return "lease_blocked";
    }

    const record = parseAttempts.get(doc.id);
    parseAttempts.set(doc.id, { attempts: (record?.attempts ?? 0) + 1, lastAtMs: nowMs });
    try {
      await processDocument(db, printId, doc);
    } catch (err) {
      // The document stays unparsed on purpose — a later tick retries it,
      // spaced out, up to MAX_PARSE_ATTEMPTS.
      statusFor(printId).sources.pipeline = `doc ${doc.id}: ${errText(err)}`;
    }
  }
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
      parsable = listUnparsedDocuments(db, printId).some(
        (doc) => !doc.source.startsWith(REJECTED_PREFIX),
      );
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
): TaggedCandidate[] {
  return candidates.map((c) => ({
    ...c,
    doc_id: docId,
    representation,
    weak_pair: weakPair,
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

async function processDocument(
  db: Database.Database,
  printId: number,
  doc: DocumentRow,
): Promise<void> {
  const print = readPrintRow(db, printId);
  if (!print) return;

  const raw = await fsp.readFile(doc.bytes_path, "utf8");
  const { contracts } = compileContracts(db, print.event_id, print.symbol);

  const fresh: TaggedCandidate[] = [];
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

  const existing = collectCandidates(db, printId).filter((c) => c.doc_id !== doc.id);
  const written = writeLines(db, printId, print.event_id, print.symbol, [...existing, ...fresh]);
  // Only stamp the document parsed if its candidates actually landed —
  // stamping a refused write would strand the document forever.
  if (!written) return;
  markDocumentParsed(db, doc.id);
  advanceState(db, printId, "parsed");
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
