/**
 * Live print v2 slice B, Task 12 — the `ir_baseline` prepare step.
 *
 * The step runs at ARM time and records what the stored IR page already
 * carries, so the window poll can treat only LATER links as tonight's print.
 * Registration is NOT tested here (the step never registers itself — the
 * earnings bootstrap owns that, Task 13); this file drives the definition
 * directly, with the network behind the `fetchBytes` seam.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  upsertPrintWatchSource,
  listIrSeenLinks,
  hasIrBaseline,
  getIrBaseline,
  upsertPrint,
  stampForcedOpen,
} from "@/lib/print-watch/store";
import {
  buildIrBaselineStep,
  irBaselineFingerprint,
  IR_BASELINE_STEP,
  IR_BASELINE_STEP_NAME,
} from "@/lib/print-watch/ir-baseline-step";
import { stableHash, type PrepareStepContext } from "@/lib/earnings/prepare-armed-event";
import type { FetchedBytes, HardenedFetchBytesOptions } from "@/lib/print-watch/url-fetch";

let db: Database.Database;
let eventId: number;
const URL1 = "https://ir.acme.example/news";
const URL2 = "https://ir.acme.example/press-releases";
const PAGE = `<a href="/news/acme-q2-2026-results">Acme Reports Q2 2026 Results</a>`;
const BASELINED_LINK = "https://ir.acme.example/news/acme-q2-2026-results";

/** The real runner always supplies BOTH fields (prepare-armed-event.ts). */
function ctx(signal: AbortSignal = new AbortController().signal): PrepareStepContext {
  return { now: () => 0, signal };
}

/** The same context at a NAMED instant — what the window guard reads. */
function ctxAt(nowMs: number, signal: AbortSignal = new AbortController().signal): PrepareStepContext {
  return { now: () => nowMs, signal };
}

// The seeded event is 2026-09-10 (EDT, UTC−4). An AMC release at 16:15 ET is
// 20:15Z, so the scheduled window opens at 20:05Z.
const RELEASE_TIME_ET = "16:15";
const BEFORE_WINDOW_MS = Date.parse("2026-09-10T12:00:00Z"); // 08:00 ET — hours early
const PRESS_MS = Date.parse("2026-09-10T20:06:00Z"); // 16:06 ET — a minute past the print

function server(
  body: string,
  finalUrl: string,
): (url: string, opts: HardenedFetchBytesOptions) => Promise<FetchedBytes> {
  return async () => ({
    bytes: Buffer.from(body, "utf8"),
    finalUrl,
    status: 200,
    contentType: "text/html",
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  eventId = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
         VALUES ('manual','earnings','2026-09-10','ACME','k','ACME')`,
      )
      .run().lastInsertRowid,
  );
});

afterEach(() => {
  db.close();
});

describe("ir_baseline prepare step", () => {
  it("is named, and the default export is the seam-free build", () => {
    expect(IR_BASELINE_STEP_NAME).toBe("ir_baseline");
    expect(typeof IR_BASELINE_STEP.fingerprint).toBe("function");
    expect(typeof IR_BASELINE_STEP.run).toBe("function");
  });

  it("fingerprint is the hash of the configured IR page URL (null when none)", () => {
    const step = buildIrBaselineStep();
    expect(step.fingerprint(db, eventId)).toBe(stableHash([null]));
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL1, linkMustContain: null });
    expect(step.fingerprint(db, eventId)).toBe(stableHash([URL1]));
    // Single-sourced so the watcher lane's `hasIrBaseline` check cannot drift.
    expect(irBaselineFingerprint(URL1)).toBe(stableHash([URL1]));
    expect(irBaselineFingerprint(null)).toBe(stableHash([null]));
  });

  it("is PENDING when no IR page is configured — that is a precondition, not an attempt", async () => {
    const fetchBytes = vi.fn(server(PAGE, URL1));
    const step = buildIrBaselineStep({ fetchBytes });
    await expect(step.run(db, eventId, ctx())).resolves.toEqual({
      status: "pending",
      reason: "no IR page configured for ACME",
    });
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(getIrBaseline(db, eventId)).toBeNull();
  });

  it("records ONE atomic baseline (links + marker) and never re-takes it", async () => {
    const fetchBytes = vi.fn(server(PAGE, URL1));
    const step = buildIrBaselineStep({ fetchBytes });
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL1, linkMustContain: null });

    await expect(step.run(db, eventId, ctx())).resolves.toEqual({
      status: "done",
      note: "1 link(s) baselined",
    });
    expect(listIrSeenLinks(db, eventId)).toEqual([{ link: BASELINED_LINK, baseline: true }]);
    expect(hasIrBaseline(db, eventId, stableHash([URL1]))).toBe(true);
    expect(getIrBaseline(db, eventId)).toMatchObject({
      source_fingerprint: stableHash([URL1]),
      link_count: 1,
    });

    // A late "go" re-runs the step; it must NOT re-baseline (the page has moved on).
    await expect(step.run(db, eventId, ctx())).resolves.toEqual({
      status: "done",
      note: "baseline already recorded",
    });
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });

  it("an empty page is a COMPLETE baseline (0 links), not a retry", async () => {
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL1, linkMustContain: null });
    const step = buildIrBaselineStep({ fetchBytes: vi.fn(server("<html><body>nothing</body></html>", URL1)) });
    await expect(step.run(db, eventId, ctx())).resolves.toEqual({
      status: "done",
      note: "0 link(s) baselined",
    });
    expect(getIrBaseline(db, eventId)).toMatchObject({ link_count: 0 });
    expect(hasIrBaseline(db, eventId, stableHash([URL1]))).toBe(true);
  });

  it("a changed IR URL is a NEW baseline (the old marker no longer short-circuits)", async () => {
    const fetchBytes = vi.fn(server(PAGE, URL2));
    const step = buildIrBaselineStep({ fetchBytes });
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL1, linkMustContain: null });
    await step.run(db, eventId, ctx());
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL2, linkMustContain: null });
    expect(hasIrBaseline(db, eventId, stableHash([URL2]))).toBe(false);
    await expect(step.run(db, eventId, ctx())).resolves.toEqual({
      status: "done",
      note: "1 link(s) baselined",
    });
    expect(getIrBaseline(db, eventId)?.source_fingerprint).toBe(stableHash([URL2]));
    expect(fetchBytes).toHaveBeenCalledTimes(2);
  });

  it("passes the IR-host allowlist into every fetch (a redirect off the IR/wire hosts is refused)", async () => {
    const fetchBytes = vi.fn(async (_url: string, opts: HardenedFetchBytesOptions) => {
      expect(opts.allowHost?.("ir.acme.example")).toBe(true);
      expect(opts.allowHost?.("www.businesswire.com")).toBe(true);
      expect(opts.allowHost?.("evil.example")).toBe(false);
      return {
        bytes: Buffer.from(PAGE, "utf8"),
        finalUrl: URL1,
        status: 200,
        contentType: "text/html",
      };
    });
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL1, linkMustContain: null });
    await buildIrBaselineStep({ fetchBytes }).run(db, eventId, ctx());
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });

  // Task 12 ruling. The runner races each invocation against its own deadline
  // and aborts the one it gave up on; unless that signal reaches the socket,
  // a hung newsroom holds the fetch open for the rest of its 20-second budget
  // while the successor invocation is already running.
  it("forwards the runner's abort signal to the fetch", async () => {
    const controller = new AbortController();
    const fetchBytes = vi.fn(async (_url: string, opts: HardenedFetchBytesOptions) => {
      expect(opts.signal).toBe(controller.signal);
      return {
        bytes: Buffer.from(PAGE, "utf8"),
        finalUrl: URL1,
        status: 200,
        contentType: "text/html",
      };
    });
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL1, linkMustContain: null });
    const out = await buildIrBaselineStep({ fetchBytes }).run(db, eventId, ctx(controller.signal));
    expect(out.status).toBe("done");
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });

  it("a fetch failure is a failed attempt, not a baseline", async () => {
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL1, linkMustContain: null });
    const step = buildIrBaselineStep({
      fetchBytes: vi.fn(async () => {
        throw new Error("t: HTTP 503 for https://ir.acme.example/news");
      }),
    });
    await expect(step.run(db, eventId, ctx())).resolves.toMatchObject({
      status: "failed",
      error: expect.stringMatching(/503/),
    });
    expect(hasIrBaseline(db, eventId, stableHash([URL1]))).toBe(false);
    expect(getIrBaseline(db, eventId)).toBeNull();
    expect(listIrSeenLinks(db, eventId)).toEqual([]);
  });

  it("a failure message carries only the REDACTED IR url — never the stored token", async () => {
    const secretUrl = "https://ir.acme.example/news?api_key=SUPERSECRET";
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: secretUrl, linkMustContain: null });
    const step = buildIrBaselineStep({
      fetchBytes: vi.fn(async () => {
        throw new Error(`connect ETIMEDOUT for ${secretUrl}`);
      }),
    });
    const outcome = await step.run(db, eventId, ctx());
    expect(outcome.status).toBe("failed");
    expect(JSON.stringify(outcome)).not.toContain("SUPERSECRET");
  });

  it("an already-aborted invocation neither fetches nor baselines (R13)", async () => {
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL1, linkMustContain: null });
    const fetchBytes = vi.fn(server(PAGE, URL1));
    const controller = new AbortController();
    controller.abort();
    await expect(buildIrBaselineStep({ fetchBytes }).run(db, eventId, ctx(controller.signal))).resolves.toEqual({
      status: "pending",
      reason: "aborted",
    });
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(getIrBaseline(db, eventId)).toBeNull();
  });

  it("an abort that lands WHILE the page is in flight books nothing (the runner already moved on)", async () => {
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL1, linkMustContain: null });
    const controller = new AbortController();
    const fetchBytes = vi.fn(async () => {
      controller.abort();
      return {
        bytes: Buffer.from(PAGE, "utf8"),
        finalUrl: URL1,
        status: 200,
        contentType: "text/html",
      };
    });
    await expect(
      buildIrBaselineStep({ fetchBytes }).run(db, eventId, ctx(controller.signal)),
    ).resolves.toEqual({ status: "pending", reason: "aborted" });
    expect(getIrBaseline(db, eventId)).toBeNull();
    expect(listIrSeenLinks(db, eventId)).toEqual([]);
  });

  it("honours the stored link_must_contain filter when taking the baseline", async () => {
    upsertPrintWatchSource(db, {
      symbol: "ACME",
      irPageUrl: URL1,
      linkMustContain: "Nothing Matches This",
    });
    const step = buildIrBaselineStep({ fetchBytes: vi.fn(server(PAGE, URL1)) });
    await expect(step.run(db, eventId, ctx())).resolves.toEqual({
      status: "done",
      note: "0 link(s) baselined",
    });
  });

  it("is PENDING for an event with no symbol at all", async () => {
    const noSymbol = Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, source_key)
           VALUES ('manual','earnings','2026-09-10','No symbol','k2')`,
        )
        .run().lastInsertRowid,
    );
    const fetchBytes = vi.fn(server(PAGE, URL1));
    await expect(buildIrBaselineStep({ fetchBytes }).run(db, noSymbol, ctx())).resolves.toMatchObject({
      status: "pending",
    });
    expect(fetchBytes).not.toHaveBeenCalled();
  });
});

/**
 * C1 / ruling R-C15 — a press that ARMS the event at the print minute enqueues
 * these steps, and the page it would baseline already carries tonight's
 * release. Recording that link as `baseline = 1` is durable and silent: every
 * runtime the watcher builds seeds `seenIrLinks` from `print_watch_ir_seen`,
 * so the release is filtered out of every poll for the rest of the night while
 * the lane reads "ok — N matching links, 0 new".
 */
describe("ir_baseline × an already-open window", () => {
  /** The page a newsroom serves once the release is posted. */
  const LIVE_PAGE = PAGE;

  function seedPress(nowMs: number): number {
    const printId = upsertPrint(db, eventId, "ACME", "2026-09-10", RELEASE_TIME_ET);
    stampForcedOpen(db, printId, new Date(nowMs).toISOString());
    return printId;
  }

  it("a press from ANOTHER process records no baseline, so the lane still sees tonight's link", async () => {
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL1, linkMustContain: null });
    // The press happened on :3000; this process (the lease owner's prepare
    // pass) only ever sees the ROW it left behind.
    seedPress(PRESS_MS);

    const fetchBytes = vi.fn(server(LIVE_PAGE, URL1));
    await expect(buildIrBaselineStep({ fetchBytes }).run(db, eventId, ctxAt(PRESS_MS))).resolves.toEqual({
      status: "done",
      note: "window already open — no baseline possible",
    });

    // Nothing fetched, nothing recorded, no marker — a runtime built after
    // this seeds an EMPTY seen-set and the period gate does the filtering.
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(listIrSeenLinks(db, eventId)).toEqual([]);
    expect(getIrBaseline(db, eventId)).toBeNull();
    expect(hasIrBaseline(db, eventId, stableHash([URL1]))).toBe(false);
  });

  it("the same press hours BEFORE the window still baselines (the pre-window arm is unchanged)", async () => {
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL1, linkMustContain: null });
    // Armed in the morning: a print row and a scheduled release still hours
    // away, no forced stamp. Whatever is on the page now IS history.
    upsertPrint(db, eventId, "ACME", "2026-09-10", RELEASE_TIME_ET);

    const fetchBytes = vi.fn(server(PAGE, URL1));
    await expect(
      buildIrBaselineStep({ fetchBytes }).run(db, eventId, ctxAt(BEFORE_WINDOW_MS)),
    ).resolves.toEqual({ status: "done", note: "1 link(s) baselined" });
    expect(listIrSeenLinks(db, eventId)).toEqual([{ link: BASELINED_LINK, baseline: true }]);
    expect(hasIrBaseline(db, eventId, stableHash([URL1]))).toBe(true);
  });

  it("the in-process race: a stamp written between enqueue and run is honoured (the row is read at RUN time)", async () => {
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL1, linkMustContain: null });
    upsertPrint(db, eventId, "ACME", "2026-09-10", RELEASE_TIME_ET);

    const fetchBytes = vi.fn(server(LIVE_PAGE, URL1));
    const step = buildIrBaselineStep({ fetchBytes });
    // The runner fingerprints the row when it enqueues/claims it…
    expect(step.fingerprint(db, eventId)).toBe(stableHash([URL1]));
    // …and the press lands in the gap before the invocation actually runs.
    seedPress(PRESS_MS);

    await expect(step.run(db, eventId, ctxAt(PRESS_MS + 500))).resolves.toEqual({
      status: "done",
      note: "window already open — no baseline possible",
    });
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(listIrSeenLinks(db, eventId)).toEqual([]);
  });

  it("a window that has already CLOSED never baselines either (an extension or a re-press would inherit it)", async () => {
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL1, linkMustContain: null });
    seedPress(PRESS_MS);
    const fetchBytes = vi.fn(server(LIVE_PAGE, URL1));
    // Three hours after the press: forced + 90m is long past.
    await expect(
      buildIrBaselineStep({ fetchBytes }).run(db, eventId, ctxAt(PRESS_MS + 3 * 60 * 60_000)),
    ).resolves.toEqual({ status: "done", note: "window already open — no baseline possible" });
    expect(listIrSeenLinks(db, eventId)).toEqual([]);
  });
});
