/**
 * Tests for POST /api/cron/evening
 *
 * Covers:
 *   - 401 on missing X-Cron-Secret header
 *   - 401 on wrong secret
 *   - 200 + {success: true} on happy path
 *   - 200 + {skipped: true, reason: "already_sent_by_cloud"} when cloud marker exists
 *   - setRunningMarker called on entry, clearRunningMarker called in finally
 *   - EveningSendError mapped to its status code
 *   - Generic errors mapped to 500
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks ─────────────────────────────────────────────────
// Hoist all vi.fn() creation so they're available before module imports.
const hoisted = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
  sendEveningEmail: vi.fn(),
  EveningSendError: class EveningSendError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "EveningSendError";
      this.status = status;
    }
  },
  checkCloudMarker: vi.fn(async () => null),
  setRunningMarker: vi.fn(async () => {}),
  clearRunningMarker: vi.fn(async () => {}),
  confirmMacSent: vi.fn(async () => {}),
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("@/lib/digest/send-evening", () => ({
  sendEveningEmail: hoisted.sendEveningEmail,
  EveningSendError: hoisted.EveningSendError,
}));

vi.mock("@/lib/cron/marker-check", () => ({
  checkCloudMarker: hoisted.checkCloudMarker,
}));

vi.mock("@/lib/cron/running-marker", () => ({
  setRunningMarker: hoisted.setRunningMarker,
  clearRunningMarker: hoisted.clearRunningMarker,
  confirmMacSent: hoisted.confirmMacSent,
}));

// Import the route handler AFTER mocks are set up
import { POST } from "@/app/api/cron/evening/route";

// ── Helpers ────────────────────────────────────────────────────────
function makeRequest(
  opts: {
    secret?: string;
    body?: Record<string, unknown>;
  } = {}
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.secret !== undefined) {
    headers["x-cron-secret"] = opts.secret;
  }
  return new Request("http://localhost/api/cron/evening", {
    method: "POST",
    headers,
    body: JSON.stringify(opts.body ?? {}),
  });
}

// ── Tests ─────────────────────────────────────────────────────────
describe("POST /api/cron/evening", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV, CRON_SHARED_SECRET: "test-secret" };
    vi.clearAllMocks();
    // Default: no cloud marker, no DB needed for most tests
    hoisted.checkCloudMarker.mockResolvedValue(null);
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  // ── Auth ────────────────────────────────────────────────────────
  it("returns 401 when X-Cron-Secret header is missing", async () => {
    const req = makeRequest({}); // no secret key in headers
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it("returns 401 when X-Cron-Secret header is wrong", async () => {
    const req = makeRequest({ secret: "wrong-secret" });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it("returns 500 when CRON_SHARED_SECRET env is not set", async () => {
    delete process.env.CRON_SHARED_SECRET;
    const req = makeRequest({ secret: "any" });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });

  // ── Cloud marker dedup ──────────────────────────────────────────
  it("returns 200 + skipped:true when cloud already sent", async () => {
    hoisted.checkCloudMarker.mockResolvedValue({
      sentBy: "cloud",
      date: "2026-05-08",
    });
    const req = makeRequest({ secret: "test-secret" });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("already_sent_by_cloud");
  });

  it("passes 'evening' type to checkCloudMarker", async () => {
    hoisted.sendEveningEmail.mockResolvedValue({
      success: true,
      sentTo: "test@example.com",
      synced: { fetched: 0, processed: 0 },
      title: "Evening Recap",
      twsSynced: false,
    });

    const req = makeRequest({ secret: "test-secret" });
    await POST(req);

    expect(hoisted.checkCloudMarker).toHaveBeenCalledWith("evening");
  });

  // ── Happy path ──────────────────────────────────────────────────
  it("returns 200 + success result on happy path", async () => {
    const mockResult = {
      success: true,
      sentTo: "test@example.com",
      synced: { fetched: 3, processed: 2 },
      title: "Evening Recap — Friday, May 8, 2026",
      twsSynced: true,
    };
    hoisted.sendEveningEmail.mockResolvedValue(mockResult);

    const req = makeRequest({ secret: "test-secret" });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.sentTo).toBe("test@example.com");
  });

  it("forwards recipient and footerNote from body to sendEveningEmail", async () => {
    hoisted.sendEveningEmail.mockResolvedValue({
      success: true,
      sentTo: "custom@example.com",
      synced: { fetched: 0, processed: 0 },
      title: "Evening Recap",
      twsSynced: false,
    });

    const req = makeRequest({
      secret: "test-secret",
      body: { recipient: "custom@example.com", footerNote: "Test note" },
    });
    await POST(req);

    // db is the mocked singleton (null in test env) — just verify opts shape
    const callArgs = hoisted.sendEveningEmail.mock.calls[0];
    expect(callArgs[1]).toMatchObject({
      recipient: "custom@example.com",
      footerNote: "Test note",
    });
  });

  // ── Running marker ──────────────────────────────────────────────
  it("calls setRunningMarker('evening') before sendEveningEmail", async () => {
    const callOrder: string[] = [];

    hoisted.setRunningMarker.mockImplementation(async () => {
      callOrder.push("setRunningMarker");
    });
    hoisted.sendEveningEmail.mockImplementation(async () => {
      callOrder.push("sendEveningEmail");
      return {
        success: true,
        sentTo: "t@t.com",
        synced: { fetched: 0, processed: 0 },
        title: "Evening Recap",
        twsSynced: false,
      };
    });
    hoisted.clearRunningMarker.mockImplementation(async () => {
      callOrder.push("clearRunningMarker");
    });

    const req = makeRequest({ secret: "test-secret" });
    await POST(req);

    // set must come before send
    expect(callOrder.indexOf("setRunningMarker")).toBeLessThan(
      callOrder.indexOf("sendEveningEmail")
    );
  });

  it("calls clearRunningMarker('evening') in finally (even on error)", async () => {
    hoisted.sendEveningEmail.mockRejectedValue(new Error("network failure"));

    const req = makeRequest({ secret: "test-secret" });
    const res = await POST(req);

    // Route should handle the error and still return a response
    expect(res.status).toBe(500);
    // clearRunningMarker must still have been called
    expect(hoisted.clearRunningMarker).toHaveBeenCalledWith("evening");
  });

  it("passes 'evening' type to both setRunningMarker and clearRunningMarker", async () => {
    hoisted.sendEveningEmail.mockResolvedValue({
      success: true,
      sentTo: "t@t.com",
      synced: { fetched: 0, processed: 0 },
      title: "Evening Recap",
      twsSynced: false,
    });

    const req = makeRequest({ secret: "test-secret" });
    await POST(req);

    expect(hoisted.setRunningMarker).toHaveBeenCalledWith("evening");
    expect(hoisted.clearRunningMarker).toHaveBeenCalledWith("evening");
  });

  // ── Error handling ───────────────────────────────────────────────
  it("maps EveningSendError to its status code", async () => {
    hoisted.sendEveningEmail.mockRejectedValue(
      new hoisted.EveningSendError("No recipient configured", 400)
    );

    const req = makeRequest({ secret: "test-secret" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("No recipient configured");
  });

  it("maps generic errors to 500", async () => {
    hoisted.sendEveningEmail.mockRejectedValue(new Error("Unexpected failure"));

    const req = makeRequest({ secret: "test-secret" });
    const res = await POST(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Unexpected failure");
  });
});
