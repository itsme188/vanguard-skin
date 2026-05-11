import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PositionRiskResult } from "@/lib/compute/risk";

vi.mock("@/lib/compute/risk", () => ({
  computePositionRisk: vi.fn(),
}));

vi.mock("@/lib/queries/accounts", () => ({
  resolveScopeToSingleId: vi.fn(() => undefined),
}));

vi.mock("@/lib/db", () => ({
  db: {} as never,
}));

import { GET } from "@/app/api/compute/position-risk/route";
import { computePositionRisk } from "@/lib/compute/risk";

const computeFn = computePositionRisk as unknown as ReturnType<typeof vi.fn>;

function fakeResult(overrides: Partial<PositionRiskResult> = {}): PositionRiskResult {
  return {
    positions: [
      {
        securityId: 1,
        symbol: "AAPL",
        securityName: "Apple Inc.",
        weight: 0.15,
        annualizedVol: 0.25,
        riskContribution: 0.18,
        correlationWithPortfolio: 0.82,
        dataPoints: 252,
      },
    ],
    correlations: [],
    portfolioVol: 0.20,
    ...overrides,
  };
}

describe("GET /api/compute/position-risk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns { data, weekAgo, delta: null } on the happy path", async () => {
    computeFn
      .mockReturnValueOnce(fakeResult())
      .mockReturnValueOnce(
        fakeResult({
          positions: [
            {
              securityId: 1,
              symbol: "AAPL",
              securityName: "Apple Inc.",
              weight: 0.14,
              annualizedVol: 0.24,
              riskContribution: 0.16,
              correlationWithPortfolio: 0.80,
              dataPoints: 245,
            },
          ],
        })
      );

    const req = new Request("http://x/api/compute/position-risk?scope=vanguard");
    const res = await GET(req as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.weekAgo).toBeDefined();
    expect(body.delta).toBeNull();
    expect(body.data.positions).toHaveLength(1);
    expect(body.weekAgo.positions).toHaveLength(1);

    expect(computeFn).toHaveBeenCalledTimes(2);
    const secondCallArgs = computeFn.mock.calls[1][1] as { asOfDate?: string };
    expect(typeof secondCallArgs.asOfDate).toBe("string");
    expect(secondCallArgs.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns 200 even when week-ago has empty positions (no data 7d ago)", async () => {
    computeFn
      .mockReturnValueOnce(fakeResult())
      .mockReturnValueOnce(
        fakeResult({ positions: [], correlations: [], portfolioVol: null })
      );

    const req = new Request("http://x/api/compute/position-risk?scope=vanguard");
    const res = await GET(req as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.positions).toHaveLength(1);
    expect(body.weekAgo.positions).toHaveLength(0);
    expect(body.delta).toBeNull();
  });
});
