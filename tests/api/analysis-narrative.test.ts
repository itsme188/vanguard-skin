import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the compute module so tests don't actually call Sonnet.
vi.mock("@/lib/compute/analysis-narratives", () => ({
  NARRATIVE_SURFACES: [
    "factor-analysis",
    "risk-metrics",
    "position-risk",
    "factor-heatmap",
    "defense",
  ],
  generateNarrative: vi.fn().mockResolvedValue({
    narrativeMd: "Mocked narrative prose.",
    fromCache: false,
    generatedAt: "2026-05-10T22:00:00Z",
    inputFingerprint: "fp-fresh",
  }),
  computeNarrativeFingerprint: vi.fn(() => "fp-current"),
}));

// Mock the cache read so tests don't depend on the real production DB's
// analysis_narratives cache. Default: cache miss (null). Individual tests
// override with mockReturnValueOnce to exercise the cache-hit path.
vi.mock("@/lib/queries/analysis-narratives", () => ({
  getCachedNarrative: vi.fn(() => null),
  isNarrativeDrifted: vi.fn(
    (row: { inputFingerprint?: string | null } | null, current: string | null) => {
      if (!row) return false;
      if (row.inputFingerprint == null) return true;
      if (current == null) return true;
      return row.inputFingerprint !== current;
    },
  ),
}));

import {
  GET,
  POST,
  __resetRateLimitForTests,
} from "@/app/api/analysis/narrative/route";
import { getCachedNarrative } from "@/lib/queries/analysis-narratives";
import {
  generateNarrative,
  computeNarrativeFingerprint,
} from "@/lib/compute/analysis-narratives";

describe("GET /api/analysis/narrative", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimitForTests();
  });

  it("cache miss returns notGenerated WITHOUT generating (side-effect-free GET, #35)", async () => {
    const req = new Request(
      "http://x/api/analysis/narrative?scope=vanguard&surface=factor-analysis"
    );
    const res = await GET(req as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.narrativeMd).toBeNull();
    expect(body.notGenerated).toBe(true);
    // GET must never call the paid Sonnet generator.
    expect(generateNarrative).not.toHaveBeenCalled();
  });

  it("cache hit returns the cached narrative (no generation)", async () => {
    (getCachedNarrative as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      narrativeMd: "Cached prose.",
      generatedAt: "2026-05-10T22:00:00Z",
    });
    const req = new Request(
      "http://x/api/analysis/narrative?scope=vanguard&surface=risk-metrics"
    );
    const res = await GET(req as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.fromCache).toBe(true);
    expect(body.narrativeMd).toBe("Cached prose.");
    expect(generateNarrative).not.toHaveBeenCalled();
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

describe("GET /api/analysis/narrative repeated cache misses (no rate-limit, never generate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimitForTests();
  });

  it("repeated cache misses all return 200 notGenerated and never generate", async () => {
    // The GET cache-miss rate-limiter is GONE — it only existed to throttle
    // generate-on-miss, which no longer happens. Every miss is a cheap read.
    const makeReq = () =>
      new Request(
        "http://x/api/analysis/narrative?scope=all&surface=factor-analysis"
      );
    const r1 = await GET(makeReq() as never);
    const r2 = await GET(makeReq() as never);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect((await r1.json()).notGenerated).toBe(true);
    expect((await r2.json()).notGenerated).toBe(true);
    expect(generateNarrative).not.toHaveBeenCalled();
  });
});

describe("GET /api/analysis/narrative drift flag (cache-invalidation-on-drift)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimitForTests();
    (computeNarrativeFingerprint as ReturnType<typeof vi.fn>).mockReturnValue("fp-current");
  });

  const get = () =>
    GET(
      new Request(
        "http://x/api/analysis/narrative?scope=all&surface=defense",
      ) as never,
    );

  it("cached row whose fingerprint matches the current inputs is NOT drifted", async () => {
    (getCachedNarrative as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      narrativeMd: "Roughly a tenth of the book is protected.",
      generatedAt: "2026-08-24 12:00:00",
      inputFingerprint: "fp-current",
    });
    const body = await (await get()).json();
    expect(body.drifted).toBe(false);
    expect(body.narrativeMd).toContain("protected");
    expect(generateNarrative).not.toHaveBeenCalled();
  });

  it("cached row whose fingerprint no longer matches is drifted — prose still returned", async () => {
    (getCachedNarrative as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      narrativeMd: "30% protected, including that SPY put.",
      generatedAt: "2026-08-12 12:00:00",
      inputFingerprint: "fp-stale",
    });
    const body = await (await get()).json();
    expect(body.drifted).toBe(true);
    // Stale prose stays visible — the banner explains it; GET never regenerates.
    expect(body.narrativeMd).toBe("30% protected, including that SPY put.");
    expect(body.generatedAt).toBe("2026-08-12 12:00:00");
    expect(generateNarrative).not.toHaveBeenCalled();
  });

  it("legacy cached row with a NULL fingerprint is drifted", async () => {
    (getCachedNarrative as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      narrativeMd: "Pre-migration prose.",
      generatedAt: "2026-08-12 12:00:00",
      inputFingerprint: null,
    });
    const body = await (await get()).json();
    expect(body.drifted).toBe(true);
    expect(generateNarrative).not.toHaveBeenCalled();
  });

  it("a fingerprint compute failure reads as drifted, not as fresh, and still returns 200", async () => {
    (computeNarrativeFingerprint as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("hedging compute blew up");
    });
    (getCachedNarrative as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      narrativeMd: "Some prose.",
      generatedAt: "2026-08-24 12:00:00",
      inputFingerprint: "fp-current",
    });
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drifted).toBe(true);
    expect(generateNarrative).not.toHaveBeenCalled();
  });

  it("cache miss reports drifted:false (nothing stale is on screen)", async () => {
    const body = await (await get()).json();
    expect(body.notGenerated).toBe(true);
    expect(body.drifted).toBe(false);
  });

  it("never computes a fingerprint when the surface is unknown (no wasted compute)", async () => {
    const res = await GET(
      new Request("http://x/api/analysis/narrative?scope=all&surface=bogus") as never,
    );
    expect(res.status).toBe(404);
    expect(computeNarrativeFingerprint).not.toHaveBeenCalled();
  });
});

describe("POST /api/analysis/narrative fingerprint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimitForTests();
  });

  it("a fresh generation is reported as not drifted", async () => {
    const res = await POST(
      new Request("http://x/api/analysis/narrative", {
        method: "POST",
        body: JSON.stringify({ scope: "all", surface: "defense" }),
        headers: { "Content-Type": "application/json" },
      }) as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.drifted).toBe(false);
    // POST is the only path allowed to burn a paid call.
    expect(generateNarrative).toHaveBeenCalledTimes(1);
    expect(
      (generateNarrative as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).toMatchObject({ forceRegen: true });
  });
});
