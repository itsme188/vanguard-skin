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
