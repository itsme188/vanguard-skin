import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the compute module so tests don't actually call Sonnet.
vi.mock("@/lib/compute/analysis-narratives", () => ({
  NARRATIVE_SURFACES: [
    "factor-analysis",
    "risk-metrics",
    "position-risk",
    "factor-heatmap",
  ],
  generateNarrative: vi.fn().mockResolvedValue({
    narrativeMd: "Mocked narrative prose.",
    fromCache: false,
    generatedAt: "2026-05-10T22:00:00Z",
  }),
}));

// Mock the cache read so tests don't depend on the real production DB's
// analysis_narratives cache. Default: cache miss (null). Individual tests
// override with mockReturnValueOnce to exercise the cache-hit path.
vi.mock("@/lib/queries/analysis-narratives", () => ({
  getCachedNarrative: vi.fn(() => null),
}));

import {
  GET,
  POST,
  __resetRateLimitForTests,
} from "@/app/api/analysis/narrative/route";
import { getCachedNarrative } from "@/lib/queries/analysis-narratives";
import { generateNarrative } from "@/lib/compute/analysis-narratives";

describe("GET /api/analysis/narrative", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimitForTests();
  });

  it("returns 200 + narrativeMd shape on cache miss", async () => {
    const req = new Request(
      "http://x/api/analysis/narrative?scope=vanguard&surface=factor-analysis"
    );
    const res = await GET(req as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.narrativeMd).toBe("Mocked narrative prose.");
  });

  it("returns 400 when scope is missing", async () => {
    const req = new Request(
      "http://x/api/analysis/narrative?surface=factor-analysis"
    );
    const res = await GET(req as never);
    expect(res.status).toBe(400);
  });

  it("returns 404 when surface is unknown", async () => {
    const req = new Request(
      "http://x/api/analysis/narrative?scope=vanguard&surface=bogus"
    );
    const res = await GET(req as never);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/analysis/narrative (force regen)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimitForTests();
  });

  it("first regen returns 200; second regen within 24h returns 429", async () => {
    const makeReq = () =>
      new Request("http://x/api/analysis/narrative", {
        method: "POST",
        body: JSON.stringify({
          scope: "vanguard",
          surface: "factor-analysis",
        }),
        headers: { "Content-Type": "application/json" },
      });
    const r1 = await POST(makeReq() as never);
    expect(r1.status).toBe(200);
    const r2 = await POST(makeReq() as never);
    expect(r2.status).toBe(429);
    const body2 = await r2.json();
    expect(body2.error).toBe("rate-limited");
    expect(body2.retryAfter).toBeGreaterThan(0);
  });

  it("returns 404 when surface is unknown (defensive parity with GET)", async () => {
    const req = new Request("http://x/api/analysis/narrative", {
      method: "POST",
      body: JSON.stringify({ scope: "vanguard", surface: "bogus" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req as never);
    expect(res.status).toBe(404);
  });

  it("rolls back the rate-limit stamp on generation failure, so a retry right after isn't blocked for 24h", async () => {
    // Pre-fix: the stamp was set BEFORE calling generateNarrative and never
    // rolled back on failure, so one transient AI error bricked the Refresh
    // button for a full day.
    (generateNarrative as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Sonnet timeout")
    );
    const makeReq = () =>
      new Request("http://x/api/analysis/narrative", {
        method: "POST",
        body: JSON.stringify({
          scope: "vanguard",
          surface: "factor-analysis",
        }),
        headers: { "Content-Type": "application/json" },
      });
    const r1 = await POST(makeReq() as never);
    expect(r1.status).toBe(500);
    const r2 = await POST(makeReq() as never);
    expect(r2.status).toBe(200);
  });
});

describe("GET /api/analysis/narrative cache-miss rate-limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimitForTests();
  });

  it("first cache-miss call goes through; second within window is rate-limited", async () => {
    const makeReq = () =>
      new Request(
        "http://x/api/analysis/narrative?scope=all&surface=factor-analysis"
      );
    const r1 = await GET(makeReq() as never);
    expect(r1.status).toBe(200);
    const r2 = await GET(makeReq() as never);
    expect(r2.status).toBe(429);
    const body2 = await r2.json();
    expect(body2.error).toBe("rate-limited (cache miss)");
    expect(body2.retryAfter).toBeGreaterThan(0);
  });

  it("cache hit bypasses rate-limit (repeated cache hits always return 200)", async () => {
    const makeReq = () =>
      new Request(
        "http://x/api/analysis/narrative?scope=all&surface=risk-metrics"
      );
    // First call: cache miss (default getCachedNarrative → null) — sets the
    // cache-miss rate-limit timestamp.
    const r1 = await GET(makeReq() as never);
    expect(r1.status).toBe(200);
    // Cache is now warm: getCachedNarrative returns a row. Even within the
    // rate-limit window, a cache hit short-circuits BEFORE the limiter → 200.
    (getCachedNarrative as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      narrativeMd: "Cached prose.",
      generatedAt: "2026-05-10T22:00:00Z",
    });
    const r2 = await GET(makeReq() as never);
    expect(r2.status).toBe(200);
    const body2 = await r2.json();
    expect(body2.fromCache).toBe(true);
    expect(body2.narrativeMd).toBe("Cached prose.");
  });
});
