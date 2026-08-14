import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the compute + cache modules so the route tests don't touch better-sqlite3.
vi.mock("@/lib/compute/security-regression", () => ({
  computeSecurityRegression: vi.fn().mockReturnValue({
    beta: 1.2,
    vol: 0.22,
    correlation: 0.85,
    rSquared: 0.72,
    dataPoints: 220,
  }),
}));
vi.mock("@/lib/queries/security-regressions", () => ({
  getCachedRegression: vi.fn().mockReturnValue(null), // default: cache miss
  upsertRegression: vi.fn(),
}));
// Stub the db singleton — neither mocked module touches it.
vi.mock("@/lib/db", () => ({ db: {} as never }));

import { GET, POST } from "@/app/api/security/[id]/regression/route";
import { computeSecurityRegression } from "@/lib/compute/security-regression";
import {
  getCachedRegression,
  upsertRegression,
} from "@/lib/queries/security-regressions";

const makeReq = (
  id: string,
  qs = "?benchmark=SPY"
): { request: Request; ctx: { params: Promise<{ id: string }> } } => ({
  request: new Request(`http://x/api/security/${id}/regression${qs}`),
  ctx: { params: Promise.resolve({ id }) },
});

describe("GET /api/security/[id]/regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the default mock returns after clearAllMocks resets them.
    vi.mocked(getCachedRegression).mockReturnValue(null);
    vi.mocked(computeSecurityRegression).mockReturnValue({
      beta: 1.2,
      vol: 0.22,
      correlation: 0.85,
      rSquared: 0.72,
      dataPoints: 220,
    });
  });

  it("on cache miss, computes fresh and RETURNS it WITHOUT writing the cache (side-effect-free GET, #35)", async () => {
    const { request, ctx } = makeReq("42");
    const res = await GET(request, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.fromCache).toBe(false);
    expect(body.data).toEqual({
      beta: 1.2,
      vol: 0.22,
      correlation: 0.85,
      rSquared: 0.72,
      dataPoints: 220,
    });
    expect(getCachedRegression).toHaveBeenCalledWith({}, 42, "SPY");
    expect(computeSecurityRegression).toHaveBeenCalledWith({}, 42, "SPY");
    // The GET must NOT persist — the write moved to POST.
    expect(upsertRegression).not.toHaveBeenCalled();
  });

  it("on cache hit, returns cached row and skips compute", async () => {
    vi.mocked(getCachedRegression).mockReturnValue({
      beta: 0.8,
      vol: 0.15,
      correlation: 0.6,
      rSquared: 0.36,
      dataPoints: 250,
      computedAtDay: "2026-05-09",
    });

    const { request, ctx } = makeReq("99");
    const res = await GET(request, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.fromCache).toBe(true);
    expect(body.data.beta).toBe(0.8);
    expect(computeSecurityRegression).not.toHaveBeenCalled();
    expect(upsertRegression).not.toHaveBeenCalled();
  });

  it("returns 400 when id is not an integer", async () => {
    const { request, ctx } = makeReq("not-a-number");
    const res = await GET(request, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(getCachedRegression).not.toHaveBeenCalled();
    expect(computeSecurityRegression).not.toHaveBeenCalled();
  });
});

describe("POST /api/security/[id]/regression (persist path, #35)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(computeSecurityRegression).mockReturnValue({
      beta: 1.2,
      vol: 0.22,
      correlation: 0.85,
      rSquared: 0.72,
      dataPoints: 220,
    });
  });

  it("computes fresh and WRITES back to the cache", async () => {
    const { request, ctx } = makeReq("42");
    const res = await POST(request, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.fromCache).toBe(false);
    expect(body.data.beta).toBe(1.2);
    expect(computeSecurityRegression).toHaveBeenCalledWith({}, 42, "SPY");
    expect(upsertRegression).toHaveBeenCalledOnce();
  });

  it("returns null data + does not write when there's insufficient history", async () => {
    vi.mocked(computeSecurityRegression).mockReturnValue(
      null as unknown as ReturnType<typeof computeSecurityRegression>,
    );
    const { request, ctx } = makeReq("7");
    const res = await POST(request, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeNull();
    expect(upsertRegression).not.toHaveBeenCalled();
  });

  it("returns 400 when id is not an integer (no compute, no write)", async () => {
    const { request, ctx } = makeReq("nope");
    const res = await POST(request, ctx);
    expect(res.status).toBe(400);
    expect(computeSecurityRegression).not.toHaveBeenCalled();
    expect(upsertRegression).not.toHaveBeenCalled();
  });
});
