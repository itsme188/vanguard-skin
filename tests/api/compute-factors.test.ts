import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FactorAnalysisResult } from "@/lib/compute/factors";

// Mock the compute module so tests don't touch the DB.
vi.mock("@/lib/compute/factors", () => ({
  computeFactorAnalysis: vi.fn(),
}));

// Resolve scope locally so the route doesn't try to read the DB for it.
vi.mock("@/lib/queries/accounts", () => ({
  resolveScopeToSingleId: vi.fn(() => undefined),
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
    },
    sizeTilt: null,
    styleTilt: null,
    sectorTilt: null,
    geographyTilt: null,
    ...overrides,
  };
}

describe("GET /api/compute/factors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
