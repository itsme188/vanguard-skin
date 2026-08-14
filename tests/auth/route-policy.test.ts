import { describe, it, expect } from "vitest";
import {
  classifyRoute,
  isImmutableAsset,
  GET_WRITE_OFFENDERS,
  listRouteHandlers,
  type RouteClass,
} from "@/lib/auth/route-policy";

// Packaged-app trust boundary (#35, task 3) — route-policy manifest. Pure
// classification + fs introspection: no DB, no HTTP. The proxy (a later
// task) and every enforcement test consume classifyRoute/isImmutableAsset
// as the single source of truth for which credential kind a route needs.

describe("classifyRoute", () => {
  it("classifies by kind", () => {
    expect(classifyRoute("POST", "/api/auth/login")).toBe("public");
    expect(classifyRoute("POST", "/api/cron/digest")).toBe("cron");
    expect(classifyRoute("POST", "/api/tws/connect")).toBe("electron");
    expect(classifyRoute("DELETE", "/api/import")).toBe("human");
  });

  it("classifies the full PUBLIC set", () => {
    expect(classifyRoute("GET", "/login")).toBe("public");
    expect(classifyRoute("POST", "/api/auth/login")).toBe("public");
  });

  it("classifies the full CRON set — /api/cron/* plus the four enrich/reconcile routes", () => {
    const cronRoutes: Array<[string, string]> = [
      ["POST", "/api/cron/briefing"],
      ["POST", "/api/cron/digest"],
      ["POST", "/api/cron/earnings-sweep"],
      ["POST", "/api/cron/evening"],
      ["POST", "/api/cron/plaid-sync"],
      ["POST", "/api/cron/research-sync"],
      ["POST", "/api/calendar/enrich"],
      ["POST", "/api/calendar/reconcile-cloud-enrich"],
      ["POST", "/api/levels/reconcile-cloud-fired"],
      ["POST", "/api/research/reconcile-cloud-fetched"],
    ];
    for (const [method, pathname] of cronRoutes) {
      expect(classifyRoute(method, pathname)).toBe("cron");
    }
  });

  it("classifies the full ELECTRON set", () => {
    expect(classifyRoute("GET", "/api/tws/status")).toBe("electron");
    expect(classifyRoute("POST", "/api/tws/connect")).toBe("electron");
    expect(classifyRoute("POST", "/api/auth/desktop-bootstrap")).toBe("electron");
  });

  it("defaults to human for anything not explicitly listed", () => {
    expect(classifyRoute("GET", "/api/summary")).toBe("human");
    expect(classifyRoute("PATCH", "/api/settings")).toBe("human");
    // A cron secret must never be accepted as a human credential on a
    // route it wasn't explicitly allowlisted for — verify the same path
    // with a different method isn't accidentally swept into "cron".
    expect(classifyRoute("GET", "/api/cron/digest")).toBe("human");
  });

  it("is keyed on the exact (method, pathname) pair — method matters", () => {
    // /api/tws/status is only ELECTRON as GET; POST to the same path is
    // not in the allowlist and must fall through to human.
    expect(classifyRoute("POST", "/api/tws/status")).toBe("human");
  });
});

describe("isImmutableAsset", () => {
  it("only immutable assets are exempt", () => {
    expect(isImmutableAsset("/_next/static/x.js")).toBe(true);
    expect(isImmutableAsset("/_next/data/b/dashboard.json")).toBe(false);
  });

  it("exempts favicon.ico and robots.txt", () => {
    expect(isImmutableAsset("/favicon.ico")).toBe(true);
    expect(isImmutableAsset("/robots.txt")).toBe(true);
  });

  it("does not exempt a blanket /_next/* — only /_next/static/*", () => {
    expect(isImmutableAsset("/_next/image")).toBe(false);
    expect(isImmutableAsset("/_next/webpack-hmr")).toBe(false);
  });

  it("does not exempt unrelated top-level paths", () => {
    expect(isImmutableAsset("/dashboard/today")).toBe(false);
    expect(isImmutableAsset("/api/summary")).toBe(false);
  });
});

describe("listRouteHandlers", () => {
  it("every route handler is classifiable (no escapes)", () => {
    const handlers = listRouteHandlers();
    expect(handlers.length).toBeGreaterThan(100);
    for (const h of handlers) {
      expect(["public", "human", "cron", "electron"] as RouteClass[]).toContain(
        classifyRoute(h.method, h.pathname),
      );
    }
  });

  it("maps a dynamic-segment file path to a bracketed pathname", () => {
    const handlers = listRouteHandlers();
    const regression = handlers.find(
      (h) => h.pathname === "/api/security/[id]/regression" && h.method === "GET",
    );
    expect(regression).toBeDefined();
  });

  it("returns every declared verb for a multi-method route", () => {
    const handlers = listRouteHandlers();
    const watchlistMethods = handlers
      .filter((h) => h.pathname === "/api/watchlist")
      .map((h) => h.method)
      .sort();
    expect(watchlistMethods).toEqual(["DELETE", "GET", "PATCH", "POST"]);
  });
});

describe("GET_WRITE_OFFENDERS", () => {
  it("is empty — all offenders migrated to POST in Task 5 (no state-changing GET)", () => {
    // The task-3 audit seeded 7 GET-write offenders; task 5 split each so the
    // GET is side-effect-free and the write moved to POST / a background path.
    // The durable guard is tests/api/no-state-changing-get.test.ts.
    expect(GET_WRITE_OFFENDERS).toEqual([]);
  });

  it("any future offender (should there be one) is classified human by default", () => {
    // Vacuously true while empty; guards against a re-added offender being
    // silently swept into a cron/electron exemption.
    for (const entry of GET_WRITE_OFFENDERS) {
      const [method, pathname] = entry.split(" ");
      expect(classifyRoute(method, pathname)).toBe("human");
    }
  });
});
