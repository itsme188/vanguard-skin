import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runMigrations } from "@/lib/db/migrate";
import {
  claimDocumentParse,
  getDocument,
  getPrintByEventId,
  getSheet,
  listDocumentRoads,
  listDocuments,
} from "@/lib/print-watch/store";
import { recordDelivery } from "@/lib/print-watch/delivery";
import type { LineContract, ParseCandidate, TaggedCandidate } from "@/lib/print-watch/types";
import {
  ensurePrintWatch,
  getWatchStatus,
  ingestDocument,
  validateDocForEvent,
  _setTestSeams,
} from "@/lib/print-watch/watcher";

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

interface FakeSeamState {
  extractCalls: ExtractCall[];
  extract: (contracts: LineContract[], text: string) => Promise<ParseCandidate[]>;
  djCalls: number;
  dj: () => Promise<{
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
  edgar: () => Promise<
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
    djCalls: 0,
    dj: async () => ({ completedReleases: [], flashes: [] }),
    edgarCalls: 0,
    edgarSeen: [],
    edgar: async () => [],
    irCalls: [],
    ir: async () => [],
    twsUp: true,
    cik: null,
    sleepThrowsOnce: false,
    storageRoot: null,
    djSeen: [],
    djConIds: [],
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
      _windowStartUtc: string,
      _nowUtc: string,
      state: { seenArticleIds: Set<string> },
    ) => {
      fake.djCalls += 1;
      fake.djConIds.push(conId);
      fake.djSeen.push([...state.seenArticleIds]);
      return fake.dj();
    },
    resolveCik: async () => fake.cik,
    resolveConId: async (_db: unknown, securityId: number) => {
      fake.conIdCalls.push(securityId);
      if (fake.conIdThrows) throw new Error(fake.conIdThrows);
      return fake.conIdResult;
    },
    pollEdgar: async (
      _cik: string,
      _startIso: string,
      _endIso: string,
      seenAccessions: Set<string>,
    ) => {
      fake.edgarCalls += 1;
      fake.edgarSeen.push([...seenAccessions]);
      return fake.edgar();
    },
    pollIrRss: async (_cfg, seenLinks: Set<string>, baseline: boolean) => {
      fake.irCalls.push({ baseline, seen: [...seenLinks] });
      return fake.ir(baseline);
    },
    extractCandidates: async (contracts: LineContract[], text: string) => {
      fake.extractCalls.push({ text });
      return fake.extract(contracts, text);
    },
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
async function waitUntil(pred: () => boolean, steps = 40): Promise<void> {
  for (let i = 0; i < steps; i += 1) {
    await flushIo(20);
    if (pred()) return;
    await vi.advanceTimersByTimeAsync(1_000);
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
    fake.edgar = () => new Promise(() => {}); // a socket that never answers

    const leaseExpiry = (): number => {
      const row = db.prepare(`SELECT value FROM settings WHERE key = 'print_watch_lease'`).get() as
        | { value: string }
        | undefined;
      return row ? (JSON.parse(row.value) as { expiresAt: number }).expiresAt : 0;
    };

    ensurePrintWatch(db);
    const expiryBefore = leaseExpiry();

    await tick(40_000);

    expect(fake.edgarCalls).toBeGreaterThan(0);
    expect(getWatchStatus(db)[0].sources.edgar).toContain("timed out");
    // The renewal happened despite the hung source, and DJ kept polling.
    expect(leaseExpiry()).toBeGreaterThan(expiryBefore);
    const djAfterStall = fake.djCalls;
    expect(djAfterStall).toBeGreaterThan(1);

    await tick(30_000);
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
});
