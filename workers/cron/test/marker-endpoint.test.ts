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

/**
 * POST /internal/armed-events — the Mac's cloud outbox drain lands here
 * (deviation D2: the Mac never touches KV directly). Body shape and headers
 * are pinned by lib/earnings/cloud-outbox.ts::drainCloudOutbox.
 */
describe("POST /internal/armed-events", () => {
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
      list: vi.fn(async () => ({ keys: [] })),
    } as any;
    env = { CRON_KV: kv, CRON_SHARED_SECRET: "test-secret" };
  });

  const entry = (eventId: number, symbol: string, eventDate: string) => ({
    eventId,
    symbol,
    eventDate,
    eventTime: "AMC",
    releaseTime: "16:15",
    sourceKey: `manual:${symbol}:${eventDate}:earnings`,
    source: "manual",
    consensusValue: null,
    expectedImpact: null,
    securityId: null,
    epsConsensusVendor: null,
  });

  const post = (body: unknown, headers: Record<string, string> = { "x-cron-secret": "test-secret" }) =>
    worker.fetch(
      new Request("https://worker.test/internal/armed-events", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      env,
    );

  it("requires the shared secret", async () => {
    const res = await post({ generation: 1, entries: [] }, {});
    expect(res.status).toBe(401);
    expect(store.size).toBe(0);
  });

  it("applies a payload and reports the generation", async () => {
    const res = await post({ generation: 4, entries: [entry(77, "ACME", "2026-09-02")] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: true, generation: 4 });
    expect(JSON.parse(store.get("armed-events")!)).toEqual({
      generation: 4,
      entries: [entry(77, "ACME", "2026-09-02")],
    });
  });

  it("is idempotent for a replayed or out-of-order generation", async () => {
    await post({ generation: 4, entries: [entry(77, "ACME", "2026-09-02")] });
    const replay = await post({ generation: 4, entries: [] });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, applied: false, generation: 4 });
    // The stored payload is untouched — a replay never empties the list.
    expect(JSON.parse(store.get("armed-events")!).entries).toHaveLength(1);
  });

  it("400s a malformed body and invalid JSON", async () => {
    const bad = await post({ generation: "x", entries: [] });
    expect(bad.status).toBe(400);
    expect((await bad.json()) as any).toMatchObject({ ok: false });

    const notJson = await post("{nope");
    expect(notJson.status).toBe(400);
    expect(store.size).toBe(0);
  });

  it("413s an oversized body before parsing it", async () => {
    const res = await worker.fetch(
      new Request("https://worker.test/internal/armed-events", {
        method: "POST",
        headers: {
          "x-cron-secret": "test-secret",
          "content-type": "application/json",
          "content-length": String(1024 * 1024),
        },
        body: JSON.stringify({ generation: 1, entries: [] }),
      }),
      env,
    );
    expect(res.status).toBe(413);
    expect(store.size).toBe(0);
  });
});

/**
 * GET /internal/armed-events — read-only twin of the POST above. The sandbox
 * end-to-end and the post-deploy check read the highest stored generation
 * through this; it must never write KV (same auth gate as every /internal/*
 * route, no side effects).
 */
describe("GET /internal/armed-events", () => {
  let store: Map<string, string>;
  let env: any;
  let putSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = new Map<string, string>();
    putSpy = vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    });
    const kv = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: putSpy,
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      list: vi.fn(async () => ({ keys: [] })),
    } as any;
    env = { CRON_KV: kv, CRON_SHARED_SECRET: "test-secret" };
  });

  const entry = (eventId: number, symbol: string, eventDate: string) => ({
    eventId,
    symbol,
    eventDate,
    eventTime: "AMC",
    releaseTime: "16:15",
    sourceKey: `manual:${symbol}:${eventDate}:earnings`,
    source: "manual",
    consensusValue: null,
    expectedImpact: null,
    securityId: null,
    epsConsensusVendor: null,
  });

  const post = (body: unknown) =>
    worker.fetch(
      new Request("https://worker.test/internal/armed-events", {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": "test-secret" },
        body: JSON.stringify(body),
      }),
      env,
    );

  const get = (headers: Record<string, string> = { "x-cron-secret": "test-secret" }) =>
    worker.fetch(
      new Request("https://worker.test/internal/armed-events", { headers }),
      env,
    );

  it("rejects a missing secret with 401", async () => {
    const res = await get({});
    expect(res.status).toBe(401);
  });

  it("rejects a mismatched secret with 401", async () => {
    const res = await get({ "x-cron-secret": "wrong" });
    expect(res.status).toBe(401);
  });

  it("returns generation 0 and no entries when nothing is stored", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ ok: true, generation: 0, entries: [] });
  });

  it("returns the stored generation and entry after a POST", async () => {
    await post({ generation: 4, entries: [entry(77, "ACME", "2026-09-02")] });

    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      generation: 4,
      entries: [entry(77, "ACME", "2026-09-02")],
    });
  });

  it("never writes to KV", async () => {
    await post({ generation: 4, entries: [entry(77, "ACME", "2026-09-02")] });
    const putCallsBefore = putSpy.mock.calls.length;

    await get();

    expect(putSpy.mock.calls.length).toBe(putCallsBefore);
  });
});
