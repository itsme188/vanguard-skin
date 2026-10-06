import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  positionRisk: vi.fn(),
  greeks: vi.fn(),
  resolveScope: vi.fn(),
}));

vi.mock("@/lib/compute/risk", async (orig) => ({
  ...(await orig<typeof import("@/lib/compute/risk")>()),
  computePositionRisk: hoisted.positionRisk,
}));
vi.mock("@/lib/compute/options-greeks", async (orig) => ({
  ...(await orig<typeof import("@/lib/compute/options-greeks")>()),
  computePortfolioGreeks: hoisted.greeks,
}));
vi.mock("@/lib/queries/accounts", () => ({
  resolveScope: hoisted.resolveScope,
}));
vi.mock("@/lib/db", () => ({ db: {} as never }));

import { GET as positionRiskGET } from "@/app/api/compute/position-risk/route";
import { GET as greeksGET } from "@/app/api/compute/options-greeks/route";
import { NextRequest } from "next/server";

const req = (path: string) => new NextRequest(`http://localhost${path}`);

describe("compute routes pass the whole scope set", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.positionRisk.mockReturnValue({ positions: [], correlations: [], portfolioVol: null });
    hoisted.greeks.mockReturnValue({ positions: [] });
    hoisted.resolveScope.mockReturnValue([1, 2, 3]);
  });
  afterEach(() => vi.useRealTimers());

  it("position-risk forwards every account id (not the first)", async () => {
    const res = await positionRiskGET(req("/api/compute/position-risk?scope=all"));
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(hoisted.positionRisk.mock.calls[0][1].accountIds).toEqual([1, 2, 3]);
    expect(hoisted.positionRisk.mock.calls[1][1].accountIds).toEqual([1, 2, 3]);
  });

  it("position-risk single explicit accountId stays a one-element set", async () => {
    await positionRiskGET(req("/api/compute/position-risk?accountId=2"));
    expect(hoisted.positionRisk.mock.calls[0][1].accountIds).toEqual([2]);
  });

  it("position-risk week-ago anchor uses the ET date at 21:00 ET (UTC next day)", async () => {
    vi.useFakeTimers();
    // 2026-03-10 21:00 EDT = 2026-03-11T01:00Z
    vi.setSystemTime(new Date("2026-03-11T01:00:00Z"));
    await positionRiskGET(req("/api/compute/position-risk"));
    expect(hoisted.positionRisk.mock.calls[1][1].asOfDate).toBe("2026-03-03");
  });

  it("options-greeks forwards every account id and keeps the envelope", async () => {
    const res = await greeksGET(req("/api/compute/options-greeks?scope=all"));
    const body = await res.json();
    expect(body).toEqual({ success: true, data: { positions: [] } });
    expect(hoisted.greeks.mock.calls[0][1].accountIds).toEqual([1, 2, 3]);
  });

  it("options-greeks single explicit accountId stays a one-element set", async () => {
    await greeksGET(req("/api/compute/options-greeks?accountId=3"));
    expect(hoisted.greeks.mock.calls[0][1].accountIds).toEqual([3]);
  });
});
