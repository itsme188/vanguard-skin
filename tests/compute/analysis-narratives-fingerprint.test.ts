import { describe, it, expect, vi } from "vitest";

// The module under test transitively imports the AI seams; mock them so no
// test can burn a real Sonnet call when ANTHROPIC_API_KEY is in the env.
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn(),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "test-model" })),
}));

import {
  canonicalJson,
  fingerprintNarrativeInputs,
  buildDefenseFingerprintInputs,
  DEFENSE_TOP_EXPOSURES_N,
} from "@/lib/compute/analysis-narratives";
import type { DefenseAnalysis } from "@/lib/compute/hedging";

// ─── Minimal DefenseAnalysis-shaped fixture ─────────────────────────────────

type Hedge = { securityId: number; badges: string[] };
type Exposure = {
  underlying: string;
  securityId: number | null;
  netExposure?: number;
  classification?: string;
  hasAmplifiers?: boolean;
  tier1CoveragePct?: number | null;
  sectorProxyCoveragePct?: number | null;
  pctOfBook?: number | null;
};

function analysis(opts: {
  hedges?: Hedge[];
  protectionRatio?: number | null;
  sectors?: Array<{ sector: string; coveragePct: number | null }>;
  betIds?: number[][];
  exposures?: Exposure[];
}): DefenseAnalysis {
  const hedges = opts.hedges ?? [
    { securityId: 11, badges: ["expiring"] },
    { securityId: 22, badges: [] },
  ];
  const sectors = opts.sectors ?? [{ sector: "Technology", coveragePct: 0.18 }];
  const betIds = opts.betIds ?? [[91, 92]];
  const exposures = opts.exposures ?? [];
  return {
    summary: {
      longExposure: 1_000_000,
      shortExposure: -100_000,
      protectiveNotional: 110_000,
      protectionRatio: opts.protectionRatio === undefined ? 0.11 : opts.protectionRatio,
      netExposure: 900_000,
      grossExposure: 1_100_000,
      hedgeCount: hedges.length,
    },
    pairs: [],
    proxies: [],
    sectorCoverage: sectors.map((s) => ({
      sector: s.sector,
      longExposure: 500_000,
      protected: 90_000,
      coveragePct: s.coveragePct,
    })),
    standaloneBets: betIds.map((ids, i) => ({
      underlying: `BET${i}`,
      exposure: -1000,
      kind: "single_name_put" as const,
      instruments: ids.map((id) => ({ securityId: id }) as never),
    })),
    rankedExposures: exposures.map((e) => ({
      underlying: e.underlying,
      securityId: e.securityId,
      netExposure: e.netExposure ?? -500_000,
      pctOfBook: e.pctOfBook === undefined ? 0.5 : e.pctOfBook,
      tier1CoveragePct: e.tier1CoveragePct === undefined ? null : e.tier1CoveragePct,
      sectorProxyCoveragePct: e.sectorProxyCoveragePct === undefined ? null : e.sectorProxyCoveragePct,
      classification: e.classification ?? "unhedged",
      hasAmplifiers: e.hasAmplifiers ?? false,
      sector: null,
    })) as never,
    hedgeScores: hedges.map((h) => ({ ...h, symbol: `S${h.securityId}` }) as never),
    diagnostics: [],
  } as unknown as DefenseAnalysis;
}

describe("canonicalJson", () => {
  it("sorts object keys so key order never changes the serialization", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("sorts array members so element order never changes the serialization", () => {
    expect(canonicalJson([{ id: 2 }, { id: 1 }])).toBe(canonicalJson([{ id: 1 }, { id: 2 }]));
  });

  it("distinguishes genuinely different content", () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });

  it("suppresses IEEE-754 tail noise without hiding real differences", () => {
    // 0.1 + 0.2 === 0.30000000000000004 — a false drift signal if hashed raw.
    expect(canonicalJson({ v: 0.1 + 0.2 })).toBe(canonicalJson({ v: 0.3 }));
    // A genuine change of the same magnitude class still registers.
    expect(canonicalJson({ v: 0.3 })).not.toBe(canonicalJson({ v: 0.30001 }));
  });

  it("keeps integer ids exact (no precision collapse on security ids)", () => {
    expect(canonicalJson({ id: 123456789 })).not.toBe(canonicalJson({ id: 123456788 }));
  });
});

describe("fingerprintNarrativeInputs", () => {
  it("returns a stable sha256 hex digest", () => {
    const fp = fingerprintNarrativeInputs("defense", { a: 1 });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintNarrativeInputs("defense", { a: 1 })).toBe(fp);
  });

  it("is order-independent across keys and arrays", () => {
    const a = fingerprintNarrativeInputs("defense", {
      hedges: [{ id: 2, badges: ["a", "b"] }, { id: 1, badges: [] }],
      ratio: 0.11,
    });
    const b = fingerprintNarrativeInputs("defense", {
      ratio: 0.11,
      hedges: [{ badges: [], id: 1 }, { badges: ["b", "a"], id: 2 }],
    });
    expect(a).toBe(b);
  });

  it("namespaces by surface key — same inputs, different surface, different hash", () => {
    expect(fingerprintNarrativeInputs("defense", { a: 1 })).not.toBe(
      fingerprintNarrativeInputs("risk-metrics", { a: 1 }),
    );
  });
});

describe("buildDefenseFingerprintInputs", () => {
  it("is order-independent — reordering hedges/sectors/bets keeps the hash", () => {
    const a = buildDefenseFingerprintInputs(
      analysis({
        hedges: [
          { securityId: 11, badges: ["expiring", "expensive"] },
          { securityId: 22, badges: [] },
        ],
        sectors: [
          { sector: "Technology", coveragePct: 0.18 },
          { sector: "Energy", coveragePct: 0.02 },
        ],
        betIds: [[91], [92]],
      }),
    );
    const b = buildDefenseFingerprintInputs(
      analysis({
        hedges: [
          { securityId: 22, badges: [] },
          { securityId: 11, badges: ["expensive", "expiring"] },
        ],
        sectors: [
          { sector: "Energy", coveragePct: 0.02 },
          { sector: "Technology", coveragePct: 0.18 },
        ],
        betIds: [[92], [91]],
      }),
    );
    expect(fingerprintNarrativeInputs("defense", a)).toBe(fingerprintNarrativeInputs("defense", b));
  });

  it("changes when a hedge position id changes (the SPY put that no longer exists)", () => {
    const before = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(analysis({ hedges: [{ securityId: 11, badges: [] }] })),
    );
    const after = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(analysis({ hedges: [{ securityId: 12, badges: [] }] })),
    );
    expect(after).not.toBe(before);
  });

  it("changes when a hedge's badge state changes", () => {
    const before = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(analysis({ hedges: [{ securityId: 11, badges: [] }] })),
    );
    const after = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(analysis({ hedges: [{ securityId: 11, badges: ["decayed"] }] })),
    );
    expect(after).not.toBe(before);
  });

  it("changes when the protection ratio moves past the 0.5pp rounding step (11% -> 30%)", () => {
    const before = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(analysis({ protectionRatio: 0.11 })),
    );
    const after = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(analysis({ protectionRatio: 0.3 })),
    );
    expect(after).not.toBe(before);
  });

  it("does NOT change for sub-rounding protection-ratio noise", () => {
    const a = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(analysis({ protectionRatio: 0.1101 })),
    );
    const b = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(analysis({ protectionRatio: 0.10993 })),
    );
    expect(a).toBe(b);
  });

  it("changes when per-sector coverage moves a full rounding step, not for noise", () => {
    const base = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(analysis({ sectors: [{ sector: "Technology", coveragePct: 0.18 }] })),
    );
    const noise = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(analysis({ sectors: [{ sector: "Technology", coveragePct: 0.18024 }] })),
    );
    const moved = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(analysis({ sectors: [{ sector: "Technology", coveragePct: 0.25 }] })),
    );
    expect(noise).toBe(base);
    expect(moved).not.toBe(base);
  });

  it("changes when the standalone-bets list changes", () => {
    const before = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(analysis({ betIds: [[91]] })),
    );
    const after = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(analysis({ betIds: [[91, 93]] })),
    );
    expect(after).not.toBe(before);
  });

  it("ignores dollar magnitudes that are not materially narrative-relevant", () => {
    const a = buildDefenseFingerprintInputs(analysis({}));
    const withBigDollars = analysis({});
    withBigDollars.summary.longExposure = 99_000_000;
    withBigDollars.summary.grossExposure = 99_000_000;
    withBigDollars.sectorCoverage[0].longExposure = 42;
    const b = buildDefenseFingerprintInputs(withBigDollars);
    expect(fingerprintNarrativeInputs("defense", a)).toBe(fingerprintNarrativeInputs("defense", b));
  });

  it("tolerates a null protection ratio / null sector coverage", () => {
    const fp = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(
        analysis({ protectionRatio: null, sectors: [{ sector: "Energy", coveragePct: null }] }),
      ),
    );
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  // ─── Ranked exposures: the exited-position drift Codex found ──────────────
  // The Defense prompt names the largest UNPROTECTED exposures — selling or
  // replacing one must invalidate the cache even though every other hashed
  // field (hedges, protection ratio, sector coverage, standalone bets) is
  // untouched.

  it("changes when the top exposure is swapped for a different identity", () => {
    const before = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(
        analysis({
          exposures: [
            { underlying: "AAPL", securityId: 1 },
            { underlying: "MSFT", securityId: 2 },
          ],
        }),
      ),
    );
    const after = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(
        analysis({
          // AAPL exited the book; TSLA took its place at rank 0.
          exposures: [
            { underlying: "TSLA", securityId: 3 },
            { underlying: "MSFT", securityId: 2 },
          ],
        }),
      ),
    );
    expect(after).not.toBe(before);
  });

  it("rank-swap-only (same identities, same rounded fields) does NOT change the hash", () => {
    // hedging.ts ranks by exact dollar exposure with no tie-break, so two
    // near-equal or tied positions can cross or swap order on a rerun with
    // zero economic change. The fingerprint carries no ordinal `rank` field
    // (only membership in the top-N set), so a pure order flip — same
    // identities, same rounded fields — must NOT read as drift.
    const before = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(
        analysis({
          exposures: [
            { underlying: "AAPL", securityId: 1 },
            { underlying: "MSFT", securityId: 2 },
          ],
        }),
      ),
    );
    const after = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(
        analysis({
          exposures: [
            { underlying: "MSFT", securityId: 2 },
            { underlying: "AAPL", securityId: 1 },
          ],
        }),
      ),
    );
    expect(after).toBe(before);
  });

  it("does NOT change when only a dollar exposure value moves (identity/rounded fields unchanged)", () => {
    const a = buildDefenseFingerprintInputs(
      analysis({
        exposures: [
          { underlying: "AAPL", securityId: 1, netExposure: -500_000 },
          { underlying: "MSFT", securityId: 2, netExposure: -250_000 },
        ],
      }),
    );
    const b = buildDefenseFingerprintInputs(
      analysis({
        exposures: [
          { underlying: "AAPL", securityId: 1, netExposure: -5_000_000 },
          { underlying: "MSFT", securityId: 2, netExposure: -3 },
        ],
      }),
    );
    expect(fingerprintNarrativeInputs("defense", a)).toBe(fingerprintNarrativeInputs("defense", b));
  });

  it("does NOT change for sub-rounding coverage noise on an exposure, but changes past the 0.5pp step", () => {
    const base = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(
        analysis({ exposures: [{ underlying: "AAPL", securityId: 1, tier1CoveragePct: 0.18 }] }),
      ),
    );
    const noise = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(
        analysis({ exposures: [{ underlying: "AAPL", securityId: 1, tier1CoveragePct: 0.18024 }] }),
      ),
    );
    const moved = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(
        analysis({ exposures: [{ underlying: "AAPL", securityId: 1, tier1CoveragePct: 0.25 }] }),
      ),
    );
    expect(noise).toBe(base);
    expect(moved).not.toBe(base);
  });

  it("changes when an exposure's protected/unprotected classification changes", () => {
    const before = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(
        analysis({ exposures: [{ underlying: "AAPL", securityId: 1, classification: "unhedged" }] }),
      ),
    );
    const after = fingerprintNarrativeInputs(
      "defense",
      buildDefenseFingerprintInputs(
        analysis({ exposures: [{ underlying: "AAPL", securityId: 1, classification: "hedged_long" }] }),
      ),
    );
    expect(after).not.toBe(before);
  });

  it("only hashes the top DEFENSE_TOP_EXPOSURES_N ranked exposures, matching the prompt slice", () => {
    const many = Array.from({ length: DEFENSE_TOP_EXPOSURES_N + 2 }, (_, i) => ({
      underlying: `SYM${i}`,
      securityId: i,
    }));
    const a = buildDefenseFingerprintInputs(analysis({ exposures: many }));
    expect(a.topExposures).toHaveLength(DEFENSE_TOP_EXPOSURES_N);

    // Changing an exposure ranked beyond N must not move the hash — the
    // prompt itself never saw that row.
    const changedBeyondN = many.map((e, i) =>
      i === many.length - 1 ? { underlying: "CHANGED", securityId: 999 } : e,
    );
    const b = buildDefenseFingerprintInputs(analysis({ exposures: changedBeyondN }));
    expect(fingerprintNarrativeInputs("defense", a)).toBe(fingerprintNarrativeInputs("defense", b));
  });
});
