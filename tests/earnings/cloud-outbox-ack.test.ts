/**
 * The drain's capability acknowledgement (FIX-W2, R1).
 *
 * THE OUTPUT THIS PROTECTS: the Mac never believes the cloud holds its
 * replaced / removed event ids when it does not. A Worker build from before
 * the id lists accepts the POST, stores `{ generation, entries }` only and
 * answers `applied:true`; D10 never re-sends an unchanged list, so a row
 * marked delivered on that answer loses its ids until the list next changes.
 * With an up-to-date Worker nothing about delivery changes.
 *
 * Both Workers below sit behind ONE fake KV, so "upgrading" is swapping the
 * code that answers while the stored record stays what the old build left.
 * The new Worker is the real `applyArmedEventsDelta`.
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

const removed = (id: number) => ({
  id,
  eventDate: "2026-09-03",
  removedAt: "2026-09-02T20:00:00.000Z",
});

interface Lists {
  supersededEventIds?: unknown[];
  removedEventIds?: unknown[];
}

/** One full-list payload at the next generation carrying the given id lists. */
function mint(lists: Lists = {}): number {
  const g =
    (db.prepare(`SELECT COALESCE(MAX(generation), 0) AS g FROM cloud_outbox`).get() as { g: number })
      .g + 1;
  db.prepare(`INSERT INTO cloud_outbox (kind, generation, payload_json) VALUES (?, ?, ?)`).run(
    ARMED_EVENTS_KIND,
    g,
    JSON.stringify({
      generation: g,
      entries: [],
      supersededEventIds: lists.supersededEventIds ?? [],
      removedEventIds: lists.removedEventIds ?? [],
    }),
  );
  return g;
}

type WorkerBuild = "old" | "new";

function makeCloud(build: WorkerBuild) {
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
  } as unknown as KVNamespace;
  const posted: number[] = [];
  let current = build;
  let respond: ((body: { generation: number }) => Response | null) | null = null;
  const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { generation: number; entries: unknown[] };
    posted.push(body.generation);
    const forced = respond?.(body);
    if (forced) return forced;
    if (current === "old") {
      // The pre-id-list build, verbatim in effect: strictly-greater apply,
      // two keys stored, no `accepted` in the answer.
      const held = store.has("armed-events")
        ? (JSON.parse(store.get("armed-events")!) as { generation: number }).generation
        : 0;
      if (body.generation <= held) return Response.json({ ok: true, applied: false, generation: held });
      store.set("armed-events", JSON.stringify({ generation: body.generation, entries: body.entries }));
      return Response.json({ ok: true, applied: true, generation: body.generation });
    }
    try {
      return Response.json({ ok: true, ...(await applyArmedEventsDelta(kv, body)) });
    } catch (err) {
      const status = err instanceof ArmedEventsValidationError ? 400 : 503;
      return Response.json({ ok: false }, { status });
    }
  }) as unknown as typeof fetch;
  return {
    posted,
    stored: () =>
      store.has("armed-events")
        ? (JSON.parse(store.get("armed-events")!) as Record<string, unknown>)
        : null,
    upgrade: () => {
      current = "new";
    },
    setRespond: (r: typeof respond) => {
      respond = r;
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

const NOT_ACKED =
  "w: worker did not acknowledge the replaced/removed id lists; deploy the Worker";

describe("drain — a row that carries ids is delivered only on the Worker's acknowledgement", () => {
  it("ids + an OLD Worker: not delivered, the drain stops in order, the error says what to do", async () => {
    const cloud = makeCloud("old");
    mint({ supersededEventIds: [11, 12], removedEventIds: [removed(13)] });
    mint();
    expect(await cloud.drain()).toEqual({ sent: 0, failed: 1, skipped: null });
    expect(cloud.posted).toEqual([1]); // generation 2 never went out
    expect(rows()).toEqual([
      { generation: 1, sent: 0, send_error: NOT_ACKED },
      { generation: 2, sent: 0, send_error: null },
    ]);
    // Idle drains change nothing: nothing is closed, nothing is skipped.
    expect(await cloud.drain()).toEqual({ sent: 0, failed: 1, skipped: null });
    expect(cloud.posted).toEqual([1, 1]);
    expect(rows().map((r) => r.sent)).toEqual([0, 0]);
  });

  it("each list alone is enough to require the acknowledgement", async () => {
    for (const lists of [{ supersededEventIds: [11] }, { removedEventIds: [removed(13)] }]) {
      db.prepare(`DELETE FROM cloud_outbox`).run();
      const cloud = makeCloud("old");
      mint(lists);
      expect(await cloud.drain()).toEqual({ sent: 0, failed: 1, skipped: null });
      expect(rows()[0]).toEqual({ generation: 1, sent: 0, send_error: NOT_ACKED });
    }
  });

  it("EMPTY lists + an OLD Worker: delivered exactly as before", async () => {
    const cloud = makeCloud("old");
    mint();
    mint();
    expect(await cloud.drain()).toEqual({ sent: 2, failed: 0, skipped: null });
    expect(rows()).toEqual([
      { generation: 1, sent: 1, send_error: null },
      { generation: 2, sent: 1, send_error: null },
    ]);
  });

  it("ids + the NEW Worker: delivered, and the cloud really holds the ids", async () => {
    const cloud = makeCloud("new");
    mint({ supersededEventIds: [11, 12], removedEventIds: [removed(13)] });
    expect(await cloud.drain()).toEqual({ sent: 1, failed: 0, skipped: null });
    expect(rows()).toEqual([{ generation: 1, sent: 1, send_error: null }]);
    expect(cloud.stored()).toMatchObject({
      generation: 1,
      supersededEventIds: [11, 12],
      removedEventIds: [removed(13)],
    });
  });

  it("after the Worker is upgraded the SAME row delivers on the next drain — ids and all", async () => {
    const cloud = makeCloud("old");
    mint({ supersededEventIds: [11, 12], removedEventIds: [removed(13)] });
    await cloud.drain();
    // The old build took the generation and dropped the lists.
    expect(cloud.stored()).toEqual({ generation: 1, entries: [] });
    expect(rows()[0].sent).toBe(0);

    cloud.upgrade();
    expect(await cloud.drain()).toEqual({ sent: 1, failed: 0, skipped: null });
    expect(rows()).toEqual([{ generation: 1, sent: 1, send_error: null }]);
    expect(cloud.stored()).toEqual({
      generation: 1,
      entries: [],
      supersededEventIds: [11, 12],
      removedEventIds: [removed(13)],
    });
  });

  it("the queue behind an unacknowledged row drains in order once the Worker is upgraded", async () => {
    const cloud = makeCloud("old");
    mint({ supersededEventIds: [11] });
    mint({ supersededEventIds: [11, 12] });
    mint();
    await cloud.drain();
    await cloud.drain();
    expect(cloud.posted).toEqual([1, 1]);
    cloud.upgrade();
    expect(await cloud.drain()).toEqual({ sent: 3, failed: 0, skipped: null });
    expect(cloud.posted).toEqual([1, 1, 1, 2, 3]);
    expect(rows().map((r) => [r.sent, r.send_error])).toEqual([
      [1, null],
      [1, null],
      [1, null],
    ]);
  });

  it("an unacknowledged row closes NOTHING below it: a rejected older row stays open", async () => {
    const cloud = makeCloud("old");
    mint({ supersededEventIds: [11] });
    mint({ supersededEventIds: [11, 12] });
    cloud.setRespond((b) => (b.generation === 1 ? new Response("bad", { status: 400 }) : null));
    expect(await cloud.drain()).toEqual({ sent: 0, failed: 2, skipped: null });
    expect(rows()).toEqual([
      { generation: 1, sent: 0, send_error: "w: HTTP 400" },
      { generation: 2, sent: 0, send_error: NOT_ACKED },
    ]);
  });

  it("an acknowledgement for the wrong generation, with the wrong counts, or malformed is not one", async () => {
    const answers: unknown[] = [
      { applied: true, generation: 1, accepted: { supersededEventIds: 1, removedEventIds: 1 } },
      { applied: true, generation: 1, accepted: { supersededEventIds: 2, removedEventIds: 0 } },
      { applied: true, generation: 1, accepted: { supersededEventIds: "2", removedEventIds: 1 } },
      { applied: true, generation: 1, accepted: null },
      { applied: true, generation: 1, accepted: { supersededEventIds: 2 } },
      { applied: true, accepted: { supersededEventIds: 2, removedEventIds: 1 } },
      { applied: false, generation: 0, accepted: { supersededEventIds: 2, removedEventIds: 1 } },
    ];
    for (const answer of answers) {
      db.prepare(`DELETE FROM cloud_outbox`).run();
      const cloud = makeCloud("new");
      cloud.setRespond(() => Response.json(answer));
      mint({ supersededEventIds: [11, 12], removedEventIds: [removed(13)] });
      expect(await cloud.drain()).toEqual({ sent: 0, failed: 1, skipped: null });
      expect(rows()[0]).toEqual({ generation: 1, sent: 0, send_error: NOT_ACKED });
    }
    // A 2xx with no JSON body is the same: the status alone proves nothing
    // about the id lists.
    db.prepare(`DELETE FROM cloud_outbox`).run();
    const cloud = makeCloud("new");
    cloud.setRespond(() => new Response("OK", { status: 200 }));
    mint({ supersededEventIds: [11] });
    expect(await cloud.drain()).toEqual({ sent: 0, failed: 1, skipped: null });
    expect(rows()[0].send_error).toBe(NOT_ACKED);
  });

  it("a re-send of a generation the NEW Worker already holds is acknowledged from what it stored", async () => {
    const cloud = makeCloud("new");
    mint({ supersededEventIds: [11, 12] });
    await cloud.drain();
    db.prepare(`UPDATE cloud_outbox SET sent_at = NULL`).run(); // the stamp was lost
    expect(await cloud.drain()).toEqual({ sent: 1, failed: 0, skipped: null });
    expect(rows()[0]).toEqual({ generation: 1, sent: 1, send_error: null });
  });

  it("duplicate ids in a payload are counted once, the way the Worker stores them", async () => {
    const cloud = makeCloud("new");
    mint({ supersededEventIds: [12, 11, 12], removedEventIds: [removed(13), removed(13)] });
    expect(await cloud.drain()).toEqual({ sent: 1, failed: 0, skipped: null });
    expect(rows()[0]).toEqual({ generation: 1, sent: 1, send_error: null });
  });
});
