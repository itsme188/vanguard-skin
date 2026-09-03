import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import {
  attemptPostCommitDrain,
  drainCloudOutbox,
  writeArmedEventsOutboxRow,
} from "@/lib/earnings/cloud-outbox";
import { readArmedGeneration } from "@/lib/earnings/armed-events-projection";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

const seedArmed = () => {
  const id = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
         VALUES ('manual','earnings','2026-09-02','ACME','k','ACME')`,
      )
      .run().lastInsertRowid,
  );
  armWorksheet(db, id);
  return id;
};

describe("drainCloudOutbox", () => {
  it("posts unsent rows in generation order with the secret header and marks sent_at on 2xx", async () => {
    seedArmed();
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init.body)),
        headers: init.headers as Record<string, string>,
      });
      return new Response("{}", { status: 200 });
    });
    const out = await drainCloudOutbox(db, {
      fetchFn: fetchFn as unknown as typeof fetch,
      workerUrl: "https://w.example",
      secret: "s3",
    });
    expect(out).toEqual({ sent: 1, failed: 0, skipped: null });
    expect(calls[0].url).toBe("https://w.example/internal/armed-events");
    expect(calls[0].headers["X-Cron-Secret"]).toBe("s3");
    expect(calls[0].body).toEqual({
      generation: 1,
      entries: [expect.objectContaining({ symbol: "ACME" })],
    });
    expect(db.prepare(`SELECT sent_at IS NOT NULL AS sent FROM cloud_outbox`).get()).toEqual({
      sent: 1,
    });
  });

  it("a failure leaves the row unsent with send_error and stops the drain; the next call retries", async () => {
    seedArmed();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 500 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await drainCloudOutbox(db, { fetchFn, workerUrl: "https://w", secret: "s" })).toEqual({
      sent: 0,
      failed: 1,
      skipped: null,
    });
    expect(db.prepare(`SELECT sent_at, send_error FROM cloud_outbox`).get()).toEqual({
      sent_at: null,
      send_error: "w: HTTP 500", // host-prefixed so the row names its target
    });
    expect(await drainCloudOutbox(db, { fetchFn, workerUrl: "https://w", secret: "s" })).toEqual({
      sent: 1,
      failed: 0,
      skipped: null,
    });
  });

  it("a failure on generation N never lets N+1 onto the wire", async () => {
    const a = seedArmed();
    db.prepare(`UPDATE calendar_events SET release_time = '16:30' WHERE id = ?`).run(a);
    db.transaction(() => writeArmedEventsOutboxRow(db)).immediate(); // gen 2
    const seen: number[] = [];
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push((JSON.parse(String(init.body)) as { generation: number }).generation);
      return new Response("nope", { status: 503 });
    });
    expect(
      await drainCloudOutbox(db, {
        fetchFn: fetchFn as unknown as typeof fetch,
        workerUrl: "https://w",
        secret: "s",
      }),
    ).toEqual({ sent: 0, failed: 1, skipped: null });
    expect(seen).toEqual([1]);
  });

  it("send_error names the target host so a silent drain failure is diagnosable, never the secret", async () => {
    seedArmed();
    const fetchFn = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    await drainCloudOutbox(db, {
      fetchFn: fetchFn as unknown as typeof fetch,
      workerUrl: "http://127.0.0.1:8787",
      secret: "s3cret",
    });
    const { send_error: err } = db
      .prepare(`SELECT send_error FROM cloud_outbox`)
      .get() as { send_error: string };
    expect(err).toBe("127.0.0.1:8787: fetch failed");
    expect(err).not.toContain("s3cret");
  });

  /**
   * [F2] The restored-DB wedge: the Worker holds a generation this Mac never
   * produced (a DB restored from backup restarts the counter), so every POST
   * is refused as a stale replay — silently, because `applied:false` is also
   * the normal reply to a legitimate re-send. Surface it on the row.
   */
  it("[F2] applied:false from a HIGHER generation is the KV wedge — surfaced on send_error, drain stops", async () => {
    const a = seedArmed(); // gen 1
    db.prepare(`UPDATE calendar_events SET release_time = '16:30' WHERE id = ?`).run(a);
    db.transaction(() => writeArmedEventsOutboxRow(db)).immediate(); // gen 2
    const seen: number[] = [];
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push((JSON.parse(String(init.body)) as { generation: number }).generation);
      return new Response(JSON.stringify({ applied: false, generation: 47 }), { status: 200 });
    });
    expect(
      await drainCloudOutbox(db, {
        fetchFn: fetchFn as unknown as typeof fetch,
        workerUrl: "http://127.0.0.1:8787",
        secret: "s",
      }),
    ).toEqual({ sent: 0, failed: 1, skipped: null });
    expect(seen).toEqual([1]); // in-order rule: generation 2 never went out
    expect(db.prepare(`SELECT sent_at, send_error FROM cloud_outbox WHERE generation = 1`).get()).toEqual({
      sent_at: null,
      send_error:
        "127.0.0.1:8787: worker holds generation 47 > local 1 — KV key armed-events needs a reset",
    });
  });

  it("[F2] applied:false at an EQUAL generation is an ordinary re-send — still marked sent", async () => {
    seedArmed();
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ applied: false, generation: 1 }), { status: 200 }),
    );
    expect(
      await drainCloudOutbox(db, {
        fetchFn: fetchFn as unknown as typeof fetch,
        workerUrl: "https://w",
        secret: "s",
      }),
    ).toEqual({ sent: 1, failed: 0, skipped: null });
    expect(db.prepare(`SELECT sent_at IS NOT NULL AS sent FROM cloud_outbox`).get()).toEqual({ sent: 1 });
  });

  it("[F2] a non-JSON 2xx body is still a success (defensive — the status is the contract)", async () => {
    seedArmed();
    const fetchFn = vi.fn(async () => new Response("OK", { status: 200 }));
    expect(
      await drainCloudOutbox(db, {
        fetchFn: fetchFn as unknown as typeof fetch,
        workerUrl: "https://w",
        secret: "s",
      }),
    ).toEqual({ sent: 1, failed: 0, skipped: null });
    expect(db.prepare(`SELECT sent_at IS NOT NULL AS sent FROM cloud_outbox`).get()).toEqual({ sent: 1 });
  });

  it("no Worker config → skipped, nothing marked", async () => {
    seedArmed();
    expect(await drainCloudOutbox(db, { workerUrl: null, secret: null })).toEqual({
      sent: 0,
      failed: 0,
      skipped: "no-worker-config",
    });
    expect(db.prepare(`SELECT sent_at, send_error FROM cloud_outbox`).get()).toEqual({
      sent_at: null,
      send_error: null,
    });
  });

  it("[C-8] overlapping drains serialise: two concurrent callers produce one strictly increasing POST sequence", async () => {
    const a = seedArmed();
    db.prepare(`UPDATE calendar_events SET release_time = '16:30' WHERE id = ?`).run(a);
    db.transaction(() => writeArmedEventsOutboxRow(db)).immediate(); // gen 2
    const seen: number[] = [];
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push((JSON.parse(String(init.body)) as { generation: number }).generation);
      await new Promise((r) => setTimeout(r, 5));
      return new Response("{}", { status: 200 });
    });
    await Promise.all([
      drainCloudOutbox(db, {
        fetchFn: fetchFn as unknown as typeof fetch,
        workerUrl: "https://w",
        secret: "s",
      }),
      drainCloudOutbox(db, {
        fetchFn: fetchFn as unknown as typeof fetch,
        workerUrl: "https://w",
        secret: "s",
      }),
    ]);
    expect(seen).toEqual([1, 2]); // never [1,1,2,2] or [1,2,1]
  });
});

describe("writeArmedEventsOutboxRow resilience", () => {
  // A truncated/corrupt newest payload must not throw inside armWorksheet's
  // transaction — that would wedge every future arm/disarm/edit. The writer
  // reads the previous entries through the projection's guarded reader, so a
  // corrupt row simply means "no previous entries".
  it("a corrupt newest payload does not wedge the next arm", () => {
    seedArmed(); // gen 1
    db.prepare(`UPDATE cloud_outbox SET payload_json = '{"generation":1,"entries":[' WHERE generation = 1`).run();
    const next = Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
           VALUES ('manual','earnings','2026-09-03','BETA','k2','BETA')`,
        )
        .run().lastInsertRowid,
    );
    expect(() => armWorksheet(db, next)).not.toThrow();
    expect(readArmedGeneration(db)).toBe(2);
  });
});

describe("attemptPostCommitDrain", () => {
  it("caps the WHOLE wait — not just its own fetches — and the chained drain still lands", async () => {
    const a = seedArmed(); // gen 1
    const slow = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 600));
      return new Response("{}", { status: 200 });
    });
    const deps = {
      fetchFn: slow as unknown as typeof fetch,
      workerUrl: "https://w",
      secret: "s",
    };
    // An in-flight drain that will hold the chain for ~600ms.
    const inFlight = drainCloudOutbox(db, deps);
    // A second generation minted while that drain is mid-fetch — the in-flight
    // drain read its row list before this existed, so only a LATER drain sends it.
    db.prepare(`UPDATE calendar_events SET release_time = '16:30' WHERE id = ?`).run(a);
    db.transaction(() => writeArmedEventsOutboxRow(db)).immediate(); // gen 2

    const t0 = Date.now();
    const out = await attemptPostCommitDrain(db, { capMs: 150, deps });
    const elapsed = Date.now() - t0;
    expect(out).toEqual({ timedOut: true, result: null });
    expect(elapsed).toBeLessThan(450); // the cap, not the 600ms chain ahead of it

    await inFlight;
    // The chained drain kept running in the background and lands generation 2.
    const deadline = Date.now() + 5_000;
    let unsent = 1;
    while (unsent > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      unsent = (
        db.prepare(`SELECT COUNT(*) AS n FROM cloud_outbox WHERE sent_at IS NULL`).get() as {
          n: number;
        }
      ).n;
    }
    expect(unsent).toBe(0);
  }, 15_000);

  it("returns the drain result when it finishes inside the cap", async () => {
    seedArmed();
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    const out = await attemptPostCommitDrain(db, {
      capMs: 2000,
      deps: { fetchFn: fetchFn as unknown as typeof fetch, workerUrl: "https://w", secret: "s" },
    });
    expect(out).toEqual({ timedOut: false, result: { sent: 1, failed: 0, skipped: null } });
  });

  it("[M2] capMs caps the fetch too — it wins over a caller-supplied deps.timeoutMs", async () => {
    seedArmed();
    let seen: AbortSignal | null = null;
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      seen = init.signal as AbortSignal;
      await new Promise((r) => setTimeout(r, 300));
      return new Response("{}", { status: 200 });
    });
    await attemptPostCommitDrain(db, {
      capMs: 40,
      deps: {
        fetchFn: fetchFn as unknown as typeof fetch,
        workerUrl: "https://w",
        secret: "s",
        timeoutMs: 5_000, // a caller-supplied timeout must never outlive the cap
      },
    });
    await new Promise((r) => setTimeout(r, 350));
    expect(seen).not.toBeNull();
    expect((seen as unknown as AbortSignal).aborted).toBe(true);
  }, 10_000);

  it("never throws when the drain itself rejects", async () => {
    seedArmed();
    db.close(); // every statement in the drain now throws
    const out = await attemptPostCommitDrain(db, {
      capMs: 2000,
      deps: { fetchFn: (async () => new Response("{}")) as unknown as typeof fetch, workerUrl: "https://w", secret: "s" },
    });
    expect(out).toEqual({ timedOut: false, result: null });
  });
});
