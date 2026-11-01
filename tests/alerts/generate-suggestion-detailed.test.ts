/** Detailed suggestion generator: the failure names its cause. Synthetic data only. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

const generateTextMock = vi.fn();
vi.mock("ai", () => ({ generateText: (...a: unknown[]) => generateTextMock(...a) }));
vi.mock("@/lib/ai/provider", () => ({ getModelForFeature: vi.fn(() => "test-model") }));

import { runMigrations } from "@/lib/db/migrate";
import { upsertLevel, triggerLevel } from "@/lib/mutations/security-levels";
import { generateSuggestionForAlertDetailed } from "@/lib/alerts/generate-suggestion";
import { APIError } from "@anthropic-ai/sdk";

let db: Database.Database;

function seedMaAlert(_x: null): number {
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
  return alertId as number;
}


beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  generateTextMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("generateSuggestionForAlertDetailed", () => {
  it("unknown alert is not_found", async () => {
    const r = await generateSuggestionForAlertDetailed(db, 9999);
    expect(r).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("a credit error is ai_account", async () => {
    const id = seedMaAlert(null);
    generateTextMock.mockRejectedValue(
      APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }, "400", new Headers()),
    );
    const r = await generateSuggestionForAlertDetailed(db, id);
    expect(r).toMatchObject({ ok: false, reason: "ai_account" });
  });

  it("an unconfigured gateway is ai_not_configured", async () => {
    const id = seedMaAlert(null);
    generateTextMock.mockRejectedValue(
      new Error("Cloudflare AI Gateway must be configured to use Workers AI (feature: alertSuggestion). Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_GATEWAY_ID."),
    );
    const r = await generateSuggestionForAlertDetailed(db, id);
    expect(r).toMatchObject({ ok: false, reason: "ai_not_configured", message: "AI suggestions are not configured on this machine." });
  });

  it("another error is generation_failed", async () => {
    const id = seedMaAlert(null);
    generateTextMock.mockRejectedValue(new Error("bad shape"));
    const r = await generateSuggestionForAlertDetailed(db, id);
    expect(r).toMatchObject({ ok: false, reason: "generation_failed" });
  });

  it("success returns and stores the sentence", async () => {
    const id = seedMaAlert(null);
    generateTextMock.mockResolvedValue({ text: " Hold. " });
    expect(await generateSuggestionForAlertDetailed(db, id)).toEqual({ ok: true, suggestion: "Hold." });
  });
});
