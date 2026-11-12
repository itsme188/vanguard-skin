/**
 * Policy pin (owner ruling 2026-11-07): NOTHING the app can choose resolves to
 * a Fable model id.
 *
 * Two halves, because either one alone would pass a broken policy:
 *   1. A RESOLUTION pass — every tier, every summary family and every feature
 *      default is resolved against a catalog that LISTS Fable, and no answer
 *      may be a Fable id. This catches a ladder, a default or a static
 *      fallback that routes to Fable even when no file spells "fable".
 *   2. A SOURCE scan over `lib/` and `workers/cron/src/` — every ladder, every
 *      default and every choice list must be free of the family name, so a new
 *      ladder entry cannot be added without this test failing. The scan is
 *      narrowed to the files that make model-selection decisions, since
 *      explanatory prose and the retired-family handling name Fable on purpose.
 *
 * Stored owner data is deliberately NOT in scope: a per-print choice or a
 * finished run saved before the ruling keeps its row, and
 * `normalizeStoredChoice` resolves it at read time
 * (tests/filing-summary/choice.test.ts, tests/filing-summary/store.test.ts).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  FAMILY_LADDERS,
  TIER_STATIC_FALLBACK,
  PROVIDER_TIER_MODELS,
  resolveTier,
  parseModelId,
  type Tier,
} from "@/lib/ai/model-tiers";
import { SUMMARY_FAMILY_LADDER, resolveFamilyModel } from "@/lib/ai/model-families";
import {
  DEFAULT_SUMMARY_CHOICE,
  SUMMARY_CHOICES,
  isSummaryChoice,
} from "@/lib/filing-summary/choice";
import { FEATURE_MODELS, expandSpec } from "@/lib/ai/models";
import {
  CHAT_FAMILY_LADDER,
  CHAT_MODEL_FAMILIES,
  DEFAULT_CHAT_MODEL_FAMILY,
  isChatModelFamily,
} from "@/lib/chat/model-choice";
import { resolveChatModelFor } from "@/lib/chat/model-resolve";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";
import { setFeatureModelOverrideSource } from "@/lib/ai/override-source";
import { FAMILY_LADDERS as WORKER_FAMILY_LADDERS } from "../../workers/cron/src/model-tiers";
import { FEATURE_TIER as WORKER_FEATURE_TIER } from "../../workers/cron/src/ai";

const RETIRED = "fable";
const TIERS: Tier[] = ["frontier", "workhorse", "cheap"];

/** A catalog that lists Fable on purpose: the ladder, not the catalog, is the guard. */
const CATALOG_WITH_FABLE = [
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-4-5-20251001",
];

const isRetired = (modelId: string) => parseModelId(modelId)?.family === RETIRED;

describe("no selectable path resolves to a retired model family", () => {
  it("the catalog fixture really does list a Fable id (else this file proves nothing)", () => {
    expect(CATALOG_WITH_FABLE.some(isRetired)).toBe(true);
  });

  it("every Anthropic tier resolves off the retired family, with and without a catalog", () => {
    for (const tier of TIERS) {
      expect(isRetired(resolveTier(tier, CATALOG_WITH_FABLE)), tier).toBe(false);
      expect(isRetired(resolveTier(tier, [])), `${tier} (static fallback)`).toBe(false);
      expect(isRetired(TIER_STATIC_FALLBACK[tier]), `${tier} (static)`).toBe(false);
    }
  });

  it("every tier resolves off it even when the newest callable rung is excluded", () => {
    // Reactive failover drops a model that just 404'd; the next rung down must
    // not be the retired family either.
    for (const tier of TIERS) {
      const excluded = new Set([resolveTier(tier, CATALOG_WITH_FABLE)]);
      expect(isRetired(resolveTier(tier, CATALOG_WITH_FABLE, excluded)), tier).toBe(false);
    }
  });

  it("every summary family — and every rung it falls to — resolves off it", () => {
    for (const family of SUMMARY_FAMILY_LADDER) {
      const hit = resolveFamilyModel(family, CATALOG_WITH_FABLE);
      expect(hit, family).not.toBeNull();
      expect(isRetired(hit!.modelId), family).toBe(false);
      expect(hit!.family, family).not.toBe(RETIRED);
    }
  });

  it("every chat model class, and every rung it falls to, resolves off it (2026-11-13)", () => {
    const viaDefault = () => expandSpec(FEATURE_MODELS.chat);
    setFeatureModelOverrideSource(null);
    setModelCatalogSource(() => CATALOG_WITH_FABLE);
    try {
      for (const family of CHAT_MODEL_FAMILIES) {
        for (const catalog of [CATALOG_WITH_FABLE, [], ["claude-fable-5-2", "claude-fable-5-1"]]) {
          const r = resolveChatModelFor(family, catalog, viaDefault);
          expect(isRetired(r.resolved.modelId), `${family} / ${catalog.join(",")}`).toBe(false);
          // And with each answer excluded in turn, the next rung is still not Fable.
          const next = resolveChatModelFor(
            family,
            catalog.filter((id) => id !== r.resolved.modelId),
            viaDefault,
          );
          expect(isRetired(next.resolved.modelId), `${family} next`).toBe(false);
        }
      }
      expect(isRetired(resolveChatModelFor(null, CATALOG_WITH_FABLE, viaDefault).resolved.modelId)).toBe(false);
    } finally {
      setModelCatalogSource(null);
    }
  });

  it("every feature default resolves off it", () => {
    setFeatureModelOverrideSource(null);
    setModelCatalogSource(() => CATALOG_WITH_FABLE);
    try {
      for (const [feature, spec] of Object.entries(FEATURE_MODELS)) {
        expect(isRetired(expandSpec(spec).modelId), feature).toBe(false);
      }
    } finally {
      setModelCatalogSource(null);
    }
  });

  it("every Worker feature tier resolves off it (the Worker has its own copy)", () => {
    for (const [feature, tier] of Object.entries(WORKER_FEATURE_TIER)) {
      expect(isRetired(resolveTier(tier, CATALOG_WITH_FABLE)), feature).toBe(false);
    }
  });
});

describe("no ladder, default or choice list names the retired family", () => {
  it("the Mac tier ladders and the Worker's mirror", () => {
    for (const tier of TIERS) {
      expect(FAMILY_LADDERS[tier], tier).not.toContain(RETIRED);
      expect(WORKER_FAMILY_LADDERS[tier], `worker ${tier}`).not.toContain(RETIRED);
    }
    // The mirror is parity-pinned, so the two must agree exactly.
    expect(WORKER_FAMILY_LADDERS).toEqual(FAMILY_LADDERS);
  });

  it("the summary family ladder", () => {
    expect([...SUMMARY_FAMILY_LADDER]).not.toContain(RETIRED);
  });

  it("the picker's choice list and its default", () => {
    expect(SUMMARY_CHOICES.map((c) => c.family)).not.toContain(RETIRED);
    expect(DEFAULT_SUMMARY_CHOICE.family).not.toBe(RETIRED);
    expect(isSummaryChoice(DEFAULT_SUMMARY_CHOICE)).toBe(true);
    // And the validator refuses it at both efforts, so no write can store one.
    for (const effort of ["medium", "high"]) {
      expect(isSummaryChoice({ family: RETIRED, effort })).toBe(false);
    }
  });

  it("the chat's model-class list, its ladder and its default", () => {
    expect([...CHAT_MODEL_FAMILIES]).not.toContain(RETIRED);
    expect([...CHAT_FAMILY_LADDER]).not.toContain(RETIRED);
    expect(DEFAULT_CHAT_MODEL_FAMILY).not.toBe(RETIRED);
    // The route validates with this, so no request can store the retired family.
    expect(isChatModelFamily(RETIRED)).toBe(false);
  });

  it("the non-Anthropic provider tier tables name no Claude family at all", () => {
    for (const [provider, table] of Object.entries(PROVIDER_TIER_MODELS)) {
      for (const tier of TIERS) {
        expect(table[tier], `${provider}/${tier}`).not.toMatch(/claude/i);
      }
    }
  });

  it("the feature default map", () => {
    for (const [feature, spec] of Object.entries(FEATURE_MODELS)) {
      expect(spec.toLowerCase(), feature).not.toContain(RETIRED);
    }
  });

  // Source scan: the decision-making files, so a NEW ladder entry fails here
  // even if it is never resolved by a test above.
  const SELECTION_FILES = [
    "lib/ai/model-tiers.ts",
    "lib/ai/model-families.ts",
    "lib/ai/models.ts",
    "lib/filing-summary/choice.ts",
    "lib/chat/model-choice.ts",
    "lib/chat/model-resolve.ts",
    "workers/cron/src/model-tiers.ts",
    "workers/cron/src/ai.ts",
  ];

  /** Drops // and /* comments so prose about the retired family does not trip the scan. */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  it.each(SELECTION_FILES)("%s names no retired family outside its comments", (rel) => {
    const abs = path.join(process.cwd(), rel);
    const src = fs.readFileSync(abs, "utf8");
    // Guard the guard: a renamed file must fail loudly, not silently pass.
    expect(src.length, rel).toBeGreaterThan(0);
    expect(stripComments(src).toLowerCase(), rel).not.toContain(RETIRED);
  });
});
