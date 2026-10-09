/**
 * `POST /api/tws/connect` with a body that is not a JSON object, or a
 * clientId that is not a whole number.
 *
 * A body of literal `null` threw on `body.host` and the route answered 500
 * with the engine's message ("Cannot read properties of null"). A string,
 * number or array body fell through to the current config and connected as if
 * nothing had been sent. `clientId` was forwarded with no type check. Each is
 * now a plain 400 in the standard envelope, before any connection attempt.
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

function rawReq(text: string | undefined): NextRequest {
  return new NextRequest("http://localhost:3099/api/tws/connect", {
    method: "POST",
    body: text,
    headers: { "content-type": "application/json" },
  });
}
const makeReq = (body: unknown) => rawReq(JSON.stringify(body));

beforeEach(() => {
  hoisted.connectTws.mockReset();
  hoisted.runAutoRefresh.mockReset();
  hoisted.connectTws.mockResolvedValue({ state: "connected", host: "127.0.0.1", port: 7496, clientId: 1 });
  hoisted.runAutoRefresh.mockResolvedValue(undefined);
});

describe("POST /api/tws/connect refuses a body that is not a JSON object", () => {
  it.each([
    ["null", null],
    ["a string", "127.0.0.1"],
    ["a number", 7496],
    ["a boolean", true],
    ["an array", [{ host: "127.0.0.1" }]],
  ])("%s: 400, plain error, no connection attempted", async (_label, body) => {
    const res = await POST(makeReq(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: "body must be a JSON object" });
    expect(hoisted.connectTws).not.toHaveBeenCalled();
    expect(hoisted.runAutoRefresh).not.toHaveBeenCalled();
  });
});

describe("POST /api/tws/connect checks clientId", () => {
  it.each([
    ["text", "1"],
    ["a fraction", 1.5],
    ["an object", { id: 1 }],
    ["an array", [1]],
    ["a boolean", true],
    ["a negative number", -1],
    ["a whole number far too large to be a client id", 1e20],
    ["a whole number past the safe range", 2 ** 53],
    ["one past the top of the range", 1000],
  ])("%s: 400, plain error, no connection attempted", async (_label, clientId) => {
    const res = await POST(makeReq({ host: "127.0.0.1", port: 7496, clientId }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: "clientId must be a whole number" });
    expect(hoisted.connectTws).not.toHaveBeenCalled();
  });

  it("a whole-number clientId is forwarded", async () => {
    const res = await POST(makeReq({ host: "127.0.0.1", port: 7496, clientId: 7 }));
    expect(res.status).toBe(200);
    expect(hoisted.connectTws).toHaveBeenCalledWith({ host: "127.0.0.1", port: 7496, clientId: 7 });
  });

  it("the top of the range (999) is forwarded", async () => {
    const res = await POST(makeReq({ host: "127.0.0.1", port: 7496, clientId: 999 }));
    expect(res.status).toBe(200);
    expect(hoisted.connectTws).toHaveBeenCalledWith({ host: "127.0.0.1", port: 7496, clientId: 999 });
  });

  it("zero is a whole number (the TWS master client id)", async () => {
    const res = await POST(makeReq({ host: "127.0.0.1", port: 7496, clientId: 0 }));
    expect(res.status).toBe(200);
    expect(hoisted.connectTws).toHaveBeenCalledWith({ host: "127.0.0.1", port: 7496, clientId: 0 });
  });

  it("an omitted or null clientId keeps the configured one (the key is not sent)", async () => {
    for (const body of [{ host: "127.0.0.1", port: 7496 }, { host: "127.0.0.1", port: 7496, clientId: null }]) {
      hoisted.connectTws.mockClear();
      const res = await POST(makeReq(body));
      expect(res.status).toBe(200);
      const arg = hoisted.connectTws.mock.calls[0][0] as Record<string, unknown>;
      expect(arg.host).toBe("127.0.0.1");
      expect(arg.port).toBe(7496);
      expect(arg.clientId).toBeUndefined();
    }
  });
});

describe("POST /api/tws/connect with no usable body still connects with the current config", () => {
  it.each([
    ["an empty body", undefined],
    ["text that is not JSON", "not json"],
    ["an empty object", "{}"],
  ])("%s", async (_label, text) => {
    const res = await POST(rawReq(text));
    expect(res.status).toBe(200);
    expect(hoisted.connectTws).toHaveBeenCalledTimes(1);
  });
});
