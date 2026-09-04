import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runMigrations } from "@/lib/db/migrate";
import {
  claimDocumentParse,
  extendPrintWindow,
  getDocument,
  getGoRequest,
  getIrBaseline,
  getPrintById,
  getPrintByEventId,
  getSheet,
  insertGoRequest,
  listDocumentRoads,
  listDocuments,
  listForcedLivePrints,
  listIrSeenLinks,
  recordIrBaseline,
  stampForcedOpen,
  upsertPrint,
  upsertPrintWatchSource,
} from "@/lib/print-watch/store";
import { addDays } from "@/lib/calendar/date-utils";
import { irBaselineFingerprint } from "@/lib/print-watch/ir-baseline-step";
import { recordDelivery } from "@/lib/print-watch/delivery";
import type { LineContract, ParseCandidate, RoadReport, TaggedCandidate } from "@/lib/print-watch/types";
import {
  ensurePrintWatch,
  getWatchStatus,
  ingestDocument,
  validateDocForEvent,
  _setTestSeams,
  runForcedPass,
  CADENCE_MS,
  GO_DISPATCH_MS,
  ROAD_ABANDON_MS,
  LEASE_RENEW_MS,
  ROAD_TIMEOUT_MS,
} from "@/lib/print-watch/watcher";
import { requestGo, WatcherLeaseLost } from "@/lib/print-watch/go";
import { acquisitionScheduler } from "@/lib/print-watch/scheduler";
import { FORCED_PRE_MS } from "@/lib/print-watch/window";
import { formatTwsDateTime } from "@/lib/print-watch/dj-adapter";
import type { FetchLike } from "@/lib/print-watch/hardened-fetch";
import { redactUrl } from "@/lib/print-watch/hardened-fetch";
// The REAL in-flight cancellation shape: `hardenedFetchBytes` maps every caller
// abort to this, not to an `AbortError` (re-review N1).
import { UrlFetchRefused } from "@/lib/print-watch/url-fetch";
import {
  textPathFor,
  PdfEncryptedError,
  PdfToolMissingError,
} from "@/lib/print-watch/pdf";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 2026-08-26 16:20 ET (EDT, UTC−4) — inside an AMC (16:15 ET) print window. */
const IN_WINDOW = new Date("2026-08-26T20:20:00Z");
const EVENT_DATE = "2026-08-26";

const NVDA_RELEASE_TEXT = [
  "NVIDIA Announces Financial Results for Second Quarter Fiscal 2027",
  "SANTA CLARA, Calif. — NVIDIA (NASDAQ: NVDA) today reported revenue of $46,743 million",
  "and non-GAAP diluted earnings per share of $1.05 for the quarter ended July 26, 2026.",
].join("\n");

const NVDA_RELEASE_HTML = [
  "<html><body><h1>NVIDIA Announces Financial Results for Second Quarter Fiscal 2027</h1>",
  "<p>NVIDIA (NASDAQ: NVDA) today reported quarterly revenue.</p>",
  "<table><tr><td>Revenue</td><td>46,743</td></tr>",
  "<tr><td>Diluted EPS</td><td>1.05</td></tr></table></body></html>",
].join("");

const WRONG_ISSUER_TEXT = [
  "ACME Widget Holdings Reports Third Quarter 2026 Results",
  "Revenue of $12.0 million and diluted earnings per share of $0.10.",
].join("\n");

let db: Database.Database;
let tmpRoot: string;

interface ExtractCall {
  text: string;
}

/** The slice of `HardenedFetchBytesOptions` these tests care about. */
interface FakeFetchOptions {
  label: string;
  allowHost?: (hostname: string) => boolean;
  /** The road's cancellation, so a fake link fetch can hang until it is
   *  aborted — or deliberately IGNORE it (the abandon-budget case). */
  signal?: AbortSignal;
}

interface FakeFetchResult {
  bytes: Buffer;
  finalUrl: string;
  status: number;
  contentType: string | null;
}

interface FakeSeamState {
  extractCalls: ExtractCall[];
  extract: (contracts: LineContract[], text: string) => Promise<ParseCandidate[]>;
  /** The PDF paths handed to the poppler seam, in order. */
  pdfTextCalls: string[];
  /** Stands in for `pdftotext -layout` — throw to simulate poppler missing
   *  or an encrypted PDF, return a string to simulate its text layer. */
  pdfText: (pdfPath: string) => Promise<string>;
  /** The PDF bytes handed to the Claude-native reading, in order. */
  extractPdfCalls: Array<{ bytes: Buffer }>;
  extractPdf: (contracts: LineContract[], bytes: Buffer) => Promise<ParseCandidate[]>;
  djCalls: number;
  /** The signal the pass handed the DJ adapter — a road that only settles when
   *  it fires is exactly "hung until cancelled". */
  dj: (signal?: AbortSignal) => Promise<{
    completedReleases: Array<{
      headline: string;
      stitchedText: string;
      partCount: number;
      articleIds: string[];
    }>;
    flashes: Array<{ time: string; headline: string; articleId: string }>;
  }>;
  edgarCalls: number;
  /** The seen-accession set as it looked at each poll — the watcher owns it
   *  and must only add to it AFTER a filing's exhibits are ingested. */
  edgarSeen: string[][];
  /** The scheduler-throttled fetch the EDGAR lane handed the adapter (slice C):
   *  calling it is how a fake road proves it is cancelled, not just abandoned. */
  edgar: (fetchFn?: FetchLike) => Promise<
    Array<{
      accession: string;
      form: string;
      acceptanceDateTime: string;
      exhibits: Array<{ name: string; url: string; html: string }>;
    }>
  >;
  /** {baseline, seen} as the watcher passed them, per IR poll. */
  irCalls: Array<{ baseline: boolean; seen: string[] }>;
  ir: (baseline: boolean) => Promise<Array<{ title: string; link: string; html: string }>>;
  /** Every URL the hardened-fetch seam was handed, with the OPTIONS it was
   *  handed them with — the M17 allowlist is an argument, so the only honest
   *  way to assert it rode along is to keep the options object. */
  fetchCalls: Array<{ url: string; opts: FakeFetchOptions }>;
  /** Stands in for `hardenedFetchBytes`. Throws by default: no test that has
   *  not stored an IR page should reach the network lane at all, and a silent
   *  empty body would hide it. */
  fetchBytes: (url: string, opts: FakeFetchOptions) => Promise<FakeFetchResult>;
  twsUp: boolean;
  cik: string | null;
  /** One-shot timer failure, to crash a loop body on purpose. */
  sleepThrowsOnce: boolean;
  /** Overrides the acquired-bytes root. Point it at a FILE and
   *  `ingestDocument` throws on its mkdir — the clean way to simulate an
   *  ingest that dies before the document ever exists. */
  storageRoot: string | null;
  /** `djState.seenArticleIds` as it looked at each DJ poll — the watcher owns
   *  it and must only add AFTER a release is ingested / a flash is batched. */
  djSeen: string[][];
  /** The conId the DJ poll seam was handed, per poll. */
  djConIds: number[];
  /** The window-START argument each seam was handed, per poll — the effective
   *  window (press − 60m on a forced open), not the scheduled one. */
  djStarts: string[];
  edgarStarts: string[];
  /**
   * The RAW fetch the acquisition scheduler wraps. It never resolves and
   * rejects with an `AbortError` when its signal fires, so a road built on it
   * hangs until it is CANCELLED — and no test ever opens a socket.
   */
  fetchImpl: FetchLike;
  /** securityIds handed to the conId resolver seam, in order. */
  conIdCalls: number[];
  /** What the conId resolver seam answers (null = TWS knows no such contract). */
  conIdResult: number | null;
  /** When set, the conId resolver seam throws with this message instead. */
  conIdThrows: string | null;
  /**
   * The watcher's clock, as an OFFSET on the (faked) system time rather than
   * an absolute stamp: reading it gives what `seams.now()` returns, and
   * `fake.nowMs += 60_000` pushes the watcher's clock forward WITHOUT
   * advancing the fake timer queue — which is how a test can walk past a
   * retry-spacing or claim-staleness threshold without also running every
   * parked loop timer in between. Default offset 0, so every existing test
   * sees exactly `Date.now()`.
   */
  nowMs: number;
}

let fake: FakeSeamState;

function candidate(metricId: string, value: number | null): ParseCandidate {
  return {
    metric_id: metricId,
    value,
    value_high: null,
    raw_text: value === null ? null : String(value),
    snippet: "verbatim snippet",
    location_hint: "table 1",
    not_disclosed: value === null,
  };
}

function installSeams(): void {
  fake = {
    extractCalls: [],
    extract: async () => [],
    pdfTextCalls: [],
    pdfText: async () => "",
    extractPdfCalls: [],
    extractPdf: async () => [],
    djCalls: 0,
    dj: async () => ({ completedReleases: [], flashes: [] }),
    edgarCalls: 0,
    edgarSeen: [],
    edgar: async () => [],
    irCalls: [],
    ir: async () => [],
    fetchCalls: [],
    fetchBytes: async () => {
      throw new Error("fetchBytes seam not stubbed by this test");
    },
    twsUp: true,
    cik: null,
    sleepThrowsOnce: false,
    storageRoot: null,
    djSeen: [],
    djConIds: [],
    djStarts: [],
    edgarStarts: [],
    fetchImpl: (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abortErr = () => Object.assign(new Error("aborted"), { name: "AbortError" });
        if (signal?.aborted) {
          reject(abortErr());
          return;
        }
        signal?.addEventListener("abort", () => reject(abortErr()), { once: true });
      }),
    conIdCalls: [],
    conIdResult: null,
    conIdThrows: null,
    nowMs: 0, // replaced below by the offset accessor
  };

  // `nowMs` reads as an absolute stamp and writes as an offset, so
  // `fake.nowMs += 60_000` shifts the watcher's clock without touching the
  // fake timer queue.
  let nowOffsetMs = 0;
  Object.defineProperty(fake, "nowMs", {
    get: () => Date.now() + nowOffsetMs,
    set: (next: number) => {
      nowOffsetMs = next - Date.now();
    },
    configurable: true,
  });

  _setTestSeams({
    now: () => fake.nowMs,
    storageRoot: () => fake.storageRoot ?? tmpRoot,
    sleep: (ms: number) => {
      if (fake.sleepThrowsOnce) {
        fake.sleepThrowsOnce = false;
        return Promise.reject(new Error("timer subsystem died"));
      }
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
    twsConnection: async () => ({
      up: fake.twsUp,
      ib: fake.twsUp ? ({} as never) : null,
    }),
    pollDjNews: async (
      _ib: unknown,
      conId: number,
      windowStartUtc: string,
      _nowUtc: string,
      state: { seenArticleIds: Set<string> },
      _nowMs: number,
      signal?: AbortSignal,
    ) => {
      fake.djCalls += 1;
      fake.djConIds.push(conId);
      fake.djStarts.push(windowStartUtc);
      fake.djSeen.push([...state.seenArticleIds]);
      return fake.dj(signal);
    },
    resolveCik: async () => fake.cik,
    resolveConId: async (_db: unknown, securityId: number) => {
      fake.conIdCalls.push(securityId);
      if (fake.conIdThrows) throw new Error(fake.conIdThrows);
      return fake.conIdResult;
    },
    pollEdgar: async (
      _cik: string,
      startIso: string,
      _endIso: string,
      seenAccessions: Set<string>,
      fetchFn?: FetchLike,
    ) => {
      fake.edgarCalls += 1;
      fake.edgarStarts.push(startIso);
      fake.edgarSeen.push([...seenAccessions]);
      return fake.edgar(fetchFn);
    },
    pollIrRss: async (_cfg, seenLinks: Set<string>, baseline: boolean) => {
      fake.irCalls.push({ baseline, seen: [...seenLinks] });
      return fake.ir(baseline);
    },
    fetchBytes: async (url: string, opts) => {
      const seen = opts as FakeFetchOptions;
      fake.fetchCalls.push({ url, opts: seen });
      return fake.fetchBytes(url, seen);
    },
    extractCandidates: async (contracts: LineContract[], text: string) => {
      fake.extractCalls.push({ text });
      return fake.extract(contracts, text);
    },
    pdfToText: async (_db: unknown, pdfPath: string) => {
      fake.pdfTextCalls.push(pdfPath);
      return fake.pdfText(pdfPath);
    },
    extractCandidatesFromPdf: async (contracts: LineContract[], bytes: Buffer) => {
      fake.extractPdfCalls.push({ bytes });
      return fake.extractPdf(contracts, bytes);
    },
    fetchImpl: (url: string, init?: RequestInit) => fake.fetchImpl(url, init),
  });
}

function seedArmedEvent(
  opts: {
    symbol?: string;
    conId?: number | null;
    eventDate?: string;
    armed?: boolean;
    eventTime?: string;
    rawJson?: string | null;
    /** false = no `securities` row at all, so nothing can resolve a conId. */
    withSecurity?: boolean;
    /** The issuer the gate matches on. Defaults to NVIDIA to match `symbol`'s
     *  default; a test that seeds another ticker should name its issuer too,
     *  or the gate reads a document from a company nobody armed. */
    issuerName?: string;
  } = {},
): { eventId: number; securityId: number | null } {
  const symbol = opts.symbol ?? "NVDA";
  const conId = opts.conId === undefined ? 4815747 : opts.conId;
  const issuerName = opts.issuerName ?? "NVIDIA Corporation";

  const securityId =
    opts.withSecurity === false
      ? null
      : (Number(
          db
            .prepare(
              `INSERT INTO securities (symbol, name, security_type, ib_con_id) VALUES (?, ?, 'Stock', ?)`,
            )
            .run(symbol, issuerName, conId).lastInsertRowid,
        ) as number);

  const ev = db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, title, symbol, security_id, raw_json, source_key)
       VALUES ('finnhub', 'earnings', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.eventDate ?? EVENT_DATE,
      opts.eventTime ?? "AMC",
      `${symbol} earnings`,
      symbol,
      securityId,
      opts.rawJson === undefined ? JSON.stringify({ entry: { hour: "amc" } }) : opts.rawJson,
      `finnhub:${symbol}:${opts.eventDate ?? EVENT_DATE}`,
    );
  const eventId = Number(ev.lastInsertRowid);

  if (opts.armed !== false) {
    db.prepare(`INSERT INTO earnings_worksheet_flags (event_id) VALUES (?)`).run(eventId);
  }

  db.prepare(
    `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus, revenue_consensus_usd)
     VALUES (?, 'manual', 'desk consensus', 1.01, 46000000000)`,
  ).run(eventId);

  return { eventId, securityId };
}

function printIdFor(eventId: number): number {
  const row = getPrintByEventId(db, eventId);
  if (!row) throw new Error("print row missing");
  return row.id;
}

/**
 * Real I/O (fs) does not resolve on the fake timer queue, and one acquired
 * document costs several event-loop turns (mkdir → write → rename → read).
 * setImmediate is deliberately left un-faked so these turns can be drained.
 */
async function flushIo(cycles = 60): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function tick(ms: number): Promise<void> {
  await flushIo();
  await vi.advanceTimersByTimeAsync(ms);
  await flushIo();
}

/**
 * The watcher's loop is a chained `while (live) { await pollOnce(); await
 * sleep(CADENCE_MS) }` (lib/print-watch/watcher.ts, "the loop" — never
 * setInterval), so the SECOND poll's `setTimeout` is only registered once the
 * FIRST poll's async work — including real fs I/O for an acquired document —
 * has actually resolved. A single `tick(11_000)` bets that the first poll's
 * I/O finishes inside one `flushIo` window; under a loaded machine it
 * sometimes doesn't, `advanceTimersByTimeAsync` returns having advanced no
 * registered timer, and only one poll ever lands. Step the cadence forward
 * one window at a time instead, re-checking after each step, so the
 * outstanding I/O gets as many `flushIo` passes as it needs (bounded, so a
 * genuine regression still fails instead of hanging).
 */
async function tickUntilSecondPoll(pollCount: () => number, maxSteps = 10): Promise<void> {
  for (let i = 0; i < maxSteps && pollCount() <= 1; i += 1) {
    await tick(11_000);
  }
}

/**
 * Wait for a DURABLE condition (a row's parse_state) rather than a fixed
 * number of I/O flushes. `replay.test.ts` has the same helper on a real clock;
 * here `setTimeout`/`Date` are faked, so a wall-clock version would spin
 * forever — this one drains real I/O first and only then steps the fake timer,
 * bounded so a genuine regression fails instead of hanging.
 */
async function waitUntil(pred: () => boolean, steps = 40, stepMs = 1_000): Promise<void> {
  for (let i = 0; i < steps; i += 1) {
    await flushIo(20);
    if (pred()) return;
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  await flushIo();
  if (!pred()) throw new Error("waitUntil: the condition never became true");
}

beforeEach(() => {
  // setImmediate stays REAL so fs promises can be flushed between fake ticks.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(IN_WINDOW);

  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "print-watch-test-"));
  installSeams();
});

afterEach(() => {
  _setTestSeams(null);
  vi.useRealTimers();
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// lease
// ---------------------------------------------------------------------------

describe("ensurePrintWatch — lease", () => {
  it("does nothing (no print, no loops) while another live holder owns the lease", async () => {
    const { eventId } = seedArmedEvent();
    db.prepare(
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    ).run(
      "print_watch_lease",
      JSON.stringify({ holder: "9999@3999", expiresAt: Date.now() + 60_000 }),
    );

    ensurePrintWatch(db);
    await tick(30_000);

    expect(getPrintByEventId(db, eventId)).toBeNull();
    expect(fake.djCalls).toBe(0);
  });

  it("reports the foreign holder in status", async () => {
    seedArmedEvent();
    // A print exists from an earlier (owning) run so status has a row to note on.
    ensurePrintWatch(db);
    await tick(1);

    db.prepare(
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    ).run(
      "print_watch_lease",
      JSON.stringify({ holder: "9999@3999", expiresAt: Date.now() + 60_000 }),
    );
    ensurePrintWatch(db);

    const status = getWatchStatus(db);
    expect(status).toHaveLength(1);
    expect(status[0].sources.watcher).toBe("watcher owned by 9999@3999");
  });

  it("stops the loops when a renewal is lost mid-window", async () => {
    seedArmedEvent();
    ensurePrintWatch(db);
    await tick(1);
    const callsBeforeSteal = fake.djCalls;
    expect(callsBeforeSteal).toBeGreaterThan(0);

    // Another process takes the lease; our next renewal (20s) must fail.
    db.prepare(
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    ).run(
      "print_watch_lease",
      JSON.stringify({ holder: "9999@3999", expiresAt: Date.now() + 120_000 }),
    );

    await tick(60_000);
    const callsAfterStop = fake.djCalls;
    await tick(60_000);
    expect(fake.djCalls).toBe(callsAfterStop);
  });

  it("resumes a PARKED loop instead of starting a second one beside it", async () => {
    seedArmedEvent();
    let inFlight = 0;
    let maxInFlight = 0;
    fake.dj = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      inFlight -= 1;
      return { completedReleases: [], flashes: [] };
    };

    ensurePrintWatch(db);
    await tick(13_000); // first poll done; the loop is now parked in its sleep

    // A user release-time override pushes the window into the future, so the
    // next ensure stands the (parked) loop down without it noticing yet.
    db.prepare(
      `INSERT INTO symbol_release_times (symbol, release_time, source, updated_at)
       VALUES ('NVDA', '18:00', 'user', datetime('now'))`,
    ).run();
    ensurePrintWatch(db);

    // Override withdrawn — the window is live again while the old task is
    // still asleep. Starting a fresh loop beside it would double every poll.
    db.prepare(`DELETE FROM symbol_release_times WHERE symbol = 'NVDA'`).run();
    ensurePrintWatch(db);
    const pollsBefore = fake.djCalls;
    await tick(60_000);

    expect(fake.djCalls).toBeGreaterThan(pollsBefore);
    expect(maxInFlight).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// reconcile: arm / disarm / window transitions
// ---------------------------------------------------------------------------

describe("ensurePrintWatch — reconcile", () => {
  it("creates the print plus pending lines carrying the parallel expected values", () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);

    const print = getPrintByEventId(db, eventId);
    expect(print).not.toBeNull();
    expect(print!.symbol).toBe("NVDA");
    expect(print!.release_time_et).toBe("16:15");
    expect(print!.state).toBe("window_open");

    const sheet = getSheet(db, print!.id);
    const ids = sheet.map((l) => l.metric_id).sort();
    expect(ids).toEqual(["eps_adj_q", "eps_gaap_q", "revenue_q"]);
    expect(sheet.every((l) => l.state === "pending")).toBe(true);

    const epsAdj = sheet.find((l) => l.metric_id === "eps_adj_q")!;
    expect(epsAdj.expected?.value).toBe(1.01);
    // The bogey never reaches an extraction prompt — it lives on the line only.
    expect(epsAdj.contract.definition).not.toContain("1.01");
  });

  it("getWatchStatus rows carry eventId — POST /accept and POST /drop key on it, not printId", () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);

    const print = getPrintByEventId(db, eventId)!;
    const status = getWatchStatus(db);
    expect(status).toHaveLength(1);
    expect(status[0].printId).toBe(print.id);
    expect(status[0].eventId).toBe(eventId);
  });

  it("keeps TODAY's expired print in status with a live drop road (the window closing is when the drop matters most)", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);

    // Past T+45m: the automatic window closes without the wire delivering.
    vi.setSystemTime(new Date("2026-08-26T21:30:00Z"));
    ensurePrintWatch(db);
    expect(getPrintByEventId(db, eventId)!.state).toBe("expired");

    // The panel must still see it — a row it cannot see is a row it cannot
    // drop onto.
    const status = getWatchStatus(db);
    expect(status).toHaveLength(1);
    expect(status[0].printId).toBe(printId);
    expect(status[0].eventId).toBe(eventId);
    expect(status[0].state).toBe("expired");

    // And the manual road still runs end-to-end from expired.
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];
    await ingestDocument(
      db,
      printId,
      "user-drop",
      "drop:release.txt",
      null,
      Buffer.from(NVDA_RELEASE_TEXT, "utf8"),
    );
    expect(getPrintByEventId(db, eventId)!.state).toBe("parsed");
    expect(getSheet(db, printId).find((l) => l.metric_id === "eps_adj_q")!.state).toBe(
      "single_source",
    );
  });

  it("drops an expired print from status once its event date is no longer today", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    vi.setSystemTime(new Date("2026-08-26T21:30:00Z"));
    ensurePrintWatch(db);
    expect(getWatchStatus(db)).toHaveLength(1);

    // Next morning ET — yesterday's miss is history, not work in hand.
    vi.setSystemTime(new Date("2026-08-27T14:00:00Z"));
    expect(getPrintByEventId(db, eventId)!.state).toBe("expired");
    expect(getWatchStatus(db)).toHaveLength(0);
  });

  it("does not drag expired prints back through the disarm/expire pass on the next sweep", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    vi.setSystemTime(new Date("2026-08-26T21:30:00Z"));
    ensurePrintWatch(db);

    // Flag removed while the print sits expired: the stale-print pass walks
    // listActivePrints, which must NOT have been widened — an expired row it
    // could see would be re-stamped 'disarmed', losing the drop road.
    db.prepare(`DELETE FROM earnings_worksheet_flags WHERE event_id = ?`).run(eventId);
    ensurePrintWatch(db);

    expect(getPrintByEventId(db, eventId)!.state).toBe("expired");
    expect(getWatchStatus(db)).toHaveLength(1);
  });

  it("is idempotent — a second ensure neither duplicates prints nor doubles the loop", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    await tick(1);
    const afterFirst = fake.djCalls;

    ensurePrintWatch(db);
    ensurePrintWatch(db);
    await tick(1);

    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM print_watch_prints WHERE event_id = ?`).get(eventId),
    ).toEqual({ n: 1 });
    // One extra poll at most from the immediate first tick, never 3x.
    expect(fake.djCalls).toBeLessThanOrEqual(afterFirst + 1);
  });

  it("picks up bogeys curated AFTER arming, but never rewrites a sheet holding evidence", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);

    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, segment_breakdown_json)
       VALUES (?, 'manual', 'later note', ?)`,
    ).run(eventId, JSON.stringify({ "Data Center": { consensus: 41000000000 } }));
    ensurePrintWatch(db);

    expect(getSheet(db, printId).map((l) => l.metric_id)).toContain("seg_data_center_revenue_q");

    // Once a document has produced candidates the sheet is off limits.
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];
    await ingestDocument(
      db,
      printId,
      "user-drop",
      "drop:release.txt",
      null,
      Buffer.from(NVDA_RELEASE_TEXT, "utf8"),
    );
    expect(getSheet(db, printId).find((l) => l.metric_id === "eps_adj_q")!.state).toBe(
      "single_source",
    );

    ensurePrintWatch(db);
    expect(getSheet(db, printId).find((l) => l.metric_id === "eps_adj_q")!.state).toBe(
      "single_source",
    );
  });

  it("disarms the print and cancels its loop when the flag is removed", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    await tick(1);
    expect(fake.djCalls).toBeGreaterThan(0);

    db.prepare(`DELETE FROM earnings_worksheet_flags WHERE event_id = ?`).run(eventId);
    ensurePrintWatch(db);

    expect(getPrintByEventId(db, eventId)!.state).toBe("disarmed");
    const frozen = fake.djCalls;
    await tick(60_000);
    expect(fake.djCalls).toBe(frozen);
    expect(getWatchStatus(db)).toHaveLength(0);
  });

  it("keeps ONE runtime through a disarm/re-arm flap — no second loop, no flash re-emission", async () => {
    const { eventId } = seedArmedEvent();
    let inFlight = 0;
    let maxInFlight = 0;
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];
    fake.dj = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      inFlight -= 1;
      return {
        completedReleases: [],
        flashes: [
          {
            time: "2026-08-26 20:20:00.0",
            headline: "*NVIDIA 2Q ADJ EPS $1.05",
            articleId: "DJ-N$flash1",
          },
        ],
      };
    };

    ensurePrintWatch(db);
    await tick(13_000); // first poll done, flash lane ran once, loop parked
    expect(fake.extractCalls).toHaveLength(1);

    // The flap: a user toggle, or a calendar sync flipping `superseded`.
    db.prepare(`DELETE FROM earnings_worksheet_flags WHERE event_id = ?`).run(eventId);
    ensurePrintWatch(db);
    db.prepare(`INSERT INTO earnings_worksheet_flags (event_id) VALUES (?)`).run(eventId);
    ensurePrintWatch(db);

    await tick(60_000);

    expect(getPrintByEventId(db, eventId)!.state).not.toBe("disarmed");
    expect(maxInFlight).toBe(1); // a second runtime would double every poll
    expect(fake.extractCalls).toHaveLength(1); // and re-parse the same flash
  });

  it("gives an unresolvable TAS row a drop-zone-only print with no window", async () => {
    const { eventId } = seedArmedEvent({ eventTime: "TAS", rawJson: null });

    ensurePrintWatch(db);
    await tick(30_000);

    const print = getPrintByEventId(db, eventId)!;
    expect(print.release_time_et).toBeNull();
    expect(print.state).toBe("scheduled"); // never auto-opens, never expires
    expect(fake.djCalls).toBe(0);
    expect(fake.edgarCalls).toBe(0);
    expect(getWatchStatus(db)[0].coverage).toEqual([
      "TAS — release time unknown; drop-zone only",
      "drop: HTML/text/PDF, or a pasted link",
    ]);

    // The drop zone still works — that is the whole point of keeping the print.
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];
    await ingestDocument(
      db,
      printIdFor(eventId),
      "user-drop",
      "drop:release.txt",
      null,
      Buffer.from(NVDA_RELEASE_TEXT, "utf8"),
    );
    expect(getSheet(db, printIdFor(eventId)).find((l) => l.metric_id === "eps_adj_q")!.state).toBe(
      "single_source",
    );
  });

  it("stays scheduled before the window opens, opens in-window, expires after T+45m", async () => {
    const { eventId } = seedArmedEvent();

    vi.setSystemTime(new Date("2026-08-26T18:00:00Z")); // 14:00 ET — before T−10m
    ensurePrintWatch(db);
    expect(getPrintByEventId(db, eventId)!.state).toBe("scheduled");
    await tick(30_000);
    expect(fake.djCalls).toBe(0);

    vi.setSystemTime(new Date("2026-08-26T20:10:00Z")); // 16:10 ET — inside T−10m
    ensurePrintWatch(db);
    expect(getPrintByEventId(db, eventId)!.state).toBe("window_open");
    await tick(1);
    expect(fake.djCalls).toBeGreaterThan(0);

    vi.setSystemTime(new Date("2026-08-26T21:30:00Z")); // 17:30 ET — past T+45m
    ensurePrintWatch(db);
    expect(getPrintByEventId(db, eventId)!.state).toBe("expired");
    const frozen = fake.djCalls;
    await tick(60_000);
    expect(fake.djCalls).toBe(frozen);
  });
});

// ---------------------------------------------------------------------------
// loops
// ---------------------------------------------------------------------------

describe("watch loop", () => {
  it("never overlaps a slow poll with itself", async () => {
    seedArmedEvent();
    let inFlight = 0;
    let maxInFlight = 0;
    fake.dj = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25_000));
      inFlight -= 1;
      return { completedReleases: [], flashes: [] };
    };

    ensurePrintWatch(db);
    await tick(120_000);

    expect(fake.djCalls).toBeGreaterThan(1);
    expect(maxInFlight).toBe(1);
  });

  it("bursts an immediate extra poll after a hit instead of waiting out the cadence", async () => {
    seedArmedEvent();
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];
    let served = false;
    fake.dj = async () => {
      if (served) return { completedReleases: [], flashes: [] };
      served = true;
      return {
        completedReleases: [
          {
            headline: "Press Release: NVIDIA",
            stitchedText: NVDA_RELEASE_TEXT,
            partCount: 1,
            articleIds: ["DJ-N$rel1"],
          },
        ],
        flashes: [],
      };
    };

    ensurePrintWatch(db);
    // Well under the 10s cadence: only a burst can produce a second DJ poll.
    await tick(2_000);

    expect(fake.djCalls).toBeGreaterThanOrEqual(2);
  });

  it("skips DJ with a 'tws offline' note when the connection seam reports down", async () => {
    seedArmedEvent();
    fake.twsUp = false;

    ensurePrintWatch(db);
    await tick(1);

    expect(fake.djCalls).toBe(0);
    const status = getWatchStatus(db);
    expect(status[0].sources.dj).toBe("tws offline");
    expect(status[0].coverage).toContain("TWS offline");
  });

  it("times out a stalled EDGAR poll so the lease keeps renewing and the loop lives", async () => {
    seedArmedEvent();
    fake.cik = "0001045810";
    // A socket that never answers AND ignores its cancellation: aborted at
    // ROAD_TIMEOUT_MS, and only then abandoned at ROAD_ABANDON_MS (R-C12), so
    // one pass of this print lasts the full abandon budget.
    fake.edgar = () => new Promise(() => {});

    const leaseExpiry = (): number => {
      const row = db.prepare(`SELECT value FROM settings WHERE key = 'print_watch_lease'`).get() as
        | { value: string }
        | undefined;
      return row ? (JSON.parse(row.value) as { expiresAt: number }).expiresAt : 0;
    };

    ensurePrintWatch(db);
    const expiryBefore = leaseExpiry();

    await tick(ROAD_ABANDON_MS + CADENCE_MS + 5_000);

    expect(fake.edgarCalls).toBeGreaterThan(0);
    expect(getWatchStatus(db)[0].sources.edgar).toContain("timed out");
    // The renewal happened despite the hung source, and DJ kept polling.
    expect(leaseExpiry()).toBeGreaterThan(expiryBefore);
    const djAfterStall = fake.djCalls;
    expect(djAfterStall).toBeGreaterThan(1);

    await tick(ROAD_ABANDON_MS + CADENCE_MS + 5_000);
    expect(fake.djCalls).toBeGreaterThan(djAfterStall);
  });

  it("records a crashed loop body and brings the loop back", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      seedArmedEvent();
      ensurePrintWatch(db);
      await tick(1);

      fake.sleepThrowsOnce = true; // the cadence sleep blows up
      await tick(11_000);
      expect(getWatchStatus(db)[0].sources.loop).toContain("loop crashed");

      const pollsAfterCrash = fake.djCalls;
      await tick(30_000);
      expect(fake.djCalls).toBeGreaterThan(pollsAfterCrash);
    } finally {
      warn.mockRestore();
    }
  });

  it("notes a missing conId as wire-off coverage and never calls DJ", async () => {
    // No securities row at all: nothing for the TWS resolver to look up.
    seedArmedEvent({ conId: null, withSecurity: false });

    ensurePrintWatch(db);
    await tick(1);

    expect(fake.djCalls).toBe(0);
    expect(fake.conIdCalls).toEqual([]);
    expect(getWatchStatus(db)[0].coverage).toContain("DJ: no conId — wire off");
  });

  it("resolves a missing conId through TWS once and arms the wire (the SNOW miss)", async () => {
    const { securityId } = seedArmedEvent({ conId: null });
    fake.conIdResult = 444884769;

    ensurePrintWatch(db);
    await tick(1);
    await tick(11_000);

    expect(fake.conIdCalls).toEqual([securityId]); // once per print, not per tick
    expect(fake.djCalls).toBeGreaterThan(0);
    expect(fake.djConIds).toContain(444884769);
    const status = getWatchStatus(db);
    expect(status[0].coverage).toContain("DJ: wire armed (conId resolved via TWS)");
  });

  it("waits for TWS before attempting the conId lookup, then attempts it", async () => {
    const { securityId } = seedArmedEvent({ conId: null });
    fake.twsUp = false;
    fake.conIdResult = 444884769;

    ensurePrintWatch(db);
    await tick(1);

    expect(fake.conIdCalls).toEqual([]); // TWS down is not a completed attempt
    expect(getWatchStatus(db)[0].coverage).toContain("DJ: no conId — TWS offline, wire off");

    fake.twsUp = true;
    await tick(11_000);

    expect(fake.conIdCalls).toEqual([securityId]);
    expect(getWatchStatus(db)[0].coverage).toContain("DJ: wire armed (conId resolved via TWS)");
  });

  it("says so, once, when TWS cannot resolve the symbol", async () => {
    seedArmedEvent({ conId: null });
    fake.conIdResult = null;

    ensurePrintWatch(db);
    await tick(1);

    expect(fake.conIdCalls).toHaveLength(1);
    expect(fake.djCalls).toBe(0);
    expect(getWatchStatus(db)[0].coverage).toContain(
      "DJ: no conId — TWS could not resolve NVDA, wire off",
    );

    await tick(11_000);
    expect(fake.conIdCalls).toHaveLength(1); // never re-asked
  });

  it("reports a throwing conId lookup and does not retry it", async () => {
    seedArmedEvent({ conId: null });
    fake.conIdThrows = "contract details timed out";

    ensurePrintWatch(db);
    await tick(1);

    expect(fake.conIdCalls).toHaveLength(1);
    expect(getWatchStatus(db)[0].sources.dj).toContain("contract details timed out");

    await tick(11_000);
    expect(fake.conIdCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// document-to-event gate
// ---------------------------------------------------------------------------

describe("validateDocForEvent", () => {
  const ctx = { symbol: "NVDA", issuerName: "NVIDIA Corporation", eventDate: EVENT_DATE };

  it("accepts a release naming the ticker and its fiscal quarter", () => {
    expect(validateDocForEvent(NVDA_RELEASE_TEXT, ctx).ok).toBe(true);
  });

  it("accepts the fiscal-label variant when the symbol matches (the CRWD Q1 FY2027 lesson)", () => {
    const crwd = { symbol: "CRWD", issuerName: "CrowdStrike Holdings, Inc.", eventDate: "2026-06-03" };
    const text =
      "CrowdStrike (NASDAQ: CRWD) Reports First Quarter Fiscal Year 2027 Financial Results";
    expect(validateDocForEvent(text, crwd).ok).toBe(true);
  });

  it("rejects a document for a different issuer", () => {
    const verdict = validateDocForEvent(WRONG_ISSUER_TEXT, ctx);
    if (verdict.ok) throw new Error("expected the wrong-issuer document to be rejected");
    expect(verdict.reason).toContain("issuer");
  });

  it("rejects a bare ordinal quarter with no year beside it", () => {
    // "Second Quarter" alone shows up in prior-year comparatives and in last
    // year's release — the ordinal branch carries the same year requirement
    // as the Qn branches.
    const verdict = validateDocForEvent(
      "NVIDIA (NASDAQ: NVDA) — Second Quarter Highlights and Key Metrics",
      ctx,
    );
    if (verdict.ok) throw new Error("expected the yearless ordinal document to be rejected");
    expect(verdict.reason).toContain("period");
  });

  it("rejects a document with no fiscal-period token", () => {
    const verdict = validateDocForEvent(
      "NVIDIA (NASDAQ: NVDA) announces a new GPU architecture.",
      ctx,
    );
    if (verdict.ok) throw new Error("expected the period-less document to be rejected");
    expect(verdict.reason).toContain("period");
  });

  // Finding A, layer 2. The IR newsroom serves LAST quarter's results
  // announcement from the same feed, matching the same title regex, forever —
  // and it is the one source whose arrival carries no period evidence of its
  // own. So an ir-page document has to name THIS event's quarter; the
  // generous any-fiscal-year fallback (right for a wire item or an in-window
  // 8-K exhibit) is not available to it.
  const LAST_QUARTERS_IR_PAGE = [
    "NVIDIA Announces Financial Results for First Quarter Fiscal 2027",
    "SANTA CLARA, Calif. — NVIDIA (NASDAQ: NVDA) today reported revenue of $44,062 million",
    "and non-GAAP diluted earnings per share of $0.96 for the first quarter of fiscal 2027.",
  ].join("\n");

  it("accepts last quarter's fiscal labels for a wire/EDGAR document (the loose branch)", () => {
    expect(validateDocForEvent(LAST_QUARTERS_IR_PAGE, { ...ctx, kind: "edgar-ex99" }).ok).toBe(true);
  });

  it("REJECTS the same document when it arrived as an ir-page", () => {
    const verdict = validateDocForEvent(LAST_QUARTERS_IR_PAGE, { ...ctx, kind: "ir-page" });
    if (verdict.ok) throw new Error("expected last quarter's IR page to be rejected");
    expect(verdict.reason).toContain("quarter");
    expect(verdict.reason).toMatch(/IR page/i);
  });

  it("still accepts an ir-page that names this event's quarter", () => {
    expect(validateDocForEvent(NVDA_RELEASE_TEXT, { ...ctx, kind: "ir-page" }).ok).toBe(true);
  });
});

describe("ingestDocument — gate", () => {
  it("stores a failing document with a rejected CONTENT verdict and never parses it", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);

    const result = await ingestDocument(
      db,
      printId,
      "user-drop",
      "drop:acme.html",
      null,
      Buffer.from(WRONG_ISSUER_TEXT, "utf8"),
    );

    const docs = listDocuments(db, printId);
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe(result.docId);
    // 089 moved the verdict off the source string and onto its own column —
    // the source keeps saying where the bytes came from.
    expect(docs[0].source).toBe("drop:acme.html");
    expect(docs[0].gate_verdict).toBe("rejected");
    expect(docs[0].gate_reason).toBe(result.rejectReason);
    expect(docs[0].parsed_at).toBeNull();
    expect(fake.extractCalls).toHaveLength(0);
    expect(getSheet(db, printId).every((l) => l.state === "pending")).toBe(true);
    expect(getWatchStatus(db)[0].sources.gate).toContain("rejected");
  });

  it("refuses an ir-page carrying last quarter's numbers, and parses nothing (finding A)", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);

    const result = await ingestDocument(
      db,
      printId,
      "ir-page",
      "ir-rss:NVIDIA Announces Financial Results for First Quarter Fiscal 2027",
      "https://nvidianews.nvidia.com/news/q1-fy2027-results",
      Buffer.from(
        [
          "NVIDIA Announces Financial Results for First Quarter Fiscal 2027",
          "NVIDIA (NASDAQ: NVDA) today reported revenue of $44,062 million",
          "and non-GAAP diluted earnings per share of $0.96 for the first quarter of fiscal 2027.",
        ].join("\n"),
        "utf8",
      ),
    );

    expect(result.outcome).toBe("rejected");
    expect(result.rejectReason).toMatch(/IR page/i);
    expect(fake.extractCalls).toHaveLength(0);
    expect(getSheet(db, printId).every((l) => l.state === "pending")).toBe(true);
    // The CONTENT is plausibly this issuer's (it names NVDA and a fiscal
    // quarter); it is the ROAD that is refused, which is precisely why the
    // same bytes by drop still parse.
    expect(listDocuments(db, printId)[0].gate_verdict).toBe("accepted");
    expect(listDocumentRoads(db, printId)).toEqual([
      expect.objectContaining({ kind: "ir-page", road_verdict: "rejected" }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// source seen-sets (fix wave, finding A baseline + finding F ordering)
// ---------------------------------------------------------------------------

describe("source seen-sets", () => {
  const IR_LINK = "https://nvidianews.nvidia.com/news/q2-fy2027-results";

  it("baselines the IR feed on the first poll, then marks a link seen only after it is ingested", async () => {
    const { eventId } = seedArmedEvent();
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];
    let served = false;
    fake.ir = async (baseline: boolean) => {
      // The real adapter fetches nothing on a baseline pass; this fake honours
      // the same contract so the watcher's plumbing is what's under test.
      if (baseline || served) return [];
      served = true;
      return [
        {
          title: "NVIDIA Announces Financial Results for Second Quarter Fiscal 2027",
          link: IR_LINK,
          html: NVDA_RELEASE_TEXT,
        },
      ];
    };

    ensurePrintWatch(db);
    await tick(1);

    // First poll of the watch: baseline, with nothing seen yet.
    expect(fake.irCalls[0].baseline).toBe(true);
    expect(fake.irCalls[0].seen).toEqual([]);
    expect(getWatchStatus(db)[0].sources.rss).toContain("baseline");

    await tick(11_000);

    const later = fake.irCalls[fake.irCalls.length - 1];
    expect(later.baseline).toBe(false);
    // The link is in the seen-set only because the WATCHER put it there, after
    // the document was ingested — the adapter never marks what it fetched.
    expect(later.seen).toContain(IR_LINK);
    expect(fake.irCalls.filter((c) => c.baseline)).toHaveLength(1);
    expect(listDocuments(db, printIdFor(eventId))).toHaveLength(1);
  });

  it("marks a DJ release's article ids only after the stitched bytes are ingested", async () => {
    seedArmedEvent();
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];
    let served = false;
    fake.dj = async () => {
      if (served) return { completedReleases: [], flashes: [] };
      served = true;
      return {
        completedReleases: [
          {
            headline: "Press Release: NVIDIA",
            stitchedText: NVDA_RELEASE_TEXT,
            partCount: 1,
            articleIds: ["DJ-N$part1", "DJ-N$part2"],
          },
        ],
        flashes: [],
      };
    };

    ensurePrintWatch(db);
    await tickUntilSecondPoll(() => fake.djSeen.length);

    // The poll that DELIVERED the release saw an empty set...
    expect(fake.djSeen[0]).toEqual([]);
    // ...and both part ids are marked only on a later poll, by the watcher.
    const later = fake.djSeen[fake.djSeen.length - 1];
    expect(later).toContain("DJ-N$part1");
    expect(later).toContain("DJ-N$part2");
  });

  it("leaves a DJ release's article ids UNMARKED when the ingest throws, so the adapter re-emits it", async () => {
    seedArmedEvent();
    // Point the byte store at a FILE: writeBytes' mkdir fails, so
    // ingestDocument throws before the document row exists — the shape of a
    // real ingest failure, and exactly what used to lose the release forever.
    const brokenRoot = path.join(tmpRoot, "not-a-directory");
    fs.writeFileSync(brokenRoot, "definitely not a directory");
    fake.storageRoot = brokenRoot;

    fake.dj = async () => ({
      completedReleases: [
        {
          headline: "Press Release: NVIDIA",
          stitchedText: NVDA_RELEASE_TEXT,
          partCount: 1,
          articleIds: ["DJ-N$part1"],
        },
      ],
      flashes: [],
    });

    ensurePrintWatch(db);
    await tick(11_000);

    expect(fake.djSeen.length).toBeGreaterThan(1);
    for (const seen of fake.djSeen) expect(seen).not.toContain("DJ-N$part1");
    expect(getWatchStatus(db)[0].sources.dj).toBeTruthy();
  });

  it("marks a flash's article id once its bullet is in the lane's batch", async () => {
    seedArmedEvent();
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];
    let served = false;
    fake.dj = async () => {
      if (served) return { completedReleases: [], flashes: [] };
      served = true;
      return {
        completedReleases: [],
        flashes: [
          {
            time: "2026-08-26 20:20:00.0",
            headline: "*NVIDIA 2Q ADJ EPS $1.05",
            articleId: "DJ-N$flash1",
          },
        ],
      };
    };

    ensurePrintWatch(db);
    await tick(11_000);

    expect(fake.djSeen[0]).toEqual([]);
    expect(fake.djSeen[fake.djSeen.length - 1]).toContain("DJ-N$flash1");
  });

  it("marks an EDGAR accession seen only after its exhibits are ingested", async () => {
    seedArmedEvent();
    fake.cik = "0001045810";
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];
    let served = false;
    fake.edgar = async () => {
      if (served) return [];
      served = true;
      return [
        {
          accession: "0001045810-26-000123",
          form: "8-K",
          acceptanceDateTime: "2026-08-26T20:22:00Z",
          exhibits: [
            {
              name: "ex991.htm",
              url: "https://www.sec.gov/Archives/edgar/data/1045810/x/ex991.htm",
              html: NVDA_RELEASE_HTML,
            },
          ],
        },
      ];
    };

    ensurePrintWatch(db);
    await tickUntilSecondPoll(() => fake.edgarSeen.length);

    // The poll that DELIVERED the filing saw an empty set — the adapter never
    // marks what it returns...
    expect(fake.edgarSeen.length).toBeGreaterThan(1);
    expect(fake.edgarSeen[0]).toEqual([]);
    // ...and the accession is only in the set on a later poll, because the
    // watcher put it there after ingesting the exhibits.
    expect(fake.edgarSeen[fake.edgarSeen.length - 1]).toContain("0001045810-26-000123");
  });
});

// ---------------------------------------------------------------------------
// stored IR page lane
// ---------------------------------------------------------------------------

describe("IR page lane", () => {
  const IR_URL = "https://ir.acme.example/news";
  const IR_HOST = "ir.acme.example";
  const FP = irBaselineFingerprint(IR_URL);
  const OLD_LINK = "https://ir.acme.example/news/acme-q1-fy2026-results";
  const NEW_LINK = "https://ir.acme.example/news/acme-q2-2026-results";
  const PAGE_BEFORE =
    `<a href="/news/acme-q1-fy2026-results">ACME Reports First Quarter Fiscal 2026 Results</a>`;
  const PAGE_AFTER =
    `${PAGE_BEFORE}<a href="/news/acme-q2-2026-results">ACME Reports Q2 2026 Results</a>`;
  /** Tonight's print: names the symbol AND this event's quarter (Q2 2026 is
   *  the prior-quarter candidate for an 2026-08-26 event date). */
  const RELEASE = `<html><body>ACME reports Q2 2026 results. Revenue $1,000 million.</body></html>`;
  /** Last quarter's post, permanently on the same newsroom page. Passes the
   *  loose CONTENT gate (fiscal 2026 + quarter word) and fails the strict
   *  ir-page ROAD gate, which is exactly the trap the road exists to catch. */
  const OLD_RELEASE =
    `<html><body>ACME reports first quarter fiscal 2026 results. Revenue $900 million.</body></html>`;

  function seedAcme(): { eventId: number } {
    return seedArmedEvent({ symbol: "ACME", issuerName: "ACME Widget Holdings", conId: null });
  }

  function html(body: string, url: string): FakeFetchResult {
    return { bytes: Buffer.from(body, "utf8"), finalUrl: url, status: 200, contentType: "text/html" };
  }

  /** A newsroom that serves `page()` at the IR url and a release at each link. */
  function pageServer(page: () => string) {
    return async (url: string): Promise<FakeFetchResult> => {
      if (url === IR_URL) return html(page(), url);
      return html(url === OLD_LINK ? OLD_RELEASE : RELEASE, url);
    };
  }

  /** Every fetch the lane made must carry the M17 host policy (page AND link). */
  function expectAllowlistOnEveryFetch(): void {
    expect(fake.fetchCalls.length).toBeGreaterThan(0);
    for (const call of fake.fetchCalls) {
      expect(call.opts.allowHost, `no allowHost on the fetch of ${call.url}`).toBeTypeOf("function");
      expect(call.opts.allowHost!(IR_HOST)).toBe(true);
      expect(call.opts.allowHost!("www.businesswire.com")).toBe(true);
      expect(call.opts.allowHost!("evil.example")).toBe(false);
    }
  }

  it("with a step-recorded baseline, ingests only a link that appeared afterwards and marks it seen after the durable outcome", async () => {
    const { eventId } = seedAcme();
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: IR_URL, linkMustContain: null });
    recordIrBaseline(db, eventId, FP, [OLD_LINK]); // what ir_baseline wrote at arm time
    let page = PAGE_BEFORE;
    fake.fetchBytes = pageServer(() => page);
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];

    ensurePrintWatch(db);
    const printId = printIdFor(eventId);

    await waitUntil(() => /0 new/.test(getWatchStatus(db)[0].sources.ir ?? ""));
    expect(listDocuments(db, printId)).toEqual([]);
    expect(getWatchStatus(db)[0].sources.ir).toMatch(/^ok —/);

    page = PAGE_AFTER;
    // Wait on the LAST durable effect of the lane, not the first: the document
    // row exists a few awaits before `recordIrSeenLinks` runs, and waiting on
    // the document alone lands in that gap often enough to flake.
    await waitUntil(() => listIrSeenLinks(db, eventId).some((l) => l.link === NEW_LINK), 80);

    const [doc] = listDocuments(db, printId);
    expect(doc.kind).toBe("ir-page");
    expect(doc.url).toBe(NEW_LINK);
    // Seen ONLY after the durable outcome, and persisted so a restart agrees.
    expect(listIrSeenLinks(db, eventId).find((l) => l.link === NEW_LINK)).toEqual({
      link: NEW_LINK,
      baseline: false,
    });
    expect(getWatchStatus(db)[0].coverage).toContain(`IR: ${IR_HOST}`);
    expectAllowlistOnEveryFetch();
  });

  it("the watcher NEVER baselines: armed late with no baseline, tonight's release is fetched and the period gate drops last quarter's", async () => {
    const { eventId } = seedAcme();
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: IR_URL, linkMustContain: null });
    // Both links already on the page when the window opens, and no baseline
    // row: the ir_baseline step never ran (a late arm).
    fake.fetchBytes = pageServer(() => PAGE_AFTER);
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];

    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    // Both rows AND the lane's summary line: the status is written at the end
    // of the poll, so a documents-only predicate can return mid-poll.
    await waitUntil(
      () => listDocuments(db, printId).length === 2 && Boolean(getWatchStatus(db)[0].sources.ir),
      80,
    );

    const docs = listDocuments(db, printId);
    const fresh = docs.find((d) => d.url === NEW_LINK)!;
    expect(fresh.gate_verdict).toBe("accepted");
    const old = docs.find((d) => d.url === OLD_LINK)!;
    const roads = listDocumentRoads(db, printId);
    expect(roads.find((r) => r.document_id === old.id)?.road_verdict).toBe("rejected");
    // Nothing the WATCHER did wrote a baseline — that is the step's job alone.
    expect(getIrBaseline(db, eventId)).toBeNull();
    expect(getWatchStatus(db)[0].sources.ir).toMatch(/no baseline/);
    // Only TONIGHT's release reached the model. (An HTML document is read as a
    // raw-text/tables PAIR, so the honest assertion is about which BYTES were
    // read, not how many calls there were.)
    expect(fake.extractCalls.some((c) => c.text.includes("1,000"))).toBe(true);
    expect(fake.extractCalls.every((c) => !c.text.includes("900"))).toBe(true);
    expect(getDocument(db, old.id)!.parsed_at).toBeNull();
  });

  it("a persisted baseline survives a restart and is never re-taken", async () => {
    const { eventId } = seedAcme();
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: IR_URL, linkMustContain: null });
    recordIrBaseline(db, eventId, FP, [OLD_LINK]);
    fake.fetchBytes = pageServer(() => PAGE_AFTER);
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];

    // A FRESH process: the runtime has no in-memory seen-set at all, so the
    // only thing standing between the lane and last quarter's post is what
    // `print_watch_ir_seen` remembers.
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    await waitUntil(() => listDocuments(db, printId).length === 1, 80);

    expect(listDocuments(db, printId)[0].url).toBe(NEW_LINK);
    expect(fake.fetchCalls.some((c) => c.url === OLD_LINK)).toBe(false);
    expect(getIrBaseline(db, eventId)).toMatchObject({ source_fingerprint: FP, link_count: 1 });
    expect(listIrSeenLinks(db, eventId).filter((l) => l.baseline)).toHaveLength(1);
  });

  it("a refused link is retried, and marked seen only after the third refusal (M17)", async () => {
    const { eventId } = seedAcme();
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: IR_URL, linkMustContain: null });
    recordIrBaseline(db, eventId, FP, [OLD_LINK]);
    let fetches = 0;
    fake.fetchBytes = async (url: string) => {
      if (url === NEW_LINK) {
        fetches += 1;
        // PK zip header with a NUL — `classifyBytes` calls it binary, so
        // `ingestDocument` REFUSES it and stores nothing.
        return {
          bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
          finalUrl: url,
          status: 200,
          contentType: "application/zip",
        };
      }
      return pageServer(() => PAGE_AFTER)(url);
    };

    ensurePrintWatch(db);
    // Strike one is on the FIRST poll, so the note is deterministic there.
    await waitUntil(() => /refused \(1\/3\)/.test(getWatchStatus(db)[0].sources.ir ?? ""));
    expect(listIrSeenLinks(db, eventId).some((l) => l.link === NEW_LINK)).toBe(false);

    await waitUntil(
      () => listIrSeenLinks(db, eventId).some((l) => l.link === NEW_LINK),
      40,
      11_000,
    );

    expect(fetches).toBe(3);
    expect(listDocuments(db, printIdFor(eventId))).toEqual([]);
    // Giving up is durable: later polls keep saying the road retired a link,
    // rather than reporting a quiet "0 new".
    expect(getWatchStatus(db)[0].sources.ir).toMatch(/1 link\(s\) retired after 3 refusals/);
  });

  // M6/R-C19. The budget is shared across the page fetch and every link of the
  // road (suspended only during an ingest), so a late link on a hammered
  // newsroom is the one that gets cut — and three cancelled polls would retire
  // TONIGHT'S link permanently, with the lane reporting "1 link(s) retired
  // after 3 refusals" and no way back.
  //
  // A cancellation reaches the lane as TWO different shapes (re-review N1), so
  // both are driven through the same walk: the error's name cannot be the test
  // of whether the road was cancelled — the road's own signal is.
  async function cancellationCostsNoStrike(cancelled: (url: string) => Error): Promise<void> {
    const { eventId } = seedAcme();
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: IR_URL, linkMustContain: null });
    recordIrBaseline(db, eventId, FP, [OLD_LINK]);
    let hang = true;
    let linkFetches = 0;
    fake.fetchBytes = async (url: string, opts: FakeFetchOptions) => {
      if (url === NEW_LINK && hang) {
        linkFetches += 1;
        // Settles only when the road's own timer (or the pass end) fires —
        // exactly what a slow newsroom looks like from here.
        return new Promise<FakeFetchResult>((_resolve, reject) => {
          const abort = () => reject(cancelled(url));
          if (opts.signal?.aborted) abort();
          else opts.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return pageServer(() => PAGE_AFTER)(url);
    };
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];

    ensurePrintWatch(db);
    await waitUntil(() => linkFetches >= 3, 80, 5_000);
    expect(listIrSeenLinks(db, eventId).some((l) => l.link === NEW_LINK)).toBe(false);
    expect(getWatchStatus(db)[0].sources.ir ?? "").not.toMatch(/link refused/);
    expect(getWatchStatus(db)[0].sources.ir ?? "").not.toMatch(/retired/);

    // The newsroom answers on a later poll: the link was never retired, so
    // tonight's release is still acquired.
    hang = false;
    await waitUntil(() => listIrSeenLinks(db, eventId).some((l) => l.link === NEW_LINK), 80);
    expect(listDocuments(db, printIdFor(eventId)).map((d) => d.url)).toContain(NEW_LINK);
  }

  // Shape 1: aborted while queued for a host token — the scheduler's own
  // `AbortedError`, whose name IS "AbortError".
  it("a road cancellation never charges the link's refusal budget (M6)", async () => {
    await cancellationCostsNoStrike(() => Object.assign(new Error("aborted"), { name: "AbortError" }));
  });

  // Shape 2, and the one the finding was written about: aborted while the
  // request is IN FLIGHT. `hardenedFetchBytes` maps every caller abort to a
  // `UrlFetchRefused` (name "UrlFetchRefused"), so a name test misses it and
  // the link is charged — exactly what happens on a slow newsroom when the
  // road's 15-second timer fires mid-request.
  it("the same for the IN-FLIGHT shape, which is a UrlFetchRefused, not an AbortError (N1)", async () => {
    await cancellationCostsNoStrike(
      (url) => new UrlFetchRefused(`IR page link: aborted by the caller (${redactUrl(url)})`),
    );
  });

  it("the NVDA RSS config keeps precedence over a stored IR page", async () => {
    const { eventId } = seedArmedEvent(); // NVDA — the one hardcoded RSS feed
    upsertPrintWatchSource(db, {
      symbol: "NVDA",
      irPageUrl: "https://nvidianews.nvidia.com/news",
      linkMustContain: null,
    });

    ensurePrintWatch(db);
    await waitUntil(() => fake.irCalls.length >= 1);

    const row = getWatchStatus(db).find((r) => r.eventId === eventId)!;
    expect(row.coverage).toContain("RSS: NVDA IR feed");
    expect(row.sources.rss).toBeTruthy();
    expect(row.sources.ir).toBeUndefined(); // the page lane never ran
    expect(fake.fetchCalls).toEqual([]); // and nothing was fetched off the page
  });

  it("follows only IR-host and wire-host links (an off-allowlist match is left alone)", async () => {
    const { eventId } = seedAcme();
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: IR_URL, linkMustContain: null });
    recordIrBaseline(db, eventId, FP, []);
    fake.fetchBytes = async (url: string) => {
      if (url === IR_URL) {
        return html(
          `<a href="https://evil.example/acme-q2-2026-results">ACME Q2 2026 Results</a>`,
          url,
        );
      }
      return html(RELEASE, url);
    };

    ensurePrintWatch(db);
    await waitUntil(() => fake.fetchCalls.length >= 2, 20).catch(() => {});

    expect(fake.fetchCalls.filter((c) => c.url.startsWith("https://evil.example"))).toEqual([]);
    expect(listDocuments(db, printIdFor(eventId))).toEqual([]);
    // The mirror was never even a candidate, so nothing is "seen" about it.
    expect(listIrSeenLinks(db, eventId).filter((l) => !l.baseline)).toEqual([]);
  });

  it("follows a wire-host link off the IR page", async () => {
    const { eventId } = seedAcme();
    const WIRE_LINK = "https://www.businesswire.com/news/home/2026/acme-q2";
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: IR_URL, linkMustContain: null });
    recordIrBaseline(db, eventId, FP, []);
    fake.fetchBytes = async (url: string) => {
      if (url === IR_URL) {
        return html(`<a href="${WIRE_LINK}">ACME Announces Q2 2026 Earnings</a>`, url);
      }
      return html(RELEASE, url);
    };
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];

    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    await waitUntil(() => listDocuments(db, printId).length === 1, 80);

    expect(listDocuments(db, printId)[0].url).toBe(WIRE_LINK);
    expectAllowlistOnEveryFetch();
  });

  it("a page that changes shape reads as '0 matching links' and the other roads still run", async () => {
    const { eventId } = seedAcme();
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: IR_URL, linkMustContain: null });
    recordIrBaseline(db, eventId, FP, [OLD_LINK]);
    fake.cik = "0001045810";
    // The newsroom was rebuilt: same URL, no anchor the pattern recognises.
    fake.fetchBytes = async (url: string) => html(`<div>Latest news</div>`, url);

    ensurePrintWatch(db);
    await waitUntil(() => (getWatchStatus(db)[0].sources.ir ?? "").includes("matching links"));

    // The panel supplies the "IR" label from LADDER_LABELS — the lane's own
    // string must not repeat it ("IR: ok — IR: 0 matching links").
    expect(getWatchStatus(db)[0].sources.ir).toContain("0 matching links");
    expect(getWatchStatus(db)[0].sources.ir).not.toContain("IR:");
    // Other roads are unaffected (spec section 7).
    expect(fake.edgarCalls).toBeGreaterThan(0);
    expect(getWatchStatus(db)[0].sources.edgar).toBeTruthy();
  });

  it("a symbol with no stored page says so, fetches nothing, and never errors", async () => {
    const { eventId } = seedAcme();

    ensurePrintWatch(db);
    await waitUntil(() => Boolean(getWatchStatus(db)[0].sources.ir));

    expect(getWatchStatus(db)[0].sources.ir).toBe("no IR page configured");
    expect(getWatchStatus(db)[0].coverage).toContain("IR: none configured");
    expect(fake.fetchCalls).toEqual([]);
    expect(getPrintByEventId(db, eventId)!.state).not.toBe("disarmed");
  });

  it("a PUT /sources during the window is picked up without a restart", async () => {
    const { eventId } = seedAcme();
    fake.fetchBytes = pageServer(() => PAGE_AFTER);
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];

    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    await waitUntil(() => getWatchStatus(db)[0].sources.ir === "no IR page configured");

    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: IR_URL, linkMustContain: null });
    await waitUntil(
      () => getWatchStatus(db)[0].coverage.includes(`IR: ${IR_HOST}`),
      80,
    );

    expect(getWatchStatus(db)[0].coverage).toContain(`IR: ${IR_HOST}`);
    expect(listDocuments(db, printId).map((d) => d.url).sort()).toEqual([OLD_LINK, NEW_LINK].sort());
  });

  it("honours link_must_contain as the desk's own literal narrowing", async () => {
    const { eventId } = seedAcme();
    upsertPrintWatchSource(db, {
      symbol: "ACME",
      irPageUrl: IR_URL,
      linkMustContain: "Q2 2026",
    });
    recordIrBaseline(db, eventId, FP, []);
    fake.fetchBytes = pageServer(() => PAGE_AFTER);
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];

    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    await waitUntil(() => listDocuments(db, printId).length === 1, 80);

    expect(listDocuments(db, printId)[0].url).toBe(NEW_LINK);
    expect(fake.fetchCalls.some((c) => c.url === OLD_LINK)).toBe(false);
  });

  it("a page fetch that is refused leaves the lane readable and the print alive", async () => {
    const { eventId } = seedAcme();
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: IR_URL, linkMustContain: null });
    recordIrBaseline(db, eventId, FP, []);
    fake.fetchBytes = async () => {
      throw new Error("IR page: HTTP 503 for https://ir.acme.example/news");
    };

    ensurePrintWatch(db);
    await waitUntil(() => /503/.test(getWatchStatus(db)[0].sources.ir ?? ""));

    expect(getWatchStatus(db)[0].sources.ir).toMatch(/503/);
    expect(getPrintByEventId(db, eventId)!.state).not.toBe("disarmed");
    expect(listDocuments(db, printIdFor(eventId))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------

describe("pipeline", () => {
  it("gives a plain-text document ONE extraction call and single_source, greening only cross-document", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];

    await ingestDocument(
      db,
      printId,
      "user-drop",
      "drop:release.txt",
      null,
      Buffer.from(NVDA_RELEASE_TEXT, "utf8"),
    );

    expect(fake.extractCalls).toHaveLength(1); // plain text = ONE call
    let line = getSheet(db, printId).find((l) => l.metric_id === "eps_adj_q")!;
    expect(line.state).toBe("single_source");
    expect(line.value).toBe(1.05);

    await ingestDocument(
      db,
      printId,
      "edgar-ex99",
      "edgar:0001045810-26-000123:ex99-1.htm",
      "https://www.sec.gov/Archives/edgar/x.htm",
      Buffer.from(NVDA_RELEASE_HTML, "utf8"),
    );

    // HTML = repA + repB, two calls.
    expect(fake.extractCalls).toHaveLength(3);
    line = getSheet(db, printId).find((l) => l.metric_id === "eps_adj_q")!;
    expect(line.state).toBe("agreed");
    expect(line.value).toBe(1.05);
    expect(getPrintByEventId(db, eventId)!.state).toBe("parsed");

    const candidates = JSON.parse(line.candidates_json) as Array<{ doc_id: number }>;
    expect(new Set(candidates.map((c) => c.doc_id)).size).toBe(2);
  });

  it("runs ONE pipeline per print at a time, in document-id order", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);

    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    fake.extract = async (_contracts, text) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      // Only the HTML path runs the representation builders, which stamp a
      // "# REPRESENTATION rep…" header; plain text is passed through raw.
      order.push(text.startsWith("# REPRESENTATION") ? "html" : "text");
      await new Promise((resolve) => setImmediate(resolve));
      running -= 1;
      return [candidate("eps_adj_q", 1.05)];
    };

    // Fired concurrently: which one wins the insert race (and therefore the
    // lower doc id) is up to the filesystem — the invariant under test is that
    // the PIPELINE then runs them one at a time in DOC-ID order.
    const first = ingestDocument(
      db,
      printId,
      "user-drop",
      "drop:one.txt",
      null,
      Buffer.from(NVDA_RELEASE_TEXT, "utf8"),
    );
    const second = ingestDocument(
      db,
      printId,
      "edgar-ex99",
      "edgar:two",
      null,
      Buffer.from(NVDA_RELEASE_HTML, "utf8"),
    );
    await Promise.all([first, second]);

    const docs = listDocuments(db, printId);
    expect(docs).toHaveLength(2);
    const expectedOrder = docs.flatMap((d) =>
      d.source === "drop:one.txt" ? ["text"] : ["html", "html"],
    );

    expect(maxRunning).toBe(1);
    expect(order).toEqual(expectedOrder);
    expect(docs.every((d) => d.parsed_at !== null)).toBe(true);
  });

  it("drains a document left unparsed by a crashed run on the next loop tick", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);

    fake.extract = async () => {
      throw new Error("model call died mid-parse");
    };
    await ingestDocument(
      db,
      printId,
      "user-drop",
      "drop:release.txt",
      null,
      Buffer.from(NVDA_RELEASE_TEXT, "utf8"),
    );

    const docs = listDocuments(db, printId);
    expect(docs).toHaveLength(1);
    expect(docs[0].parsed_at).toBeNull();
    expect(getSheet(db, printId).find((l) => l.metric_id === "eps_adj_q")!.state).toBe("pending");

    fake.extract = async () => [candidate("eps_adj_q", 1.05)];

    // Retries are SPACED 30s apart: three attempts inside half a minute would
    // spend the document's whole budget on one transient failure.
    await tick(11_000);
    expect(fake.extractCalls).toHaveLength(1);
    expect(listDocuments(db, printId)[0].parsed_at).toBeNull();

    await tick(31_000); // past the spacing — the next tick drains it

    expect(fake.extractCalls.length).toBeGreaterThan(1);
    expect(listDocuments(db, printId)[0].parsed_at).not.toBeNull();
    expect(getSheet(db, printId).find((l) => l.metric_id === "eps_adj_q")!.state).toBe(
      "single_source",
    );
  });

  it("ingests DJ flashes into the flash lane with no document of record", async () => {
    seedArmedEvent();
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];
    let served = false;
    fake.dj = async () => {
      if (served) return { completedReleases: [], flashes: [] };
      served = true;
      return {
        completedReleases: [],
        flashes: [
          {
            time: "2026-08-26 20:20:00.0",
            headline: "*NVIDIA 2Q ADJ EPS $1.05",
            articleId: "DJ-N$flash1",
          },
        ],
      };
    };

    ensurePrintWatch(db);
    await tick(1);

    const status = getWatchStatus(db);
    const printId = status[0].printId;
    const line = getSheet(db, printId).find((l) => l.metric_id === "eps_adj_q")!;
    expect(line.state).toBe("flash");
    expect(line.value).toBe(1.05);
    // Flash values have no document — the FK column must stay NULL.
    expect(line.source_doc_id).toBeNull();
    expect(listDocuments(db, printId)).toHaveLength(0);
  });

  it("serializes the flash lane against the document pipeline — neither writer erases the other", async () => {
    const { eventId } = seedArmedEvent();
    let releaseFlash!: () => void;
    const flashGate = new Promise<void>((resolve) => {
      releaseFlash = resolve;
    });

    // Both writers are read-modify-writes wrapped around a model call. The
    // guarantee under test is MUTUAL EXCLUSION — that one is never at the
    // model while the other is — because the moment anything adds an await
    // between "collect the candidate pool" and "write the sheet", overlapping
    // writers start erasing each other's evidence.
    let writersInFlight = 0;
    let maxWritersInFlight = 0;
    fake.extract = async (_contracts, text) => {
      writersInFlight += 1;
      maxWritersInFlight = Math.max(maxWritersInFlight, writersInFlight);
      try {
        if (text.includes("*NVIDIA")) {
          await flashGate; // park the flash lane inside its model call
          return [candidate("eps_gaap_q", 0.99)];
        }
        return [candidate("eps_adj_q", 1.05)];
      } finally {
        writersInFlight -= 1;
      }
    };
    let served = false;
    fake.dj = async () => {
      if (served) return { completedReleases: [], flashes: [] };
      served = true;
      return {
        completedReleases: [],
        flashes: [
          {
            time: "2026-08-26 20:20:00.0",
            headline: "*NVIDIA 2Q ADJ EPS $1.05",
            articleId: "DJ-N$flash1",
          },
        ],
      };
    };

    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    await tick(1); // flash lane is now parked mid-extraction

    // A drop lands while the flash lane still holds the print.
    const drop = ingestDocument(
      db,
      printId,
      "user-drop",
      "drop:release.txt",
      null,
      Buffer.from(NVDA_RELEASE_TEXT, "utf8"),
    );
    await flushIo();

    releaseFlash();
    await drop;
    await flushIo();

    expect(maxWritersInFlight).toBe(1);
    const sheet = getSheet(db, printId);
    expect(sheet.find((l) => l.metric_id === "eps_adj_q")!.state).toBe("single_source");
    expect(sheet.find((l) => l.metric_id === "eps_gaap_q")!.state).toBe("flash");
    expect(listDocuments(db, printId)[0].parsed_at).not.toBeNull();
  });

  it("refuses the sheet write when the lease changed hands during the model call", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);

    fake.extract = async () => {
      // Another process takes the watcher over while we are at the model.
      db.prepare(
        `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
      ).run(
        "print_watch_lease",
        JSON.stringify({ holder: "9999@3999", expiresAt: Date.now() + 120_000 }),
      );
      return [candidate("eps_adj_q", 1.05)];
    };

    await ingestDocument(
      db,
      printId,
      "user-drop",
      "drop:release.txt",
      null,
      Buffer.from(NVDA_RELEASE_TEXT, "utf8"),
    );

    // Our snapshot is stale — refuse, and leave the document for the new owner.
    expect(getSheet(db, printId).find((l) => l.metric_id === "eps_adj_q")!.state).toBe("pending");
    expect(listDocuments(db, printId)[0].parsed_at).toBeNull();
    expect(getWatchStatus(db)[0].sources.pipeline).toContain("refused");
  });

  it("re-ingesting identical bytes is a no-op (no second parse)", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];

    const buf = Buffer.from(NVDA_RELEASE_TEXT, "utf8");
    const first = await ingestDocument(db, printId, "user-drop", "drop:a.txt", null, buf);
    const second = await ingestDocument(db, printId, "user-drop", "drop:a.txt", null, buf);

    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.docId).toBe(first.docId);
    expect(fake.extractCalls).toHaveLength(1);

    // The VERDICT, not just the id: "already ingested" is a different thing to
    // tell the desk than "parsing now".
    expect(first.outcome).toBe("parsed");
    expect(second.outcome).toBe("duplicate");
  });

  it("reports a lease-blocked ingest as 'queued', and a later ensure drains it (finding C)", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];

    // Another process owns the watcher by the time the drop lands.
    db.prepare(
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    ).run(
      "print_watch_lease",
      JSON.stringify({ holder: "9999@3999", expiresAt: Date.now() + 120_000 }),
    );

    const result = await ingestDocument(
      db,
      printId,
      "user-drop",
      "drop:release.txt",
      null,
      Buffer.from(NVDA_RELEASE_TEXT, "utf8"),
    );

    // NOT "parsed": the sheet did not move, and saying it did was the bug.
    expect(result.outcome).toBe("queued");
    expect(result.isNew).toBe(true);
    expect(fake.extractCalls).toHaveLength(0);
    expect(listDocuments(db, printId)[0].parsed_at).toBeNull();
    expect(getSheet(db, printId).every((l) => l.state === "pending")).toBe(true);

    // The window closes and the other process goes away. An expired print has
    // no loop left, so the reconcile pass is what has to pick the document up.
    vi.setSystemTime(new Date("2026-08-26T21:30:00Z"));
    db.prepare(`DELETE FROM settings WHERE key = 'print_watch_lease'`).run();

    ensurePrintWatch(db);
    await flushIo();

    expect(getPrintByEventId(db, eventId)!.state).toBe("parsed");
    expect(listDocuments(db, printId)[0].parsed_at).not.toBeNull();
    expect(getSheet(db, printId).find((l) => l.metric_id === "eps_adj_q")!.state).toBe(
      "single_source",
    );
  });

  it("reports a gate rejection as its own outcome, carrying the reason", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);

    const result = await ingestDocument(
      db,
      printId,
      "user-drop",
      "drop:acme.html",
      null,
      Buffer.from(WRONG_ISSUER_TEXT, "utf8"),
    );

    expect(result.outcome).toBe("rejected");
    expect(result.rejectReason).toContain("issuer");
    // The stored row keeps the same reason — the panel's banner and the
    // document row tell one story.
    expect(listDocuments(db, printId)[0].gate_reason).toBe(result.rejectReason);
  });

  // -------------------------------------------------------------------------
  // slice B: content identity, the CAS parse queue, refusals, M15
  // -------------------------------------------------------------------------

  /** An ACME print, so the slice-B fixtures can use short ACME release text
   *  that the gate reads as this event's (issuer + quarter both named). */
  function seedAcmePrint(): { eventId: number; printId: number } {
    const { eventId } = seedArmedEvent({ symbol: "ACME", issuerName: "ACME Corporation" });
    ensurePrintWatch(db);
    return { eventId, printId: printIdFor(eventId) };
  }

  it("identical bytes through two roads are ONE document with two roads, ONE extraction, and single_source (M13)", async () => {
    const { printId } = seedAcmePrint();
    fake.extract = async () => [candidate("revenue_q", 1000)];
    const text = "ACME reports Q2 2026 results. Revenue $1,000 million.";

    const a = await ingestDocument(
      db,
      printId,
      "edgar-ex99",
      "edgar:0001:ex99-1",
      "https://www.sec.gov/x",
      Buffer.from(text, "utf8"),
    );
    const b = await ingestDocument(
      db,
      printId,
      "user-drop",
      "user-drop:release.txt",
      null,
      Buffer.from(text, "utf8"),
    );

    expect(a.outcome).toBe("parsed");
    expect(b).toMatchObject({ docId: a.docId, isNew: false, outcome: "duplicate" });
    expect(listDocuments(db, printId)).toHaveLength(1);
    expect(listDocumentRoads(db, printId).map((r) => r.kind).sort()).toEqual([
      "edgar-ex99",
      "user-drop",
    ]);
    // The SECOND road is provenance, not a second reading: one extraction, and
    // the line stays honestly single-sourced.
    expect(fake.extractCalls).toHaveLength(1);
    const line = getSheet(db, printId).find((l) => l.metric_id === "revenue_q")!;
    expect(line.state).toBe("single_source");
    expect((JSON.parse(line.candidates_json) as TaggedCandidate[]).map((c) => c.doc_id)).toEqual([
      a.docId,
    ]);
  });

  it("a stricter road first (ir-page, last quarter's labels) is rejected; the same bytes by drop become eligible and parse", async () => {
    const { printId } = seedAcmePrint();
    fake.extract = async () => [candidate("revenue_q", 900)];
    const text = "ACME reports first quarter fiscal 2027 results. Revenue $900 million.";

    const ir = await ingestDocument(
      db,
      printId,
      "ir-page",
      "ir-page:old",
      "https://ir.acme.example/old",
      Buffer.from(text, "utf8"),
    );
    expect(ir.outcome).toBe("rejected");
    expect(ir.rejectReason).toMatch(/IR page/i);
    expect(fake.extractCalls).toHaveLength(0);

    const drop = await ingestDocument(
      db,
      printId,
      "user-drop",
      "user-drop:same.txt",
      null,
      Buffer.from(text, "utf8"),
    );
    // Same bytes, same document — the drop only adds a road the gate trusts.
    expect(drop).toMatchObject({ docId: ir.docId, outcome: "parsed" });
    expect(fake.extractCalls).toHaveLength(1);
    expect(listDocuments(db, printId)).toHaveLength(1);
  });

  it("refuses binary bytes without storing a document", async () => {
    const { printId } = seedAcmePrint();

    const r = await ingestDocument(
      db,
      printId,
      "user-drop",
      "user-drop:x.bin",
      null,
      Buffer.from([0x41, 0x00, 0x42]),
    );

    expect(r).toMatchObject({ docId: 0, isNew: false, outcome: "refused" });
    expect(r.rejectReason).toMatch(/binary/);
    // A refusal is about the FILE — there is nothing to keep as evidence.
    expect(listDocuments(db, printId)).toEqual([]);
    expect(fake.extractCalls).toHaveLength(0);
  });

  it("parses through a CAS claim: a stale claim from a dead worker is taken over on the next drain", async () => {
    const { printId } = seedAcmePrint();
    fake.extract = async () => [candidate("revenue_q", 1)];
    const text = "ACME reports Q2 2026 results.";
    const bytes = Buffer.from(text, "utf8");
    const bytesPath = path.join(tmpRoot, "dead.txt");

    const delivered = recordDelivery(db, printId, "user-drop", "u", null, bytes, {
      bytesPath,
      text,
      gateCtx: { symbol: "ACME", issuerName: "ACME Corporation", eventDate: EVENT_DATE },
    });
    fs.writeFileSync(bytesPath, bytes);
    // A worker claimed it six minutes ago and never finalised.
    claimDocumentParse(db, delivered.id, "dead-token", fake.nowMs - 6 * 60_000);

    ensurePrintWatch(db); // the next drain is what takes the claim over

    await waitUntil(() => getDocument(db, delivered.id)?.parse_state === "parsed");
    expect(fake.extractCalls).toHaveLength(1);
    // The dead worker's attempt is not refunded — the budget is durable.
    expect(getDocument(db, delivered.id)?.parse_attempts).toBe(2);
  });

  it("a failed extraction reports parse_failed with the durable error, returns the document to the queue, and counts ONE attempt (M15)", async () => {
    const { printId } = seedAcmePrint();
    fake.extract = async () => {
      throw new Error("model 529");
    };

    const r = await ingestDocument(
      db,
      printId,
      "user-drop",
      "u",
      null,
      Buffer.from("ACME reports Q2 2026 results.", "utf8"),
    );

    // The DURABLE state after the drain, never the drain's return value.
    expect(r.outcome).toBe("parse_failed");
    expect(r.rejectReason).toMatch(/model 529/);
    expect(getDocument(db, r.docId)).toMatchObject({
      parse_state: "queued",
      parse_attempts: 1,
      parse_last_error: expect.stringMatching(/model 529/),
    });
    expect(getWatchStatus(db)[0].sources.pipeline).toMatch(/model 529/);
    expect(fake.extractCalls).toHaveLength(1);
  });

  it("the attempt budget survives a restart and a fifth failure is terminal until a person re-delivers (M15)", async () => {
    const { printId } = seedAcmePrint();
    fake.extract = async () => {
      throw new Error("model 529");
    };

    const r = await ingestDocument(
      db,
      printId,
      "user-drop",
      "u",
      null,
      Buffer.from("ACME reports Q2 2026 results.", "utf8"),
    );
    db.prepare(`UPDATE print_watch_documents SET parse_attempts = 4 WHERE id = ?`).run(r.docId);

    _setTestSeams(null); // "restart": every in-memory attempt record is gone
    installSeams();
    fake.extract = async () => {
      throw new Error("model 529");
    };
    fake.nowMs += 60_000;
    ensurePrintWatch(db);

    await waitUntil(() => getDocument(db, r.docId)?.parse_state === "failed");
    expect(getDocument(db, r.docId)?.parse_attempts).toBe(5);

    // A person re-delivering the same bytes is the ONE thing that buys a fresh
    // budget — an automated road re-serving them does not.
    fake.extract = async () => [candidate("revenue_q", 1)];
    const again = await ingestDocument(
      db,
      printId,
      "user-drop",
      "u2",
      null,
      Buffer.from("ACME reports Q2 2026 results.", "utf8"),
    );
    expect(again).toMatchObject({ docId: r.docId, outcome: "parsed" });
  });

  it("reaps a claim abandoned at the attempt cap: it books failed with no model call, and a person can revive it", async () => {
    const { printId } = seedAcmePrint();
    fake.extract = async () => [candidate("revenue_q", 1)];
    const text = "ACME reports Q2 2026 results.";
    const bytes = Buffer.from(text, "utf8");
    const bytesPath = path.join(tmpRoot, "abandoned.txt");

    const delivered = recordDelivery(db, printId, "user-drop", "u", null, bytes, {
      bytesPath,
      text,
      gateCtx: { symbol: "ACME", issuerName: "ACME Corporation", eventDate: EVENT_DATE },
    });
    fs.writeFileSync(bytesPath, bytes);
    // Its FIFTH and last attempt was claimed by a process that then died.
    db.prepare(`UPDATE print_watch_documents SET parse_attempts = 4 WHERE id = ?`).run(delivered.id);
    claimDocumentParse(db, delivered.id, "dead-token", fake.nowMs - 6 * 60_000);
    expect(getDocument(db, delivered.id)).toMatchObject({
      parse_state: "claimed",
      parse_attempts: 5,
    });

    ensurePrintWatch(db);
    await waitUntil(() => getDocument(db, delivered.id)?.parse_state === "failed");

    // Booked terminal WITHOUT a model call — there was no attempt left to spend.
    expect(getDocument(db, delivered.id)?.parse_last_error).toMatch(
      /abandoned claim at the attempt cap/,
    );
    expect(fake.extractCalls).toHaveLength(0);

    // ...and `failed` is the one state a person's re-delivery can clear.
    const again = await ingestDocument(db, printId, "user-drop", "u2", null, bytes);
    expect(again).toMatchObject({ docId: delivered.id, outcome: "parsed" });
    expect(fake.extractCalls).toHaveLength(1);
  });

  it("a headless HTML fragment (bare <div>/<table>, as EDGAR serves) is stored .html and read as a repA/repB pair", async () => {
    const { printId } = seedAcmePrint();
    fake.extract = async () => [candidate("revenue_q", 1000)];
    const fragment =
      "<div><h1>ACME reports Q2 2026 results</h1><table><tr><td>Revenue</td><td>1,000</td></tr></table></div>";

    const r = await ingestDocument(
      db,
      printId,
      "edgar-ex99",
      "edgar:0001:ex99-1",
      "https://www.sec.gov/x",
      Buffer.from(fragment, "utf8"),
    );

    expect(r.outcome).toBe("parsed");
    expect(listDocuments(db, printId)[0].bytes_path.endsWith(".html")).toBe(true);
    // TWO readings of the one document — the pair that lets a single document
    // reach `agreed` at all. Stored as .txt it would be capped at single_source.
    expect(fake.extractCalls).toHaveLength(2);
    expect(fake.extractCalls[0].text.startsWith("# REPRESENTATION")).toBe(true);
    expect(getSheet(db, printId).find((l) => l.metric_id === "revenue_q")!.state).toBe("agreed");
  });

  // -------------------------------------------------------------------------
  // the PDF road (Task 10)
  // -------------------------------------------------------------------------

  /** A poppler text layer that names ACME's Q2 2026 (so the gate accepts it)
   *  AND carries enough non-whitespace to clear the image-only floor. */
  function acmePdfText(): string {
    return `ACME reports Q2 2026 results. Revenue $1,000 million.\n${"Segment detail line. ".repeat(40)}\f`;
  }

  const PDF_BYTES = Buffer.from("%PDF-1.7\n%fake\n");

  it("a PDF drop is read twice (pdfText + pdfNative) as a weak pair, persists its text, and reaches single_source", async () => {
    const { printId } = seedAcmePrint();
    fake.pdfText = async () => acmePdfText();
    fake.extract = async () => [candidate("revenue_q", 1000)];
    fake.extractPdf = async () => [candidate("revenue_q", 1000)];

    const r = await ingestDocument(db, printId, "user-drop", "user-drop:release.pdf", null, PDF_BYTES);

    expect(r.outcome).toBe("parsed");
    const [doc] = listDocuments(db, printId);
    expect(doc.bytes_path.endsWith(".pdf")).toBe(true);
    expect(fake.pdfTextCalls).toEqual([doc.bytes_path]);
    expect(fs.existsSync(textPathFor(doc.bytes_path))).toBe(true);
    expect(fs.readFileSync(textPathFor(doc.bytes_path), "utf8")).toBe(acmePdfText());
    // The TEXT identity lands on the row too, so a re-saved PDF with the same
    // text layer dedupes onto this document instead of opening a second one.
    expect(doc.text_sha256).toMatch(/^[0-9a-f]{64}$/);

    // Reading one is the poppler text through the ordinary text extractor;
    // reading two is the PDF bytes themselves.
    expect(fake.extractCalls).toHaveLength(1);
    expect(fake.extractCalls[0].text).toBe(acmePdfText());
    expect(fake.extractPdfCalls).toHaveLength(1);
    expect(fake.extractPdfCalls[0].bytes.equals(PDF_BYTES)).toBe(true);

    const line = getSheet(db, printId).find((l) => l.metric_id === "revenue_q")!;
    // Both readings are WEAK (DECISIONS.md, 2026-09-02): two agreeing readings
    // of one PDF cap at single_source - a PDF alone can never green.
    expect(line.state).toBe("single_source");
    const cands = JSON.parse(line.candidates_json) as TaggedCandidate[];
    expect(cands.map((c) => c.representation).sort()).toEqual(["pdfNative", "pdfText"]);
    expect(cands.every((c) => c.weak_pair && c.pair_note === "pdf-weak")).toBe(true);
  });

  it("refuses a PDF when poppler is missing, naming the tool and the setting, storing nothing", async () => {
    const { printId } = seedAcmePrint();
    fake.pdfText = async () => {
      throw new PdfToolMissingError(
        "pdftotext not found - install poppler (brew install poppler) or set settings.pdftotext_path",
      );
    };

    const r = await ingestDocument(db, printId, "user-drop", "u.pdf", null, PDF_BYTES);

    expect(r).toMatchObject({ docId: 0, outcome: "refused" });
    expect(r.rejectReason).toMatch(/pdftotext/);
    expect(r.rejectReason).toMatch(/pdftotext_path/);
    expect(listDocuments(db, printId)).toEqual([]);
    const dir = path.join(tmpRoot, String(printId));
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]); // no orphan bytes (M14)
  });

  it("refuses an image-only PDF (thin text layer) and an encrypted one, each with its own reason", async () => {
    const { printId } = seedAcmePrint();

    fake.pdfText = async () => "ACME\f";
    const thin = await ingestDocument(db, printId, "user-drop", "u.pdf", null, PDF_BYTES);
    expect(thin.outcome).toBe("refused");
    expect(thin.rejectReason).toMatch(/image-only|text layer/i);

    fake.pdfText = async () => {
      throw new PdfEncryptedError("encrypted PDF - remove the password and drop it again");
    };
    const locked = await ingestDocument(db, printId, "user-drop", "u.pdf", null, PDF_BYTES);
    expect(locked.outcome).toBe("refused");
    expect(locked.rejectReason).toMatch(/encrypted/i);

    // Both refusals came from POPPLER, not from a byte pattern (R-B15) — the
    // file reached pdftotext each time.
    expect(fake.pdfTextCalls).toHaveLength(2);

    expect(listDocuments(db, printId)).toEqual([]);
    const dir = path.join(tmpRoot, String(printId));
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it("a permissions-only PDF (/Encrypt in its bytes, no user password) is read, not refused (R-B15)", async () => {
    const { printId } = seedAcmePrint();
    // An owner-password-only release: permission flags, EMPTY user password.
    // pdftotext opens it, so print-watch must too — refusing on the byte
    // pattern would tell the desk to remove a password that does not exist.
    const permissionsOnly = Buffer.from("%PDF-1.7\ntrailer << /Encrypt 5 0 R /Root 1 0 R >>\n%%EOF\n");
    fake.pdfText = async () => acmePdfText();
    fake.extract = async () => [candidate("revenue_q", 1000)];
    fake.extractPdf = async () => [candidate("revenue_q", 1000)];

    const r = await ingestDocument(db, printId, "user-drop", "perm.pdf", null, permissionsOnly);

    expect(r.outcome).toBe("parsed");
    expect(fake.pdfTextCalls).toHaveLength(1); // it reached poppler
    expect(listDocuments(db, printId)).toHaveLength(1);
    expect(getSheet(db, printId).find((l) => l.metric_id === "revenue_q")!.state).toBe(
      "single_source",
    );
  });

  it("a second PDF whose text layer matches an existing one is the SAME document (text identity)", async () => {
    const { printId } = seedAcmePrint();
    fake.pdfText = async () => acmePdfText();
    fake.extract = async () => [candidate("revenue_q", 1000)];
    fake.extractPdf = async () => [candidate("revenue_q", 1000)];

    const first = await ingestDocument(db, printId, "user-drop", "u1.pdf", null, PDF_BYTES);
    // Different BYTES (a re-saved copy), identical poppler text.
    const resaved = Buffer.from("%PDF-1.7\n%resaved by another writer\n");
    const second = await ingestDocument(db, printId, "user-drop", "u2.pdf", null, resaved);

    expect(first.outcome).toBe("parsed");
    expect(second).toMatchObject({ docId: first.docId, isNew: false, outcome: "duplicate" });
    expect(listDocuments(db, printId)).toHaveLength(1);
    // ONE extraction pair, not two.
    expect(fake.extractCalls).toHaveLength(1);
    expect(fake.extractPdfCalls).toHaveLength(1);
  });

  // Task 9/10 minor, ruled in. Text identity (M13) deduped these bytes onto an
  // EXISTING document whose `bytes_path` points somewhere else, so the file we
  // had just written is referenced by nothing: no row, no re-parse, no
  // retention rule. Left behind it is a private release sitting on disk that
  // nothing will ever read or clean up.
  it("a text-identity duplicate deletes the bytes it just wrote (nothing references them)", async () => {
    const { printId } = seedAcmePrint();
    fake.pdfText = async () => acmePdfText();
    fake.extract = async () => [candidate("revenue_q", 1000)];
    fake.extractPdf = async () => [candidate("revenue_q", 1000)];

    const first = await ingestDocument(db, printId, "user-drop", "u1.pdf", null, PDF_BYTES);
    const [doc] = listDocuments(db, printId);
    const dir = path.join(tmpRoot, String(printId));
    const resaved = Buffer.from("%PDF-1.7\n%resaved by another writer\n");
    const second = await ingestDocument(db, printId, "user-drop", "u2.pdf", null, resaved);

    expect(second).toMatchObject({ docId: first.docId, isNew: false });
    // The survivor keeps BOTH of its files; the re-saved copy left nothing.
    expect(fs.existsSync(doc.bytes_path)).toBe(true);
    expect(fs.existsSync(textPathFor(doc.bytes_path))).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(
      [path.basename(doc.bytes_path), path.basename(textPathFor(doc.bytes_path))].sort(),
    );
  });

  it("the same cleanup on the text road: whitespace-only differences leave one file", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    fake.extract = async () => [candidate("eps_adj_q", 1.05)];

    const first = await ingestDocument(
      db,
      printId,
      "user-drop",
      "drop:a.txt",
      null,
      Buffer.from(NVDA_RELEASE_TEXT, "utf8"),
    );
    const [doc] = listDocuments(db, printId);
    const second = await ingestDocument(
      db,
      printId,
      "user-drop",
      "drop:b.txt",
      null,
      // Same words, re-wrapped: different sha256, identical normalised text.
      Buffer.from(NVDA_RELEASE_TEXT.replace(/ /g, "  "), "utf8"),
    );

    expect(second).toMatchObject({ docId: first.docId, isNew: false });
    expect(fs.readdirSync(path.join(tmpRoot, String(printId)))).toEqual([
      path.basename(doc.bytes_path),
    ]);
  });

  it("a refusal on a RE-delivery never deletes the bytes an existing document owns", async () => {
    const { printId } = seedAcmePrint();
    fake.pdfText = async () => acmePdfText();
    fake.extract = async () => [candidate("revenue_q", 1000)];
    fake.extractPdf = async () => [candidate("revenue_q", 1000)];

    const first = await ingestDocument(db, printId, "user-drop", "u1.pdf", null, PDF_BYTES);
    expect(first.outcome).toBe("parsed");
    const [doc] = listDocuments(db, printId);

    // Poppler goes away and the SAME PDF is dropped again. The refusal's
    // cleanup is content-addressed at exactly this document's bytes.
    fake.pdfText = async () => {
      throw new PdfToolMissingError("pdftotext not found — install poppler");
    };
    const again = await ingestDocument(db, printId, "user-drop", "u1.pdf", null, PDF_BYTES);
    expect(again.outcome).toBe("refused");

    expect(fs.existsSync(doc.bytes_path)).toBe(true);
    expect(fs.existsSync(textPathFor(doc.bytes_path))).toBe(true);
    expect(listDocuments(db, printId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// slice C — the ONE effective window, the parallel fan-out, and the go road
// ---------------------------------------------------------------------------

describe("slice C — window, fan-out, go", () => {
  const ACME_ISSUER = "ACME Widget Holdings";
  const ACME_CIK = "0001234567";
  /** Names the ticker AND this event's quarter, so the gate accepts it. */
  const ACME_RELEASE_TEXT = "ACME reports Q2 2026 results. Revenue $1,000 million.";

  /**
   * An in-window armed ACME print whose print ROW already exists, so a test can
   * install its fakes BEFORE the first `ensurePrintWatch` starts the loop.
   */
  function seedAcmePrint(): { eventId: number; printId: number } {
    const { eventId } = seedArmedEvent({ symbol: "ACME", issuerName: ACME_ISSUER });
    fake.cik = ACME_CIK;
    const printId = upsertPrint(db, eventId, "ACME", EVENT_DATE, "16:15");
    return { eventId, printId };
  }

  /** An armed ACME event whose scheduled release is `hours` from now — the
   *  window has NOT opened, so only a go press can make it live. */
  function seedLaterAcmeEvent(hours: number): number {
    const { eventId } = seedArmedEvent({
      symbol: "ACME",
      issuerName: ACME_ISSUER,
      eventTime: hhmmEt(fake.nowMs + hours * 60 * 60_000),
      rawJson: null,
    });
    fake.cik = ACME_CIK;
    return eventId;
  }

  function acmeRelease() {
    return {
      headline: "Press Release: ACME reports Q2 2026 results",
      stitchedText: ACME_RELEASE_TEXT,
      partCount: 1,
      articleIds: ["DJ-N$acme1"],
    };
  }

  /** "HH:MM" in America/New_York — the shape `calendar_events.event_time` takes
   *  when the vendor gave a wall-clock release time. */
  function hhmmEt(ms: number): string {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(ms));
  }

  /** Overwrite the lease row in `acquireWatcherLease`'s own stored shape. */
  function stealLease(target: Database.Database, holder: string, expiresAtMs: number): void {
    target
      .prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
      .run("print_watch_lease", JSON.stringify({ holder, expiresAt: expiresAtMs }));
  }

  function statusRow(target: Database.Database, printId: number) {
    const row = getWatchStatus(target).find((r) => r.printId === printId);
    if (!row) throw new Error(`no status row for print ${printId}`);
    return row;
  }

  it("polls DJ, EDGAR and IR in ONE pass, concurrently: a stalled EDGAR does not delay the DJ ingest", async () => {
    const { printId } = seedAcmePrint();
    let releaseEdgar!: () => void;
    fake.edgar = () =>
      new Promise((resolve) => {
        releaseEdgar = () => resolve([]);
      });
    fake.twsUp = true;
    fake.dj = async () => ({ completedReleases: [acmeRelease()], flashes: [] });

    ensurePrintWatch(db);
    // The DJ bytes land while the EDGAR road is still parked — impossible if
    // the roads ran one after another.
    await waitUntil(() => listDocuments(db, printId).length === 1);
    expect(fake.edgarCalls).toBe(1);

    releaseEdgar();
    await waitUntil(() => (statusRow(db, printId).sources.edgar ?? "").startsWith("ok"));
    // Only NOW is the DJ road guaranteed to have written its own note: the
    // document lands mid-road, before the lane records its summary.
    expect(statusRow(db, printId).sources.dj ?? "").toMatch(/^ok/);
  });

  it("a road that exceeds ROAD_TIMEOUT_MS is ABORTED (its signal fires) and the pass still completes with the other roads' results", async () => {
    const { printId } = seedAcmePrint();
    let cancelled = false;
    // The throttled fetch carries the pass signal: a road that only settles
    // when that signal fires is exactly "hung until cancelled".
    fake.edgar = (fetchFn?: FetchLike) =>
      new Promise<never>((_resolve, reject) => {
        void fetchFn?.("https://data.sec.gov/probe").catch((err) => {
          cancelled = true;
          reject(err as Error);
        });
      });
    fake.twsUp = true;
    fake.dj = async () => ({ completedReleases: [], flashes: [] });

    ensurePrintWatch(db);
    await tick(ROAD_TIMEOUT_MS + 1_000);

    expect(cancelled).toBe(true);
    const row = statusRow(db, printId);
    expect(row.sources.edgar).toMatch(/timed out|abort/i);
    expect(row.sources.dj).toMatch(/^ok/);
  });

  it("a go request before the scheduled window forces it open, runs a pass at once, and lands one report per road", async () => {
    const eventId = seedLaterAcmeEvent(3);
    ensurePrintWatch(db);
    let printId = getPrintByEventId(db, eventId)!.id;
    expect(getPrintById(db, printId)!.state).toBe("scheduled");

    fake.twsUp = false; // TWS down at go → the wire road is skipped (spec §7)
    fake.edgar = async () => [];

    // REAL requestGo; its defaults reach THIS process's watcher. Only the
    // post-commit fan-out (A's prepare pass + the outbox drain) is stubbed —
    // it is another slice's work and has nothing to do with acquisition.
    const ack = await requestGo(db, eventId, {}, { postCommit: async () => {} });
    printId = ack.printId;
    expect(ack.wakeError).toBeNull();

    await waitUntil(() => getGoRequest(db, ack.requestId)?.status === "done");
    expect(getPrintById(db, printId)!.state).toBe("window_open");

    const result = JSON.parse(getGoRequest(db, ack.requestId)!.result_json!) as RoadReport[];
    expect(result.map((r) => r.road)).toEqual(["dj", "edgar", "ir"]);
    // The pass ran NOW, not at the next cadence tick.
    expect(fake.edgarCalls).toBeGreaterThanOrEqual(1);
    expect(result.find((r) => r.road === "dj")).toMatchObject({ outcome: "skipped" });
  });

  it("the DJ and EDGAR query bounds start at the EFFECTIVE window start (press − 60m), not the scheduled one", async () => {
    const eventId = seedLaterAcmeEvent(3);
    ensurePrintWatch(db);
    fake.twsUp = true;
    fake.dj = async () => ({ completedReleases: [], flashes: [] });
    fake.edgar = async () => [];

    const ack = await requestGo(db, eventId, {}, { postCommit: async () => {} });
    await waitUntil(() => getGoRequest(db, ack.requestId)?.status === "done");

    const startMs = Date.parse(ack.forcedOpenAt) - FORCED_PRE_MS;
    expect(Date.parse(fake.edgarStarts.at(-1)!)).toBe(startMs);
    expect(fake.djStarts.at(-1)!).toBe(formatTwsDateTime(new Date(startMs)));
  });

  it("an extension written by ANOTHER process is honoured at the next pass (the window is re-read from the row)", async () => {
    const { printId } = seedAcmePrint();
    fake.twsUp = false;
    fake.edgar = async () => [];
    ensurePrintWatch(db);

    const before = statusRow(db, printId).effectiveWindow!;
    expect(before).not.toBeNull();
    // "Another process" writes the row; this process never hears about it.
    extendPrintWindow(db, printId, new Date(Date.parse(before.end) + 30 * 60_000).toISOString());
    await tick(CADENCE_MS + 100);

    fake.nowMs = Date.parse(before.end) + 10 * 60_000; // past the OLD end, inside the extension
    await tick(CADENCE_MS + 100);

    expect(getPrintById(db, printId)!.state).toBe("window_open"); // not expired
    expect(statusRow(db, printId).windowExtendedUntil).not.toBeNull();
  });

  it("go dispatcher: a request queued by another CONNECTION is claimed within GO_DISPATCH_MS by the lease owner and runs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "print-watch-godb-"));
    const file = path.join(dir, "watch.db");
    const owner = new Database(file);
    owner.pragma("foreign_keys = ON");
    runMigrations(owner);
    const inMemory = db;
    db = owner; // the seed helpers write through the module-level handle
    try {
      const { printId } = seedAcmePrint();
      fake.twsUp = false;
      fake.edgar = async () => [];
      ensurePrintWatch(owner);

      // Ten minutes of idle: no ensure, no press, nothing but the dispatcher.
      await tick(10 * 60_000);

      const other = new Database(file);
      const id = insertGoRequest(other, {
        printId,
        inputKind: "none",
        inputUrl: null,
        inputSha256: null,
        inputBytesPath: null,
        requestedAt: new Date(fake.nowMs).toISOString(),
      });
      other.close();

      await tick(GO_DISPATCH_MS + 50);
      await waitUntil(() => getGoRequest(owner, id)?.status === "done");
      expect(getGoRequest(owner, id)!.attempts).toBe(1);
    } finally {
      db = inMemory;
      _setTestSeams(null); // stop the dispatcher before the file handle closes
      owner.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // I1/R-C16. The one the two-connection test above could NOT prove: it seeds
  // the print and calls `ensurePrintWatch` BEFORE the foreign insert, so the
  // owner already has a runtime. The real topology is packaged :3099 holding
  // the lease while the desk presses on dev :3000 for an event :3099 has not
  // reconciled — an event the press itself armed, or one dated outside ±1 day.
  // `wakePrintWatch` is in-process, so nothing but the tick can place that row.
  it("go dispatcher: a press for a print the owner has NEVER reconciled is still claimed within GO_DISPATCH_MS (I1)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "print-watch-godb-"));
    const file = path.join(dir, "watch.db");
    const owner = new Database(file);
    owner.pragma("foreign_keys = ON");
    runMigrations(owner);
    const inMemory = db;
    db = owner;
    try {
      // Ten days out: outside the ±1-day armed scope, and its scheduled window
      // is days away — only the press can make this print live.
      const farDate = addDays(EVENT_DATE, 10);
      const { eventId } = seedArmedEvent({
        symbol: "ACME",
        issuerName: ACME_ISSUER,
        eventDate: farDate,
      });
      fake.cik = ACME_CIK;
      fake.twsUp = false;
      fake.edgar = async () => [];

      ensurePrintWatch(owner);
      expect(getPrintByEventId(owner, eventId)).toBeNull(); // out of scope: no runtime here
      await tick(10 * 60_000); // idle: no ensure, only the dispatcher

      // The press happens in ANOTHER process. All this one ever sees is rows.
      const other = new Database(file);
      other.pragma("foreign_keys = ON");
      const printId = upsertPrint(other, eventId, "ACME", farDate, "16:15");
      stampForcedOpen(other, printId, new Date(fake.nowMs).toISOString());
      const id = insertGoRequest(other, {
        printId,
        inputKind: "none",
        inputUrl: null,
        inputSha256: null,
        inputBytesPath: null,
        requestedAt: new Date(fake.nowMs).toISOString(),
      });
      other.close();

      await tick(GO_DISPATCH_MS + 50);
      // Claimed inside one tick — `claimGoRequest` runs synchronously at the
      // head of `runGoRequest`, so "not queued" here IS "claimed within 2 s".
      expect(getGoRequest(owner, id)!.status).not.toBe("queued");

      await waitUntil(() => getGoRequest(owner, id)?.status === "done");
      expect(getGoRequest(owner, id)!.attempts).toBe(1);
      expect(getPrintById(owner, printId)!.state).toBe("window_open");
    } finally {
      db = inMemory;
      _setTestSeams(null);
      owner.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The same gap on the extend control: the owner's loop stopped at the old
  // end, and the extension arrives as a row nobody in this process announced.
  it("an extension written by another process AFTER the loop stopped brings the loop back within one tick (I1)", async () => {
    const { eventId, printId } = seedAcmePrint();
    void eventId;
    fake.twsUp = false;
    fake.edgar = async () => [];
    stampForcedOpen(db, printId, new Date(fake.nowMs).toISOString()); // the press
    ensurePrintWatch(db);
    await tick(CADENCE_MS + 100);
    const window = statusRow(db, printId).effectiveWindow!;

    // Past the end: the loop's next pass expires the print and stands down.
    fake.nowMs = Date.parse(window.end) + 60_000;
    await tick(CADENCE_MS + 100);
    expect(getPrintById(db, printId)!.state).toBe("expired");
    const pollsWhileExpired = fake.edgarCalls;
    await tick(CADENCE_MS * 2);
    expect(fake.edgarCalls).toBe(pollsWhileExpired); // genuinely stopped

    // "Extend 30 min" on the other process — a row write, nothing more.
    extendPrintWindow(db, printId, new Date(fake.nowMs + 30 * 60_000).toISOString());
    await tick(GO_DISPATCH_MS + 50);
    expect(getPrintById(db, printId)!.state).toBe("window_open");
    await tick(CADENCE_MS + 100);
    expect(fake.edgarCalls).toBeGreaterThan(pollsWhileExpired);
  });

  // I2/R-C17. The skip this replaces claimed to protect "the press armed it",
  // but `extraDates` already re-fetches a forced print's event through the
  // flag-joined query — so the only print it could still reach was one whose
  // flag the desk had just REMOVED.
  it("a disarm after a press ends the forced watch — the user's disarm wins (I2)", async () => {
    const { eventId, printId } = seedAcmePrint();
    fake.twsUp = false;
    fake.edgar = async () => [];
    stampForcedOpen(db, printId, new Date(fake.nowMs).toISOString()); // pressed the wrong name
    ensurePrintWatch(db);
    await tick(CADENCE_MS + 100);
    expect(getPrintById(db, printId)!.state).toBe("window_open");
    const pollsBefore = fake.edgarCalls;
    expect(pollsBefore).toBeGreaterThan(0);

    // The arm chip, pressed again: the flag goes, nothing touches the print.
    db.prepare(`DELETE FROM earnings_worksheet_flags WHERE event_id = ?`).run(eventId);
    ensurePrintWatch(db);

    expect(getPrintById(db, printId)!.state).toBe("disarmed");
    // …and no consumer resurrects it: the forced-window list excludes it, so
    // the dispatcher's own reconcile (I1) cannot bring the loop back either.
    expect(listForcedLivePrints(db, fake.nowMs).map((p) => p.id)).not.toContain(printId);
    await tick(CADENCE_MS * 3);
    expect(fake.edgarCalls).toBe(pollsBefore);
    expect(getPrintById(db, printId)!.state).toBe("disarmed");
  });

  // N2 — the other half of I2's deletion: the disarm branch may only stand a
  // forced print down when the flag is GONE, never because the print row's
  // copy of the event date went stale. A calendar sync correcting the date
  // mid-window used to be caught by the old skip.
  it("a still-flagged event whose DATE is corrected mid-forced-window keeps its watch (N2)", async () => {
    const { eventId, printId } = seedAcmePrint();
    fake.twsUp = false;
    fake.edgar = async () => [];
    stampForcedOpen(db, printId, new Date(fake.nowMs).toISOString());
    ensurePrintWatch(db);
    await tick(CADENCE_MS + 100);
    expect(getPrintById(db, printId)!.state).toBe("window_open");
    const pollsBefore = fake.edgarCalls;

    // The calendar sync moves the event ten days out. The FLAG is untouched —
    // the desk still cares about this print, and the press is still open.
    const correctedDate = addDays(EVENT_DATE, 10);
    db.prepare(`UPDATE calendar_events SET event_date = ? WHERE id = ?`).run(correctedDate, eventId);
    expect(getPrintById(db, printId)!.event_date).toBe(EVENT_DATE); // the row's copy is now stale

    ensurePrintWatch(db);
    expect(getPrintById(db, printId)!.state).toBe("window_open"); // not disarmed, not expired
    expect(getPrintById(db, printId)!.event_date).toBe(correctedDate); // and re-synced
    await tick(CADENCE_MS + 100);
    expect(fake.edgarCalls).toBeGreaterThan(pollsBefore); // still polling
  });

  // M5/R-C18: the watcher side of the requeue. `runGoRequest` treats this
  // throw as "nobody looked" and puts the row back on the queue.
  it("runForcedPass THROWS WatcherLeaseLost once the lease has moved, instead of answering with skipped reports (M5)", async () => {
    const { printId } = seedAcmePrint();
    fake.twsUp = false;
    fake.edgar = async () => [];
    ensurePrintWatch(db);
    await tick(1);

    stealLease(db, "someone-else@3099", fake.nowMs + 60_000);
    ensurePrintWatch(db); // notices the lease is gone and stands the loops down

    await expect(runForcedPass(db, printId)).rejects.toBeInstanceOf(WatcherLeaseLost);
  });

  it("any wake runs the go dispatcher, whatever reason the scheduler reports (R-C10)", async () => {
    const { printId } = seedAcmePrint();
    fake.twsUp = false;
    fake.edgar = async () => [];
    ensurePrintWatch(db);
    await tick(1);

    // The scheduler keeps the FIRST remembered reason, so the desk's go press
    // below is reported as "burst". The reason is informational: the wake must
    // still dispatch.
    acquisitionScheduler.wake(printId, "burst");
    const id = insertGoRequest(db, {
      printId,
      inputKind: "none",
      inputUrl: null,
      inputSha256: null,
      inputBytesPath: null,
      requestedAt: new Date(fake.nowMs).toISOString(),
    });
    acquisitionScheduler.wake(printId, "go");

    // Under GO_DISPATCH_MS of fake time: only the WAKE can have claimed it.
    await waitUntil(() => getGoRequest(db, id)?.status === "done", 3, 500);
    expect(getGoRequest(db, id)!.attempts).toBe(1);
  });

  it("losing the lease mid-pass aborts every road of that pass", async () => {
    const { printId } = seedAcmePrint();
    fake.twsUp = true;
    fake.dj = async () => ({ completedReleases: [], flashes: [] });
    fake.edgar = async () => [];

    // A document waiting to be parsed makes the pass LONG — the parse is the
    // phase the mid-pass renewal timer exists for (a model call is minutes,
    // not seconds), and it is the only phase longer than ROAD_TIMEOUT_MS.
    const bytes = Buffer.from(ACME_RELEASE_TEXT, "utf8");
    const bytesPath = path.join(tmpRoot, "slow.txt");
    recordDelivery(db, printId, "user-drop", "slow", null, bytes, {
      bytesPath,
      text: ACME_RELEASE_TEXT,
      gateCtx: { symbol: "ACME", issuerName: ACME_ISSUER, eventDate: EVENT_DATE },
    });
    fs.writeFileSync(bytesPath, bytes);
    fake.extract = () => new Promise((resolve) => setTimeout(() => resolve([]), 30_000));

    ensurePrintWatch(db);
    await tick(10);
    // Another process takes the lease: our mid-pass renewal fails.
    stealLease(db, "other-process", fake.nowMs + 120_000);

    await tick(LEASE_RENEW_MS + 100);
    await tick(30_000); // the parse finishes; the roads then find the pass aborted

    const row = statusRow(db, printId);
    expect(row.sources.edgar).toMatch(/abort|lease/i);
    expect(row.sources.dj).toMatch(/abort|lease/i);
  });

  it("a renewal that THROWS aborts the pass instead of taking the process down", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { printId } = seedAcmePrint();
      fake.twsUp = true;
      fake.dj = async () => ({ completedReleases: [], flashes: [] });
      fake.edgar = async () => [];

      const bytes = Buffer.from(ACME_RELEASE_TEXT, "utf8");
      const bytesPath = path.join(tmpRoot, "throwy.txt");
      recordDelivery(db, printId, "user-drop", "throwy", null, bytes, {
        bytesPath,
        text: ACME_RELEASE_TEXT,
        gateCtx: { symbol: "ACME", issuerName: ACME_ISSUER, eventDate: EVENT_DATE },
      });
      fs.writeFileSync(bytesPath, bytes);
      fake.extract = () => new Promise((resolve) => setTimeout(() => resolve([]), 30_000));

      ensurePrintWatch(db);
      await tick(10);
      // The lease WRITE itself starts failing — `acquireWatcherLease`'s UPDATE
      // raises, so `renewLeaseIfDue` throws rather than returning false.
      db.exec(
        `CREATE TRIGGER lease_boom BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'lease store is down'); END`,
      );

      await tick(LEASE_RENEW_MS + 100);
      await tick(30_000);

      const row = statusRow(db, printId);
      expect(row.sources.edgar).toMatch(/abort|lease store is down/i);
      db.exec(`DROP TRIGGER lease_boom`);
    } finally {
      warn.mockRestore();
    }
  });

  it("an external signal aborted mid-pass cancels the roads and the pass settles writing nothing (R-C11)", async () => {
    // A print whose scheduled window has NOT opened: the runtime exists, but no
    // cadence loop runs, so the only pass in flight is the forced one — the
    // scheduler cannot coalesce this call into somebody else's.
    const eventId = seedLaterAcmeEvent(3);
    ensurePrintWatch(db);
    const printId = getPrintByEventId(db, eventId)!.id;

    const abortErr = () => Object.assign(new Error("aborted"), { name: "AbortError" });
    fake.twsUp = true;
    // Both wire and EDGAR hang until their signal fires; the wire would ingest a
    // release if it were ever allowed to finish.
    fake.dj = (signal?: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(abortErr()), { once: true });
      });
    fake.edgar = (fetchFn?: FetchLike) =>
      new Promise<never>((_resolve, reject) => {
        void fetchFn?.("https://data.sec.gov/probe").catch(reject);
      });

    const claim = new AbortController();
    const running = runForcedPass(db, printId, claim.signal);
    await flushIo();
    expect(fake.djCalls).toBe(1); // the pass really is in flight

    claim.abort();
    const reports = await running;

    expect(reports.map((r) => r.road)).toEqual(["dj", "edgar", "ir"]);
    expect(reports.find((r) => r.road === "dj")!.outcome).toBe("failed");
    expect(reports.find((r) => r.road === "edgar")!.outcome).toBe("failed");
    // Cancelled, not merely abandoned: nothing was written for this print.
    expect(listDocuments(db, printId)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // R-C12: the road budgets cover ACQUISITION; a report settles at delivery
  // -------------------------------------------------------------------------

  /** A scheduled (not-yet-open) print: the runtime exists, no cadence loop
   *  runs, so `runForcedPass` is the only pass and its reports are the test's. */
  function scheduledAcme(): number {
    const eventId = seedLaterAcmeEvent(3);
    ensurePrintWatch(db);
    return getPrintByEventId(db, eventId)!.id;
  }

  /** Resolve after `ms` of FAKE time. */
  function after<T>(ms: number, value: T): Promise<T> {
    return new Promise((resolve) => setTimeout(() => resolve(value), ms));
  }

  async function forcedPass(printId: number, budgetMs = 120_000): Promise<RoadReport[]> {
    let reports: RoadReport[] | null = null;
    void runForcedPass(db, printId).then((r) => {
      reports = r;
    });
    await waitUntil(() => reports !== null, Math.ceil(budgetMs / 1_000), 1_000);
    return reports!;
  }

  it("a road whose fetch lands fast but whose PARSE runs long is reported ok, and the document is parsed (R-C12)", async () => {
    const printId = scheduledAcme();
    fake.twsUp = true;
    // 5 seconds of acquisition, then 40 seconds of parse — far past
    // ROAD_TIMEOUT_MS, which covers acquisition only.
    fake.dj = async () => after(5_000, { completedReleases: [acmeRelease()], flashes: [] });
    fake.edgar = async () => [];
    fake.extract = async () => after(40_000, [candidate("eps_adj_q", 1.05)]);

    const reports = await forcedPass(printId);

    expect(reports.find((r) => r.road === "dj")).toMatchObject({ outcome: "ok" });
    const docs = listDocuments(db, printId);
    expect(docs).toHaveLength(1);
    expect(getDocument(db, docs[0].id)!.parse_state).toBe("parsed");
  });

  it("a road whose FETCH hangs is aborted at ROAD_TIMEOUT_MS and reported timed out (R-C12)", async () => {
    const printId = scheduledAcme();
    fake.twsUp = true;
    // Honours its cancellation: it settles the moment the abort lands.
    fake.dj = (signal?: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
    fake.edgar = async () => [];

    const reports = await forcedPass(printId);

    const dj = reports.find((r) => r.road === "dj")!;
    expect(dj.outcome).toBe("failed");
    expect(dj.detail).toMatch(/timed out/i);
    expect(listDocuments(db, printId)).toEqual([]);
  });

  it("the IR lane keeps walking its links while a SIBLING road's timer fires (R-C12)", async () => {
    const IR_URL = "https://ir.acme.example/news";
    const LINK_A = "https://ir.acme.example/news/acme-q2-2026-results-one";
    const LINK_B = "https://ir.acme.example/news/acme-q2-2026-results-two";
    const PAGE =
      `<a href="/news/acme-q2-2026-results-one">ACME Reports Q2 2026 Results</a>` +
      `<a href="/news/acme-q2-2026-results-two">ACME Reports Q2 2026 Results Supplement</a>`;
    const RELEASE = `<html><body>ACME reports Q2 2026 results. Revenue $1,000 million.</body></html>`;

    const eventId = seedLaterAcmeEvent(3);
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: IR_URL, linkMustContain: null });
    ensurePrintWatch(db);
    const printId = getPrintByEventId(db, eventId)!.id;

    fake.twsUp = false;
    // EDGAR hangs on its own signal: its road is aborted at ROAD_TIMEOUT_MS,
    // 15 seconds into a walk the IR lane is still in the middle of.
    fake.edgar = (fetchFn?: FetchLike) =>
      new Promise<never>((_resolve, reject) => {
        void fetchFn?.("https://data.sec.gov/probe").catch(reject);
      });
    // DISTINCT bytes per link: identical bytes are ONE document with two roads
    // (M13), which would hide whether the second link was walked at all.
    fake.fetchBytes = async (url: string) => ({
      bytes: Buffer.from(
        url === IR_URL ? PAGE : RELEASE.replace("</body>", `<p>${url}</p></body>`),
        "utf8",
      ),
      finalUrl: url,
      status: 200,
      contentType: "text/html",
    });
    // Each parse is long enough that the sibling's 15s timer lands between the
    // two links — and long enough that a budget covering the parse would kill
    // the second one.
    fake.extract = async () => after(10_000, [candidate("eps_adj_q", 1.05)]);

    const reports = await forcedPass(printId);

    expect(reports.find((r) => r.road === "edgar")!.outcome).toBe("failed");
    // Both links walked: the IR road neither inherited the sibling's abort nor
    // spent its own acquisition budget on the parses.
    const urls = listDocuments(db, printId).map((d) => d.url);
    expect(urls).toHaveLength(2);
    expect(urls).toEqual(expect.arrayContaining([LINK_A, LINK_B]));
    expect(reports.find((r) => r.road === "ir")!.outcome).toBe("ok");
  });

  it("a road ABANDONED after it already delivered is reported ok, never failed (R-C12)", async () => {
    const IR_URL = "https://ir.acme.example/news";
    const LINK_A = "https://ir.acme.example/news/acme-q2-2026-results-one";
    const PAGE =
      `<a href="/news/acme-q2-2026-results-one">ACME Reports Q2 2026 Results</a>` +
      `<a href="/news/acme-q2-2026-results-two">ACME Reports Q2 2026 Results Supplement</a>`;
    const RELEASE = `<html><body>ACME reports Q2 2026 results. Revenue $1,000 million.</body></html>`;

    const eventId = seedLaterAcmeEvent(3);
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: IR_URL, linkMustContain: null });
    ensurePrintWatch(db);
    const printId = getPrintByEventId(db, eventId)!.id;

    fake.twsUp = false;
    fake.edgar = async () => [];
    fake.fetchBytes = async (url: string) => {
      if (url === IR_URL) {
        return { bytes: Buffer.from(PAGE, "utf8"), finalUrl: url, status: 200, contentType: "text/html" };
      }
      if (url === LINK_A) {
        return { bytes: Buffer.from(RELEASE, "utf8"), finalUrl: url, status: 200, contentType: "text/html" };
      }
      // The second link IGNORES its cancellation — the only case the abandon
      // budget exists for. The road is rejected, but it already delivered.
      return new Promise<never>(() => {});
    };

    const reports = await forcedPass(printId);

    const ir = reports.find((r) => r.road === "ir")!;
    expect(ir.outcome).toBe("ok");
    expect(ir.detail).toMatch(/1 document\(s\) delivered/);
    expect(listDocuments(db, printId).map((d) => d.url)).toEqual([LINK_A]);
  });

  it("status carries forcedOpenAt, windowExtendedUntil, effectiveWindow and the latest goRequest", async () => {
    const eventId = seedLaterAcmeEvent(1);
    ensurePrintWatch(db);
    fake.twsUp = false;
    fake.edgar = async () => [];

    const ack = await requestGo(db, eventId, {}, { postCommit: async () => {} });
    await waitUntil(() => getGoRequest(db, ack.requestId)?.status === "done");

    const row = statusRow(db, ack.printId);
    expect(row.forcedOpenAt).toBe(ack.forcedOpenAt);
    expect(row.windowExtendedUntil).toBeNull();
    expect(row.effectiveWindow).toEqual({
      start: new Date(Date.parse(ack.forcedOpenAt) - FORCED_PRE_MS).toISOString(),
      end: expect.any(String),
    });
    expect(row.goRequest).toMatchObject({ id: ack.requestId, status: "done", attempts: 1 });
    expect(row.goRequest!.result!.map((r) => r.road)).toEqual(["dj", "edgar", "ir"]);
  });
});
