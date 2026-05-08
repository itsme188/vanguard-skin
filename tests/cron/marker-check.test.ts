/**
 * Tests for marker-check.ts — specifically verifying the "evening" type
 * extension works correctly alongside the existing "briefing" | "digest" types.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkCloudMarker } from "@/lib/cron/marker-check";

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
});
