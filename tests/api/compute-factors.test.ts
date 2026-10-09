import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { FactorAnalysisResult } from "@/lib/compute/factors";

// Mock the compute module so tests don't touch the DB.
vi.mock("@/lib/compute/factors", () => ({
  computeFactorAnalysis: vi.fn(),
}));

// Resolve scope locally so the route doesn't try to read the DB for it.
// The route resolves a scope to its WHOLE id list (resolveScope); the old
// first-account collapse (resolveScopeToSingleId) is deliberately not
// offered here, so a route that still reaches for it fails every test.
const scopeMock = vi.hoisted(() => ({
  resolveScope: vi.fn<(db: unknown, scope: string | null) => number[] | undefined>(),
}));
vi.mock("@/lib/queries/accounts", () => ({
  resolveScope: scopeMock.resolveScope,
}));

// `db` is referenced by the route but never used by mocks.
vi.mock("@/lib/db", () => ({
  db: {} as never,
}));

import { GET } from "@/app/api/compute/factors/route";
import { computeFactorAnalysis } from "@/lib/compute/factors";

const computeFn = computeFactorAnalysis as unknown as ReturnType<typeof vi.fn>;

function fakeResult(overrides: Partial<FactorAnalysisResult> = {}): FactorAnalysisResult {
  return {
    marketRegression: {
      beta: 1.0,
      alpha: 0.02,
      rSquared: 0.85,
      trackingError: 0.04,
      correlation: 0.92,
      dataPoints: 252,
      windowStart: "2025-01-02",
      windowEnd: "2025-12-31",
    },
    sizeTilt: null,
    styleTilt: null,
    sectorTilt: null,
    geographyTilt: null,
    tilts: [],
    ...overrides,
  };
}

describe("GET /api/compute/factors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeMock.resolveScope.mockReturnValue(undefined);
  });

  it("returns { data, weekAgo, delta } on the happy path", async () => {
    computeFn
      .mockReturnValueOnce(
        fakeResult({
          marketRegression: {
            beta: 1.10,
            alpha: 0.03,
            rSquared: 0.90,
            trackingError: 0.04,
            correlation: 0.95,
            dataPoints: 252,
            windowStart: "2025-01-02",
            windowEnd: "2025-12-31",
          },
        })
      )
      .mockReturnValueOnce(
        fakeResult({
          marketRegression: {
            beta: 1.00,
            alpha: 0.02,
            rSquared: 0.85,
            trackingError: 0.04,
            correlation: 0.92,
            dataPoints: 245,
            windowStart: "2025-01-02",
            windowEnd: "2025-12-31",
          },
        })
      );

    const req = new Request("http://x/api/compute/factors?scope=vanguard");
    const res = await GET(req as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.weekAgo).toBeDefined();
    expect(body.delta).toBeDefined();
    expect(body.delta.marketRegression.beta).toBeCloseTo(0.10, 6);
    expect(body.delta.marketRegression.alpha).toBeCloseTo(0.01, 6);
    expect(body.delta.marketRegression.rSquared).toBeCloseTo(0.05, 6);

    // compute fn called twice (now + week-ago)
    expect(computeFn).toHaveBeenCalledTimes(2);
    const secondCallArgs = computeFn.mock.calls[1][1] as { asOfDate?: string };
    expect(typeof secondCallArgs.asOfDate).toBe("string");
    expect(secondCallArgs.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns 200 with null delta when week-ago has no marketRegression", async () => {
    computeFn
      .mockReturnValueOnce(
        fakeResult({
          marketRegression: {
            beta: 1.0,
            alpha: 0,
            rSquared: 0.8,
            trackingError: 0,
            correlation: 0,
            dataPoints: 100,
            windowStart: "2025-01-02",
            windowEnd: "2025-12-31",
          },
        })
      )
      .mockReturnValueOnce(
        fakeResult({ marketRegression: null })
      );

    const req = new Request("http://x/api/compute/factors?scope=vanguard");
    const res = await GET(req as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.delta.marketRegression.beta).toBeNull();
    expect(body.delta.marketRegression.alpha).toBeNull();
    expect(body.delta.marketRegression.rSquared).toBeNull();
  });
});

describe("GET /api/compute/factors: the whole scope, and the Eastern day", () => {
  type Opts = { accountId?: number; accountIds?: number[]; asOfDate?: string; benchmarkSymbol?: string };
  const callOpts = (i: number) => computeFn.mock.calls[i][1] as Opts;

  beforeEach(() => {
    vi.clearAllMocks();
    computeFn.mockReturnValue(fakeResult());
    scopeMock.resolveScope.mockReturnValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it("a named scope forwards every account id to both snapshots, not the first", async () => {
    scopeMock.resolveScope.mockReturnValue([3, 4]);
    const res = await GET(new Request("http://x/api/compute/factors?scope=ibkr") as never);
    expect((await res.json()).success).toBe(true);
    expect(scopeMock.resolveScope.mock.calls[0][1]).toBe("ibkr");
    expect(callOpts(0).accountIds).toEqual([3, 4]);
    expect(callOpts(1).accountIds).toEqual([3, 4]);
    expect(callOpts(0).accountId).toBeUndefined();
    expect(callOpts(1).accountId).toBeUndefined();
  });

  it("a one-account scope reaches the engine as that one account, exactly as before", async () => {
    scopeMock.resolveScope.mockReturnValue([2]);
    await GET(new Request("http://x/api/compute/factors?scope=roth") as never);
    // The engine reads its accounts only through normalizeAccountIds, and a
    // one-id list normalizes to the same set the old single id did.
    const { normalizeAccountIds } =
      await vi.importActual<typeof import("@/lib/compute/factors")>("@/lib/compute/factors");
    for (const i of [0, 1]) {
      expect(normalizeAccountIds(callOpts(i))).toEqual(normalizeAccountIds({ accountId: 2 }));
      expect(normalizeAccountIds(callOpts(i))).toEqual([2]);
    }
  });

  it("an explicit accountId is still one account and skips scope resolution", async () => {
    await GET(new Request("http://x/api/compute/factors?accountId=3&scope=vanguard&benchmark=QQQ") as never);
    expect(scopeMock.resolveScope).not.toHaveBeenCalled();
    expect(callOpts(0)).toEqual({ accountId: 3, benchmarkSymbol: "QQQ" });
    expect(callOpts(1).accountId).toBe(3);
    expect(callOpts(1).benchmarkSymbol).toBe("QQQ");
  });

  it("no scope is the whole portfolio", async () => {
    await GET(new Request("http://x/api/compute/factors") as never);
    expect(callOpts(0).accountId).toBeUndefined();
    expect(callOpts(0).accountIds).toBeUndefined();
  });

  it("the week-ago snapshot is seven days before the EASTERN day (21:00 ET is already tomorrow in UTC)", async () => {
    vi.useFakeTimers();
    // 2026-03-10 21:00 EDT = 2026-03-11T01:00Z
    vi.setSystemTime(new Date("2026-03-11T01:00:00Z"));
    await GET(new Request("http://x/api/compute/factors") as never);
    expect(callOpts(1).asOfDate).toBe("2026-03-03");
    expect(callOpts(0).asOfDate).toBeUndefined();
  });

  it("the route no longer collapses a scope or reads a UTC today", () => {
    const route = readFileSync("app/api/compute/factors/route.ts", "utf8");
    expect(route).not.toContain("resolveScopeToSingleId");
    expect(route).not.toContain("toISOString");
    expect(route).toContain("todayET()");
  });
});
