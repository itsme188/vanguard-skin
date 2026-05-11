import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/queries/drill-down", () => ({
  getHoldingsInBucket: vi.fn().mockReturnValue([
    {
      symbol: "AAPL",
      securityName: "Apple Inc",
      securityId: 1,
      marketValue: 50000,
      weight: 0.1,
      beta: 1.2,
      factors: { ai_exposure: "High" },
      sector: "Technology",
    },
  ]),
}));
vi.mock("@/lib/queries/accounts", () => ({
  resolveScope: vi.fn().mockReturnValue([1, 2]),
}));
// Stub the db singleton — neither mocked module touches it.
vi.mock("@/lib/db", () => ({ db: {} as never }));

import { GET } from "@/app/api/analysis/drill-down/route";
import { getHoldingsInBucket } from "@/lib/queries/drill-down";
import { resolveScope } from "@/lib/queries/accounts";

const makeReq = (qs: string): Request =>
  new Request(`http://x/api/analysis/drill-down${qs}`);

describe("GET /api/analysis/drill-down", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveScope).mockReturnValue([1, 2]);
    vi.mocked(getHoldingsInBucket).mockReturnValue([
      {
        symbol: "AAPL",
        securityName: "Apple Inc",
        securityId: 1,
        marketValue: 50000,
        weight: 0.1,
        beta: 1.2,
        factors: { ai_exposure: "High" },
        sector: "Technology",
      },
    ]);
  });

  it("classification kind happy path returns 200 + rows", async () => {
    const res = await GET(
      makeReq(
        "?scope=vanguard&kind=classification&dimension=sector&bucket=Technology"
      ) as never
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].symbol).toBe("AAPL");
    // Verify the route resolved the scope and forwarded the discriminated-union
    // filter through to getHoldingsInBucket.
    expect(resolveScope).toHaveBeenCalledWith({}, "vanguard");
    expect(getHoldingsInBucket).toHaveBeenCalledWith(
      {},
      "vanguard",
      { kind: "classification", dimension: "sector", bucket: "Technology" },
      [1, 2]
    );
  });

  it("returns 400 when scope is missing", async () => {
    const res = await GET(
      makeReq(
        "?kind=classification&dimension=sector&bucket=Technology"
      ) as never
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/scope/i);
    expect(getHoldingsInBucket).not.toHaveBeenCalled();
  });

  it("returns 400 when kind is unknown", async () => {
    const res = await GET(makeReq("?scope=vanguard&kind=bogus") as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/kind/i);
    expect(getHoldingsInBucket).not.toHaveBeenCalled();
  });
});
