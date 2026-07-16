/**
 * Tests for marker-check.ts — specifically verifying the "evening" type
 * extension works correctly alongside the existing "briefing" | "digest" types,
 * and the on-wake reconcile (2026-07-15) that advances last_digest_sent_at
 * from cloud markers the Mac slept through.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  checkCloudMarker,
  reconcileRecentCloudSends,
} from "@/lib/cron/marker-check";
import { getLastDigestSentAt, setLastDigestSentAt } from "@/lib/digest/daily-digest";
import { todayET, addDays } from "@/lib/calendar/date-utils";

describe("checkCloudMarker", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = OLD_ENV;
    vi.unstubAllGlobals();
  });

  it("returns null when WORKER_MARKER_URL is unset (evening type)", async () => {
    delete process.env.WORKER_MARKER_URL;
    process.env.CRON_SHARED_SECRET = "secret";

    const result = await checkCloudMarker("evening");
    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns null when CRON_SHARED_SECRET is unset (evening type)", async () => {
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    delete process.env.CRON_SHARED_SECRET;

    const result = await checkCloudMarker("evening");
    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("calls /internal/marker?type=evening when configured", async () => {
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    process.env.CRON_SHARED_SECRET = "topsecret";

    const mockResponse = { sentBy: "cloud", date: "2026-05-08" };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await checkCloudMarker("evening");

    expect(fetch).toHaveBeenCalledWith(
      "https://worker.example.com/internal/marker?type=evening",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "X-Cron-Secret": "topsecret" }),
      })
    );
    expect(result).toEqual(mockResponse);
  });

  it("returns null and logs warning when Worker returns non-ok (evening type)", async () => {
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    process.env.CRON_SHARED_SECRET = "topsecret";

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
    } as Response);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await checkCloudMarker("evening");

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("400")
    );
    warnSpy.mockRestore();
  });

  it("existing briefing type still works", async () => {
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    process.env.CRON_SHARED_SECRET = "s";

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sentBy: "mac", date: "2026-05-08" }),
    } as Response);

    const result = await checkCloudMarker("briefing");
    expect(result?.sentBy).toBe("mac");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("type=briefing"),
      expect.anything()
    );
  });

  it("existing digest type still works", async () => {
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    process.env.CRON_SHARED_SECRET = "s";

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sentBy: "cloud", date: "2026-05-08" }),
    } as Response);

    const result = await checkCloudMarker("digest");
    expect(result?.sentBy).toBe("cloud");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("type=digest"),
      expect.anything()
    );
  });

  it("forwards an explicit date as a query param", async () => {
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    process.env.CRON_SHARED_SECRET = "s";

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sentBy: null, date: "2026-07-14", sentAt: null }),
    } as Response);

    await checkCloudMarker("digest", { date: "2026-07-14" });
    expect(fetch).toHaveBeenCalledWith(
      "https://worker.example.com/internal/marker?type=digest&date=2026-07-14",
      expect.anything()
    );
  });
});

describe("reconcileRecentCloudSends", () => {
  const OLD_ENV = process.env;
  let db: Database.Database;
  const today = todayET();
  const yesterday = addDays(today, -1);

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    process.env.CRON_SHARED_SECRET = "s";
    db = new Database(":memory:");
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = OLD_ENV;
    db.close();
    vi.unstubAllGlobals();
  });

  /** Mock the Worker marker endpoint with a per-(type,date) response map. */
  function mockMarkers(map: Record<string, object>) {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(String(input));
      const key = `${url.searchParams.get("type")}:${url.searchParams.get("date")}`;
      const body = map[key] ?? {
        sentBy: null,
        date: url.searchParams.get("date"),
        sentAt: null,
      };
      return { ok: true, json: async () => body } as Response;
    });
  }

  it("advances the pointer from a confirmed cloud digest send the Mac slept through", async () => {
    setLastDigestSentAt(db, "2026-07-13T12:47:00.000Z");
    mockMarkers({
      [`digest:${yesterday}`]: {
        sentBy: "cloud",
        date: yesterday,
        sentAt: "2026-07-14T13:02:15.000Z",
        via: "sent",
      },
    });

    const result = await reconcileRecentCloudSends(db);

    expect(result.advanced).toBe(true);
    // 13:02:15 minus the 5-minute overlap buffer
    expect(getLastDigestSentAt(db)).toBe("2026-07-14T12:57:15.000Z");
  });

  it("takes the newest across all four (type, date) markers", async () => {
    setLastDigestSentAt(db, "2026-07-13T12:47:00.000Z");
    mockMarkers({
      [`digest:${yesterday}`]: {
        sentBy: "cloud", date: yesterday, sentAt: "2026-07-14T13:02:15.000Z", via: "sent",
      },
      [`evening:${yesterday}`]: {
        sentBy: "cloud", date: yesterday, sentAt: "2026-07-14T23:17:40.000Z", via: "sent",
      },
      [`digest:${today}`]: {
        sentBy: "cloud", date: today, sentAt: "2026-07-15T14:47:20.000Z", via: "sent",
      },
    });

    await reconcileRecentCloudSends(db);

    // Newest confirmed cloud send (today 14:47:20) minus the 5-min buffer wins.
    expect(getLastDigestSentAt(db)).toBe("2026-07-15T14:42:20.000Z");
  });

  it("does NOT advance from an in-flight attempt (via=attempting)", async () => {
    setLastDigestSentAt(db, "2026-07-13T12:47:00.000Z");
    mockMarkers({
      [`digest:${today}`]: {
        sentBy: "cloud", date: today, sentAt: "2026-07-15T13:00:05.000Z", via: "attempting",
      },
    });

    const result = await reconcileRecentCloudSends(db);

    expect(result.advanced).toBe(false);
    expect(getLastDigestSentAt(db)).toBe("2026-07-13T12:47:00.000Z");
  });

  it("does NOT advance from mac-sent markers (Mac already advanced locally)", async () => {
    setLastDigestSentAt(db, "2026-07-13T12:47:00.000Z");
    mockMarkers({
      [`digest:${yesterday}`]: {
        sentBy: "mac", date: yesterday, sentAt: "2026-07-14T12:50:00.000Z", via: "sent",
      },
    });

    const result = await reconcileRecentCloudSends(db);

    expect(result.advanced).toBe(false);
    expect(getLastDigestSentAt(db)).toBe("2026-07-13T12:47:00.000Z");
  });

  it("never moves the pointer backwards", async () => {
    setLastDigestSentAt(db, "2026-07-15T18:00:00.000Z");
    mockMarkers({
      [`digest:${today}`]: {
        sentBy: "cloud", date: today, sentAt: "2026-07-15T14:47:20.000Z", via: "sent",
      },
    });

    const result = await reconcileRecentCloudSends(db);

    expect(result.advanced).toBe(false);
    expect(getLastDigestSentAt(db)).toBe("2026-07-15T18:00:00.000Z");
  });

  it("is a silent no-op when WORKER_MARKER_URL is unset", async () => {
    delete process.env.WORKER_MARKER_URL;
    setLastDigestSentAt(db, "2026-07-13T12:47:00.000Z");

    const result = await reconcileRecentCloudSends(db);

    expect(result.advanced).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(getLastDigestSentAt(db)).toBe("2026-07-13T12:47:00.000Z");
  });

  it("tolerates a legacy Worker response without via (treats as sent)", async () => {
    setLastDigestSentAt(db, "2026-07-13T12:47:00.000Z");
    mockMarkers({
      [`digest:${yesterday}`]: {
        sentBy: "cloud", date: yesterday, sentAt: "2026-07-14T13:02:15.000Z",
      },
    });

    const result = await reconcileRecentCloudSends(db);

    expect(result.advanced).toBe(true);
    expect(getLastDigestSentAt(db)).toBe("2026-07-14T12:57:15.000Z");
  });

  it("survives Worker fetch failures without touching the pointer", async () => {
    setLastDigestSentAt(db, "2026-07-13T12:47:00.000Z");
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await reconcileRecentCloudSends(db);

    expect(result.advanced).toBe(false);
    expect(getLastDigestSentAt(db)).toBe("2026-07-13T12:47:00.000Z");
    warnSpy.mockRestore();
  });
});
