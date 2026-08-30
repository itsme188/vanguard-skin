import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the compute + cache modules so the route tests don't touch better-sqlite3.
// Only `computeSecurityRegression` is stubbed — `regressionBetaVerdict` stays
// REAL so these tests exercise the actual publish gate the route applies.
vi.mock("@/lib/compute/security-regression", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/compute/security-regression")>();
  return {
    ...actual,
    computeSecurityRegression: vi.fn().mockReturnValue({
      beta: 1.2,
      vol: 0.22,
      correlation: 0.85,
      rSquared: 0.72,
      dataPoints: 220,
    }),
  };
});
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
    // Long, well-correlated series (r² 0.72 over 220 pairs) — beta publishes.
    expect(body.betaVerdict).toEqual({ ok: true });
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
    expect(body.betaVerdict).toEqual({ ok: true });
    expect(computeSecurityRegression).not.toHaveBeenCalled();
    expect(upsertRegression).not.toHaveBeenCalled();
  });

  // qa: security-detail-factor-profile--regression-card-publishes-betas-failing-confidence-gate
  it("fresh compute over a short series carries betaVerdict few_pairs (beta withheld)", async () => {
    // A thinly traded / expired instrument: MIN_DATA_POINTS (10) lets 13 return
    // pairs through the compute, but 13 < 30 so the beta must not publish.
    vi.mocked(computeSecurityRegression).mockReturnValue({
      beta: 17.4,
      vol: 1.8,
      correlation: 0.22,
      rSquared: 0.05,
      dataPoints: 13,
    });

    const { request, ctx } = makeReq("42");
    const res = await GET(request, ctx);
    const body = await res.json();
    expect(body.success).toBe(true);
    // The raw statistics still travel — only the PUBLISH decision changes.
    expect(body.data.beta).toBeCloseTo(17.4, 6);
    expect(body.data.dataPoints).toBe(13);
    expect(body.betaVerdict).toEqual({ ok: false, reason: "few_pairs" });
  });

  it("cached row with low r² carries betaVerdict low_r2 (beta withheld)", async () => {
    vi.mocked(getCachedRegression).mockReturnValue({
      beta: -3.1,
      vol: 0.44,
      correlation: 0.2,
      rSquared: 0.04,
      dataPoints: 250,
      computedAtDay: "2026-08-29",
    });

    const { request, ctx } = makeReq("99");
    const res = await GET(request, ctx);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.fromCache).toBe(true);
    expect(body.data.beta).toBeCloseTo(-3.1, 6);
    expect(body.betaVerdict).toEqual({ ok: false, reason: "low_r2" });
  });

  it("omits betaVerdict when there is no regression to gate", async () => {
    vi.mocked(computeSecurityRegression).mockReturnValue(
      null as unknown as ReturnType<typeof computeSecurityRegression>,
    );
    const { request, ctx } = makeReq("7");
    const res = await GET(request, ctx);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeNull();
    expect(body.betaVerdict).toBeUndefined();
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
    expect(body.betaVerdict).toEqual({ ok: true });
    expect(computeSecurityRegression).toHaveBeenCalledWith({}, 42, "SPY");
    expect(upsertRegression).toHaveBeenCalledOnce();
  });

  it("still caches the raw statistics but reports the withheld verdict", async () => {
    vi.mocked(computeSecurityRegression).mockReturnValue({
      beta: 17.4,
      vol: 1.8,
      correlation: 0.22,
      rSquared: 0.05,
      dataPoints: 13,
    });

    const { request, ctx } = makeReq("42");
    const res = await POST(request, ctx);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.dataPoints).toBe(13);
    expect(body.betaVerdict).toEqual({ ok: false, reason: "few_pairs" });
    // The cache keeps the raw row — the gate is a read-time publish decision.
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
