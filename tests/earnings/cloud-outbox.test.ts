import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { drainCloudOutbox, writeArmedEventsOutboxRow } from "@/lib/earnings/cloud-outbox";

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
      send_error: "HTTP 500",
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
