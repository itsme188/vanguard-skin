/**
 * Tests for lib/ibkr/web-api.ts::openSession + isSessionYield — the polite
 * compete:"false" session open (2026-07-21 probe: scripts/probe-ibkr-compete.ts).
 * IBKR allows exactly one brokerage session per username; compete:"false"
 * means TWS wins and the Web API yields observably (IbkrSessionYieldError)
 * instead of silently evicting the desktop login.
 */
import { describe, it, expect, vi } from "vitest";
import { openSession, isSessionYield, IbkrSessionYieldError } from "@/lib/ibkr/web-api";
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
  it("posts compete:false + publish:true to ssodh/init", async () => {
    const request = vi.fn(async () => respondJson({ authenticated: true }));
    const getLst = fakeGetLst();

    await openSession(CFG, { request: request as never, getLst });

    expect(request).toHaveBeenCalledWith(
      CFG,
      LST.token,
      "POST",
      "/iserver/auth/ssodh/init",
      { compete: "false", publish: "true" },
    );
  });

  it("throws IbkrSessionYieldError on the probe-verified yield body", async () => {
    // Exact body from the 2026-07-21 live probe with TWS logged in.
    const request = vi.fn(async () =>
      respondJson({ passed: false, authenticated: false, connected: true, competing: false }),
    );
    const getLst = fakeGetLst();

    await expect(
      openSession(CFG, { request: request as never, getLst }),
    ).rejects.toBeInstanceOf(IbkrSessionYieldError);
  });

  it("yield error message starts with the cross-package sentinel", async () => {
    const request = vi.fn(async () =>
      respondJson({ passed: false, authenticated: false, connected: true, competing: false }),
    );
    const getLst = fakeGetLst();

    await expect(
      openSession(CFG, { request: request as never, getLst }),
    ).rejects.toThrow(/^ibkr-session-yield/);
  });

  it("returns the LST when authenticated:true", async () => {
    const request = vi.fn(async () => respondJson({ authenticated: true }));
    const getLst = fakeGetLst();

    const result = await openSession(CFG, { request: request as never, getLst });

    expect(result).toEqual(LST);
  });

  it("warns but still returns the LST on a non-2xx init response (preserves today's lenient behavior)", async () => {
    const request = vi.fn(async () => respondJson({ error: "server exploded" }, 500));
    const getLst = fakeGetLst();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await openSession(CFG, { request: request as never, getLst });

    expect(result).toEqual(LST);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("existing callers (no deps arg) still compile/run against the real signedRequest/getLiveSessionToken defaults", () => {
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
      isSessionYield(500, false, { passed: false, authenticated: false, connected: true, competing: false }),
    ).toBe(false);
  });
});
