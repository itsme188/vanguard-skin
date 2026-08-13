import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PortfolioRiskMetrics } from "@/lib/compute/risk";

vi.mock("@/lib/compute/risk", () => ({
  computeRiskMetrics: vi.fn(),
}));

vi.mock("@/lib/queries/accounts", () => ({
  resolveScopeToSingleId: vi.fn(() => undefined),
}));

vi.mock("@/lib/db", () => ({
  db: {} as never,
}));

import { GET } from "@/app/api/compute/risk/route";
import { computeRiskMetrics } from "@/lib/compute/risk";

const computeFn = computeRiskMetrics as unknown as ReturnType<typeof vi.fn>;

function fakeMetrics(overrides: Partial<PortfolioRiskMetrics> = {}): PortfolioRiskMetrics {
  return {
    maxDrawdown: {
      percent: -0.15,
      peakDate: "2026-01-01",
      troughDate: "2026-03-15",
      peakValue: 1_000_000,
      troughValue: 850_000,
      netFlowsInWindow: 0,
    },
    currentDrawdown: null,
    volatility: 0.18,
    sharpeRatio: 0.55,
    riskFreeRate: 0.0368,
    herfindahl: 0.12,
    top5Concentration: 0.45,
    top5Positions: [],
    positionCount: 50,
    dataPoints: 252,
    seriesStart: "2026-01-01",
    seriesEnd: "2026-07-21",
    seamDaysBridged: 0,
    ...overrides,
  };
}

describe("GET /api/compute/risk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns { data, weekAgo, delta } on the happy path", async () => {
    computeFn
      .mockReturnValueOnce(
        fakeMetrics({ volatility: 0.20, sharpeRatio: 0.60, herfindahl: 0.14 })
      )
      .mockReturnValueOnce(
        fakeMetrics({ volatility: 0.18, sharpeRatio: 0.55, herfindahl: 0.12 })
      );

    const req = new Request("http://x/api/compute/risk?scope=vanguard");
    const res = await GET(req as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.weekAgo).toBeDefined();
    expect(body.delta).toBeDefined();
    expect(body.delta.volatility).toBeCloseTo(0.02, 6);
    expect(body.delta.sharpeRatio).toBeCloseTo(0.05, 6);
    expect(body.delta.herfindahl).toBeCloseTo(0.02, 6);
    expect(body.delta.maxDrawdown.percent).toBeCloseTo(0, 6);

    expect(computeFn).toHaveBeenCalledTimes(2);
    const secondCallArgs = computeFn.mock.calls[1][1] as { asOfDate?: string };
    expect(typeof secondCallArgs.asOfDate).toBe("string");
    expect(secondCallArgs.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns 200 with null delta entries when week-ago has insufficient data", async () => {
    computeFn
      .mockReturnValueOnce(fakeMetrics())
      .mockReturnValueOnce(
        fakeMetrics({
          maxDrawdown: null,
          volatility: null,
          sharpeRatio: null,
          herfindahl: null,
        })
      );

    const req = new Request("http://x/api/compute/risk?scope=vanguard");
    const res = await GET(req as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.delta.maxDrawdown.percent).toBeNull();
    expect(body.delta.volatility).toBeNull();
    expect(body.delta.sharpeRatio).toBeNull();
    expect(body.delta.herfindahl).toBeNull();
  });
});
