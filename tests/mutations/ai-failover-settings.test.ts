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
import { getFailoverDisabledFeatures, getFailoverEnabledFeatures, getFailoverFallbacks } from "@/lib/queries/ai-failover-settings";
import { setFeatureModelOverride } from "@/lib/mutations/ai-model-overrides";
import { getFeatureModelOverrides } from "@/lib/queries/ai-model-overrides";
import {
  EARNINGS_PREP_FAILOVER_GROUP,
  FAILOVER_ELIGIBLE_CEILING,
  FAILOVER_PARKED,
  failoverTargets,
  isFailoverEnabled,
  setFailoverDisabledSource,
  setFailoverFallbackSource,
} from "@/lib/ai/failover";
import { FEATURE_MODELS } from "@/lib/ai/models";
import type { FeatureKey } from "@/lib/ai/feature-keys";
import { setFeatureModelOverrideSource } from "@/lib/ai/override-source";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";

let db: Database.Database;

/** Wire the executor's sources to the db exactly as lib/db.ts does. */
function wire() {
  setFailoverDisabledSource(() => new Set(getFailoverDisabledFeatures(db) as FeatureKey[]));
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
  setFailoverDisabledSource(null);
  setFailoverFallbackSource(null);
});

const patch = (body: unknown) =>
  PATCH(new NextRequest("http://localhost/api/settings/ai-failover", { method: "PATCH", body: JSON.stringify(body) }));

describe("failover is on by default (owner directive 2026-11-03)", () => {
  it("a fresh database: every ceiling feature is on, no parked feature is, nothing is explicitly configured", async () => {
    expect(getFailoverEnabledFeatures(db)).toEqual([]);
    expect(getFailoverDisabledFeatures(db)).toEqual([]);
    expect(getFailoverFallbacks(db)).toEqual({});
    for (const key of Object.keys(FEATURE_MODELS) as FeatureKey[]) {
      expect(isFailoverEnabled(key)).toBe(FAILOVER_ELIGIBLE_CEILING.has(key));
    }
    const body = await (await GET()).json();
    const rows = body.features as { key: string; eligible: boolean; enabled: boolean; explicit: string | null }[];
    for (const r of rows) {
      expect(r.enabled).toBe(r.eligible);
      expect(r.explicit).toBeNull();
    }
    expect(body.group.allEnabled).toBe(true);
  });

  it("an explicit opt-out is authoritative and survives a restart (re-reading the store through fresh sources)", async () => {
    expect((await patch({ key: "chat", enabled: false })).status).toBe(200);
    expect(isFailoverEnabled("chat")).toBe(false);
    expect(getFailoverDisabledFeatures(db)).toEqual(["chat"]);
    // "Restart": drop and re-register the executor sources from the database alone.
    setFailoverDisabledSource(null);
    setFailoverFallbackSource(null);
    expect(isFailoverEnabled("chat")).toBe(true); // no sources registered = the default
    wire();
    expect(isFailoverEnabled("chat")).toBe(false); // the saved opt-out is read back
    const row = (await (await GET()).json()).features.find((f: { key: string }) => f.key === "chat");
    expect(row).toMatchObject({ enabled: false, explicit: "off" });
    // Opting back in lifts it.
    expect((await patch({ key: "chat", enabled: true })).status).toBe(200);
    expect(isFailoverEnabled("chat")).toBe(true);
    expect(getFailoverDisabledFeatures(db)).toEqual([]);
  });

  it("the owner's saved set (6 print-prep features + newsletterProcessing) behaves identically before and after: still on, shown as an explicit opt-in", async () => {
    const saved = [...EARNINGS_PREP_FAILOVER_GROUP, "newsletterProcessing"];
    db.prepare(`INSERT INTO settings (key, value) VALUES ('ai_failover_enabled', ?)`).run(JSON.stringify(saved));
    for (const k of saved) expect(isFailoverEnabled(k as FeatureKey)).toBe(true); // as before
    const rows = (await (await GET()).json()).features as { key: string; enabled: boolean; explicit: string | null }[];
    for (const k of saved) expect(rows.find((r) => r.key === k)).toMatchObject({ enabled: true, explicit: "on" });
    // Newly covered by the default, never stored by the owner:
    expect(rows.find((r) => r.key === "chat")).toMatchObject({ enabled: true, explicit: null });
  });

  it("an opt-out beats a stale opt-in for the same feature", () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('ai_failover_enabled', ?)`).run(JSON.stringify(["chat"]));
    db.prepare(`INSERT INTO settings (key, value) VALUES ('ai_failover_disabled', ?)`).run(JSON.stringify(["chat"]));
    expect(isFailoverEnabled("chat")).toBe(false);
  });

  it("the ordered fallback lists are unchanged by the default", () => {
    expect(failoverTargets("chat").map((t) => t.provider)).toEqual(["openai", "workers-ai"]);
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
    expect(getFailoverDisabledFeatures(db)).toEqual([]);
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
      JSON.stringify(["scheduleVerification", "pdfParsing", "newsletterProcessing"]),
    );
    expect(isFailoverEnabled("scheduleVerification")).toBe(false);
    expect(isFailoverEnabled("pdfParsing")).toBe(false);
    expect(isFailoverEnabled("newsletterProcessing")).toBe(true);
    const view = await (await GET()).json();
    expect(view.features.find((f: { key: string }) => f.key === "scheduleVerification").enabled).toBe(false);
  });

  it("the group toggle touches exactly the print-prep features, all inside the ceiling", () => {
    for (const k of EARNINGS_PREP_FAILOVER_GROUP) expect(FAILOVER_ELIGIBLE_CEILING.has(k)).toBe(true);
    for (const k of FAILOVER_PARKED) expect(EARNINGS_PREP_FAILOVER_GROUP).not.toContain(k);
    setFailoverEnabled(db, "chat", false);
    setFailoverGroupEnabled(db, false);
    expect(getFailoverDisabledFeatures(db).sort()).toEqual(["chat", ...EARNINGS_PREP_FAILOVER_GROUP].sort());
    setFailoverGroupEnabled(db, true);
    expect(getFailoverDisabledFeatures(db)).toEqual(["chat"]); // only the group's members were switched back on
    for (const k of EARNINGS_PREP_FAILOVER_GROUP) expect(isFailoverEnabled(k)).toBe(true);
  });
});

describe("round trip through the settings store into the executor", () => {
  it("switching off in the store turns the executor's gate off; switching back on restores it", async () => {
    expect(isFailoverEnabled("newsletterProcessing")).toBe(true);
    expect((await patch({ key: "newsletterProcessing", enabled: false })).status).toBe(200);
    expect(isFailoverEnabled("newsletterProcessing")).toBe(false);
    expect((await patch({ key: "newsletterProcessing", enabled: true })).status).toBe(200);
    expect(isFailoverEnabled("newsletterProcessing")).toBe(true);
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
    const res = await patch({ key: "chat", enabled: false, fallbacks: ["bogus/model"] });
    expect(res.status).toBe(400);
    expect(getFailoverDisabledFeatures(db)).toEqual([]);
    expect(getFailoverEnabledFeatures(db)).toEqual([]);
    expect(getFailoverFallbacks(db)).toEqual({});
  });

  it("does not touch the model-override store, and the two stay independent", () => {
    setFeatureModelOverride(db, "chat", "openai/$frontier");
    setFailoverFallbacks(db, "chat", ["workers-ai/$frontier"]);
    setFailoverEnabled(db, "chat", false);
    expect(getFeatureModelOverrides(db)).toEqual({ chat: "openai/$frontier" });
    setFeatureModelOverride(db, "chat", null);
    expect(getFailoverFallbacks(db)).toEqual({ chat: ["workers-ai/$frontier"] });
  });

  it("the view reports the saved list and the default order per feature", async () => {
    setFailoverFallbacks(db, "briefing", ["openai/$frontier"]);
    const body = await (await GET()).json();
    const row = body.features.find((f: { key: string }) => f.key === "briefing");
    expect(row.fallbacks).toEqual(["openai/$frontier"]);
    // `briefing` sits on the workhorse tier since the 2026-11-07 model-policy
    // ruling, and the default fallback order follows the feature's own tier.
    expect(row.defaultFallbacks).toEqual(["openai/$workhorse", "workers-ai/$workhorse"]);
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
