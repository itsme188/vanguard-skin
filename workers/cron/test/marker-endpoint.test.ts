import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../src/index";
import { todayET } from "../src/dst";

/**
 * GET /internal/marker endpoint contract.
 *
 * Regression (found 2026-07-15): the endpoint called getMarkerStatus without
 * forwarding the ?date= param, so a query for yesterday's marker silently
 * returned TODAY's marker status. The Mac's on-wake reconcile reads
 * yesterday+today markers to advance last_digest_sent_at after cloud sends —
 * a date-blind endpoint makes that reconcile read garbage.
 */
describe("GET /internal/marker", () => {
  let kv: KVNamespace;
  let env: any;

  beforeEach(() => {
    const store = new Map<string, string>();
    kv = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      list: vi.fn(),
    } as any;
    env = { CRON_KV: kv, CRON_SHARED_SECRET: "test-secret" };
  });

  const get = (qs: string) =>
    worker.fetch(
      new Request(`https://worker.test/internal/marker?${qs}`, {
        headers: { "x-cron-secret": "test-secret" },
      }),
      env,
    );

  it("returns the marker for the REQUESTED date, not today's", async () => {
    await kv.put("cloud-sent-digest-2026-07-14", "2026-07-14T13:02:15.000Z");
    await kv.put(`cloud-sent-digest-${todayET()}`, "2026-07-15T14:47:20.000Z");

    const res = await get("type=digest&date=2026-07-14");
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.date).toBe("2026-07-14");
    expect(body.sentBy).toBe("cloud");
    expect(body.sentAt).toBe("2026-07-14T13:02:15.000Z");
  });

  it("marks a confirmed cloud send as via=sent", async () => {
    await kv.put("cloud-sent-digest-2026-07-14", "2026-07-14T13:02:15.000Z");

    const res = await get("type=digest&date=2026-07-14");
    const body = (await res.json()) as any;

    expect(body.sentBy).toBe("cloud");
    expect(body.via).toBe("sent");
  });

  it("marks an in-flight cloud attempt as via=attempting (advance-unsafe)", async () => {
    // Only the attempting marker exists — the fallback is mid-flight and may
    // still fail. Callers must not advance since-window pointers from this.
    await kv.put("cloud-attempting-digest-2026-07-14", "2026-07-14T13:00:05.000Z");

    const res = await get("type=digest&date=2026-07-14");
    const body = (await res.json()) as any;

    expect(body.sentBy).toBe("cloud");
    expect(body.via).toBe("attempting");
    expect(body.sentAt).toBe("2026-07-14T13:00:05.000Z");
  });

  it("mac-sent markers carry via=sent", async () => {
    await kv.put("mac-sent-digest-2026-07-14", "2026-07-14T12:50:00.000Z");

    const res = await get("type=digest&date=2026-07-14");
    const body = (await res.json()) as any;

    expect(body.sentBy).toBe("mac");
    expect(body.via).toBe("sent");
  });

  it("returns null sentBy for a requested date with no markers", async () => {
    await kv.put(`cloud-sent-digest-${todayET()}`, "2026-07-15T14:47:20.000Z");

    const res = await get("type=digest&date=2026-07-10");
    const body = (await res.json()) as any;

    expect(body.date).toBe("2026-07-10");
    expect(body.sentBy).toBeNull();
    expect(body.sentAt).toBeNull();
  });

  it("defaults to today ET when no date is given", async () => {
    await kv.put(`mac-sent-evening-${todayET()}`, "2026-07-15T23:02:00.000Z");

    const res = await get("type=evening");
    const body = (await res.json()) as any;

    expect(body.date).toBe(todayET());
    expect(body.sentBy).toBe("mac");
  });

  it("rejects a malformed date with 400", async () => {
    const res = await get("type=digest&date=07/14/2026");
    expect(res.status).toBe(400);
  });

  it("rejects an unknown type with 400", async () => {
    const res = await get("type=lunch&date=2026-07-14");
    expect(res.status).toBe(400);
  });

  it("rejects a missing secret with 401", async () => {
    const res = await worker.fetch(
      new Request("https://worker.test/internal/marker?type=digest"),
      env,
    );
    expect(res.status).toBe(401);
  });
});

/**
 * GET /internal/cloud-sent-earnings — lists every live cloud-sent earnings
 * marker so the Mac's sweep can backfill audit rows for sends the Worker
 * delivered while the Mac slept (2026-07-15). Read-only: the markers double
 * as the Worker's own send dedup, so the Mac never deletes them.
 */
describe("GET /internal/cloud-sent-earnings", () => {
  let store: Map<string, string>;
  let env: any;

  beforeEach(() => {
    store = new Map<string, string>();
    const kv = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      list: vi.fn(async ({ prefix }: { prefix: string }) => ({
        keys: [...store.keys()]
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
      })),
    } as any;
    env = { CRON_KV: kv, CRON_SHARED_SECRET: "test-secret" };
  });

  const get = () =>
    worker.fetch(
      new Request("https://worker.test/internal/cloud-sent-earnings", {
        headers: { "x-cron-secret": "test-secret" },
      }),
      env,
    );

  it("returns every cloud-sent marker with phase, eventId, and sentAt", async () => {
    store.set("cloud-sent-earnings-preview-951", "2026-07-14T10:00:12.000Z");
    store.set("cloud-sent-earnings-recap-951", "2026-07-14T14:00:36.000Z");
    store.set("cloud-sent-earnings-preview-957", "2026-07-15T10:00:05.000Z");
    // Non-matching keys in the namespace must not leak in.
    store.set("mac-sent-earnings-preview-950", "2026-07-14T09:59:00.000Z");
    store.set("cloud-sent-digest-2026-07-15", "2026-07-15T14:47:20.000Z");
    store.set("mac-running-earnings-preview-951", "2026-07-14T09:58:00.000Z");

    const res = await get();
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    const sorted = body.sends.sort(
      (a: any, b: any) => a.eventId - b.eventId || a.phase.localeCompare(b.phase),
    );
    expect(sorted).toEqual([
      { phase: "preview", eventId: 951, sentAt: "2026-07-14T10:00:12.000Z" },
      { phase: "recap", eventId: 951, sentAt: "2026-07-14T14:00:36.000Z" },
      { phase: "preview", eventId: 957, sentAt: "2026-07-15T10:00:05.000Z" },
    ]);
  });

  it("returns sentAt null for a malformed marker value", async () => {
    store.set("cloud-sent-earnings-preview-960", "not-a-timestamp");

    const res = await get();
    const body = (await res.json()) as any;

    expect(body.sends).toEqual([{ phase: "preview", eventId: 960, sentAt: null }]);
  });

  it("returns an empty list when no markers exist", async () => {
    const res = await get();
    const body = (await res.json()) as any;
    expect(body.sends).toEqual([]);
  });

  it("requires the shared secret", async () => {
    const res = await worker.fetch(
      new Request("https://worker.test/internal/cloud-sent-earnings"),
      env,
    );
    expect(res.status).toBe(401);
  });
});
