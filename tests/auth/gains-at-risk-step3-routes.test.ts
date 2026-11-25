/**
 * Gains at risk step 3 (Task S4, D11): the four new routes are human routes by
 * the default policy (no edit to lib/auth/route-policy.ts or proxy.ts), and a
 * request with no session, or with a session but a failing CSRF check, is
 * denied by `decideRequest` before any route code runs: the route modules are
 * never loaded and the fake broker sees nothing.
 */
import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { createSession } from "@/lib/mutations/sessions";
import { decideRequest, type RequestCtx } from "@/lib/auth/verify-request";
import { classifyRoute, listRouteHandlers } from "@/lib/auth/route-policy";
import { SESSION_COOKIE, CSRF_COOKIE } from "@/lib/auth/cookies";

const loaded = vi.hoisted(() => ({ count: 0 }));
const fakeApi = vi.hoisted(() => ({
  getMarketData: vi.fn(),
  getContractDetails: vi.fn(),
  getSecDefOptParams: vi.fn(),
  setMarketDataType: vi.fn(),
}));

// Any route module that did load would reach the broker through this client.
vi.mock("@/lib/tws/client", () => {
  loaded.count++;
  return { getIbApi: () => fakeApi };
});

const ROUTES = [
  "/api/compute/gains-at-risk/single-name-drivers",
  "/api/compute/gains-at-risk/candidates",
  "/api/tws/option-candidates/chain",
  "/api/tws/option-candidates/quotes",
] as const;

const T0 = Date.parse("2026-11-10T15:00:00Z");
const ORIGIN = "http://localhost:3099";

function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function ctx(partial: Partial<RequestCtx> & Pick<RequestCtx, "pathname">): RequestCtx {
  return {
    method: "POST",
    host: "localhost:3099",
    cookies: {},
    headers: {},
    hosts: new Set(["localhost:3099"]),
    origins: new Set([ORIGIN]),
    cronSecret: "cron-secret-value",
    electronCred: "electron-cred-value",
    ...partial,
  };
}

function noBrokerRequests(): void {
  for (const f of Object.values(fakeApi)) expect(f).not.toHaveBeenCalled();
  expect(loaded.count).toBe(0);
}

describe("Gains at risk step 3 routes behind the trust boundary", () => {
  it("D11 the four new routes exist as POST handlers and classify human", () => {
    const handlers = listRouteHandlers();
    for (const pathname of ROUTES) {
      expect(handlers).toContainEqual({ method: "POST", pathname });
      expect(classifyRoute("POST", pathname)).toBe("human");
    }
  });

  it("D11 no session: denied for each new route; no route module loaded, the fake broker untouched", () => {
    const db = fresh();
    for (const pathname of ROUTES) {
      expect(decideRequest(db, ctx({ pathname, headers: { origin: ORIGIN } }), T0).action).toBe("deny401");
      // Even with the service credentials: a human route takes neither.
      expect(
        decideRequest(
          db,
          ctx({ pathname, headers: { origin: ORIGIN, "x-cron-secret": "cron-secret-value", "x-electron-cred": "electron-cred-value" } }),
          T0,
        ).action,
      ).toBe("deny401");
    }
    noBrokerRequests();
  });

  it("D11 a valid session with a failing CSRF check (missing, wrong, or no Origin): denied for each new route", () => {
    const db = fresh();
    const { rawToken, csrfToken } = createSession(db, { label: "zz-test" }, T0);
    const cookies = { [SESSION_COOKIE]: rawToken, [CSRF_COOKIE]: csrfToken };
    for (const pathname of ROUTES) {
      expect(decideRequest(db, ctx({ pathname, cookies, headers: { origin: ORIGIN } }), T0).action).toBe("deny401");
      expect(
        decideRequest(db, ctx({ pathname, cookies, headers: { origin: ORIGIN, "x-csrf-token": "zz-wrong" } }), T0).action,
      ).toBe("deny401");
      expect(decideRequest(db, ctx({ pathname, cookies, headers: { "x-csrf-token": csrfToken } }), T0).action).toBe("deny401");
      // The control: the same request with a good token is allowed, so the denials above are the CSRF check.
      expect(
        decideRequest(db, ctx({ pathname, cookies, headers: { origin: ORIGIN, "x-csrf-token": csrfToken } }), T0).action,
      ).toBe("allow");
    }
    noBrokerRequests();
  });
});
