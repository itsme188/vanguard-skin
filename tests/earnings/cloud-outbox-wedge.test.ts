/**
 * The drain against the REAL Worker apply function behind a fake KV.
 *
 * THE OUTPUT THIS PROTECTS: once the network is up the Worker holds the Mac's
 * NEWEST generation, whichever older generations failed and however — and
 * `send_error` only ever says something true.
 *
 * The fake "Worker" below answers the way workers/cron/src/index.ts does: 400
 * for a validation error, 503 for any other throw, 200 + the apply result
 * otherwise. Individual tests override one generation's answer.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { drainCloudOutbox } from "@/lib/earnings/cloud-outbox";
import { ARMED_EVENTS_KIND } from "@/lib/earnings/armed-events-projection";
import {
  applyArmedEventsDelta,
  ArmedEventsValidationError,
} from "../../workers/cron/src/armed-events";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

/** One full-list payload at the next generation (content is irrelevant here). */
function mint(): number {
  const g =
    (db.prepare(`SELECT COALESCE(MAX(generation), 0) AS g FROM cloud_outbox`).get() as { g: number })
      .g + 1;
  db.prepare(`INSERT INTO cloud_outbox (kind, generation, payload_json) VALUES (?, ?, ?)`).run(
    ARMED_EVENTS_KIND,
    g,
    JSON.stringify({ generation: g, entries: [], supersededEventIds: [], removedEventIds: [] }),
  );
  return g;
}

type Override = (generation: number) => Response | "network" | null;

function makeWorker(initialGeneration = 0) {
  const store = new Map<string, string>();
  if (initialGeneration > 0) {
    store.set("armed-events", JSON.stringify({ generation: initialGeneration, entries: [] }));
  }
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
  } as unknown as KVNamespace;
  const posted: number[] = [];
  let override: Override = () => null;
  const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { generation: number };
    posted.push(body.generation);
    const forced = override(body.generation);
    if (forced === "network") throw new Error("fetch failed");
    if (forced) return forced;
    try {
      const r = await applyArmedEventsDelta(kv, body);
      return Response.json({ ok: true, ...r });
    } catch (err) {
      const status = err instanceof ArmedEventsValidationError ? 400 : 503;
      return Response.json({ ok: false }, { status });
    }
  }) as unknown as typeof fetch;
  return {
    posted,
    held: () =>
      store.has("armed-events")
        ? (JSON.parse(store.get("armed-events")!) as { generation: number }).generation
        : 0,
    setOverride: (o: Override) => {
      override = o;
    },
    drain: () => drainCloudOutbox(db, { fetchFn, workerUrl: "https://w", secret: "s" }),
  };
}

const rows = () =>
  db
    .prepare(
      `SELECT generation, sent_at IS NOT NULL AS sent, send_error FROM cloud_outbox ORDER BY generation`,
    )
    .all() as Array<{ generation: number; sent: number; send_error: string | null }>;

const bad400: Override = (g) => (g === 2 ? new Response("bad", { status: 400 }) : null);

describe("drain vs the real Worker apply — a failed old generation never blocks the newest", () => {
  // The reviewer's probe. Before the fix: drain 1 posted 1,2,3 (sent 2,
  // failed 1); drains 2 and 3 each posted ONLY generation 2 (sent 0) — the
  // Worker's applied:false at generation 3 read as a restored database — and
  // generations 4 and 5 never went out.
  it("the probe: gen 2 answers 400, then the Worker answers for itself; gens 4 and 5 still reach it", async () => {
    const w = makeWorker();
    let rejected = false;
    w.setOverride((g) => {
      if (g !== 2 || rejected) return null;
      rejected = true;
      return new Response("bad", { status: 400 });
    });
    mint();
    mint();
    mint();
    expect(await w.drain()).toEqual({ sent: 2, failed: 1, skipped: null });
    expect(w.posted).toEqual([1, 2, 3]);
    expect(w.held()).toBe(3);

    // Two idle drains (the sweep tick), then two more generations.
    expect(await w.drain()).toEqual({ sent: 0, failed: 0, skipped: null });
    expect(await w.drain()).toEqual({ sent: 0, failed: 0, skipped: null });
    expect(w.posted).toEqual([1, 2, 3]);
    mint();
    mint();
    expect(await w.drain()).toEqual({ sent: 2, failed: 0, skipped: null });
    expect(await w.drain()).toEqual({ sent: 0, failed: 0, skipped: null });
    expect(w.posted).toEqual([1, 2, 3, 4, 5]);
    expect(w.held()).toBe(5);
    expect(rows()).toEqual([
      { generation: 1, sent: 1, send_error: null },
      {
        generation: 2,
        sent: 1,
        send_error: "superseded by generation 3 (never delivered; last error: w: HTTP 400)",
      },
      { generation: 3, sent: 1, send_error: null },
      { generation: 4, sent: 1, send_error: null },
      { generation: 5, sent: 1, send_error: null },
    ]);
  });

  it("BOUND: a permanently failing old row is posted once in total, over any number of drains", async () => {
    const w = makeWorker();
    w.setOverride(bad400);
    mint();
    mint();
    mint();
    for (let i = 0; i < 6; i += 1) {
      if (i === 2 || i === 4) mint();
      await w.drain();
    }
    expect(w.posted.filter((g) => g === 2)).toHaveLength(1);
    expect(w.held()).toBe(5);
  });

  it("a queue head left unsent by the OLD code (400, newer generation already delivered) is closed without a post", async () => {
    const w = makeWorker(3);
    mint();
    mint();
    mint();
    db.prepare(`UPDATE cloud_outbox SET sent_at = datetime('now') WHERE generation IN (1, 3)`).run();
    db.prepare(`UPDATE cloud_outbox SET send_error = 'w: HTTP 400' WHERE generation = 2`).run();
    mint();
    expect(await w.drain()).toEqual({ sent: 1, failed: 0, skipped: null });
    expect(w.posted).toEqual([4]);
    expect(w.held()).toBe(4);
    expect(rows()[1]).toEqual({
      generation: 2,
      sent: 1,
      send_error: "superseded by generation 3 (never delivered; last error: w: HTTP 400)",
    });
  });

  it("the NEWEST row answering 400 stays unsent, is retried once per drain, and never blocks what is minted after it", async () => {
    const w = makeWorker();
    w.setOverride(bad400);
    mint();
    mint();
    expect(await w.drain()).toEqual({ sent: 1, failed: 1, skipped: null });
    expect(rows()[1]).toEqual({ generation: 2, sent: 0, send_error: "w: HTTP 400" });
    expect(await w.drain()).toEqual({ sent: 0, failed: 1, skipped: null });
    expect(w.posted).toEqual([1, 2, 2]); // once per drain, never twice in one

    // A transient Worker fault: the same row is accepted on a later drain.
    w.setOverride(() => null);
    expect(await w.drain()).toEqual({ sent: 1, failed: 0, skipped: null });
    expect(w.held()).toBe(2);
    expect(rows()[1]).toEqual({ generation: 2, sent: 1, send_error: null });

    // And when it never recovers, the generation minted after it still lands.
    w.setOverride((g) => (g === 3 ? new Response("bad", { status: 400 }) : null));
    mint();
    await w.drain();
    mint();
    expect(await w.drain()).toEqual({ sent: 1, failed: 1, skipped: null });
    expect(w.held()).toBe(4);
    expect(rows()[2]).toEqual({
      generation: 3,
      sent: 1,
      send_error: "superseded by generation 4 (never delivered; last error: w: HTTP 400)",
    });
  });

  it("an old row replayed after a newer one landed is NOT read as a restored database", async () => {
    // Generation 1 fails in transit, the caller later mints 2 and 3, and a
    // foreign path already delivered 3 (the Worker holds 3 = the Mac's MAX).
    const w = makeWorker(3);
    mint();
    mint();
    mint();
    expect(await w.drain()).toEqual({ sent: 1, failed: 0, skipped: null });
    expect(w.posted).toEqual([1, 2, 3]);
    expect(rows()).toEqual([
      { generation: 1, sent: 1, send_error: "superseded by generation 3" },
      { generation: 2, sent: 1, send_error: "superseded by generation 3" },
      { generation: 3, sent: 1, send_error: null },
    ]);
  });

  it("the restored-database refusal fires only above the Mac's own MAX(generation); a KV reset then lets everything land", async () => {
    const w = makeWorker(47);
    mint();
    mint();
    expect(await w.drain()).toEqual({ sent: 0, failed: 1, skipped: null });
    expect(w.posted).toEqual([1]); // in order: nothing later while refused
    expect(rows()[0].send_error).toBe(
      "w: worker holds generation 47 > local 1 — KV key armed-events needs a reset",
    );
    expect(w.held()).toBe(47);

    // The owner resets the KV key (the documented repair): everything lands.
    const fresh = makeWorker();
    expect(await fresh.drain()).toEqual({ sent: 2, failed: 0, skipped: null });
    expect(fresh.held()).toBe(2);
    expect(rows().map((r) => r.send_error)).toEqual([null, null]);
  });

  it("5xx, a network error and a timeout-style throw still stop the drain and retry in order", async () => {
    const w = makeWorker();
    mint();
    mint();
    mint();
    w.setOverride((g) => (g === 2 ? new Response("down", { status: 503 }) : null));
    expect(await w.drain()).toEqual({ sent: 1, failed: 1, skipped: null });
    expect(w.posted).toEqual([1, 2]);
    expect(rows()[1]).toEqual({ generation: 2, sent: 0, send_error: "w: HTTP 503" });

    w.setOverride((g) => (g === 2 ? "network" : null));
    expect(await w.drain()).toEqual({ sent: 0, failed: 1, skipped: null });
    expect(w.posted).toEqual([1, 2, 2]);
    expect(rows()[1].send_error).toBe("w: fetch failed");

    w.setOverride(() => null);
    expect(await w.drain()).toEqual({ sent: 2, failed: 0, skipped: null });
    expect(w.posted).toEqual([1, 2, 2, 2, 3]);
    expect(w.held()).toBe(3);
  });

  it("a 400 followed by a 5xx: the rejected row is NOT closed (nothing newer was delivered) and the newest still lands later", async () => {
    const w = makeWorker();
    mint();
    mint();
    mint();
    w.setOverride((g) =>
      g === 2 ? new Response("bad", { status: 400 }) : g === 3 ? new Response("down", { status: 503 }) : null,
    );
    expect(await w.drain()).toEqual({ sent: 1, failed: 2, skipped: null });
    expect(rows().map((r) => r.sent)).toEqual([1, 0, 0]);
    w.setOverride(bad400);
    expect(await w.drain()).toEqual({ sent: 1, failed: 1, skipped: null });
    expect(w.held()).toBe(3);
    expect(rows().map((r) => r.sent)).toEqual([1, 1, 1]);
  });
});
