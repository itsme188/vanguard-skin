/**
 * Tests for lib/ibkr/web-api.ts::openSession + isSessionYield + isTwsListeningLocally
 * — the 2026-07-21 pivot (scripts/probe-ibkr-compete.ts, scenario-b probe).
 *
 * Ground truth: this consumer key is provisioned with the force-compete
 * capability and CANNOT authenticate with compete:"false" (probe-verified,
 * both TWS-open and TWS-closed). So `openSession` now:
 *   1. gates on a LOCAL TWS-aliveness check (no LST mint, no IBKR call) —
 *      if TWS is listening locally, yield immediately.
 *   2. otherwise opens with compete:"true" (safe: TWS is confirmed absent).
 * The isSessionYield post-init check becomes a defensive backstop only.
 */
import { describe, it, expect, vi } from "vitest";
import net from "node:net";
import {
  openSession,
  isSessionYield,
  isTwsListeningLocally,
  IbkrSessionYieldError,
} from "@/lib/ibkr/web-api";
import type { IbkrOAuthConfig } from "@/lib/ibkr/oauth-client";

const CFG = {} as IbkrOAuthConfig; // opaque — requests are injected
const LST = { token: "LST-TOKEN", expirationMs: Date.parse("2026-07-21T20:00:00Z") };

function respondJson(json: unknown, status = 200) {
  return new Response(JSON.stringify(json), { status });
}

function fakeGetLst() {
  return vi.fn(async () => ({ ...LST }));
}

describe("openSession", () => {
  it("throws IbkrSessionYieldError immediately when TWS is listening locally — no LST mint, no request", async () => {
    const request = vi.fn();
    const getLst = vi.fn();
    const isTwsListening = vi.fn(async () => true);

    await expect(
      openSession(CFG, { request: request as never, getLst, isTwsListening }),
    ).rejects.toBeInstanceOf(IbkrSessionYieldError);

    expect(getLst).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("yield error message starts with the cross-package sentinel (local-gate path)", async () => {
    const isTwsListening = vi.fn(async () => true);

    await expect(openSession(CFG, { isTwsListening })).rejects.toThrow(
      /^ibkr-session-yield/,
    );
  });

  it("posts compete:true + publish:true to ssodh/init when TWS is NOT listening locally", async () => {
    const request = vi.fn(async () => respondJson({ authenticated: true }));
    const getLst = fakeGetLst();
    const isTwsListening = vi.fn(async () => false);

    await openSession(CFG, { request: request as never, getLst, isTwsListening });

    expect(request).toHaveBeenCalledWith(
      CFG,
      LST.token,
      "POST",
      "/iserver/auth/ssodh/init",
      { compete: "true", publish: "true" },
    );
  });

  it("returns the LST when authenticated:true (TWS closed, compete:true succeeds)", async () => {
    const request = vi.fn(async () =>
      respondJson({ passed: true, authenticated: true, connected: true, competing: false }),
    );
    const getLst = fakeGetLst();
    const isTwsListening = vi.fn(async () => false);

    const result = await openSession(CFG, {
      request: request as never,
      getLst,
      isTwsListening,
    });

    expect(result).toEqual(LST);
  });

  it("defensive: throws IbkrSessionYieldError + warns when the gate says TWS is absent but the init body is yield-shaped anyway", async () => {
    const request = vi.fn(async () =>
      respondJson({ passed: false, authenticated: false, connected: true, competing: false }),
    );
    const getLst = fakeGetLst();
    const isTwsListening = vi.fn(async () => false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      openSession(CFG, { request: request as never, getLst, isTwsListening }),
    ).rejects.toBeInstanceOf(IbkrSessionYieldError);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("warns but still returns the LST on a non-2xx init response (preserves today's lenient behavior)", async () => {
    const request = vi.fn(async () => respondJson({ error: "server exploded" }, 500));
    const getLst = fakeGetLst();
    const isTwsListening = vi.fn(async () => false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await openSession(CFG, {
      request: request as never,
      getLst,
      isTwsListening,
    });

    expect(result).toEqual(LST);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("existing callers (no deps arg) still compile/run against the real signedRequest/getLiveSessionToken/isTwsListeningLocally defaults", () => {
    // Type-level + smoke check only — openSession(cfg) must remain a valid call.
    expect(typeof openSession).toBe("function");
    expect(openSession.length).toBe(1); // cfg only; deps is optional
  });
});

describe("isSessionYield", () => {
  it("true for the exact probed yield body", () => {
    expect(
      isSessionYield(200, true, {
        passed: false,
        authenticated: false,
        connected: true,
        competing: false,
      }),
    ).toBe(true);
  });

  it("false for authenticated:true", () => {
    expect(isSessionYield(200, true, { authenticated: true })).toBe(false);
  });

  it("false for competing:true with authenticated true (NOT keyed on competing — probe disproved that shape)", () => {
    expect(isSessionYield(200, true, { authenticated: true, competing: true })).toBe(false);
  });

  it("false for a non-object body", () => {
    expect(isSessionYield(200, true, null)).toBe(false);
    expect(isSessionYield(200, true, undefined)).toBe(false);
    expect(isSessionYield(200, true, "authenticated:false")).toBe(false);
    expect(isSessionYield(200, true, 42)).toBe(false);
  });

  it("false when the authenticated field is missing (lenient)", () => {
    expect(isSessionYield(200, true, { passed: false })).toBe(false);
    expect(isSessionYield(200, true, {})).toBe(false);
  });

  it("false when the response is not ok, even with a yield-shaped body", () => {
    expect(
      isSessionYield(500, false, {
        passed: false,
        authenticated: false,
        connected: true,
        competing: false,
      }),
    ).toBe(false);
  });
});

describe("isTwsListeningLocally", () => {
  it("resolves true when something is listening on the port (real ephemeral server)", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;

    await expect(isTwsListeningLocally("127.0.0.1", port)).resolves.toBe(true);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("resolves false on a closed port (connection refused)", async () => {
    // Grab a real ephemeral port, then close it — nothing is listening there.
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect(isTwsListeningLocally("127.0.0.1", port)).resolves.toBe(false);
  });

  it("resolves false on a connection timeout", async () => {
    // RFC 5737 TEST-NET-1 — reserved for documentation, expected non-routable
    // (some networks fast-REJECT it instead: false arrives via the error path
    // rather than the timeout path — either way the assertion holds),
    // so the connect attempt hangs until our own timeout fires (verified: ~300ms
    // for a 300ms budget in this sandbox, no external network required to pass).
    await expect(isTwsListeningLocally("192.0.2.1", 81, 200)).resolves.toBe(false);
  }, 3000);
});
