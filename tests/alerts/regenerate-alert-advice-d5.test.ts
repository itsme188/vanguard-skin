/**
 * D5 — a moving-average alert's stored AI advice can be regenerated.
 * Synthetic symbols and invented prices only. The AI call is mocked at the
 * `ai` generateText seam and the provider's model lookup, never a real model.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

const generateTextMock = vi.fn();
vi.mock("ai", () => ({ generateText: (...a: unknown[]) => generateTextMock(...a) }));
vi.mock("@/lib/ai/provider", () => ({ getModelForFeature: vi.fn(() => "test-model") }));

import { runMigrations } from "@/lib/db/migrate";
import { upsertLevel, triggerLevel, setAlertSuggestion } from "@/lib/mutations/security-levels";
import {
  regenerateSuggestionForAlert,
  claimRegenerateSlot,
  releaseRegenerateSlot,
  __resetRegenerateLimitForTests,
} from "@/lib/alerts/generate-suggestion";

let db: Database.Database;

function seedMaAlert(withAdvice: string | null): number {
  const secId = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES ('ZZA', 'ZZA Corp', 'stock', 'equity', 1)",
    )
    .run().lastInsertRowid as number;
  const levelId = upsertLevel(db, {
    security_id: secId,
    level_type: "support",
    price: 60,
    price_source: "sma_9",
  });
  const { alertId } = triggerLevel(db, {
    levelId,
    securityId: secId,
    triggeredPrice: 99,
    thresholdPrice: 100,
  });
  if (withAdvice) setAlertSuggestion(db, alertId as number, withAdvice);
  return alertId as number;
}

const stored = (id: number) =>
  (db.prepare("SELECT suggested_action FROM level_alerts WHERE id = ?").get(id) as {
    suggested_action: string | null;
  }).suggested_action;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  generateTextMock.mockReset();
  __resetRegenerateLimitForTests();
});

describe("regenerateSuggestionForAlert", () => {
  it("replaces an existing stored sentence with one call and returns it", async () => {
    const id = seedMaAlert("Trim near $60.00.");
    generateTextMock.mockResolvedValue({ text: " Wait for a hold above $100.00. " });
    const r = await regenerateSuggestionForAlert(db, id);
    expect(r).toEqual({ ok: true, suggestion: "Wait for a hold above $100.00." });
    expect(stored(id)).toBe("Wait for a hold above $100.00.");
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock.mock.calls[0][0].prompt).toContain("$100.00");
  });

  it("keeps the old sentence when the model call fails", async () => {
    const id = seedMaAlert("Old advice.");
    generateTextMock.mockRejectedValue(new Error("boom"));
    const r = await regenerateSuggestionForAlert(db, id);
    expect(r).toEqual({ ok: false, reason: "generation_failed" });
    expect(stored(id)).toBe("Old advice.");
  });

  it("reports an unknown alert without calling the model", async () => {
    const r = await regenerateSuggestionForAlert(db, 9999);
    expect(r).toEqual({ ok: false, reason: "not_found" });
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

describe("regenerate rate limit (per alert)", () => {
  it("blocks a second claim for the same alert inside the window and frees it on release", () => {
    expect(claimRegenerateSlot(7, 1_000).ok).toBe(true);
    const second = claimRegenerateSlot(7, 2_000);
    expect(second.ok).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);
    expect(claimRegenerateSlot(8, 2_000).ok).toBe(true); // other alert unaffected
    releaseRegenerateSlot(7);
    expect(claimRegenerateSlot(7, 2_500).ok).toBe(true);
  });
});

describe("the route and the card", () => {
  it("route is a thin wrapper that reads ?id= and maps the rate limit to 429", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/api/alerts/suggest/route.ts", "utf8");
    expect(src).toContain('searchParams.get("id")');
    expect(src).toContain("regenerateSuggestionForAlert");
    expect(src).toContain("429");
  });

  it("card offers a Regenerate control that says it makes one AI call", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/dashboard/alerts/page.tsx", "utf8");
    expect(src).toContain("Regenerate advice");
    expect(src).toContain("/api/alerts/suggest?id=");
    expect(src).toMatch(/one AI call/);
  });
});
