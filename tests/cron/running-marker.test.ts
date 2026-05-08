/**
 * Tests for running-marker.ts — verifying the "evening" type extension.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setRunningMarker, clearRunningMarker } from "@/lib/cron/running-marker";

describe("running-marker", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = OLD_ENV;
    vi.unstubAllGlobals();
  });

  it("setRunningMarker('evening') calls /internal/running-marker?type=evening&action=set", async () => {
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    process.env.CRON_SHARED_SECRET = "topsecret";

    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    await setRunningMarker("evening");

    expect(fetch).toHaveBeenCalledWith(
      "https://worker.example.com/internal/running-marker?type=evening&action=set",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Cron-Secret": "topsecret" }),
      })
    );
  });

  it("clearRunningMarker('evening') calls /internal/running-marker?type=evening&action=clear", async () => {
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    process.env.CRON_SHARED_SECRET = "topsecret";

    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    await clearRunningMarker("evening");

    expect(fetch).toHaveBeenCalledWith(
      "https://worker.example.com/internal/running-marker?type=evening&action=clear",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("no-ops when WORKER_MARKER_URL is unset (evening)", async () => {
    delete process.env.WORKER_MARKER_URL;
    process.env.CRON_SHARED_SECRET = "s";

    await setRunningMarker("evening");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("existing briefing type still works for set", async () => {
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    process.env.CRON_SHARED_SECRET = "s";

    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    await setRunningMarker("briefing");

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("type=briefing&action=set"),
      expect.anything()
    );
  });

  it("existing digest type still works for clear", async () => {
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    process.env.CRON_SHARED_SECRET = "s";

    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    await clearRunningMarker("digest");

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("type=digest&action=clear"),
      expect.anything()
    );
  });
});
