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

/** A parse that keeps failing must not burn the model budget forever. */
const MAX_PARSE_ATTEMPTS = 3;

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
  cik: string | null;
  /** Never null past this DTO (Codex #19) — the slot default backstops it. */
  releaseTimeEt: string;
}

export interface WatchStatusRow {
  printId: number;
  symbol: string;
  state: PrintWatchState;
  /** Per-source last outcome, plain short strings for the panel's ladder. */
  sources: Record<string, string>;
  /** Static capability notes (Codex #23) — what CAN and cannot fire tonight. */
  coverage: string[];
}

export interface DocGateContext {
  symbol: string;
  issuerName: string | null;
  eventDate: string;
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
  pollEdgar: (
    cik: string,
    windowStartIso: string,
    windowEndIso: string,
    seenAccessions: Set<string>,
  ) => Promise<EdgarFiling[]>;
  pollIrRss: (
    cfg: IrRssConfig,
    seenLinks: Set<string>,
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

const DEFAULT_SEAMS: WatcherSeams = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  storageRoot: () => path.join(resolveDbDir(), "print-watch"),
  twsConnection: defaultTwsConnection,
  pollDjNews: (ib, conId, windowStartUtc, nowUtc, state, nowMs) =>
    pollDjNews(ib, conId, windowStartUtc, nowUtc, state, nowMs),
  resolveCik: (symbol) => resolveCik(symbol),
  pollEdgar: (cik, startIso, endIso, seen) => pollEdgar(cik, startIso, endIso, seen),
  pollIrRss: (cfg, seenLinks) => pollIrRss(cfg, seenLinks),
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

interface PrintRuntime {
  printId: number;
  dto: ArmedEventDto;
  issuerName: string | null;
  windowStartMs: number;
  windowEndMs: number;
  live: boolean;
  burst: boolean;
  loop: Promise<void> | null;
  djState: DjPollState;
  seenAccessions: Set<string>;
  seenIrLinks: Set<string>;
  flashHeadlines: string[];
  seenFlashKeys: Set<string>;
  cikAttempted: boolean;
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
const queues = new Map<number, Promise<void>>();
const parseAttempts = new Map<number, number>();
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
  // Codex #19: a window needs a time. The slot default is the last line of
  // defence — AMC/unknown lands on the 16:15 convention already used by
  // earningsHourToReleaseTime, BMO on 08:00.
  const releaseTimeEt =
    resolved && /^\d{2}:\d{2}$/.test(resolved) ? resolved : slot === "bmo" ? "08:00" : "16:15";

  return {
    eventId: row.eventId,
    symbol: row.symbol,
    eventDate: row.event_date,
    conId: row.con_id ?? null,
    cik: cikCache.get(row.symbol.toUpperCase()) ?? null,
    releaseTimeEt,
  };
}

function windowFor(dto: ArmedEventDto): { startMs: number; endMs: number } | null {
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
    if (lower.includes(`${ORDINALS[q]} quarter`)) return { ok: true };
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
  if (nowMs > rt.windowEndMs) return current === "parsed" ? "parsed" : "expired";
  if (current === "acquired" || current === "parsed") return current;
  return nowMs >= rt.windowStartMs ? "window_open" : "scheduled";
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
  const notes: string[] = [];
  notes.push(rt.dto.conId === null ? "DJ: no conId — wire off" : "DJ: wire armed");
  if (rt.lastTwsUp === false) notes.push("TWS offline");
  if (rt.dto.cik) notes.push(`EDGAR: CIK ${rt.dto.cik}`);
  else notes.push(rt.cikAttempted ? "EDGAR: CIK unresolved" : "EDGAR: CIK pending");
  notes.push(irConfigFor(rt.dto.symbol) ? `RSS: ${rt.dto.symbol} IR feed` : "RSS: NVDA only");
  notes.push("drop: HTML/text");
  statusFor(rt.printId).coverage = notes;
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
  const holder = watcherHolder();
  const nowMs = seams.now();

  if (!acquireWatcherLease(db, holder, nowMs, LEASE_TTL_MS)) {
    leaseNote = `watcher owned by ${readLeaseHolder(db)}`;
    stopAllLoops();
    return;
  }
  leaseNote = null;
  leaseRenewedAtMs = nowMs;

  const today = todayET(new Date(nowMs));
  const dates = [addDays(today, -1), today, addDays(today, 1)];
  const armed = getArmedWorksheetEvents(db, dates);
  const armedEventIds = new Set(armed.map((r) => r.eventId));

  for (const row of armed) {
    const dto = buildArmedEventDto(db, row);
    const window = windowFor(dto);
    if (!window) continue; // unparseable date/time — nothing to open

    const printId = upsertPrint(db, dto.eventId, dto.symbol, dto.eventDate, dto.releaseTimeEt);

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
        windowStartMs: window.startMs,
        windowEndMs: window.endMs,
        live: false,
        burst: false,
        loop: null,
        djState: createDjPollState(),
        seenAccessions: new Set(),
        seenIrLinks: new Set(),
        flashHeadlines: [],
        seenFlashKeys: new Set(),
        cikAttempted: false,
        lastTwsUp: null,
      };
      runtimes.set(printId, rt);
    } else {
      // Keep the runtime's learned CIK; everything else re-derives.
      rt.dto = { ...dto, cik: rt.dto.cik ?? dto.cik };
      rt.issuerName = row.issuer_name;
      rt.windowStartMs = window.startMs;
      rt.windowEndMs = window.endMs;
    }

    const current = readPrintRow(db, printId)?.state ?? "scheduled";
    const next = desiredState(current, nowMs, rt);
    if (next !== current) setPrintState(db, printId, next);

    if (next === "expired") {
      rt.live = false;
    } else if (nowMs >= rt.windowStartMs && nowMs <= rt.windowEndMs) {
      startLoop(db, rt);
    } else {
      rt.live = false;
    }

    refreshCoverage(rt, null);
  }

  for (const print of listActivePrints(db)) {
    if (armedEventIds.has(print.event_id)) continue;
    // An active print with no armed flag is either a genuine disarm or a
    // leftover whose day has passed (the app was closed through its window) —
    // call the stale one `expired`, which is what actually happened to it.
    setPrintState(db, print.id, print.event_date < today ? "expired" : "disarmed");
    const rt = runtimes.get(print.id);
    if (rt) {
      rt.live = false;
      runtimes.delete(print.id);
    }
  }
}

/** Read-only status for the panel (Codex #9 — the GET route must not mutate). */
export function getWatchStatus(db: Database.Database): WatchStatusRow[] {
  return listActivePrints(db).map((print) => {
    const status = statuses.get(print.id);
    const sources = { ...(status?.sources ?? {}) };
    if (leaseNote) sources.watcher = leaseNote;
    return {
      printId: print.id,
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
  rt.loop = (async () => {
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
    rt.loop = null;
  })();
}

async function pollOnce(db: Database.Database, rt: PrintRuntime): Promise<void> {
  const nowMs = seams.now();

  // Lease renewal rides the loop rather than its own timer: the loop is the
  // only thing the lease protects, so a lost renewal must stop exactly it.
  if (nowMs - leaseRenewedAtMs >= LEASE_RENEW_MS) {
    if (!acquireWatcherLease(db, watcherHolder(), nowMs, LEASE_TTL_MS)) {
      leaseNote = `watcher owned by ${readLeaseHolder(db)}`;
      stopAllLoops();
      return;
    }
    leaseRenewedAtMs = nowMs;
  }

  if (nowMs > rt.windowEndMs) {
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

  const twsUp = await pollDjSource(db, rt);
  await pollEdgarSource(db, rt);
  await pollIrSource(db, rt);
  refreshCoverage(rt, twsUp);
}

/** @returns whether TWS was up (null when DJ is off for this print). */
async function pollDjSource(db: Database.Database, rt: PrintRuntime): Promise<boolean | null> {
  const status = statusFor(rt.printId);
  if (rt.dto.conId === null) {
    status.sources.dj = "no conId — wire off";
    return null;
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
      formatTwsDateTime(new Date(rt.windowStartMs)),
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
    }

    let freshFlashes = 0;
    for (const flash of out.flashes) {
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

    status.sources.dj = `ok — ${out.completedReleases.length} release(s), ${rt.flashHeadlines.length} flash(es)`;
    return true;
  } catch (err) {
    status.sources.dj = errText(err);
    return null;
  }
}

async function pollEdgarSource(db: Database.Database, rt: PrintRuntime): Promise<void> {
  const status = statusFor(rt.printId);
  try {
    if (rt.dto.cik === null && !rt.cikAttempted) {
      rt.cikAttempted = true;
      const cached = cikCache.get(rt.dto.symbol.toUpperCase());
      if (cached !== undefined) {
        rt.dto.cik = cached;
      } else {
        await spaceHost(SEC_HOST);
        const cik = await seams.resolveCik(rt.dto.symbol);
        cikCache.set(rt.dto.symbol.toUpperCase(), cik);
        rt.dto.cik = cik;
      }
    }
    if (rt.dto.cik === null) {
      status.sources.edgar = "CIK unresolved";
      return;
    }

    await spaceHost(SEC_HOST);
    const filings = await seams.pollEdgar(
      rt.dto.cik,
      new Date(rt.windowStartMs).toISOString(),
      new Date(seams.now()).toISOString(),
      rt.seenAccessions,
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
    const items = await seams.pollIrRss(cfg, rt.seenIrLinks);
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
    }
    status.sources.rss = `ok — ${items.length} item(s)`;
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
 */
export async function ingestDocument(
  db: Database.Database,
  printId: number,
  kind: PrintWatchDocKind,
  source: string,
  url: string | null,
  buf: Buffer,
): Promise<{ docId: number; isNew: boolean }> {
  const print = readPrintRow(db, printId);
  if (!print) throw new Error(`print-watch: print ${printId} not found`);

  const text = buf.toString("utf8");
  const sha = sha256(buf);
  const ext = looksLikeHtml(text) ? "html" : "txt";
  const bytesPath = await writeBytes(printId, sha, ext, buf);

  const verdict = validateDocForEvent(text, gateContextFor(db, print));
  const storedSource = verdict.ok ? source : `${REJECTED_PREFIX}${verdict.reason}`;
  const { id, isNew } = insertDocument(db, printId, kind, storedSource, url, sha, bytesPath);

  if (!verdict.ok) {
    statusFor(printId).sources.gate = `doc ${id} rejected: ${verdict.reason}`;
    return { docId: id, isNew };
  }

  if (isNew) {
    advanceState(db, printId, "acquired");
    await runQueue(db, printId);
  }
  return { docId: id, isNew };
}

/**
 * ONE pipeline at a time per print (Codex #8): every caller chains onto the
 * print's in-flight drain instead of starting a parallel one, so two documents
 * landing together still parse in doc-id order.
 */
function runQueue(db: Database.Database, printId: number): Promise<void> {
  const prev = queues.get(printId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => drainQueue(db, printId));
  queues.set(printId, next);
  return next;
}

async function drainQueue(db: Database.Database, printId: number): Promise<void> {
  const attemptedThisPass = new Set<number>();
  for (;;) {
    const pending = listUnparsedDocuments(db, printId).filter(
      (doc) =>
        !attemptedThisPass.has(doc.id) &&
        !doc.source.startsWith(REJECTED_PREFIX) &&
        (parseAttempts.get(doc.id) ?? 0) < MAX_PARSE_ATTEMPTS,
    );
    if (pending.length === 0) return;

    const doc = pending[0];
    attemptedThisPass.add(doc.id);
    parseAttempts.set(doc.id, (parseAttempts.get(doc.id) ?? 0) + 1);
    try {
      await processDocument(db, printId, doc);
    } catch (err) {
      // The document stays unparsed on purpose — the next tick retries it,
      // up to MAX_PARSE_ATTEMPTS.
      statusFor(printId).sources.pipeline = `doc ${doc.id}: ${errText(err)}`;
    }
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

function writeLines(
  db: Database.Database,
  printId: number,
  eventId: number,
  symbol: string,
  all: TaggedCandidate[],
): void {
  const { contracts, expected } = compileContracts(db, eventId, symbol);
  const accepted = getSheet(db, printId).filter((l) => l.state === "accepted");
  const lines = reconcile(contracts, expected, all, accepted).map((line) =>
    line.source_doc_id === FLASH_DOC_ID ? { ...line, source_doc_id: null } : line,
  );
  upsertLines(db, printId, lines);
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
  writeLines(db, printId, print.event_id, print.symbol, [...existing, ...fresh]);
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
 */
async function runFlashLane(db: Database.Database, rt: PrintRuntime): Promise<void> {
  const print = readPrintRow(db, rt.printId);
  if (!print) return;
  const { contracts } = compileContracts(db, print.event_id, print.symbol);
  try {
    const parsed = await seams.extractCandidates(contracts, rt.flashHeadlines.join("\n"));
    const flashCandidates = tag(parsed, FLASH_DOC_ID, "flash", false);
    const existing = collectCandidates(db, rt.printId).filter((c) => c.representation !== "flash");
    writeLines(db, rt.printId, print.event_id, print.symbol, [...existing, ...flashCandidates]);
  } catch (err) {
    statusFor(rt.printId).sources.flash = errText(err);
  }
}
