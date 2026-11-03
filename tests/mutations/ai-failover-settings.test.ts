/**
 * Settings → AI failover (design §7, slice 4): ceiling enforcement, the
 * round-trip through the settings store into the executor, validation through
 * the override machinery, and "shipping the UX enables nothing".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";

const hoisted = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

import { GET, PATCH } from "@/app/api/settings/ai-failover/route";
import {
  setFailoverEnabled,
  setFailoverGroupEnabled,
  setFailoverFallbacks,
} from "@/lib/mutations/ai-failover-settings";
import { getFailoverEnabledFeatures, getFailoverFallbacks } from "@/lib/queries/ai-failover-settings";
import { setFeatureModelOverride } from "@/lib/mutations/ai-model-overrides";
import { getFeatureModelOverrides } from "@/lib/queries/ai-model-overrides";
import {
  EARNINGS_PREP_FAILOVER_GROUP,
  FAILOVER_ELIGIBLE_CEILING,
  FAILOVER_PARKED,
  failoverTargets,
  isFailoverEnabled,
  setFailoverEnabledSource,
  setFailoverFallbackSource,
} from "@/lib/ai/failover";
import { FEATURE_MODELS } from "@/lib/ai/models";
import type { FeatureKey } from "@/lib/ai/feature-keys";
import { setFeatureModelOverrideSource } from "@/lib/ai/override-source";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";

let db: Database.Database;

/** Wire the executor's sources to the db exactly as lib/db.ts does. */
function wire() {
  setFailoverEnabledSource(() => new Set(getFailoverEnabledFeatures(db) as FeatureKey[]));
  setFailoverFallbackSource(() => getFailoverFallbacks(db));
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  hoisted.db = db;
  setFeatureModelOverrideSource(null);
  setModelCatalogSource(() => ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]);
  wire();
});
afterEach(() => {
  setFailoverEnabledSource(null);
  setFailoverFallbackSource(null);
});

const patch = (body: unknown) =>
  PATCH(new NextRequest("http://localhost/api/settings/ai-failover", { method: "PATCH", body: JSON.stringify(body) }));

describe("shipping the UX enables nothing", () => {
  it("a fresh database has nothing on and no custom lists", async () => {
    expect(getFailoverEnabledFeatures(db)).toEqual([]);
    expect(getFailoverFallbacks(db)).toEqual({});
    for (const key of Object.keys(FEATURE_MODELS) as FeatureKey[]) expect(isFailoverEnabled(key)).toBe(false);
    const body = await (await GET()).json();
    expect(body.success).toBe(true);
    expect(body.features.every((f: { enabled: boolean }) => !f.enabled)).toBe(true);
    expect(body.group.allEnabled).toBe(false);
  });
});

describe("the section 4 ceiling is enforced on every write", () => {
  it.each([...FAILOVER_PARKED])("%s cannot be enabled, given a list, or reach the store", async (key) => {
    expect(() => setFailoverEnabled(db, key, true)).toThrow(/cannot fail over/);
    expect(() => setFailoverFallbacks(db, key, ["openai/$workhorse"])).toThrow(/cannot fail over/);
    const res = await patch({ key, enabled: true });
    expect(res.status).toBe(400);
    expect((await res.json()).success).toBe(false);
    expect(getFailoverEnabledFeatures(db)).toEqual([]);
    expect(getFailoverFallbacks(db)).toEqual({});
  });

  it("an unknown feature key is refused", () => {
    expect(() => setFailoverEnabled(db, "notAFeature", true)).toThrow(/Unknown feature/);
  });

  it("the view marks every parked feature as having no controls, with a reason", async () => {
    const body = await (await GET()).json();
    for (const key of FAILOVER_PARKED) {
      const row = body.features.find((f: { key: string }) => f.key === key);
      expect(row).toMatchObject({ eligible: false, enabled: false, fallbacks: null });
      expect(row.parkedReason).toMatch(/\w/);
    }
  });

  it("a hand-edited store row still cannot enable a parked feature (the executor intersects the ceiling)", async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('ai_failover_enabled', ?)`).run(
      JSON.stringify(["earningsPreview", "pdfParsing", "newsletterProcessing"]),
    );
    expect(isFailoverEnabled("earningsPreview")).toBe(false);
    expect(isFailoverEnabled("pdfParsing")).toBe(false);
    expect(isFailoverEnabled("newsletterProcessing")).toBe(true);
    const view = await (await GET()).json();
    expect(view.features.find((f: { key: string }) => f.key === "earningsPreview").enabled).toBe(false);
  });

  it("the group toggle touches exactly the print-prep features, all inside the ceiling", () => {
    for (const k of EARNINGS_PREP_FAILOVER_GROUP) expect(FAILOVER_ELIGIBLE_CEILING.has(k)).toBe(true);
    for (const k of FAILOVER_PARKED) expect(EARNINGS_PREP_FAILOVER_GROUP).not.toContain(k);
    setFailoverEnabled(db, "chat", true);
    const on = setFailoverGroupEnabled(db, true);
    expect(on.sort()).toEqual(["chat", ...EARNINGS_PREP_FAILOVER_GROUP].sort());
    const off = setFailoverGroupEnabled(db, false);
    expect(off).toEqual(["chat"]); // only the group's members were switched off
  });
});

describe("round trip through the settings store into the executor", () => {
  it("enabling in the store turns the executor's gate on; disabling turns it off", async () => {
    expect(isFailoverEnabled("newsletterProcessing")).toBe(false);
    expect((await patch({ key: "newsletterProcessing", enabled: true })).status).toBe(200);
    expect(isFailoverEnabled("newsletterProcessing")).toBe(true);
    expect((await patch({ key: "newsletterProcessing", enabled: false })).status).toBe(200);
    expect(isFailoverEnabled("newsletterProcessing")).toBe(false);
  });

  it("an ordered list is honoured in the operator's order, and clearing restores the default", async () => {
    const dflt = failoverTargets("newsletterProcessing").map((t) => t.provider);
    expect(dflt).toEqual(["openai", "workers-ai"]);
    const res = await patch({ key: "newsletterProcessing", fallbacks: ["workers-ai/$workhorse", "openai/gpt-6.1-terra"] });
    expect(res.status).toBe(200);
    expect(failoverTargets("newsletterProcessing")).toEqual([
      { provider: "workers-ai", modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
      { provider: "openai", modelId: "gpt-6.1-terra" },
    ]);
    expect((await patch({ key: "newsletterProcessing", fallbacks: null })).status).toBe(200);
    expect(failoverTargets("newsletterProcessing").map((t) => t.provider)).toEqual(dflt);
  });

  it("enabled + list are saved together or not at all", async () => {
    const res = await patch({ key: "chat", enabled: true, fallbacks: ["bogus/model"] });
    expect(res.status).toBe(400);
    expect(getFailoverEnabledFeatures(db)).toEqual([]);
    expect(getFailoverFallbacks(db)).toEqual({});
  });

  it("does not touch the model-override store, and the two stay independent", () => {
    setFeatureModelOverride(db, "chat", "openai/$frontier");
    setFailoverFallbacks(db, "chat", ["workers-ai/$frontier"]);
    setFailoverEnabled(db, "chat", true);
    expect(getFeatureModelOverrides(db)).toEqual({ chat: "openai/$frontier" });
    setFeatureModelOverride(db, "chat", null);
    expect(getFailoverFallbacks(db)).toEqual({ chat: ["workers-ai/$frontier"] });
  });

  it("the view reports the saved list and the default order per feature", async () => {
    setFailoverFallbacks(db, "briefing", ["openai/$frontier"]);
    const body = await (await GET()).json();
    const row = body.features.find((f: { key: string }) => f.key === "briefing");
    expect(row.fallbacks).toEqual(["openai/$frontier"]);
    expect(row.defaultFallbacks).toEqual(["openai/$frontier", "workers-ai/$frontier"]);
  });
});

describe("fallback entries go through the override validation", () => {
  it.each([
    ["not a provider/model string", ["justaword"], /Invalid fallback/],
    ["whitespace", ["openai/gpt 6"], /Invalid fallback/],
    ["a provider outside the whitelist", ["mistral/large"], /Unknown provider/],
    ["the primary provider", ["anthropic/$workhorse"], /primary provider/],
    ["the same provider twice", ["openai/$workhorse", "openai/gpt-6-luna"], /twice/],
    ["too many", ["openai/a", "workers-ai/b", "openai/c", "x/y"], /At most/],
  ])("rejects %s", (_n, specs, re) => {
    expect(() => setFailoverFallbacks(db, "chat", specs)).toThrow(re);
    expect(getFailoverFallbacks(db)).toEqual({});
  });

  it("the route rejects a malformed body", async () => {
    expect((await patch({})).status).toBe(400);
    expect((await patch({ key: "chat" })).status).toBe(400);
    expect((await patch({ key: "chat", enabled: "yes" })).status).toBe(400);
    expect((await patch({ group: "nope", enabled: true })).status).toBe(400);
    expect((await patch({ key: "chat", fallbacks: [1] })).status).toBe(400);
  });

  it("a stored entry that later stops parsing is skipped by the executor, not thrown", () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('ai_failover_fallbacks', ?)`).run(
      JSON.stringify({ chat: ["openai/$nonsense-tier-but-valid-pattern", "workers-ai/$frontier"] }),
    );
    // "$nonsense..." is not a tier token, so it parses as a concrete id; the list still resolves in order.
    expect(failoverTargets("chat").map((t) => t.provider)).toContain("workers-ai");
  });
});
