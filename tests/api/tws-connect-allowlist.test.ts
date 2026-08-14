import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

// Packaged-app trust boundary (#35, task 19) — `POST /api/tws/connect`
// route-level hardening (defense-in-depth, spec §G). The route is `dual`
// class (task 18): auth limits WHO can call it. This test covers a SEPARATE
// concern — WHAT target it's allowed to connect to. Without this check, a
// caller with a stolen session/cred could use the route as an SSRF/port-scan
// primitive by supplying an arbitrary host/port that gets forwarded straight
// into connectTws() -> @stoqey/ib's raw TCP connect.

const hoisted = vi.hoisted(() => ({
  connectTws: vi.fn(),
  runAutoRefresh: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/tws/auto-refresh", () => ({ runAutoRefresh: hoisted.runAutoRefresh }));

// The route calls assertAllowedTwsTarget + getTwsStatus for real (they're the
// thing under test); only connectTws (the actual network call) is mocked.
vi.mock("@/lib/tws/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tws/client")>();
  return { ...actual, connectTws: hoisted.connectTws };
});

// Imported AFTER the mocks are registered.
import { POST } from "@/app/api/tws/connect/route";
import { assertAllowedTwsTarget } from "@/lib/tws/client";

function makeReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3099/api/tws/connect", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("assertAllowedTwsTarget", () => {
  const originalTwsHost = process.env.TWS_HOST;

  afterEach(() => {
    if (originalTwsHost === undefined) delete process.env.TWS_HOST;
    else process.env.TWS_HOST = originalTwsHost;
  });

  it("allows loopback hosts on standard TWS ports", () => {
    expect(() => assertAllowedTwsTarget("127.0.0.1", 7496)).not.toThrow();
    expect(() => assertAllowedTwsTarget("localhost", 7496)).not.toThrow();
    expect(() => assertAllowedTwsTarget("127.0.0.1", 7497)).not.toThrow();
  });

  it("allows the configured TWS_HOST env value", () => {
    process.env.TWS_HOST = "tws.internal.example";
    expect(() => assertAllowedTwsTarget("tws.internal.example", 7496)).not.toThrow();
  });

  it("rejects an arbitrary host even on a standard port", () => {
    expect(() => assertAllowedTwsTarget("169.254.169.254", 7496)).toThrow();
    expect(() => assertAllowedTwsTarget("evil.example", 7496)).toThrow();
  });

  it("rejects an arbitrary/off port even on an allowed host", () => {
    expect(() => assertAllowedTwsTarget("127.0.0.1", 22)).toThrow();
    expect(() => assertAllowedTwsTarget("127.0.0.1", 8080)).toThrow();
  });
});

describe("POST /api/tws/connect — target allowlist", () => {
  beforeEach(() => {
    hoisted.connectTws.mockReset();
    hoisted.runAutoRefresh.mockReset();
    hoisted.connectTws.mockResolvedValue({
      state: "connected",
      host: "127.0.0.1",
      port: 7496,
      clientId: 1,
    });
    hoisted.runAutoRefresh.mockResolvedValue(undefined);
  });

  it("rejects a disallowed target with a clean 400, never calling connectTws", async () => {
    const res = await POST(makeReq({ host: "169.254.169.254", port: 22, clientId: 1 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(hoisted.connectTws).not.toHaveBeenCalled();
  });

  it("calls connectTws for a valid loopback target", async () => {
    const res = await POST(makeReq({ host: "127.0.0.1", port: 7496, clientId: 1 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(hoisted.connectTws).toHaveBeenCalledTimes(1);
  });
});
