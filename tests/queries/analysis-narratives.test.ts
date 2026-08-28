import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getCachedNarrative,
  upsertNarrative,
  isNarrativeDrifted,
} from "@/lib/queries/analysis-narratives";

describe("analysis-narratives cache", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  it("returns null for cache miss", () => {
    expect(
      getCachedNarrative(db, "vanguard", "factor-analysis", "2026-05-04")
    ).toBeNull();
  });

  it("upsert + read returns the same row", () => {
    upsertNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
      narrativeMd: "Tech tilt is doing the lifting.",
      modelUsed: "anthropic/claude-sonnet-4-6",
    });
    const r = getCachedNarrative(db, "vanguard", "factor-analysis", "2026-05-04");
    expect(r?.narrativeMd).toBe("Tech tilt is doing the lifting.");
    expect(r?.scope).toBe("vanguard");
    expect(r?.surfaceKey).toBe("factor-analysis");
    expect(r?.weekOf).toBe("2026-05-04");
    expect(r?.modelUsed).toBe("anthropic/claude-sonnet-4-6");
    expect(r?.generatedAt).toBeTruthy();
  });

  it("upsert is idempotent — second write replaces first, no duplicate row", () => {
    upsertNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
      narrativeMd: "v1",
      modelUsed: "anthropic/claude-sonnet-4-6",
    });
    upsertNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
      narrativeMd: "v2",
      modelUsed: "anthropic/claude-sonnet-4-6",
    });
    const r = getCachedNarrative(db, "vanguard", "factor-analysis", "2026-05-04");
    expect(r?.narrativeMd).toBe("v2");
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM analysis_narratives")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("different (scope, surface, week) tuples can coexist", () => {
    upsertNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
      narrativeMd: "a",
      modelUsed: "m",
    });
    upsertNarrative(db, {
      scope: "ibkr",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
      narrativeMd: "b",
      modelUsed: "m",
    });
    upsertNarrative(db, {
      scope: "vanguard",
      surfaceKey: "risk-metrics",
      weekOf: "2026-05-04",
      narrativeMd: "c",
      modelUsed: "m",
    });
    upsertNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-04-27",
      narrativeMd: "d",
      modelUsed: "m",
    });
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM analysis_narratives")
      .get() as { n: number };
    expect(count.n).toBe(4);
  });
});

describe("input_fingerprint drift detection", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  it("round-trips the fingerprint written at generation time", () => {
    upsertNarrative(db, {
      scope: "all",
      surfaceKey: "defense",
      weekOf: "2026-08-24",
      narrativeMd: "Roughly a fifth of the book is protected.",
      modelUsed: "m",
      inputFingerprint: "abc123",
    });
    const r = getCachedNarrative(db, "all", "defense", "2026-08-24");
    expect(r?.inputFingerprint).toBe("abc123");
  });

  it("omitting the fingerprint stores NULL (legacy writer / unknown inputs)", () => {
    upsertNarrative(db, {
      scope: "all",
      surfaceKey: "defense",
      weekOf: "2026-08-24",
      narrativeMd: "Legacy prose.",
      modelUsed: "m",
    });
    const r = getCachedNarrative(db, "all", "defense", "2026-08-24");
    expect(r?.inputFingerprint).toBeNull();
  });

  it("a re-generation overwrites the stored fingerprint", () => {
    upsertNarrative(db, {
      scope: "all",
      surfaceKey: "defense",
      weekOf: "2026-08-24",
      narrativeMd: "v1",
      modelUsed: "m",
      inputFingerprint: "fp-1",
    });
    upsertNarrative(db, {
      scope: "all",
      surfaceKey: "defense",
      weekOf: "2026-08-24",
      narrativeMd: "v2",
      modelUsed: "m",
      inputFingerprint: "fp-2",
    });
    const r = getCachedNarrative(db, "all", "defense", "2026-08-24");
    expect(r?.inputFingerprint).toBe("fp-2");
  });

  it("legacy row with a NULL fingerprint reads as drifted", () => {
    upsertNarrative(db, {
      scope: "all",
      surfaceKey: "defense",
      weekOf: "2026-08-24",
      narrativeMd: "Legacy prose.",
      modelUsed: "m",
    });
    const r = getCachedNarrative(db, "all", "defense", "2026-08-24");
    expect(isNarrativeDrifted(r, "fp-current")).toBe(true);
  });

  it("matching fingerprint is NOT drifted", () => {
    upsertNarrative(db, {
      scope: "all",
      surfaceKey: "defense",
      weekOf: "2026-08-24",
      narrativeMd: "Fresh prose.",
      modelUsed: "m",
      inputFingerprint: "fp-current",
    });
    const r = getCachedNarrative(db, "all", "defense", "2026-08-24");
    expect(isNarrativeDrifted(r, "fp-current")).toBe(false);
  });

  it("mismatched fingerprint is drifted", () => {
    upsertNarrative(db, {
      scope: "all",
      surfaceKey: "defense",
      weekOf: "2026-08-24",
      narrativeMd: "Stale prose about a SPY put that no longer exists.",
      modelUsed: "m",
      inputFingerprint: "fp-old",
    });
    const r = getCachedNarrative(db, "all", "defense", "2026-08-24");
    expect(isNarrativeDrifted(r, "fp-current")).toBe(true);
  });

  it("no cached row is not drifted (nothing to contradict)", () => {
    expect(isNarrativeDrifted(null, "fp-current")).toBe(false);
  });

  it("an uncomputable current fingerprint reads as drifted (never claim fresh unverified)", () => {
    upsertNarrative(db, {
      scope: "all",
      surfaceKey: "defense",
      weekOf: "2026-08-24",
      narrativeMd: "Fresh prose.",
      modelUsed: "m",
      inputFingerprint: "fp-current",
    });
    const r = getCachedNarrative(db, "all", "defense", "2026-08-24");
    expect(isNarrativeDrifted(r, null)).toBe(true);
  });
});
