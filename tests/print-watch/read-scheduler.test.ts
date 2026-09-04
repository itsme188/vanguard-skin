import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertPrint, upsertLines, setPrintState } from "@/lib/print-watch/store";
import { claimRead, finalizeReadDone, finalizeReadFailed } from "@/lib/print-watch/read-store";
import {
  scheduleFirstPassRead,
  reconcilePendingReads,
  armReconcileTimer,
  enableFirstPassScheduler,
  disableFirstPassScheduler,
  schedulerEnabled,
  _setSchedulerSeams,
  __pendingReadTimers,
  __resetSchedulerForTests,
  READ_DEBOUNCE_MS,
  READ_RECONCILE_EVERY_MS,
  ASK_MEMORY_TTL_MS,
} from "@/lib/print-watch/read-scheduler";
import { todayET } from "@/lib/calendar/date-utils";
import { buildFirstPassPrompt } from "@/lib/print-watch/first-pass-prompt";
import fs from "node:fs";
import type { PrintWatchLine } from "@/lib/print-watch/types";

let db: Database.Database;
const T0 = Date.parse("2026-09-10T20:06:00Z");
const PROSE = { read: ["1", "2", "3", "4", "5", "6"], call_watch: ["a", "b", "c"], caveats: [] };

function acceptedLine(): PrintWatchLine {
  return {
    metric_id: "revenue_q",
    contract: {
      metric_id: "revenue_q",
      label: "Revenue",
      definition: "d",
      basis: "na",
      period: "Q",
      currency: "USD",
      unit: "usd",
      kind: "point",
      segment: null,
    },
    expected: null,
    state: "accepted",
    value: 1,
    value_high: null,
    snippet: null,
    source_doc_id: null,
    candidates_json: "[]",
  };
}

function seedPrint(date: string, key: string, state: "parsed" | "expired" = "parsed"): number {
  const eventId = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings',?, 'ACME', ?, 'ACME')`,
      )
      .run(date, key).lastInsertRowid,
  );
  const id = upsertPrint(db, eventId, "ACME", date, "16:05");
  upsertLines(db, id, [acceptedLine()]);
  setPrintState(db, id, state);
  return id;
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetSchedulerForTests();
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  _setSchedulerSeams(null);
  disableFirstPassScheduler();
  vi.useRealTimers();
  db.close();
});

describe("gating (#25)", () => {
  it("is off under VITEST until a test opts in; scheduleFirstPassRead is then a no-op", () => {
    expect(schedulerEnabled()).toBe(false);
    scheduleFirstPassRead(db, 7);
    expect(__pendingReadTimers()).toEqual([]);
    enableFirstPassScheduler();
    expect(schedulerEnabled()).toBe(true);
    scheduleFirstPassRead(db, 7);
    expect(__pendingReadTimers()).toEqual([7]);
  });
});

describe("scheduleFirstPassRead (debounce)", () => {
  beforeEach(() => enableFirstPassScheduler());

  it("runs once, 5 s after the LAST schedule call for a print, and clears its timer", async () => {
    const runner = vi.fn(async () => undefined);
    _setSchedulerSeams({ runner });
    scheduleFirstPassRead(db, 7);
    vi.advanceTimersByTime(3_000);
    scheduleFirstPassRead(db, 7);
    vi.advanceTimersByTime(3_000);
    expect(runner).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS - 3_000 + 1);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(db, 7);
    expect(__pendingReadTimers()).toEqual([]);
  });

  it("a runner rejection is swallowed with an id-only warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    _setSchedulerSeams({
      runner: async () => {
        throw new Error("revenue of $898.2 million leaked?");
      },
    });
    scheduleFirstPassRead(db, 9);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS + 1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/print 9/);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/898/);
    warn.mockRestore();
  });
});

describe("reconcilePendingReads (#16)", () => {
  beforeEach(() => enableFirstPassScheduler());

  it("schedules a parsed print with no read for its current fingerprint (the crashed-timer case) and skips done/generating/backoff/expired/old prints", async () => {
    const runner = vi.fn(async () => undefined);
    const today = todayET(new Date(T0));
    const crashed = seedPrint(today, "a");
    const done = seedPrint(today, "b");
    const generating = seedPrint(today, "c");
    const backoff = seedPrint(today, "d");
    const expired = seedPrint(today, "e", "expired");
    const old = seedPrint("2026-08-01", "f");
    const fp = (id: number) => `fp-${id}`;
    _setSchedulerSeams({ runner, now: () => T0, fingerprintFor: async (_db, id) => fp(id) });

    const d = claimRead(db, done, { fingerprint: fp(done), recompute: () => fp(done), nowMs: T0, modelId: "m" });
    if (d.kind !== "claimed") throw new Error();
    finalizeReadDone(db, { readId: d.row.id, token: d.token, facts: [], prose: PROSE, callouts: [], nowMs: T0 });
    claimRead(db, generating, {
      fingerprint: fp(generating),
      recompute: () => fp(generating),
      nowMs: T0 - 1000,
      modelId: "m",
    });
    const b = claimRead(db, backoff, { fingerprint: fp(backoff), recompute: () => fp(backoff), nowMs: T0, modelId: "m" });
    if (b.kind !== "claimed") throw new Error();
    finalizeReadFailed(db, { readId: b.row.id, token: b.token, error: "e", errorCode: "model_error", nowMs: T0, retryable: true });

    const r = await reconcilePendingReads(db, T0);
    expect(r.scheduled).toEqual([crashed]);
    expect(r.checked).toBe(4);
    void expired;
    void old;
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS + 1);
    expect(runner).toHaveBeenCalledWith(db, crashed);
    // after the backoff, the failed print is scheduled too
    const r2 = await reconcilePendingReads(db, T0 + 61_000);
    expect(r2.scheduled).toEqual([backoff]);
  });

  it("a print whose fingerprint changed since its done read is scheduled again (merge / bogey edit / new document)", async () => {
    const today = todayET(new Date(T0));
    const p = seedPrint(today, "g");
    const d = claimRead(db, p, { fingerprint: "fp-old", recompute: () => "fp-old", nowMs: T0, modelId: "m" });
    if (d.kind !== "claimed") throw new Error();
    finalizeReadDone(db, { readId: d.row.id, token: d.token, facts: [], prose: PROSE, callouts: [], nowMs: T0 });
    _setSchedulerSeams({ runner: async () => undefined, now: () => T0, fingerprintFor: async () => "fp-new" });
    expect((await reconcilePendingReads(db, T0)).scheduled).toEqual([p]);
  });

  it("re-schedules a print whose dispatched run REJECTED, inside the ask-memory TTL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const today = todayET(new Date(T0));
    const p = seedPrint(today, "i");
    const runner = vi.fn(async () => {
      throw new Error("the model wire went down");
    });
    _setSchedulerSeams({ runner, now: () => T0, fingerprintFor: async () => "fp" });

    expect((await reconcilePendingReads(db, T0)).scheduled).toEqual([p]);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS + 1);
    expect(runner).toHaveBeenCalledTimes(1);
    // The ask never reached a row, so the next tick must ask again — even
    // though the fingerprint has not moved and the TTL has not expired.
    expect((await reconcilePendingReads(db, T0 + 61_000)).scheduled).toEqual([p]);
    warn.mockRestore();
  });

  it("a tick that cannot fingerprint the sheet forgets what it asked, so a re-accepted sheet is asked again (R-D18)", async () => {
    const today = todayET(new Date(T0));
    const p = seedPrint(today, "k");
    const runner = vi.fn(async () => undefined);
    let fp: string | null = "fp";
    _setSchedulerSeams({ runner, now: () => T0, fingerprintFor: async () => fp });

    expect((await reconcilePendingReads(db, T0)).scheduled).toEqual([p]);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS + 1);
    // The desk un-accepts the sheet inside the debounce window: the run skips
    // on no_facts and writes nothing, and the next tick has no fingerprint.
    fp = null;
    expect((await reconcilePendingReads(db, T0 + 60_000)).scheduled).toEqual([]);
    // Re-accepted. The SAME fingerprint must be asked for again rather than
    // stranded behind the dedupe memory until a restart.
    fp = "fp";
    expect((await reconcilePendingReads(db, T0 + 120_000)).scheduled).toEqual([p]);
  });

  it("re-asks once the ask-memory TTL expires, even when nothing else changed (R-D18: a dedupe, not a latch)", async () => {
    const today = todayET(new Date(T0));
    const p = seedPrint(today, "j");
    // Resolves without writing a row — the store's gate stays open.
    const runner = vi.fn(async () => undefined);
    _setSchedulerSeams({ runner, now: () => T0, fingerprintFor: async () => "fp" });

    expect((await reconcilePendingReads(db, T0)).scheduled).toEqual([p]);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS + 1);
    expect((await reconcilePendingReads(db, T0 + 61_000)).scheduled).toEqual([]);
    expect((await reconcilePendingReads(db, T0 + ASK_MEMORY_TTL_MS + 1)).scheduled).toEqual([p]);
  });

  it("does nothing at all — no query, no timer — while the scheduler is disabled", async () => {
    disableFirstPassScheduler();
    const prepare = vi.spyOn(db, "prepare");
    expect(await reconcilePendingReads(db, T0)).toEqual({ scheduled: [], checked: 0 });
    expect(prepare).not.toHaveBeenCalled();
    expect(__pendingReadTimers()).toEqual([]);
    prepare.mockRestore();
  });
});

describe("default seams (R-D22)", () => {
  it("resolve the real chain lazily: no eager import of ./read or ./first-pass-prompt, and the dynamic builder answers exactly as a direct import does", async () => {
    // The watcher imports this module. An eager import here pulled the AI
    // wrapper and the prompt builder into memory at watcher-import time.
    const src = fs.readFileSync("lib/print-watch/read-scheduler.ts", "utf8");
    expect(src).not.toMatch(/^import[^\n]*from "\.\/(read|first-pass-prompt)";/m);

    const today = todayET(new Date(T0));
    const withFacts = seedPrint(today, "lazy-facts");
    const noFacts = seedPrint(today, "lazy-empty");
    db.prepare(`DELETE FROM print_watch_lines WHERE print_id = ?`).run(noFacts);
    // A direct import is the oracle: a sheet with an accepted line has a
    // fingerprint, an empty one has none.
    expect((await buildFirstPassPrompt(db, withFacts))?.fingerprint).toEqual(expect.any(String));
    expect(await buildFirstPassPrompt(db, noFacts)).toBeNull();

    enableFirstPassScheduler();
    _setSchedulerSeams(null); // the real defaults, dynamic imports and all
    expect((await reconcilePendingReads(db, T0)).scheduled).toEqual([withFacts]);
    // Drop the armed debounce before it can fire the real runner.
    __resetSchedulerForTests();
  });
});

describe("armReconcileTimer", () => {
  it("is idempotent, unref'd, and ticks reconcile every 60 s once enabled", async () => {
    enableFirstPassScheduler();
    const today = todayET(new Date(T0));
    const p = seedPrint(today, "h");
    const runner = vi.fn(async () => undefined);
    _setSchedulerSeams({ runner, now: () => T0, fingerprintFor: async () => "fp" });
    armReconcileTimer(db);
    armReconcileTimer(db);
    await vi.advanceTimersByTimeAsync(READ_RECONCILE_EVERY_MS + READ_DEBOUNCE_MS + 2);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(db, p);
  });

  it("does nothing while the scheduler is disabled", () => {
    const si = vi.spyOn(globalThis, "setInterval");
    armReconcileTimer(db);
    expect(si).not.toHaveBeenCalled();
    si.mockRestore();
  });

  it("is armed by the first scheduleFirstPassRead, once across two calls (M5)", () => {
    // The email sweep's headless ensurePrintWatch never goes through the
    // ensure route, so the durable path has to self-arm off the first parse or
    // accept that hands the scheduler a db.
    enableFirstPassScheduler();
    const setInterval = vi.fn((_fn: () => void, _ms?: number) => 0);
    _setSchedulerSeams({ setInterval: setInterval as never, setTimeout: (() => 0) as never, clearTimeout: (() => undefined) as never });
    scheduleFirstPassRead(db, 11);
    scheduleFirstPassRead(db, 12);
    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(setInterval.mock.calls[0][1]).toBe(READ_RECONCILE_EVERY_MS);
  });
});
