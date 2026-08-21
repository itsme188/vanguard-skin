import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runMigrations } from "@/lib/db/migrate";
import { getSheet, listDocuments, getPrintByEventId } from "@/lib/print-watch/store";
import type { LineContract, ParseCandidate } from "@/lib/print-watch/types";
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
    completedReleases: Array<{ headline: string; stitchedText: string; partCount: number }>;
    flashes: Array<{ time: string; headline: string }>;
  }>;
  edgarCalls: number;
  edgar: () => Promise<
    Array<{
      accession: string;
      form: string;
      acceptanceDateTime: string;
      exhibits: Array<{ name: string; url: string; html: string }>;
    }>
  >;
  twsUp: boolean;
  cik: string | null;
  /** One-shot timer failure, to crash a loop body on purpose. */
  sleepThrowsOnce: boolean;
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
    edgar: async () => [],
    twsUp: true,
    cik: null,
    sleepThrowsOnce: false,
  };

  _setTestSeams({
    storageRoot: () => tmpRoot,
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
    pollDjNews: async () => {
      fake.djCalls += 1;
      return fake.dj();
    },
    resolveCik: async () => fake.cik,
    pollEdgar: async () => {
      fake.edgarCalls += 1;
      return fake.edgar();
    },
    pollIrRss: async () => [],
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
  } = {},
): { eventId: number } {
  const symbol = opts.symbol ?? "NVDA";
  const conId = opts.conId === undefined ? 4815747 : opts.conId;

  const sec = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, ib_con_id) VALUES (?, ?, 'Stock', ?)`,
    )
    .run(symbol, "NVIDIA Corporation", conId);

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
      Number(sec.lastInsertRowid),
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

  return { eventId };
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
        flashes: [{ time: "2026-08-26 20:20:00.0", headline: "*NVIDIA 2Q ADJ EPS $1.05" }],
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
      "drop: HTML/text",
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
          { headline: "Press Release: NVIDIA", stitchedText: NVDA_RELEASE_TEXT, partCount: 1 },
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
    seedArmedEvent({ conId: null });

    ensurePrintWatch(db);
    await tick(1);

    expect(fake.djCalls).toBe(0);
    expect(getWatchStatus(db)[0].coverage).toContain("DJ: no conId — wire off");
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
});

describe("ingestDocument — gate", () => {
  it("stores a failing document as rejected:<reason> and never parses it", async () => {
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
    expect(docs[0].source.startsWith("rejected:")).toBe(true);
    expect(docs[0].parsed_at).toBeNull();
    expect(fake.extractCalls).toHaveLength(0);
    expect(getSheet(db, printId).every((l) => l.state === "pending")).toBe(true);
    expect(getWatchStatus(db)[0].sources.gate).toContain("rejected");
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
        flashes: [{ time: "2026-08-26 20:20:00.0", headline: "*NVIDIA 2Q ADJ EPS $1.05" }],
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
        flashes: [{ time: "2026-08-26 20:20:00.0", headline: "*NVIDIA 2Q ADJ EPS $1.05" }],
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
  });
});
