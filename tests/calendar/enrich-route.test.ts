import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  getIbApi: vi.fn(() => null),
  runEnrichment: vi.fn(async () => []),
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("@/lib/tws/client", () => ({
  getIbApi: hoisted.getIbApi,
}));

vi.mock("@/lib/calendar/enrichment-runner", () => ({
  runEnrichment: hoisted.runEnrichment,
}));

import { POST } from "@/app/api/calendar/enrich/route";

function makeRequest(headers: Record<string, string> = {}, body: unknown = {}) {
  return new NextRequest("http://attacker.example/api/calendar/enrich", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/calendar/enrich", () => {
  beforeEach(() => {
    hoisted.db = new Database(":memory:");
    hoisted.db.pragma("foreign_keys = ON");
    runMigrations(hoisted.db);
    hoisted.getIbApi.mockClear();
    hoisted.runEnrichment.mockClear();
    vi.stubGlobal("fetch", vi.fn());
    process.env.CRON_SHARED_SECRET = "test-secret";
    delete process.env.WORKER_MARKER_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    hoisted.db.close();
    delete process.env.CRON_SHARED_SECRET;
    delete process.env.WORKER_MARKER_URL;
  });

  it("rejects missing X-Cron-Secret", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect(hoisted.runEnrichment).not.toHaveBeenCalled();
  });

  it("rejects wrong X-Cron-Secret", async () => {
    const res = await POST(makeRequest({ "x-cron-secret": "wrong" }));
    expect(res.status).toBe(401);
    expect(hoisted.runEnrichment).not.toHaveBeenCalled();
  });

  it("returns 500 when CRON_SHARED_SECRET is not configured", async () => {
    delete process.env.CRON_SHARED_SECRET;
    const res = await POST(makeRequest({ "x-cron-secret": "test-secret" }));
    expect(res.status).toBe(500);
    expect(hoisted.runEnrichment).not.toHaveBeenCalled();
  });

  it("runs enrichment with the correct X-Cron-Secret", async () => {
    const res = await POST(makeRequest({ "x-cron-secret": "test-secret" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(hoisted.runEnrichment).toHaveBeenCalledOnce();
  });

  it("does not send X-Cron-Secret to the caller-controlled Host", async () => {
    process.env.WORKER_MARKER_URL = "https://worker.example/internal/marker";
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      async json() {
        return { payloads: {} };
      },
    });

    const res = await POST(
      makeRequest({
        "x-cron-secret": "test-secret",
        host: "evil.example",
        "x-forwarded-proto": "https",
      }),
    );

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledOnce();
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe("https://worker.example/internal/cloud-enriched");
    expect(String(url)).not.toContain("evil.example");
    expect(init?.headers).toEqual({ "X-Cron-Secret": "test-secret" });
  });
});
