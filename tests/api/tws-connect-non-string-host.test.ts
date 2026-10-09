/**
 * `POST /api/tws/connect` with a host that is not text (wave Q unit 30).
 *
 * `assertAllowedTwsTarget` called `.toLowerCase()` on whatever the body
 * carried. A number, object, array or boolean threw a raw TypeError, and the
 * route passed that engine message ("... toLowerCase is not a function") to
 * the caller. The status was already 400; the message was not plain. The
 * target is still refused before any connection is attempted.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  connectTws: vi.fn(),
  runAutoRefresh: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/tws/auto-refresh", () => ({ runAutoRefresh: hoisted.runAutoRefresh }));
vi.mock("@/lib/tws/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tws/client")>();
  return { ...actual, connectTws: hoisted.connectTws };
});

import { POST } from "@/app/api/tws/connect/route";
import { assertAllowedTwsTarget } from "@/lib/tws/client";

function makeReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3099/api/tws/connect", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const NON_STRING_HOSTS: [string, unknown][] = [
  ["a number", 12345],
  ["an object", { toLowerCase: "x" }],
  ["an array", ["127.0.0.1"]],
  ["a boolean", true],
  ["zero", 0],
];

beforeEach(() => {
  hoisted.connectTws.mockReset();
  hoisted.runAutoRefresh.mockReset();
  hoisted.connectTws.mockResolvedValue({ state: "connected", host: "127.0.0.1", port: 7496, clientId: 1 });
  hoisted.runAutoRefresh.mockResolvedValue(undefined);
});

describe("assertAllowedTwsTarget refuses a non-text host with a plain message", () => {
  it.each(NON_STRING_HOSTS)("%s", (_label, host) => {
    let message = "";
    try {
      assertAllowedTwsTarget(host as string, 7496);
    } catch (err) {
      expect(err).not.toBeInstanceOf(TypeError);
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/^TWS connect target not allowed: /);
    expect(message).toMatch(/host must be text/);
    expect(message).not.toMatch(/is not a function|toLowerCase|\[object/);
  });

  it("a non-number port is refused with a plain message too", () => {
    expect(() => assertAllowedTwsTarget("127.0.0.1", "7496" as unknown as number)).toThrow(
      /^TWS connect target not allowed: port must be a number/,
    );
    expect(() => assertAllowedTwsTarget("127.0.0.1", { a: 1 } as unknown as number)).toThrow(
      /^TWS connect target not allowed: port must be a number/,
    );
  });

  it("text hosts behave exactly as before", () => {
    expect(() => assertAllowedTwsTarget("127.0.0.1", 7496)).not.toThrow();
    expect(() => assertAllowedTwsTarget("LOCALHOST", 7497)).not.toThrow();
    expect(() => assertAllowedTwsTarget("evil.example", 7496)).toThrow(/not in the allowlist/);
    expect(() => assertAllowedTwsTarget("", 7496)).toThrow(/not in the allowlist/);
    expect(() => assertAllowedTwsTarget("127.0.0.1", 22)).toThrow(/not a standard TWS port/);
  });
});

describe("POST /api/tws/connect answers a non-text host with a plain 400", () => {
  it.each(NON_STRING_HOSTS)("%s: 400, plain error, no connection attempted", async (_label, host) => {
    const res = await POST(makeReq({ host, port: 7496, clientId: 1 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/host must be text/);
    expect(body.error).not.toMatch(/is not a function|toLowerCase|\[object/);
    expect(hoisted.connectTws).not.toHaveBeenCalled();
    expect(hoisted.runAutoRefresh).not.toHaveBeenCalled();
  });

  it("a text port is a plain 400 and never reaches connectTws", async () => {
    const res = await POST(makeReq({ host: "127.0.0.1", port: "7496", clientId: 1 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/port must be a number/);
    expect(hoisted.connectTws).not.toHaveBeenCalled();
  });

  it("a valid loopback target still connects", async () => {
    const res = await POST(makeReq({ host: "127.0.0.1", port: 7496, clientId: 1 }));
    expect(res.status).toBe(200);
    expect(hoisted.connectTws).toHaveBeenCalledWith({ host: "127.0.0.1", port: 7496, clientId: 1 });
  });
});
