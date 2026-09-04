import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { upsertPrint, upsertLines } from "@/lib/print-watch/store";
import { listReads, claimRead, finalizeReadDone, finalizeReadFailed, READ_RETRY_BACKOFF_MS } from "@/lib/print-watch/read-store";
import { _setReadSeams } from "@/lib/print-watch/read";
import {
  enableFirstPassScheduler,
  disableFirstPassScheduler,
  _setSchedulerSeams,
  __pendingReadTimers,
  __resetSchedulerForTests,
} from "@/lib/print-watch/read-scheduler";
import { classifyRoute } from "@/lib/auth/route-policy";
import { decideRequest } from "@/lib/auth/verify-request";
import type { PrintWatchLine } from "@/lib/print-watch/types";

const hoisted = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("@/lib/db", () => ({ get db() { return hoisted.db; } }));
vi.mock("@/lib/ai/generate", () => ({ generateObjectForFeature: vi.fn(async () => { throw new Error("SDK must never be reached"); }) }));
vi.mock("@/lib/ai/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/models")>();
  return { ...actual, resolveFeatureModel: () => ({ provider: "anthropic", modelId: "test-model-1" }) };
});

let db: Database.Database; let eventId: number; let printId: number; let docId: number;
const T0 = Date.parse("2026-09-10T20:06:00Z");
const PROSE = { read: ["1", "2", "3", "4", "5", "6"], call_watch: ["a", "b", "c"], caveats: [] };

function line(): PrintWatchLine {
  return { metric_id: "revenue_q", contract: { metric_id: "revenue_q", label: "Revenue", definition: "d", basis: "na", period: "Q", currency: "USD", unit: "usd", kind: "point", segment: null }, expected: { value: 877.3e6, value_high: null, whisper: null, source_label: "VK" }, state: "accepted", value: 898.2e6, value_high: null, snippet: null, source_doc_id: null, candidates_json: "[]" };
}
function json(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
function seedCallout(): number {
  const c = claimRead(db, printId, { fingerprint: "fp-c", recompute: () => "fp-c", nowMs: T0, modelId: "m" }); if (c.kind !== "claimed") throw new Error();
  finalizeReadDone(db, { readId: c.row.id, token: c.token, facts: [], prose: PROSE, callouts: [{ label: "ARR", label_norm: "arr", value: 1, value_high: null, unit: "count", value_text: "1", snippet: "1 customer", doc_id: docId, doc_sha256: "sha", evidence_sha256: "ev", verifier_version: 1, vs_bogey_text: null }], nowMs: T0 });
  return (db.prepare(`SELECT id FROM print_watch_callouts WHERE print_id = ?`).get(printId) as { id: number }).id;
}

beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys = ON"); runMigrations(db); hoisted.db = db;
  eventId = Number(db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-10','ACME','k','ACME')`).run().lastInsertRowid);
  printId = upsertPrint(db, eventId, "ACME", "2026-09-10", "16:05");
  docId = Number(db.prepare(`INSERT INTO print_watch_documents (print_id, kind, source, sha256, bytes_path, gate_verdict, gate_version, parse_state) VALUES (?, 'user-drop', 'drop', 'sha', '/nonexistent.txt', 'accepted', 2, 'parsed')`).run(printId).lastInsertRowid);
  db.prepare(`INSERT INTO print_watch_document_roads (document_id, kind, source, road_verdict) VALUES (?, 'user-drop', 'drop', 'accepted')`).run(docId);
  upsertLines(db, printId, [line()]);
  _setReadSeams({ generate: () => new Promise(() => {}), setInterval: (() => 0) as never, clearInterval: (() => undefined) as never, setTimeout: (() => 0) as never, clearTimeout: (() => undefined) as never });
});
afterEach(() => { _setReadSeams(null); db.close(); });

describe("route policy anchors (#22)", () => {
  const HOSTS = new Set(["localhost:3099"]); const ORIGINS = new Set(["http://localhost:3099"]);
  it("both POSTs and the status GET classify human", () => {
    expect(classifyRoute("POST", "/api/print-watch/read")).toBe("human");
    expect(classifyRoute("POST", "/api/print-watch/callouts/accept")).toBe("human");
    expect(classifyRoute("GET", "/api/print-watch/status")).toBe("human");
  });
  it("the proxy denies each endpoint without a session (and each POST without CSRF)", () => {
    for (const [method, pathname] of [["POST", "/api/print-watch/read"], ["POST", "/api/print-watch/callouts/accept"], ["GET", "/api/print-watch/status"]] as const) {
      const d = decideRequest(db, { method, pathname, host: "localhost:3099", cookies: {}, headers: { origin: "http://localhost:3099" }, hosts: HOSTS, origins: ORIGINS, cronSecret: "", electronCred: "" }, T0);
      expect(d.action).not.toBe("allow");
    }
  });
});

describe("POST /api/print-watch/read", () => {
  it("claims the next nonce and returns immediately with generating; the done read stays the page's read meanwhile", async () => {
    const { POST } = await import("@/app/api/print-watch/read/route");
    const { GET } = await import("@/app/api/print-watch/status/route");
    const body = await (await POST(json("/api/print-watch/read", { eventId }))).json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ status: "generating", nonce: 0 });
    expect(listReads(db, printId)).toHaveLength(1);
    const status = await (await GET()).json();
    const entry = status.data.prints.find((p: { printId: number }) => p.printId === printId);
    expect(entry.read).toBeNull();
    expect(entry.activeRead).toMatchObject({ id: body.data.readId, status: "generating" });
    const again = await (await POST(json("/api/print-watch/read", { eventId }))).json();
    expect(again.data).toMatchObject({ status: "generating", nonce: 1 });
  });
  it("404s an unknown event, 400s a malformed body, reports no_facts without claiming", async () => {
    const { POST } = await import("@/app/api/print-watch/read/route");
    expect((await POST(json("/api/print-watch/read", { eventId: 999999 }))).status).toBe(404);
    expect((await POST(json("/api/print-watch/read", { nope: 1 }))).status).toBe(400);
    db.prepare(`DELETE FROM print_watch_lines WHERE print_id = ?`).run(printId);
    expect((await (await POST(json("/api/print-watch/read", { eventId }))).json()).data).toEqual({ readId: null, nonce: null, status: "no_facts" });
    expect(listReads(db, printId)).toHaveLength(0);
  });
});

describe("POST /api/print-watch/callouts/accept (#12)", () => {
  it("accepts and un-accepts; 409 with a domain message when the document withdrew or the verifier moved on; 404 unknown", async () => {
    const { POST } = await import("@/app/api/print-watch/callouts/accept/route");
    const id = seedCallout();
    let body = await (await POST(json("/api/print-watch/callouts/accept", { calloutId: id, accept: true }))).json();
    expect(body.data.callout).toMatchObject({ id, state: "accepted" });
    body = await (await POST(json("/api/print-watch/callouts/accept", { calloutId: id, accept: false }))).json();
    expect(body.data.callout).toMatchObject({ id, state: "proposed", accepted_at: null });
    db.prepare(`UPDATE print_watch_documents SET gate_verdict = 'rejected' WHERE id = ?`).run(docId);
    const res = await POST(json("/api/print-watch/callouts/accept", { calloutId: id, accept: true }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/document/);
    db.prepare(`UPDATE print_watch_documents SET gate_verdict = 'accepted' WHERE id = ?`).run(docId);
    db.prepare(`UPDATE print_watch_callouts SET verifier_version = 0 WHERE id = ?`).run(id);
    expect((await POST(json("/api/print-watch/callouts/accept", { calloutId: id, accept: true }))).status).toBe(409);
    expect((await POST(json("/api/print-watch/callouts/accept", { calloutId: 424242, accept: true }))).status).toBe(404);
  });
});

describe("GET /api/print-watch/status (#15)", () => {
  it("returns the newest DONE read as `read`, a newer generating attempt as `activeRead`, callouts, and stays a pure read", async () => {
    const { GET } = await import("@/app/api/print-watch/status/route");
    let entry = (await (await GET()).json()).data.prints.find((p: { printId: number }) => p.printId === printId);
    expect(entry.read).toBeNull(); expect(entry.activeRead).toBeNull(); expect(entry.callouts).toEqual([]);
    seedCallout();
    const doneId = (db.prepare(`SELECT id FROM print_watch_reads WHERE print_id = ?`).get(printId) as { id: number }).id;
    entry = (await (await GET()).json()).data.prints.find((p: { printId: number }) => p.printId === printId);
    expect(entry.read).toMatchObject({ id: doneId, status: "done", prose: PROSE });
    expect(entry.activeRead).toBeNull();
    expect(entry.callouts).toHaveLength(1);
    const r = claimRead(db, printId, { fingerprint: "fp-c", recompute: () => "fp-c", nowMs: T0, modelId: "m", regenerate: true }); if (r.kind !== "claimed") throw new Error();
    entry = (await (await GET()).json()).data.prints.find((p: { printId: number }) => p.printId === printId);
    expect(entry.read.id).toBe(doneId);
    expect(entry.activeRead).toMatchObject({ id: r.row.id, status: "generating", nonce: 1 });
    const src = fs.readFileSync("app/api/print-watch/status/route.ts", "utf8");
    expect(src).not.toMatch(/runFirstPassRead|claimRead|scheduleFirstPassRead|acceptCallout|INSERT|UPDATE|DELETE/);
  });
});

describe("GET /api/print-watch/status — activeRead is live work only (F10)", () => {
  /** Fails the print's read until the attempt cap stops it. Only the FIRST
   *  claim regenerates (that is what opens a new nonce past the done read);
   *  the rest are ordinary retries after their backoff, which is the path the
   *  cap actually counts. */
  function failUntilCapped(): void {
    let now = T0;
    let regenerate = true;
    for (let i = 0; i < 6; i++) {
      const c = claimRead(db, printId, { fingerprint: "fp-c", recompute: () => "fp-c", nowMs: now, modelId: "m", regenerate });
      regenerate = false;
      if (c.kind === "failed_cap") return;
      if (c.kind !== "claimed") throw new Error(c.kind);
      finalizeReadFailed(db, { readId: c.row.id, token: c.token, error: "prose failed validation: read 5/6+", errorCode: "cites", nowMs: now, retryable: true });
      now += READ_RETRY_BACKOFF_MS + 1;
    }
    throw new Error("never capped");
  }
  /** A done read on the current fingerprint, whatever came before it. */
  function landDoneRead(nowMs: number): number {
    const c = claimRead(db, printId, { fingerprint: "fp-c", recompute: () => "fp-c", nowMs, modelId: "m", regenerate: true });
    if (c.kind !== "claimed") throw new Error(c.kind);
    finalizeReadDone(db, { readId: c.row.id, token: c.token, facts: [], prose: PROSE, callouts: [], nowMs });
    return c.row.id;
  }
  const entryOf = async () => (await (await (await import("@/app/api/print-watch/status/route")).GET()).json()).data.prints.find((p: { printId: number }) => p.printId === printId);

  it("a terminal failure lands in lastAttempt with its CAUSE and `capped`, never in activeRead", async () => {
    seedCallout();
    const doneId = (db.prepare(`SELECT id FROM print_watch_reads WHERE print_id = ?`).get(printId) as { id: number }).id;
    failUntilCapped();
    const entry = await entryOf();
    expect(entry.activeRead).toBeNull();
    expect(entry.read.id).toBe(doneId); // the good read still stands
    // F2: the cap no longer eats the reason; the total is what the cap counted.
    expect(entry.lastAttempt).toMatchObject({ error_code: "cites", capped: true, next_retry_at: null });
    expect(entry.lastAttempt.attempts).toBeGreaterThanOrEqual(3);
    expect(entry.lastAttempt.error).toMatch(/^attempt cap reached/);
  });

  it("a live generating row is the activeRead; a failure the newest done read already answered is not surfaced", async () => {
    const f = claimRead(db, printId, { fingerprint: "fp-c", recompute: () => "fp-c", nowMs: T0, modelId: "m" });
    if (f.kind !== "claimed") throw new Error();
    finalizeReadFailed(db, { readId: f.row.id, token: f.token, error: "boom", errorCode: "model_error", nowMs: T0, retryable: true });
    expect((await entryOf()).lastAttempt).toMatchObject({ id: f.row.id, capped: false, error_code: "model_error" });

    landDoneRead(T0 + 1000); // a good read lands AFTER that failure
    expect((await entryOf()).lastAttempt).toBeNull();

    const g = claimRead(db, printId, { fingerprint: "fp-c", recompute: () => "fp-c", nowMs: T0, modelId: "m", regenerate: true });
    if (g.kind !== "claimed") throw new Error();
    const entry = await entryOf();
    expect(entry.activeRead).toMatchObject({ id: g.row.id, status: "generating" });
    expect(entry.lastAttempt).toBeNull();
  });
});

describe("POST /api/print-watch/accept arms the first-pass read (R-D21)", () => {
  // Facts are accepted-only, so the parse-time hook always skips a fresh print
  // on `no_facts`: the desk's accept is the first thing that can produce a
  // readable sheet, and B's route re-arms the debounce once the write commits.
  const armed: number[] = [];
  beforeEach(() => {
    __resetSchedulerForTests();
    enableFirstPassScheduler();
    _setSchedulerSeams({
      setTimeout: ((fn: () => void) => { armed.push(armed.length); void fn; return armed.length; }) as never,
      clearTimeout: (() => undefined) as never,
      setInterval: (() => 0) as never,
      clearInterval: (() => undefined) as never,
    });
    armed.length = 0;
  });
  afterEach(() => {
    __resetSchedulerForTests();
    disableFirstPassScheduler();
    _setSchedulerSeams(null);
  });

  it("a successful accept arms the debounce for that print; a refused accept arms nothing", async () => {
    const { POST } = await import("@/app/api/print-watch/accept/route");
    const ok = await POST(json("/api/print-watch/accept", { eventId, accept: ["revenue_q"] }));
    expect(ok.status).toBe(200);
    expect(__pendingReadTimers()).toContain(printId);
    expect(armed).toHaveLength(1);

    __resetSchedulerForTests();
    armed.length = 0;
    const refused = await POST(json("/api/print-watch/accept", { eventId, accept: ["not_a_metric"] }));
    expect(refused.status).toBe(400);
    expect(__pendingReadTimers()).toEqual([]);
    expect(armed).toEqual([]);
  });
});
