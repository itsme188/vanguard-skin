/**
 * Tests for GET + POST /api/analysis/macro-themes
 *
 * Uses an in-memory SQLite database to avoid touching the real data/vanguard.db.
 * The route module uses `import { db } from "@/lib/db"` — we mock that module
 * before importing the route handlers (pattern: tests/api/settings-email-recipients.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertMacroThemes } from "@/lib/queries/analysis-macro-themes";

// ── Shared mock — replace the `db` singleton with an in-memory DB ──────────

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

describe("/api/analysis/macro-themes", () => {
  it("GET returns cache hit shape when present", async () => {
    const { GET } = await import("@/app/api/analysis/macro-themes/route");
    const { db } = await import("@/lib/db");
    upsertMacroThemes(db, {
      scope: "all", weekOf: "2026-05-04",
      themesJson: JSON.stringify([{
        name: "X", factor_label: "ai_exposure", direction: "risk-on",
        summary: "y".repeat(20), exposure_bucket: "low", top_contributors: [],
      }]),
      sourceSummary: null, modelUsed: "v1",
    });
    const req = new Request("http://localhost/api/analysis/macro-themes?scope=all&week=2026-05-04");
    const res = await GET(req as unknown as NextRequest);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.themes).toHaveLength(1);
  });

  it("GET cache miss returns notGenerated WITHOUT generating (side-effect-free GET, #35)", async () => {
    const macroThemes = await import("@/lib/compute/macro-themes");
    const spy = vi.spyOn(macroThemes, "generateMacroThemes");
    try {
      const { GET } = await import("@/app/api/analysis/macro-themes/route");
      const req = new Request(
        "http://localhost/api/analysis/macro-themes?scope=all&week=2026-05-04",
      );
      const res = await GET(req as unknown as NextRequest);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.notGenerated).toBe(true);
      expect(body.themes).toBeNull();
      // GET must never call the paid Sonnet generator.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("GET returns underThreshold for a cached empty-themes row", async () => {
    const { GET } = await import("@/app/api/analysis/macro-themes/route");
    const { db } = await import("@/lib/db");
    upsertMacroThemes(db, {
      scope: "all", weekOf: "2026-05-04", themesJson: "[]",
      sourceSummary: null, modelUsed: "(none — under threshold)",
    });
    const req = new Request(
      "http://localhost/api/analysis/macro-themes?scope=all&week=2026-05-04",
    );
    const res = await GET(req as unknown as NextRequest);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.underThreshold).toBe(true);
    expect(body.themes).toEqual([]);
  });

  it("GET returns 400 when scope missing", async () => {
    const { GET } = await import("@/app/api/analysis/macro-themes/route");
    const req = new Request("http://localhost/api/analysis/macro-themes");
    const res = await GET(req as unknown as NextRequest);
    expect(res.status).toBe(400);
  });

  it("POST rate-limits to once per day per scope", async () => {
    // Mock generateMacroThemes so the first POST doesn't invoke a real Sonnet
    // call when ANTHROPIC_API_KEY is loaded into the test env. The test only
    // cares about the rate-limit semantics, not the AI output.
    const macroThemes = await import("@/lib/compute/macro-themes");
    const spy = vi
      .spyOn(macroThemes, "generateMacroThemes")
      .mockResolvedValue({
        themes: [],
        sourceSummary: null,
        fromCache: false,
        generatedAt: new Date().toISOString(),
        underThreshold: true,
      });
    try {
      const { POST, __resetMacroRegenLimitForTests } = await import("@/app/api/analysis/macro-themes/route");
      __resetMacroRegenLimitForTests();
      const make = () => new Request("http://localhost/api/analysis/macro-themes", {
        method: "POST",
        body: JSON.stringify({ scope: "all" }),
        headers: { "Content-Type": "application/json" },
      });
      await POST(make() as unknown as NextRequest);
      const res2 = await POST(make() as unknown as NextRequest);
      expect(res2.status).toBe(429);
      // `reason` is what lets the card tell this limit from the short
      // post-failure cooldown, which needs different copy entirely.
      expect((await res2.json()).reason).toBe("daily");
    } finally {
      spy.mockRestore();
    }
  });

  // ── Failure handling: a malformed model reply must not lock the scope ─────
  // QA finding `analysis-macro-themes--cold-cache-500-raw-parser-message-regression-1`:
  // the route stamped the 24h window BEFORE generating, so one unparseable
  // Sonnet reply 500'd and then 429'd every later page load for a full day.

  const OK_RESULT = {
    themes: [],
    sourceSummary: null,
    fromCache: false,
    generatedAt: new Date().toISOString(),
    underThreshold: true,
  };

  function makePost(scope: string) {
    return () =>
      new Request("http://localhost/api/analysis/macro-themes", {
        method: "POST",
        body: JSON.stringify({ scope }),
        headers: { "Content-Type": "application/json" },
      }) as unknown as NextRequest;
  }

  it("POST failure does NOT consume the 24h window", async () => {
    const macroThemes = await import("@/lib/compute/macro-themes");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi
      .spyOn(macroThemes, "generateMacroThemes")
      .mockRejectedValueOnce(
        new macroThemes.MacroThemesParseError(
          "The model's reply couldn't be read as themes — try again in a moment.",
          'Unterminated string in JSON at position 1074 — reply began: [{"name":"QAAA rotation","fa',
        ),
      )
      .mockResolvedValue(OK_RESULT);
    try {
      const { POST, __resetMacroRegenLimitForTests, __clearMacroFailCooldownForTests } =
        await import("@/app/api/analysis/macro-themes/route");
      __resetMacroRegenLimitForTests();
      const makeReq = makePost("vanguard");

      const res1 = await POST(makeReq());
      expect(res1.status).toBe(500);

      // Only the short failure cooldown was stamped. Clear it and the next
      // request reaches the generator again instead of 429ing for 24h.
      __clearMacroFailCooldownForTests();
      const res2 = await POST(makeReq());
      expect(res2.status).toBe(200);
      expect((await res2.json()).success).toBe(true);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("POST failure body carries the user-facing message, never the raw parser text", async () => {
    const macroThemes = await import("@/lib/compute/macro-themes");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const detail =
      'Unterminated string in JSON at position 1074 — reply began: [{"name":"QAAA rotation","fa';
    const spy = vi
      .spyOn(macroThemes, "generateMacroThemes")
      .mockRejectedValue(
        new macroThemes.MacroThemesParseError(
          "The model's reply couldn't be read as themes — try again in a moment.",
          detail,
        ),
      );
    try {
      const { POST, __resetMacroRegenLimitForTests } =
        await import("@/app/api/analysis/macro-themes/route");
      __resetMacroRegenLimitForTests();
      const res = await POST(makePost("ibkr")());
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe(
        "The model's reply couldn't be read as themes — try again in a moment.",
      );
      expect(body.error).not.toMatch(/JSON|position|Unexpected|Unterminated/);
      expect(body.error).not.toContain(detail);
      // ...but the operator still gets it in the server log.
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("position 1074"))).toBe(true);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("POST 429s a retry inside the 10-minute failure cooldown, with a short retryAfter", async () => {
    const macroThemes = await import("@/lib/compute/macro-themes");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi
      .spyOn(macroThemes, "generateMacroThemes")
      .mockRejectedValue(
        new macroThemes.MacroThemesParseError(
          "The model's reply couldn't be read as themes — try again in a moment.",
          "boom",
        ),
      );
    try {
      const { POST, __resetMacroRegenLimitForTests } =
        await import("@/app/api/analysis/macro-themes/route");
      __resetMacroRegenLimitForTests();
      const makeReq = makePost("roth");

      expect((await POST(makeReq())).status).toBe(500);
      const res2 = await POST(makeReq());
      expect(res2.status).toBe(429);
      const body = await res2.json();
      expect(body.error).toBe("rate-limited");
      expect(body.reason).toBe("last_attempt_failed");
      expect(body.retryAfter).toBeGreaterThan(0);
      expect(body.retryAfter).toBeLessThanOrEqual(10 * 60 * 1000);
      // A persistently failing model is re-billed at most once per cooldown.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  // ── The in-flight claim ───────────────────────────────────────────────────
  // The 24h map is the only mutex this route has. Stamping it only AFTER the
  // await left a window in which a second POST for the same scope (two tabs, a
  // StrictMode double-effect, an A→B→A scope toggle) sailed past the limit
  // check and started a SECOND paid generation.

  it("POST 429s a concurrent second request for the same scope instead of billing twice", async () => {
    const macroThemes = await import("@/lib/compute/macro-themes");
    let releaseGeneration!: (r: typeof OK_RESULT) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<typeof OK_RESULT>((resolve) => {
      releaseGeneration = resolve;
    });
    const spy = vi.spyOn(macroThemes, "generateMacroThemes").mockImplementation(() => {
      markStarted();
      return gate;
    });
    try {
      const { POST, __resetMacroRegenLimitForTests } =
        await import("@/app/api/analysis/macro-themes/route");
      __resetMacroRegenLimitForTests();
      const makeReq = makePost("all");

      const first = POST(makeReq());
      await started; // the first generation is now genuinely in flight

      const res2 = await POST(makeReq());
      expect(res2.status).toBe(429);
      const body = await res2.json();
      expect(body.reason).toBe("daily");

      releaseGeneration(OK_RESULT);
      expect((await first).status).toBe(200);
      // One request in flight, one paid generation.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("POST releases the 24h claim when the generation fails, so the scope is not locked out", async () => {
    const macroThemes = await import("@/lib/compute/macro-themes");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi
      .spyOn(macroThemes, "generateMacroThemes")
      .mockRejectedValueOnce(new Error("provider exploded"))
      .mockResolvedValue(OK_RESULT);
    try {
      const { POST, __resetMacroRegenLimitForTests, __clearMacroFailCooldownForTests } =
        await import("@/app/api/analysis/macro-themes/route");
      __resetMacroRegenLimitForTests();
      const makeReq = makePost("vanguard");

      expect((await POST(makeReq())).status).toBe(500);

      // Inside the failure cooldown the answer is the FAILURE 429, never the
      // daily one — the claim was released, not left standing.
      const cooled = await POST(makeReq());
      expect(cooled.status).toBe(429);
      expect((await cooled.json()).reason).toBe("last_attempt_failed");

      __clearMacroFailCooldownForTests();
      expect((await POST(makeReq())).status).toBe(200);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  // ── Raw provider text never reaches the card ──────────────────────────────
  // generateMacroThemes also throws plain Errors carrying provider text (and a
  // refusal). Only MacroThemesParseError writes a message for a reader; the
  // rest used to render verbatim, in red, in the Macro card.

  it("POST replaces a non-parse failure message with user-facing copy, logging the raw text", async () => {
    const macroThemes = await import("@/lib/compute/macro-themes");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = "macro-themes generation failed: 529 overloaded_error from the provider";
    const spy = vi
      .spyOn(macroThemes, "generateMacroThemes")
      .mockRejectedValue(new Error(raw));
    try {
      const { POST, __resetMacroRegenLimitForTests } =
        await import("@/app/api/analysis/macro-themes/route");
      __resetMacroRegenLimitForTests();
      const res = await POST(makePost("roth")());
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe("Couldn't refresh macro themes — try again in a few minutes.");
      expect(body.error).not.toContain("overloaded_error");
      expect(body.error).not.toContain("provider");
      // ...but the operator still gets the raw text in the server log.
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("overloaded_error"))).toBe(true);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
