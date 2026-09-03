/**
 * Slice C Task 5 — the durable "print is live" request.
 *
 * A press is a ROW, not a call. These tests pin the four properties that make
 * that true: nothing is written until the input and the event both validate; a
 * single immediate transaction carries the arm, the once-only forced stamp and
 * the request row together; the post-commit fan-out (prepare steps, outbox
 * drain, scheduler wake) can fail WITHOUT failing the press; and the claim/run
 * loop only ever writes under a token it still owns.
 *
 * Every date fixture is seeded relative to `todayET()` (worktree rule) and the
 * clock is a seam — no wall-clock sleeps, no literal dates that go stale.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { todayET } from "@/lib/calendar/date-utils";
import {
  requestGo,
  runGoRequest,
  extendGoWindow,
  mergePrintWatchGoState,
  safeErrorText,
  GoRefused,
  GO_STAGING_DIR_KEY,
  GO_CLAIM_HEARTBEAT_MS,
  PRINT_WATCH_GO_MERGE_HANDLER_NAME,
  type GoSeams,
} from "@/lib/print-watch/go";
import {
  getGoRequest,
  getPrintById,
  getPrintByEventId,
  upsertPrint,
  latestGoRequest,
  claimGoRequest,
  insertGoRequest,
  movePrintGoState,
  GO_MAX_ATTEMPTS,
  GO_CLAIM_STALE_MS,
} from "@/lib/print-watch/store";
import { effectiveWindow, extendedUntil, composeReleaseInstant, EXTEND_MS, FORCED_PRE_MS } from "@/lib/print-watch/window";
import { sha256Hex } from "@/lib/print-watch/delivery";
import { redactUrl } from "@/lib/print-watch/hardened-fetch";
import { registerPrintWatch, __resetRegisterForTests } from "@/lib/print-watch/register";
import {
  listEventMergeHandlers,
  mergeEarningsEventState,
  __resetEventMergeHandlersForTests,
} from "@/lib/earnings/event-merge";
import { __resetPrepareStepsForTests } from "@/lib/earnings/prepare-armed-event";
import { PRINT_WATCH_MERGE_HANDLER_NAME } from "@/lib/print-watch/merge-handler";
import type { RoadReport } from "@/lib/print-watch/types";

let db: Database.Database;

/** The event date is TODAY in ET; the press is an hour before a 16:05 print. */
const EVENT_DATE = todayET();
const RELEASE_MS = composeReleaseInstant(EVENT_DATE, "16:05")!.getTime();
const NOW = RELEASE_MS - 60 * 60_000;

function seedEvent(sourceKey = "go-ev", opts: { eventTime?: string | null; superseded?: 0 | 1 } = {}): number {
  const eventTime = opts.eventTime === undefined ? "16:05" : opts.eventTime;
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol, event_time, release_time, superseded)
         VALUES ('manual','earnings',?,'ACME',?,'ACME',?,?,?)`,
      )
      .run(EVENT_DATE, sourceKey, eventTime, eventTime, opts.superseded ?? 0).lastInsertRowid,
  );
}

interface FakeSeams extends GoSeams {
  calls: Record<string, unknown[][]>;
}

function fakeSeams(over: Partial<GoSeams> = {}): FakeSeams {
  const calls: Record<string, unknown[][]> = {
    writeBytes: [],
    readBytes: [],
    unlink: [],
    wake: [],
    ingest: [],
    deliverUrl: [],
    acquire: [],
    postCommit: [],
  };
  const seams: GoSeams = {
    now: () => NOW,
    resolveEvent: async () => ({ symbol: "ACME", eventDate: EVENT_DATE, releaseTimeEt: "16:05" }),
    writeBytes: async (dirKey, sha, ext) => {
      calls.writeBytes.push([dirKey, sha, ext]);
      return `/tmp/pw/${String(dirKey)}/${sha}.${ext}`;
    },
    readBytes: async (path) => {
      calls.readBytes.push([path]);
      return Buffer.from("<html>ACME</html>");
    },
    unlink: async (path) => {
      calls.unlink.push([path]);
    },
    wake: async (_db, printId) => {
      calls.wake.push([printId]);
    },
    postCommit: async (_db, eventId) => {
      calls.postCommit.push([eventId]);
    },
    ingest: async (_db, printId, kind, source) => {
      calls.ingest.push([printId, kind, source]);
      return { outcome: "parsed", docId: 41 };
    },
    deliverUrl: async (_db, printId, url) => {
      calls.deliverUrl.push([printId, url]);
      return { outcome: "rejected", detail: "wrong period" };
    },
    acquire: async (_db, printId) => {
      calls.acquire.push([printId]);
      return [
        { road: "dj", outcome: "skipped", detail: "TWS offline" },
        { road: "edgar", outcome: "ok", detail: "0 filings" },
        { road: "ir", outcome: "skipped", detail: "no IR page" },
      ] satisfies RoadReport[];
    },
    ...over,
  };
  return Object.assign(seams, { calls });
}

beforeEach(() => {
  // Own the registries: the tests below register print-watch's handlers by
  // hand, and the reset helpers also suppress A's lazy bootstrap so its four
  // real prepare steps are never added (and never RUN) under them.
  __resetEventMergeHandlersForTests();
  __resetPrepareStepsForTests();
  __resetRegisterForTests();
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  db.close();
  __resetEventMergeHandlersForTests();
  __resetPrepareStepsForTests();
  __resetRegisterForTests();
});

function isArmed(eventId: number): boolean {
  return (
    db.prepare(`SELECT 1 FROM earnings_worksheet_flags WHERE event_id = ?`).get(eventId) !== undefined
  );
}

describe("safeErrorText", () => {
  it("scrubs a signed URL and a home path, and caps the message", () => {
    const text = safeErrorText(
      new Error("fetch of https://ir.acme.example/q2?token=SECRET failed writing /Users/desk/data/pw/1/a.html"),
    );
    expect(text).not.toContain("SECRET");
    expect(text).toContain("https://ir.acme.example/q2");
    expect(text).toContain("<path>");
    expect(text).not.toContain("/Users/desk");
    expect(safeErrorText(new Error("x".repeat(900))).length).toBeLessThanOrEqual(500);
    expect(safeErrorText("plain string")).toBe("plain string");
  });
});

describe("requestGo", () => {
  it("arms, creates the print, stamps forced_open_at ONCE, inserts a queued request, and wakes", async () => {
    const eventId = seedEvent();
    const seams = fakeSeams();
    const ack = await requestGo(db, eventId, {}, seams);

    expect(isArmed(eventId)).toBe(true);
    expect(ack.newlyArmed).toBe(true);
    expect(ack.wakeError).toBeNull();
    const print = getPrintByEventId(db, eventId)!;
    expect(ack.printId).toBe(print.id);
    expect(ack.forcedOpenAt).toBe(new Date(NOW).toISOString());
    expect(print.forced_open_at).toBe(ack.forcedOpenAt);

    const req = getGoRequest(db, ack.requestId)!;
    expect(req).toMatchObject({ print_id: print.id, status: "queued", input_kind: "none", attempts: 0 });
    expect(req.input_url).toBeNull();
    expect(seams.calls.wake).toEqual([[print.id]]);
    expect(seams.calls.postCommit).toEqual([[eventId]]);

    // The window opened NOW: the forced term reaches 60 minutes back.
    const w = effectiveWindow(print)!;
    expect(w.startMs).toBe(NOW - FORCED_PRE_MS);

    // A second press: a new request row, the SAME stamp (spec §9 ruling 2).
    const again = await requestGo(db, eventId, {}, { ...seams, now: () => NOW + 10 * 60_000 });
    expect(again.forcedOpenAt).toBe(ack.forcedOpenAt);
    expect(again.requestId).not.toBe(ack.requestId);
    expect(again.newlyArmed).toBe(false);
    expect(getPrintByEventId(db, eventId)!.forced_open_at).toBe(ack.forcedOpenAt);
  });

  it("persists a pasted file content-addressed BEFORE acknowledging, with sha and path on the row", async () => {
    const eventId = seedEvent();
    const seams = fakeSeams();
    const html = Buffer.from("<html><body>ACME reports second quarter results</body></html>");
    const ack = await requestGo(
      db,
      eventId,
      { filename: "release.html", contentBase64: html.toString("base64") },
      seams,
    );
    const req = getGoRequest(db, ack.requestId)!;
    expect(req.input_kind).toBe("file");
    expect(req.input_sha256).toBe(sha256Hex(html));
    expect(req.input_bytes_path).toBe(`/tmp/pw/${GO_STAGING_DIR_KEY}/${sha256Hex(html)}.html`);
    // Staged under the staging key, never under a print id we do not have yet.
    expect(seams.calls.writeBytes[0]).toEqual([GO_STAGING_DIR_KEY, sha256Hex(html), "html"]);
    expect(seams.calls.unlink).toEqual([]);
  });

  it("stores a pasted URL and refuses a non-public or credential-bearing one before touching anything", async () => {
    const eventId = seedEvent();
    const seams = fakeSeams();
    const ack = await requestGo(db, eventId, { url: "https://ir.acme.example/q2?x=1" }, seams);
    const req = getGoRequest(db, ack.requestId)!;
    expect(req.input_kind).toBe("url");
    expect(req.input_url).toBe("https://ir.acme.example/q2?x=1");

    const refused = seedEvent("go-ev-refused");
    await expect(requestGo(db, refused, { url: "https://127.0.0.1/x" }, seams)).rejects.toBeInstanceOf(GoRefused);
    await expect(requestGo(db, refused, { url: "http://ir.acme.example/q2" }, seams)).rejects.toBeInstanceOf(GoRefused);
    // A credential-bearing link cannot be persisted honestly, so it is refused
    // at the press rather than stored redacted and fetched truncated.
    await expect(
      requestGo(db, refused, { url: "https://ir.acme.example/q2?token=SECRET&x=1" }, seams),
    ).rejects.toThrow(/secret-bearing/);
    expect(isArmed(refused)).toBe(false);
    expect(getPrintByEventId(db, refused)).toBeNull();
  });

  it("strips a fragment before storing and fetching, so a fragment-borne secret is never persisted (review I1)", async () => {
    const eventId = seedEvent();
    const seams = fakeSeams();
    const ack = await requestGo(
      db,
      eventId,
      { url: "https://ir.acme.example/q2?page=2#access_token=SECRET" },
      seams,
    );
    const req = getGoRequest(db, ack.requestId)!;
    expect(req.input_url).toBe("https://ir.acme.example/q2?page=2");
    expect(JSON.stringify(req)).not.toContain("SECRET");
    expect(JSON.stringify(req)).not.toContain("#");
    // And the fetch goes to that same fragment-free target.
    await runGoRequest(db, ack.requestId, seams);
    expect(seams.calls.deliverUrl).toEqual([[ack.printId, "https://ir.acme.example/q2?page=2"]]);
  });

  it("refuses a link carrying embedded credentials, in domain language, with the secret never echoed (review I1)", async () => {
    const eventId = seedEvent();
    const seams = fakeSeams();
    let message = "";
    try {
      await requestGo(db, eventId, { url: "https://desk:hunter2@ir.acme.example/q2" }, seams);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(GoRefused);
      message = (err as Error).message;
    }
    expect(message).toMatch(/credential/i);
    expect(message).not.toContain("hunter2");
    expect(isArmed(eventId)).toBe(false);
    expect(getPrintByEventId(db, eventId)).toBeNull();
  });

  it("accepts a long link with no secret in it and stores it IN FULL (review M3)", async () => {
    const eventId = seedEvent();
    const long = `https://ir.acme.example/newsroom/${"q".repeat(300)}?page=2`;
    expect(long.length).toBeGreaterThan(200);
    const seams = fakeSeams();
    const ack = await requestGo(db, eventId, { url: long }, seams);
    // Storage keeps the whole link — `redactUrl`'s 200-character cap is a
    // DISPLAY rule, and truncating what we fetch would send us elsewhere.
    expect(getGoRequest(db, ack.requestId)!.input_url).toBe(long);
    expect(redactUrl(long).length).toBeLessThan(long.length);
    await runGoRequest(db, ack.requestId, seams);
    expect(seams.calls.deliverUrl).toEqual([[ack.printId, long]]);
  });

  it("refuses both a url and a file, a binary file, an oversize file, and an event that cannot be resolved", async () => {
    const eventId = seedEvent();
    await expect(
      requestGo(db, eventId, { url: "https://ir.acme.example/q2", contentBase64: "aGk=" }, fakeSeams()),
    ).rejects.toThrow(/one of/);
    const binary = Buffer.alloc(64, 0);
    await expect(requestGo(db, eventId, { contentBase64: binary.toString("base64") }, fakeSeams())).rejects.toThrow(
      /binary/,
    );
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41);
    await expect(requestGo(db, eventId, { contentBase64: big.toString("base64") }, fakeSeams())).rejects.toThrow(
      /10 MB/,
    );
    await expect(requestGo(db, eventId, {}, fakeSeams({ resolveEvent: async () => null }))).rejects.toThrow(
      /superseded|not found|no earnings event/i,
    );
    expect(isArmed(eventId)).toBe(false);
    expect(getPrintByEventId(db, eventId)).toBeNull();
  });

  it("a refused press leaves NO state: nothing armed, no print, no request, and no staged bytes when the press never reaches the disk", async () => {
    const eventId = seedEvent();
    const html = Buffer.from("<html>ACME</html>");
    const seams = fakeSeams({ resolveEvent: async () => null });
    await expect(
      requestGo(db, eventId, { contentBase64: html.toString("base64") }, seams),
    ).rejects.toBeInstanceOf(GoRefused);
    // The event is resolved BEFORE anything is staged, so the refused press
    // never wrote a byte in the first place.
    expect(seams.calls.writeBytes).toEqual([]);
    expect(isArmed(eventId)).toBe(false);
    expect(getPrintByEventId(db, eventId)).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM print_watch_go_requests`).get()).toEqual({ n: 0 });
  });

  it("unlinks staged bytes when the transaction rolls back, and keeps bytes another row still owns", async () => {
    const eventId = seedEvent();
    const html = Buffer.from("<html>ACME rolls back</html>");
    const sha = sha256Hex(html);
    // The write seam runs between the resolve and the transaction: dooming the
    // event row here makes the arm's FK fail, so the transaction rolls back
    // with bytes already staged.
    const seams = fakeSeams({
      writeBytes: async (dirKey, s, ext) => {
        db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(eventId);
        return `/tmp/pw/${String(dirKey)}/${s}.${ext}`;
      },
    });
    await expect(requestGo(db, eventId, { contentBase64: html.toString("base64") }, seams)).rejects.toThrow();
    expect(seams.calls.unlink).toEqual([[`/tmp/pw/${GO_STAGING_DIR_KEY}/${sha}.html`]]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM print_watch_go_requests`).get()).toEqual({ n: 0 });

    // Same rollback, but a request row already points at those exact bytes:
    // the staged file is another row's evidence and must survive.
    const keeper = seedEvent("go-ev-keeper");
    const keeperSeams = fakeSeams();
    const first = await requestGo(db, keeper, { contentBase64: html.toString("base64") }, keeperSeams);
    expect(getGoRequest(db, first.requestId)!.input_bytes_path).toBe(
      `/tmp/pw/${GO_STAGING_DIR_KEY}/${sha}.html`,
    );
    const doomed = seedEvent("go-ev-doomed");
    const doomedSeams = fakeSeams({
      writeBytes: async (dirKey, s, ext) => {
        db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(doomed);
        return `/tmp/pw/${String(dirKey)}/${s}.${ext}`;
      },
    });
    await expect(
      requestGo(db, doomed, { contentBase64: html.toString("base64") }, doomedSeams),
    ).rejects.toThrow();
    expect(doomedSeams.calls.unlink).toEqual([]);
  });

  it("a wake that throws still acks with wakeError, and the row stays queued for the dispatcher", async () => {
    const eventId = seedEvent();
    const seams = fakeSeams({
      wake: async () => {
        throw new Error("scheduler is down at /Users/desk/code/x.ts");
      },
    });
    const ack = await requestGo(db, eventId, {}, seams);
    expect(ack.wakeError).toContain("scheduler is down");
    expect(ack.wakeError).not.toContain("/Users/desk");
    expect(getGoRequest(db, ack.requestId)!.status).toBe("queued");
    expect(getPrintByEventId(db, eventId)!.forced_open_at).toBe(ack.forcedOpenAt);
  });

  // The ONLY test in this file that pays for the watcher's module graph (the
  // default `resolveEvent` reaches `buildArmedEventDto` through the lazy
  // `import("./watcher")`, which pulls in TWS, the scheduler, the PDF and
  // extract lanes). That import measures ~1.4 s on an idle machine and this
  // file runs beside other agents' suites, where a 5x slowdown puts it past
  // Vitest's 5 s default and fails the test on nothing but load. An explicit,
  // generous timeout — not a retry, and no behaviour is timing-dependent.
  it("the DEFAULT resolveEvent reads calendar_events by id: refuses a missing or superseded row, resolves a live one", async () => {
    const live = seedEvent("go-ev-live");
    const seams = fakeSeams();
    const { resolveEvent, ...rest } = seams; // exercise the real resolver
    void resolveEvent;
    const ack = await requestGo(db, live, {}, rest);
    const print = getPrintByEventId(db, live)!;
    expect(print.symbol).toBe("ACME");
    expect(print.event_date).toBe(EVENT_DATE);
    expect(print.release_time_et).toBe("16:05");
    expect(ack.printId).toBe(print.id);

    const superseded = seedEvent("go-ev-superseded", { superseded: 1 });
    await expect(requestGo(db, superseded, {}, rest)).rejects.toBeInstanceOf(GoRefused);
    await expect(requestGo(db, 999_999, {}, rest)).rejects.toBeInstanceOf(GoRefused);
    expect(isArmed(superseded)).toBe(false);
  }, 30_000);
});

describe("runGoRequest", () => {
  it("claims, runs the input road then a forced pass, and finalises done with one report per road", async () => {
    const eventId = seedEvent();
    const seams = fakeSeams();
    const html = Buffer.from("<html>ACME</html>");
    const ack = await requestGo(db, eventId, { contentBase64: html.toString("base64") }, seams);

    const runSeams = fakeSeams({ readBytes: async () => html });
    const row = (await runGoRequest(db, ack.requestId, runSeams))!;
    expect(row.status).toBe("done");
    expect(row.attempts).toBe(1);
    expect(row.claim_token).toBeNull();
    expect(row.finished_at).toBe(new Date(NOW).toISOString());
    const reports = JSON.parse(row.result_json!) as RoadReport[];
    expect(reports.map((r) => r.road)).toEqual(["user-drop", "dj", "edgar", "ir"]);
    expect(reports[0]).toMatchObject({ road: "user-drop", outcome: "parsed" });
    expect(runSeams.calls.ingest).toEqual([[ack.printId, "user-drop", `go:${sha256Hex(html)}`]]);
    expect(runSeams.calls.acquire).toEqual([[ack.printId]]);
  });

  it("a URL input runs deliverFromUrl on the STORED url (which IS what the desk pasted)", async () => {
    const eventId = seedEvent();
    const seams = fakeSeams();
    const ack = await requestGo(db, eventId, { url: "https://ir.acme.example/q2?page=2" }, seams);
    const row = (await runGoRequest(db, ack.requestId, seams))!;
    expect(seams.calls.deliverUrl).toEqual([[ack.printId, "https://ir.acme.example/q2?page=2"]]);
    const reports = JSON.parse(row.result_json!) as RoadReport[];
    expect(reports[0]).toMatchObject({ road: "user-url", outcome: "rejected", detail: "wrong period" });
    expect(reports.map((r) => r.road)).toEqual(["user-url", "dj", "edgar", "ir"]);
  });

  it("a lost claim returns null and changes nothing", async () => {
    const eventId = seedEvent();
    const seams = fakeSeams();
    const ack = await requestGo(db, eventId, {}, seams);
    expect(claimGoRequest(db, ack.requestId, "someone-else", NOW)).toBe(true);
    expect(await runGoRequest(db, ack.requestId, seams)).toBeNull();
    const row = getGoRequest(db, ack.requestId)!;
    expect(row.status).toBe("claimed");
    expect(row.claim_token).toBe("someone-else");
    expect(row.attempts).toBe(1);
    expect(seams.calls.acquire).toEqual([]);
  });

  it("an ordinary failure requeues with attempts kept; the attempt at the cap finalises failed", async () => {
    const eventId = seedEvent();
    const ack = await requestGo(db, eventId, {}, fakeSeams());
    const boom = () =>
      fakeSeams({
        acquire: async () => {
          throw new Error("scheduler exploded");
        },
      });

    for (let attempt = 1; attempt < GO_MAX_ATTEMPTS; attempt += 1) {
      const row = (await runGoRequest(db, ack.requestId, boom()))!;
      expect(row.status).toBe("queued");
      expect(row.attempts).toBe(attempt);
      expect(row.claim_token).toBeNull();
      const reports = JSON.parse(row.result_json!) as RoadReport[];
      expect(reports.at(-1)).toMatchObject({ road: "system", outcome: "failed" });
      expect(reports.at(-1)!.detail).toContain("scheduler exploded");
    }
    const final = (await runGoRequest(db, ack.requestId, boom()))!;
    expect(final.status).toBe("failed");
    expect(final.attempts).toBe(GO_MAX_ATTEMPTS);
    expect(final.result_json).toContain("scheduler exploded");
    expect(final.finished_at).not.toBeNull();
    // Spent: nothing may claim it again.
    expect(await runGoRequest(db, ack.requestId, fakeSeams())).toBeNull();
  });

  it("a claim lost mid-run (a merge re-homed the row) stops the worker before the fan-out pass", async () => {
    const donorEvent = seedEvent("go-d");
    const targetEvent = seedEvent("go-t");
    const seams = fakeSeams();
    const ack = await requestGo(db, donorEvent, { url: "https://ir.acme.example/q2" }, seams);
    const targetPrintId = upsertPrint(db, targetEvent, "ACME", EVENT_DATE, "16:05");

    const stealing = fakeSeams({
      deliverUrl: async (_db, printId, url) => {
        // A merge lands while the road is in flight: the row is repointed and
        // its claim invalidated.
        movePrintGoState(db, ack.printId, targetPrintId);
        return { outcome: "parsed", detail: `fetched ${url} for print ${printId}` };
      },
    });
    expect(await runGoRequest(db, ack.requestId, stealing)).toBeNull();
    expect(stealing.calls.acquire).toEqual([]);
    const row = getGoRequest(db, ack.requestId)!;
    expect(row.print_id).toBe(targetPrintId);
    expect(row.status).toBe("queued");
    expect(row.claim_token).toBeNull();
  });

  it("renews the claim while a long pass runs, so a second worker cannot steal it mid-fetch (review I2)", async () => {
    vi.useFakeTimers();
    try {
      const eventId = seedEvent();
      const ack = await requestGo(db, eventId, {}, fakeSeams());
      let clock = NOW;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let passStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        passStarted = resolve;
      });
      const seams = fakeSeams({
        now: () => clock,
        acquire: async (_db, printId) => {
          passStarted();
          await gate;
          return [{ road: "dj", outcome: "ok", detail: `print ${printId}` }];
        },
      });
      const run = runGoRequest(db, ack.requestId, seams);
      await started; // the run IS inside the fan-out pass — not "probably, by now"

      for (let beat = 0; beat < 7; beat += 1) {
        clock += GO_CLAIM_HEARTBEAT_MS;
        await vi.advanceTimersByTimeAsync(GO_CLAIM_HEARTBEAT_MS);
      }
      expect(clock - NOW).toBeGreaterThan(2 * GO_CLAIM_STALE_MS);
      // Every beat renewed the claim: the row carries the LAST beat's instant.
      expect(getGoRequest(db, ack.requestId)!.claimed_at).toBe(new Date(clock).toISOString());
      // Without the renewal this row would look abandoned and be taken.
      expect(claimGoRequest(db, ack.requestId, "second-worker", clock)).toBe(false);

      release();
      const row = (await run)!;
      expect(row.status).toBe("done");
      expect(row.attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a claim stolen mid-pass aborts the in-flight work and finalises nothing (review I2)", async () => {
    vi.useFakeTimers();
    try {
      const eventId = seedEvent();
      const ack = await requestGo(db, eventId, {}, fakeSeams());
      let clock = NOW;
      let aborted = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let passStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        passStarted = resolve;
      });
      const seams = fakeSeams({
        now: () => clock,
        acquire: async (_db, _printId, signal) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
          });
          passStarted();
          await gate;
          return [];
        },
      });
      const run = runGoRequest(db, ack.requestId, seams);
      await started; // the abort listener is attached before anything can abort

      // Someone else takes the row (a stale-claim takeover, or a merge).
      db.prepare(`UPDATE print_watch_go_requests SET claim_token = 'thief' WHERE id = ?`).run(ack.requestId);
      clock += GO_CLAIM_HEARTBEAT_MS;
      await vi.advanceTimersByTimeAsync(GO_CLAIM_HEARTBEAT_MS);

      expect(await run).toBeNull();
      expect(aborted).toBe(true);
      const row = getGoRequest(db, ack.requestId)!;
      expect(row.claim_token).toBe("thief");
      expect(row.status).toBe("claimed");
      expect(row.result_json).toBeNull();
      expect(row.finished_at).toBeNull();
      release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a heartbeat that THROWS ends the run instead of escaping the timer (re-review)", async () => {
    vi.useFakeTimers();
    try {
      const eventId = seedEvent();
      const ack = await requestGo(db, eventId, {}, fakeSeams());
      let clock = NOW;
      let aborted = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let passStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        passStarted = resolve;
      });
      const seams = fakeSeams({
        now: () => clock,
        acquire: async (_db, _printId, signal) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
          });
          passStarted();
          await gate;
          return [];
        },
      });
      const run = runGoRequest(db, ack.requestId, seams);
      await started; // the abort listener is attached before anything can abort

      // The handle goes bad under a detached run — a locked DB in production,
      // a raising trigger here. The heartbeat's UPDATE now throws.
      db.exec(
        `CREATE TRIGGER go_hb_boom BEFORE UPDATE OF claimed_at ON print_watch_go_requests
         BEGIN SELECT RAISE(ABORT, 'database is locked'); END`,
      );
      clock += GO_CLAIM_HEARTBEAT_MS;
      // If the callback let the error escape, THIS is where it would surface
      // as an uncaught exception (in production it would take the process).
      let escaped: unknown = null;
      try {
        await vi.advanceTimersByTimeAsync(GO_CLAIM_HEARTBEAT_MS);
      } catch (err) {
        escaped = err;
      }
      expect(escaped).toBeNull();

      expect(await run).toBeNull();
      expect(aborted).toBe(true);
      const row = getGoRequest(db, ack.requestId)!;
      expect(row.status).toBe("claimed"); // nothing finalised, nothing requeued
      expect(row.result_json).toBeNull();
      expect(row.finished_at).toBeNull();
      expect(row.attempts).toBe(1);
      release();
      db.exec(`DROP TRIGGER go_hb_boom`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an incoherent input row fails loudly instead of finalising done (review M5)", async () => {
    const eventId = seedEvent();
    const ack = await requestGo(db, eventId, {}, fakeSeams());
    db.prepare(
      `UPDATE print_watch_go_requests SET input_kind = 'file', input_sha256 = 'deadbeef', input_bytes_path = '' WHERE id = ?`,
    ).run(ack.requestId);
    const seams = fakeSeams();
    const row = (await runGoRequest(db, ack.requestId, seams))!;
    expect(seams.calls.ingest).toEqual([]);
    expect(seams.calls.acquire).toEqual([]);
    const reports = JSON.parse(row.result_json!) as RoadReport[];
    expect(reports[0]).toMatchObject({ road: "system", outcome: "failed" });
    expect(reports[0].detail).toContain("incoherent");
  });

  it("re-verifies the staged file's SHA: bytes that changed on disk fail the run with a system report", async () => {
    const eventId = seedEvent();
    const html = Buffer.from("<html>ACME</html>");
    const ack = await requestGo(db, eventId, { contentBase64: html.toString("base64") }, fakeSeams());
    const tampered = fakeSeams({ readBytes: async () => Buffer.from("<html>NOT ACME</html>") });
    const row = (await runGoRequest(db, ack.requestId, tampered))!;
    expect(tampered.calls.ingest).toEqual([]);
    expect(tampered.calls.acquire).toEqual([]);
    const reports = JSON.parse(row.result_json!) as RoadReport[];
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ road: "system", outcome: "failed" });
    expect(reports[0].detail).toContain("changed on disk");
  });
});

describe("extendGoWindow", () => {
  it("writes max(now, current end) + 30m, stacks on a repeat press, and a repeat GO never extends", async () => {
    const eventId = seedEvent();
    const seams = fakeSeams();
    const ack = await requestGo(db, eventId, {}, seams);
    const before = effectiveWindow(getPrintById(db, ack.printId)!)!;

    const first = extendGoWindow(db, eventId, NOW);
    expect(Date.parse(first.windowExtendedUntil)).toBe(before.endMs + EXTEND_MS);
    expect(first.printId).toBe(ack.printId);
    expect(first.effectiveWindow!.end).toBe(first.windowExtendedUntil);

    const second = extendGoWindow(db, eventId, NOW);
    expect(Date.parse(second.windowExtendedUntil)).toBe(before.endMs + 2 * EXTEND_MS);
    expect(getPrintById(db, ack.printId)!.window_extended_until).toBe(second.windowExtendedUntil);

    await requestGo(db, eventId, {}, { ...seams, now: () => NOW + 60_000 });
    expect(getPrintById(db, ack.printId)!.window_extended_until).toBe(second.windowExtendedUntil);

    expect(() => extendGoWindow(db, 999_999, NOW)).toThrow(GoRefused);
  });

  it("an extension from a later clock floors on now, not on an end that has already passed", async () => {
    const eventId = seedEvent();
    const ack = await requestGo(db, eventId, {}, fakeSeams());
    const print = getPrintById(db, ack.printId)!;
    const late = effectiveWindow(print)!.endMs + 5 * 60_000;
    const out = extendGoWindow(db, eventId, late);
    expect(out.windowExtendedUntil).toBe(extendedUntil(effectiveWindow(print), late));
    expect(Date.parse(out.windowExtendedUntil)).toBe(late + EXTEND_MS);
  });
});

describe("mergePrintWatchGoState", () => {
  it("both prints: go rows follow the target, earliest stamp / latest extension carried; re-home is a no-op", async () => {
    const donorEvent = seedEvent("go-d");
    const targetEvent = seedEvent("go-t");
    const seams = fakeSeams();
    const donorAck = await requestGo(db, donorEvent, {}, seams);
    const targetPrintId = upsertPrint(db, targetEvent, "ACME", EVENT_DATE, "16:05");

    const out = mergePrintWatchGoState({ db, donorEventId: donorEvent, targetEventId: targetEvent });
    const goTable = out.find((t) => t.table === "print_watch_go_requests")!;
    expect(goTable.moved).toBe(1);
    expect(latestGoRequest(db, targetPrintId)!.id).toBe(donorAck.requestId);
    expect(getPrintById(db, targetPrintId)!.forced_open_at).toBe(donorAck.forcedOpenAt);

    // Re-home (the target has no print of its own): B moves the print itself,
    // so the go rows are already attached to the surviving row.
    const donor2 = seedEvent("go-d2");
    const target2 = seedEvent("go-t2");
    await requestGo(db, donor2, {}, seams);
    expect(mergePrintWatchGoState({ db, donorEventId: donor2, targetEventId: target2 })).toEqual([]);
  });

  it("R-C7: registered AHEAD of B's handler, so B's donor-print delete never hits the go-row FK", async () => {
    registerPrintWatch();
    expect(listEventMergeHandlers()).toEqual([
      PRINT_WATCH_GO_MERGE_HANDLER_NAME,
      PRINT_WATCH_MERGE_HANDLER_NAME,
    ]);

    const donorEvent = seedEvent("go-d");
    const targetEvent = seedEvent("go-t");
    const seams = fakeSeams();
    const queued = await requestGo(db, donorEvent, {}, seams);
    const donorPrintId = queued.printId;
    // A second row on the donor, IN FLIGHT under someone's token.
    const claimed = insertGoRequest(db, {
      printId: donorPrintId,
      inputKind: "none",
      inputUrl: null,
      inputSha256: null,
      inputBytesPath: null,
      requestedAt: new Date(NOW).toISOString(),
    });
    expect(claimGoRequest(db, claimed, "in-flight", NOW)).toBe(true);
    const targetPrintId = upsertPrint(db, targetEvent, "ACME", EVENT_DATE, "16:05");

    const report = db.transaction(() => mergeEarningsEventState(db, donorEvent, targetEvent))();
    expect(report.handlers.map((h) => h.name)).toEqual([
      "builtin:worksheet_flags",
      "builtin:prepare_steps",
      "builtin:bogey_scans",
      "builtin:bogeys",
      "builtin:email_audit",
      PRINT_WATCH_GO_MERGE_HANDLER_NAME,
      PRINT_WATCH_MERGE_HANDLER_NAME,
    ]);
    // B deleted the donor print — only possible because C repointed the go rows first.
    expect(getPrintById(db, donorPrintId)).toBeNull();
    expect(getGoRequest(db, queued.requestId)).toMatchObject({ print_id: targetPrintId, status: "queued" });
    const invalidated = getGoRequest(db, claimed)!;
    expect(invalidated).toMatchObject({ print_id: targetPrintId, status: "queued" });
    expect(invalidated.claim_token).toBeNull();
    expect(getPrintById(db, targetPrintId)!.forced_open_at).toBe(queued.forcedOpenAt);
  });
});
