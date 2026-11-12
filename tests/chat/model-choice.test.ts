/**
 * The chat's per-conversation model class (owner-approved 2026-11-13).
 *
 * The conversation stores a CLASS (haiku / sonnet / opus), never an id. At
 * request time the class resolves to its newest current id through the same
 * ladder walk the filing summary uses (resolveFamilyOnLadder); an
 * unavailable class steps DOWN the chat ladder, and when nothing below it is
 * callable the turn runs on the chat's default resolution. Either way the
 * fallback is reported (fellBackFrom), so the label can say so.
 *
 * Precedence (the filing-summary precedent, CLAUDE.md "the per-print choice
 * beats the Settings AI-models override"): a stored class beats a Settings
 * override for the chat feature; a conversation with NO class (NULL, every
 * conversation older than migration 103) resolves exactly as before, through
 * resolveFeatureModel("chat"), override included.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  CHAT_FAMILY_LADDER,
  CHAT_MODEL_FAMILIES,
  DEFAULT_CHAT_MODEL_FAMILY,
  chatFamilyName,
  chatModelLabel,
  invalidModelFamilyMessage,
  isChatModelFamily,
  readStoredChatFamily,
  liveModelLabel,
  requestModelFamily,
} from "@/lib/chat/model-choice";
import { resolveChatModel, resolveChatModelFor } from "@/lib/chat/model-resolve";
import { resolveFamilyModel } from "@/lib/ai/model-families";
import { CURRENT_CLASS_MODELS } from "@/lib/ai/model-tiers";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";
import { setFeatureModelOverrideSource } from "@/lib/ai/override-source";
import type { ResolvedModel } from "@/lib/ai/models";

const FULL = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-4-6"];
const DEFAULT: ResolvedModel = { provider: "anthropic", modelId: "claude-sonnet-5-5" };
const OVERRIDE: ResolvedModel = { provider: "anthropic", modelId: "claude-opus-5-5" };

function counting(answer: ResolvedModel) {
  const calls = { n: 0 };
  return { calls, fn: () => { calls.n += 1; return answer; } };
}

describe("the choice list", () => {
  it("offers Haiku, Sonnet and Opus, cheapest first, Sonnet preselected", () => {
    expect([...CHAT_MODEL_FAMILIES]).toEqual(["haiku", "sonnet", "opus"]);
    expect(DEFAULT_CHAT_MODEL_FAMILY).toBe("sonnet");
    expect([...CHAT_FAMILY_LADDER]).toEqual(["opus", "sonnet", "haiku"]);
  });

  it("validates exactly the three names", () => {
    for (const f of CHAT_MODEL_FAMILIES) expect(isChatModelFamily(f)).toBe(true);
    for (const bad of ["Opus", "claude-opus-5-5", "", null, undefined, 3, "fable", "gpt"]) {
      expect(isChatModelFamily(bad), String(bad)).toBe(false);
    }
  });

  it("names the valid classes in the refusal", () => {
    expect(invalidModelFamilyMessage("gpt")).toBe("Unknown model class: gpt. Valid: haiku, sonnet, opus.");
  });

  it("reads a stored value back, and anything unexpected as no class", () => {
    expect(readStoredChatFamily("opus")).toBe("opus");
    expect(readStoredChatFamily(null)).toBeNull();
    expect(readStoredChatFamily("fable")).toBeNull();
    expect(chatFamilyName("haiku")).toBe("Haiku");
  });
});

describe("resolution per class", () => {
  it.each([
    ["haiku", "claude-haiku-5-5"],
    ["sonnet", "claude-sonnet-5-5"],
    ["opus", "claude-opus-5-5"],
  ] as const)("%s resolves to the newest current id of its class", (family, id) => {
    const d = counting(DEFAULT);
    const r = resolveChatModelFor(family, FULL, d.fn);
    expect(r).toEqual({
      source: "family",
      resolved: { provider: "anthropic", modelId: id },
      requested: family,
      family,
      fellBackFrom: null,
    });
    expect(d.calls.n).toBe(0);
  });

  it("follows a newer version inside the class without a code change", () => {
    const r = resolveChatModelFor("opus", [...FULL, "claude-opus-5-7"], () => DEFAULT);
    expect(r.resolved.modelId).toBe("claude-opus-5-7");
  });

  it("an empty catalog (a fresh database) uses the class's current id", () => {
    for (const f of CHAT_MODEL_FAMILIES) {
      const r = resolveChatModelFor(f, [], () => DEFAULT);
      expect(r.resolved.modelId).toBe(CURRENT_CLASS_MODELS[f]);
      expect(r.fellBackFrom).toBeNull();
      expect(r.source).toBe("family");
    }
  });

  it("an unavailable Opus steps down to Sonnet and says so", () => {
    const r = resolveChatModelFor("opus", ["claude-sonnet-5-5", "claude-haiku-5-5"], () => DEFAULT);
    expect(r.resolved.modelId).toBe("claude-sonnet-5-5");
    expect(r.family).toBe("sonnet");
    expect(r.fellBackFrom).toBe("opus");
  });

  it("an older Opus generation is never chosen; the walk goes down the ladder", () => {
    const r = resolveChatModelFor("opus", ["claude-opus-4-8", "claude-sonnet-5-5"], () => DEFAULT);
    expect(r.resolved.modelId).toBe("claude-sonnet-5-5");
    expect(r.fellBackFrom).toBe("opus");
  });

  it("an unavailable Sonnet steps down to Haiku", () => {
    const r = resolveChatModelFor("sonnet", ["claude-opus-5-5", "claude-haiku-5-5"], () => DEFAULT);
    expect(r.resolved.modelId).toBe("claude-haiku-5-5");
    expect(r.fellBackFrom).toBe("sonnet");
  });

  it("an unavailable Haiku (nothing below it) runs on the chat default and says so", () => {
    const d = counting(DEFAULT);
    const r = resolveChatModelFor("haiku", ["claude-opus-5-5", "claude-sonnet-5-5"], d.fn);
    expect(r.source).toBe("default");
    expect(r.resolved).toEqual(DEFAULT);
    expect(r.family).toBe("sonnet");
    expect(r.fellBackFrom).toBe("haiku");
    expect(d.calls.n).toBe(1);
  });

  it("no class at all is exactly the default resolution", () => {
    const d = counting(DEFAULT);
    const r = resolveChatModelFor(null, FULL, d.fn);
    expect(r).toEqual({ source: "default", resolved: DEFAULT, requested: null, family: "sonnet", fellBackFrom: null });
    expect(d.calls.n).toBe(1);
  });

  it("the filing summary's own ladder is unchanged by the shared walk", () => {
    // Sonnet missing: the summary ladder has nothing below Sonnet, so null,
    // never Haiku (the chat ladder's extra rung must not leak into it).
    expect(resolveFamilyModel("sonnet", ["claude-opus-5-5", "claude-haiku-5-5"])).toBeNull();
    expect(resolveFamilyModel("opus", ["claude-sonnet-5-5"])).toEqual({
      modelId: "claude-sonnet-5-5",
      family: "sonnet",
      fellBackFrom: "opus",
    });
  });
});

describe("precedence with a Settings override for the chat feature", () => {
  afterEach(() => {
    setFeatureModelOverrideSource(null);
    setModelCatalogSource(null);
  });

  it("a stored class beats the override", () => {
    setModelCatalogSource(() => FULL);
    setFeatureModelOverrideSource(() => ({ chat: "anthropic/claude-opus-5-5" }));
    const r = resolveChatModel("haiku");
    expect(r.resolved.modelId).toBe("claude-haiku-5-5");
    expect(r.source).toBe("family");
  });

  it("a conversation with no class still follows the override", () => {
    setModelCatalogSource(() => FULL);
    setFeatureModelOverrideSource(() => ({ chat: "anthropic/claude-opus-5-5" }));
    const r = resolveChatModel(null);
    expect(r.resolved).toEqual(OVERRIDE);
    expect(r.source).toBe("default");
  });

  it("a fallback to the default also follows the override", () => {
    setModelCatalogSource(() => ["claude-opus-5-5", "claude-sonnet-5-5"]);
    setFeatureModelOverrideSource(() => ({ chat: "anthropic/claude-opus-5-5" }));
    const r = resolveChatModel("haiku");
    expect(r.resolved).toEqual(OVERRIDE);
    expect(r.fellBackFrom).toBe("haiku");
    expect(r.family).toBe("opus");
  });
});

describe("the label the conversation shows", () => {
  it("names the class and the version it resolved to", () => {
    expect(chatModelLabel({ modelId: "claude-opus-5-5", fellBackFrom: null })).toBe("Opus 5.5");
    expect(chatModelLabel({ modelId: "claude-haiku-5-5", fellBackFrom: null })).toBe("Haiku 5.5");
  });

  it("says so in plain words when a fallback answers", () => {
    expect(chatModelLabel({ modelId: "claude-sonnet-5-5", fellBackFrom: "opus" })).toBe(
      "Sonnet 5.5 (Opus not available)",
    );
  });

  it("never prints a raw id it cannot read", () => {
    expect(chatModelLabel({ modelId: "gpt-6.1-sol", fellBackFrom: "haiku" })).toBe(
      "the AI model (Haiku not available)",
    );
  });
});

describe("an older generation answering says so (review item 5)", () => {
  it("the default fallback can land on an older version; the label names it", () => {
    // Nothing current in the catalog: the class walk finds nothing, and the
    // chat default degrades rather than being down (the tier resolver's rule).
    const older = resolveChatModelFor("sonnet", ["claude-sonnet-4-6", "claude-haiku-4-5"], () => ({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    }));
    expect(older.resolved.modelId).toBe("claude-sonnet-4-6");
    expect(older.fellBackFrom).toBeNull();
    expect(chatModelLabel({ modelId: older.resolved.modelId, fellBackFrom: older.fellBackFrom })).toBe(
      "Sonnet 4.6 (older version in use)",
    );
  });

  it("a fallback onto an older version says both", () => {
    expect(chatModelLabel({ modelId: "claude-sonnet-4-6", fellBackFrom: "opus" })).toBe(
      "Sonnet 4.6 (Opus not available; older version in use)",
    );
  });

  it("a current or newer version carries no note", () => {
    expect(chatModelLabel({ modelId: "claude-sonnet-5-5", fellBackFrom: null })).toBe("Sonnet 5.5");
    expect(chatModelLabel({ modelId: "claude-opus-5-7", fellBackFrom: null })).toBe("Opus 5.7");
  });
});

describe("what the client sends as the class (review item 2)", () => {
  const list = [
    { id: 1, model_family: "opus" },
    { id: 2, model_family: null },
  ];

  it("a new chat sends the picker's value", () => {
    expect(requestModelFamily(list, null, "haiku")).toBe("haiku");
  });

  it("an open conversation sends its own stored class, never the picker's", () => {
    expect(requestModelFamily(list, 1, "haiku")).toBe("opus");
  });

  it("an open conversation with no class sends none", () => {
    expect(requestModelFamily(list, 2, "haiku")).toBeNull();
  });

  it("an open conversation not in the list yet (its first turn just adopted) sends the picker's value", () => {
    expect(requestModelFamily(list, 9, "sonnet")).toBe("sonnet");
  });
});

describe("the live label from the stream (review item 4)", () => {
  it("reads the newest assistant message's modelLabel metadata", () => {
    expect(
      liveModelLabel([
        { role: "user", metadata: undefined },
        { role: "assistant", metadata: { modelLabel: "Opus 5.5", finishReason: "stop" } },
        { role: "user" },
        { role: "assistant", metadata: { modelLabel: "Sonnet 5.5 (Opus not available)" } },
      ]),
    ).toBe("Sonnet 5.5 (Opus not available)");
  });

  it("is null when no message carries one (a reloaded history)", () => {
    expect(liveModelLabel([{ role: "assistant" }, { role: "assistant", metadata: { modelLabel: 3 } }])).toBeNull();
  });
});
