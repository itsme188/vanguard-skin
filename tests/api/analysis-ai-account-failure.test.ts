/**
 * QA finding (medium): an Anthropic account outage (out of credit) reached
 * the Analysis generate routes as a 500 carrying the raw provider text
 * (narrative) or a "try again in a few minutes" sentence (macro themes).
 *
 * Both routes now answer an account-level failure (`accountFailureOf`) with
 * HTTP 503, `reason: "ai_account"` and the shared `aiUnavailableReason(kind)`
 * sentence; the provider text goes to the server log only. Any other failure
 * keeps its old answer. The error is built by the REAL AI SDK against a
 * canned Anthropic envelope (tests/helpers/ai-sdk-real-errors.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { aiUnavailableReason } from "@/lib/earnings/ai-unavailable";
import {
  ANTHROPIC_FAILURES,
  CREDIT_BALANCE_MESSAGE,
  errorFromRealSdk,
} from "@/tests/helpers/ai-sdk-real-errors";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("@/lib/compute/analysis-narratives", () => ({
  NARRATIVE_SURFACES: ["factor-analysis", "risk-metrics", "position-risk", "factor-heatmap", "defense"],
  generateNarrative: vi.fn(),
  computeNarrativeFingerprint: vi.fn(() => "fp-current"),
  provenNarrativeBenchmark: vi.fn(() => null),
}));

import { generateNarrative } from "@/lib/compute/analysis-narratives";
import * as macroThemes from "@/lib/compute/macro-themes";
import {
  POST as narrativePOST,
  __resetRateLimitForTests,
} from "@/app/api/analysis/narrative/route";
import {
  POST as macroPOST,
  __resetMacroRegenLimitForTests,
} from "@/app/api/analysis/macro-themes/route";

let creditError: unknown;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  __resetRateLimitForTests();
  __resetMacroRegenLimitForTests();
  vi.mocked(generateNarrative).mockReset();
  creditError ??= (await errorFromRealSdk(ANTHROPIC_FAILURES.billing400, { maxRetries: 0 })).error;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function narrativeReq() {
  return new Request("http://x/api/analysis/narrative", {
    method: "POST",
    body: JSON.stringify({ scope: "vanguard", surface: "factor-analysis" }),
    headers: { "Content-Type": "application/json" },
  }) as never;
}

function macroReq(scope = "all") {
  return new Request("http://localhost/api/analysis/macro-themes", {
    method: "POST",
    body: JSON.stringify({ scope }),
    headers: { "Content-Type": "application/json" },
  }) as unknown as NextRequest;
}

describe("POST /api/analysis/narrative — account outage", () => {
  it("answers 503 with the shared sentence, never the provider text", async () => {
    vi.mocked(generateNarrative).mockRejectedValueOnce(creditError);
    const res = await narrativePOST(narrativeReq());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: aiUnavailableReason("billing"), reason: "ai_account" });
    expect(JSON.stringify(body)).not.toContain("credit balance");
    // The operator still sees the provider text.
    expect(errSpy.mock.calls.some((c: unknown[]) => c.map(String).join(" ").includes(CREDIT_BALANCE_MESSAGE))).toBe(true);
  });

  it("still releases the 24h stamp so a retry after the top-up is allowed", async () => {
    vi.mocked(generateNarrative)
      .mockRejectedValueOnce(creditError)
      .mockResolvedValueOnce({
        narrativeMd: "Prose.",
        fromCache: false,
        generatedAt: "2026-05-10T22:00:00Z",
        inputFingerprint: "fp",
      } as never);
    expect((await narrativePOST(narrativeReq())).status).toBe(503);
    expect((await narrativePOST(narrativeReq())).status).toBe(200);
  });

  it("keeps any other failure on its old 500 answer", async () => {
    vi.mocked(generateNarrative).mockRejectedValueOnce(new Error("compute regression"));
    const res = await narrativePOST(narrativeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).reason).toBeUndefined();
  });
});

describe("POST /api/analysis/macro-themes — account outage", () => {
  it("answers 503 with the shared sentence, never 'try again in a few minutes'", async () => {
    vi.spyOn(macroThemes, "generateMacroThemes").mockRejectedValueOnce(creditError);
    const res = await macroPOST(macroReq("vanguard"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: aiUnavailableReason("billing"), reason: "ai_account" });
    expect(body.error).not.toMatch(/few minutes|credit balance/);
    expect(errSpy.mock.calls.some((c: unknown[]) => c.map(String).join(" ").includes(CREDIT_BALANCE_MESSAGE))).toBe(true);
  });

  it("keeps a plain provider failure on its old 500 sentence", async () => {
    vi.spyOn(macroThemes, "generateMacroThemes").mockRejectedValueOnce(new Error("provider exploded"));
    const res = await macroPOST(macroReq("ibkr"));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Couldn't refresh macro themes — try again in a few minutes.");
  });
});
