import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/compute/hedging", () => ({ computeDefenseAnalysis: vi.fn() }));
vi.mock("@/lib/queries/accounts", () => ({ resolveScope: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} as never }));

import { GET } from "@/app/api/analysis/defense/route";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";
import { resolveScope } from "@/lib/queries/accounts";

function makeReq(qs: string) {
  return { nextUrl: new URL(`http://localhost/api/analysis/defense${qs}`) };
}

describe("GET /api/analysis/defense", () => {
  beforeEach(() => {
    vi.mocked(resolveScope).mockReturnValue([1]);
    vi.mocked(computeDefenseAnalysis).mockReturnValue({ summary: { hedgeCount: 2 } } as never);
  });

  it("wraps the analysis in the {success, data} envelope", async () => {
    const res = await GET(makeReq("?scope=vanguard") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ summary: { hedgeCount: 2 } });
  });

  it("returns {success:false, error} with 500 on compute failure", async () => {
    vi.mocked(computeDefenseAnalysis).mockImplementation(() => {
      throw new Error("boom");
    });
    const res = await GET(makeReq("?scope=all") as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("boom");
  });
});
