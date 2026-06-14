# Tier-based AI Model Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every hardcoded Claude model ID with tier-based resolution (`frontier`/`workhorse`/`cheap`) that auto-adopts new versions, auto-fails-over when a model is pulled, and never requires editing a model string for a routine release or rollback.

**Architecture:** A pure resolver walks an ordered family ladder per tier against a cached list of *available* models (Anthropic `/v1/models`, refreshed weekly), picking the newest version of the top available family; an empty catalog falls back to static IDs. Reactive failover catches `not_found` at call time and re-resolves instantly (cadence-independent). Wrapper helpers centralize both the failover and Fable's `refusal` stop-reason handling so call sites inherit them with a one-line swap. The Worker mirrors the resolver byte-for-byte and reads the catalog from the R2 snapshot.

**Tech Stack:** TypeScript, `@ai-sdk/anthropic` + `ai` (Vercel AI SDK), `@anthropic-ai/sdk` (raw, for `models.list()`), better-sqlite3 (`settings` table), Vitest, Cloudflare Worker (`workers/cron/`).

**Spec:** `docs/superpowers/specs/2026-06-14-model-tier-resolution-design.md`

---

## File structure

| File | Responsibility | New/Modify |
|---|---|---|
| `lib/ai/model-tiers.ts` | Tier types, family ladders, static fallback, version parsing, **pure** `resolveTier` | New |
| `lib/ai/model-catalog.ts` | `settings`-backed catalog cache: read / staleness / write / refresh from `/v1/models` | New |
| `lib/ai/catalog-source.ts` | Registered synchronous reader seam (mirror of `override-source.ts`) | New |
| `lib/ai/generate.ts` | `generateTextForFeature` / `generateObjectForFeature` wrappers: reactive failover + refusal handling | New |
| `lib/ai/models.ts` | `FEATURE_MODELS` → tier tokens; `resolveFeatureModel` expands `$tier` | Modify |
| `lib/claude-models.ts` | Becomes thin re-export of `TIER_STATIC_FALLBACK` ids | Modify |
| `lib/db.ts` | Register the catalog reader | Modify |
| `lib/digest/send-briefing.ts` | Weekly `refreshModelCatalog` hook | Modify |
| ~16 call sites | Swap `generateText({model: getModelForFeature(x)…})` → `generateTextForFeature(x, …)` | Modify |
| `app/api/chat/route.ts`, `lib/import/vanguard-pdf.ts`, `lib/digest/send-earnings-email.ts` | Refusal handling (streaming + raw clients) | Modify |
| `workers/cron/src/model-tiers.ts` | Byte-parity mirror of the resolver | New |
| `workers/cron/src/ai.ts` | Tier tokens + resolve from snapshot catalog + reactive failover | Modify |
| `scripts/snapshot-state-to-r2.ts` | Snapshot v6 adds `modelCatalog` | Modify |

---

## Phase A — Pure tier resolver

### Task 1: `lib/ai/model-tiers.ts` + tests

**Files:**
- Create: `lib/ai/model-tiers.ts`
- Test: `tests/ai/model-tiers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ai/model-tiers.test.ts
import { describe, it, expect } from "vitest";
import {
  resolveTier,
  parseModelId,
  TIER_STATIC_FALLBACK,
} from "@/lib/ai/model-tiers";

describe("parseModelId", () => {
  it("parses family + numeric version, ignoring date suffix", () => {
    expect(parseModelId("claude-opus-4-8")).toEqual({ family: "opus", version: [4, 8] });
    expect(parseModelId("claude-fable-5")).toEqual({ family: "fable", version: [5] });
    expect(parseModelId("claude-haiku-4-5-20251001")).toEqual({ family: "haiku", version: [4, 5] });
  });
  it("returns null for non-claude ids", () => {
    expect(parseModelId("@cf/meta/llama-4-scout")).toBeNull();
  });
});

describe("resolveTier", () => {
  const catalog = ["claude-fable-5", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"];

  it("frontier picks Fable when available", () => {
    expect(resolveTier("frontier", catalog)).toBe("claude-fable-5");
  });
  it("frontier falls to newest Opus when Fable is pulled", () => {
    const pulled = catalog.filter((m) => m !== "claude-fable-5");
    expect(resolveTier("frontier", pulled)).toBe("claude-opus-4-8");
  });
  it("picks the newest version within the top available family", () => {
    expect(resolveTier("frontier", ["claude-opus-4-7", "claude-opus-4-8"])).toBe("claude-opus-4-8");
    expect(resolveTier("frontier", ["claude-opus-4-10", "claude-opus-4-8"])).toBe("claude-opus-4-10");
  });
  it("workhorse prefers Sonnet over Haiku", () => {
    expect(resolveTier("workhorse", catalog)).toBe("claude-sonnet-4-6");
  });
  it("cheap resolves Haiku", () => {
    expect(resolveTier("cheap", catalog)).toBe("claude-haiku-4-5");
  });
  it("empty catalog → static fallback", () => {
    expect(resolveTier("frontier", [])).toBe(TIER_STATIC_FALLBACK.frontier);
    expect(resolveTier("workhorse", [])).toBe(TIER_STATIC_FALLBACK.workhorse);
    expect(resolveTier("cheap", [])).toBe(TIER_STATIC_FALLBACK.cheap);
  });
  it("frontier static fallback is Opus, not Fable (availability-safe)", () => {
    expect(TIER_STATIC_FALLBACK.frontier).toBe("claude-opus-4-8");
  });
  it("honours the excluded set (reactive failover)", () => {
    expect(resolveTier("frontier", catalog, new Set(["claude-fable-5"]))).toBe("claude-opus-4-8");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ai/model-tiers.test.ts`
Expected: FAIL — cannot import from `@/lib/ai/model-tiers`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/ai/model-tiers.ts
/**
 * Tier policy + pure resolver for AI model selection.
 *
 * The ONE human-editable piece of domain knowledge: the ordered family ladder
 * per capability tier (the Anthropic Models API lists which models EXIST but
 * does not rank them, so ordering must live in code). A version bump within a
 * family and a model pull are both handled automatically; only a brand-new
 * FAMILY NAME requires editing FAMILY_LADDERS — deliberately, so a new flagship
 * is reviewed before production spend routes to it.
 *
 * resolveTier is pure: (tier, available-model-ids, excluded?) → concrete id.
 */

export type Tier = "frontier" | "workhorse" | "cheap";

/** Capability order, highest first, per tier. Values are model *families*. */
export const FAMILY_LADDERS: Record<Tier, string[]> = {
  frontier: ["fable", "opus", "sonnet"],
  workhorse: ["sonnet", "haiku"],
  cheap: ["haiku"],
};

/**
 * Used only when the live catalog is empty/unknown. Must be a reliably-available
 * model: frontier is OPUS (not Fable) because Fable's availability is exactly
 * what's uncertain.
 */
export const TIER_STATIC_FALLBACK: Record<Tier, string> = {
  frontier: "claude-opus-4-8",
  workhorse: "claude-sonnet-4-6",
  cheap: "claude-haiku-4-5-20251001",
};

export interface ParsedModel {
  family: string;
  version: number[];
}

/**
 * "claude-opus-4-8" → { family: "opus", version: [4, 8] }
 * "claude-fable-5"  → { family: "fable", version: [5] }
 * "claude-haiku-4-5-20251001" → { family: "haiku", version: [4, 5] } (date dropped)
 * Returns null for any non-"claude-<family>-<ver>" id (e.g. Workers-AI models).
 */
export function parseModelId(id: string): ParsedModel | null {
  const m = /^claude-([a-z]+)-(\d+(?:-\d+)*)/.exec(id);
  if (!m) return null;
  const family = m[1];
  const version = m[2].split("-").map((n) => parseInt(n, 10));
  if (version.some((n) => !Number.isFinite(n))) return null;
  return { family, version };
}

/** Compare version tuples: [4,10] > [4,8] > [4,7]; longer wins on shared prefix. */
function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Resolve a tier to a concrete model id, given the available-model catalog.
 * Walks the family ladder; for the first family with ≥1 available (non-excluded)
 * model, returns the newest version. Empty result → TIER_STATIC_FALLBACK[tier].
 *
 * `excluded` lets reactive failover drop a model that just 404'd so the retry
 * skips it even before the catalog cache refreshes.
 */
export function resolveTier(
  tier: Tier,
  catalogIds: string[],
  excluded: Set<string> = new Set(),
): string {
  const available = catalogIds
    .filter((id) => !excluded.has(id))
    .map((id) => ({ id, parsed: parseModelId(id) }))
    .filter((x): x is { id: string; parsed: ParsedModel } => x.parsed !== null);

  for (const family of FAMILY_LADDERS[tier]) {
    const hits = available.filter((x) => x.parsed.family === family);
    if (hits.length === 0) continue;
    hits.sort((a, b) => compareVersions(b.parsed.version, a.parsed.version));
    return hits[0].id;
  }
  return TIER_STATIC_FALLBACK[tier];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ai/model-tiers.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/ai/model-tiers.ts tests/ai/model-tiers.test.ts
git commit -m "feat(ai): pure tier resolver with ordered family ladders"
```

---

## Phase B — Catalog cache + reader seam

### Task 2: `lib/ai/model-catalog.ts` + tests

**Files:**
- Create: `lib/ai/model-catalog.ts`
- Test: `tests/ai/model-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ai/model-catalog.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  getModelCatalog,
  setModelCatalog,
  isModelCatalogStale,
} from "@/lib/ai/model-catalog";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)",
  );
  return db;
}

describe("model-catalog", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("returns [] when unset", () => {
    expect(getModelCatalog(db)).toEqual([]);
  });
  it("returns [] (not throw) when settings table is missing", () => {
    const bare = new Database(":memory:");
    expect(getModelCatalog(bare)).toEqual([]);
  });
  it("round-trips a catalog and reports fresh", () => {
    setModelCatalog(db, ["claude-opus-4-8", "claude-sonnet-4-6"]);
    expect(getModelCatalog(db)).toEqual(["claude-opus-4-8", "claude-sonnet-4-6"]);
    expect(isModelCatalogStale(db)).toBe(false);
  });
  it("is stale when never set", () => {
    expect(isModelCatalogStale(db)).toBe(true);
  });
  it("is stale when older than the guard window", () => {
    setModelCatalog(db, ["claude-opus-4-8"]);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'model_catalog_updated_at'")
      .run(new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString());
    expect(isModelCatalogStale(db)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ai/model-catalog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// lib/ai/model-catalog.ts
/**
 * settings-backed cache of AVAILABLE Anthropic model ids (from /v1/models).
 * Mirrors the getRiskFreeRate pattern (lib/queries/risk-free-rate.ts): a
 * synchronous read off the `settings` table, a staleness guard, and a refresh
 * that is graceful on API error (never clobbers a good cache).
 *
 * Cadence is intentionally loose — the catalog only drives NEW-model discovery
 * (weekly is plenty). Pulls are handled reactively at call time, not here.
 */

import type Database from "better-sqlite3";

const KEY = "model_catalog";
const KEY_UPDATED = "model_catalog_updated_at";
/** Safety net only (Mac missed the weekly run, e.g. travel) — NOT the cadence. */
const STALE_AFTER_HOURS = 14 * 24;

interface SettingRow { value: string; }

/** Synchronous read of the cached available-model ids. [] if unset/missing. */
export function getModelCatalog(db: Database.Database): string[] {
  let row: SettingRow | undefined;
  try {
    row = db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as
      | SettingRow
      | undefined;
  } catch {
    return [];
  }
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function isModelCatalogStale(db: Database.Database): boolean {
  let row: SettingRow | undefined;
  try {
    row = db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY_UPDATED) as
      | SettingRow
      | undefined;
  } catch {
    return true;
  }
  if (!row) return true;
  const updatedAt = new Date(row.value + (row.value.includes("T") ? "" : "Z"));
  if (isNaN(updatedAt.getTime())) return true;
  return (Date.now() - updatedAt.getTime()) / 3_600_000 > STALE_AFTER_HOURS;
}

export function setModelCatalog(db: Database.Database, ids: string[]): void {
  const tx = db.transaction(() => {
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ).run(KEY, JSON.stringify(ids));
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ).run(KEY_UPDATED, new Date().toISOString());
  });
  tx();
}

/**
 * Fetch the current model list from Anthropic and write it to the cache.
 * Uses the raw @anthropic-ai/sdk client (Gateway-routed) — the AI SDK provider
 * doesn't expose models.list(). Graceful: on error, logs and leaves the prior
 * cache intact (returns the existing cached ids).
 */
export async function refreshModelCatalog(db: Database.Database): Promise<string[]> {
  const { getRawAnthropicClient } = await import("@/lib/ai/provider");
  try {
    const client = getRawAnthropicClient("chat"); // feature tag only; any key works
    const ids: string[] = [];
    // models.list() auto-paginates on iteration.
    for await (const m of client.models.list()) {
      if (typeof m.id === "string") ids.push(m.id);
    }
    if (ids.length === 0) {
      console.warn("[model-catalog] /v1/models returned 0 ids — keeping prior cache");
      return getModelCatalog(db);
    }
    setModelCatalog(db, ids);
    console.log(`[model-catalog] refreshed: ${ids.length} models`);
    return ids;
  } catch (err) {
    console.warn(`[model-catalog] refresh failed, keeping prior cache: ${String(err)}`);
    return getModelCatalog(db);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ai/model-catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/model-catalog.ts tests/ai/model-catalog.test.ts
git commit -m "feat(ai): settings-backed available-model catalog cache"
```

### Task 3: `lib/ai/catalog-source.ts` seam + register in `lib/db.ts`

**Files:**
- Create: `lib/ai/catalog-source.ts`
- Modify: `lib/db.ts` (add registration next to the override-source registration at line ~27)
- Test: `tests/ai/catalog-source.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ai/catalog-source.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  getCachedModelCatalog,
  setModelCatalogSource,
  invalidateModelCatalogCache,
  dropModelFromCatalog,
} from "@/lib/ai/catalog-source";

describe("catalog-source", () => {
  beforeEach(() => setModelCatalogSource(null));

  it("returns [] when no source registered", () => {
    expect(getCachedModelCatalog()).toEqual([]);
  });
  it("reads from the registered source", () => {
    setModelCatalogSource(() => ["claude-opus-4-8", "claude-sonnet-4-6"]);
    expect(getCachedModelCatalog()).toEqual(["claude-opus-4-8", "claude-sonnet-4-6"]);
  });
  it("returns [] (not throw) when the source throws", () => {
    setModelCatalogSource(() => { throw new Error("no table"); });
    expect(getCachedModelCatalog()).toEqual([]);
  });
  it("dropModelFromCatalog removes an id from the in-memory working set", () => {
    setModelCatalogSource(() => ["claude-fable-5", "claude-opus-4-8"]);
    getCachedModelCatalog();           // prime cache
    dropModelFromCatalog("claude-fable-5");
    expect(getCachedModelCatalog()).toEqual(["claude-opus-4-8"]);
  });
  it("invalidate forces a re-read", () => {
    let v = ["claude-opus-4-8"];
    setModelCatalogSource(() => v);
    expect(getCachedModelCatalog()).toEqual(["claude-opus-4-8"]);
    v = ["claude-fable-5", "claude-opus-4-8"];
    invalidateModelCatalogCache();
    expect(getCachedModelCatalog()).toEqual(["claude-fable-5", "claude-opus-4-8"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/ai/catalog-source.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// lib/ai/catalog-source.ts
/**
 * Injection seam + cache for the available-model catalog, exactly mirroring
 * lib/ai/override-source.ts. lib/ai/models.ts is imported at module top-level by
 * many AI modules; importing the lib/db singleton from here would open the real
 * DB as a side effect. Instead lib/db.ts registers a SQLite-backed reader after
 * the singleton is created; tests inject a stub; any context without a source
 * (Workers, in-memory test DBs) falls back to [] → static tier fallback.
 *
 * dropModelFromCatalog removes an id from the in-memory working set so reactive
 * failover can skip a just-404'd model immediately, before the next refresh.
 */

export type ModelCatalogReader = () => string[];

const TTL_MS = 30_000;

let reader: ModelCatalogReader | null = null;
let cache: { value: string[]; readAt: number } | null = null;

export function setModelCatalogSource(fn: ModelCatalogReader | null): void {
  reader = fn;
  cache = null;
}

export function invalidateModelCatalogCache(): void {
  cache = null;
}

/** Remove an id from the current cached working set (reactive failover). */
export function dropModelFromCatalog(id: string): void {
  const current = getCachedModelCatalog();
  cache = { value: current.filter((m) => m !== id), readAt: Date.now() };
}

export function getCachedModelCatalog(): string[] {
  if (!reader) return [];
  const now = Date.now();
  if (cache && now - cache.readAt < TTL_MS) return cache.value;
  let value: string[] = [];
  try {
    value = reader() ?? [];
  } catch {
    value = [];
  }
  cache = { value, readAt: now };
  return value;
}
```

- [ ] **Step 4: Register the reader in `lib/db.ts`**

After the existing override-source registration (line ~27,
`setFeatureModelOverrideSource(() => getFeatureModelOverrides(db));`), add:

```ts
import { setModelCatalogSource } from "./ai/catalog-source";
import { getModelCatalog } from "./ai/model-catalog";
// ...after the singleton `db` is created and override source is registered:
setModelCatalogSource(() => getModelCatalog(db));
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/ai/catalog-source.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/ai/catalog-source.ts lib/db.ts tests/ai/catalog-source.test.ts
git commit -m "feat(ai): catalog reader seam + db registration"
```

---

## Phase C — Wire tiers into resolveFeatureModel

### Task 4: tier tokens in `lib/ai/models.ts` + fold `claude-models.ts`

**Files:**
- Modify: `lib/ai/models.ts`
- Modify: `lib/claude-models.ts`
- Test: `tests/ai/resolve-feature-model.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ai/resolve-feature-model.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { resolveFeatureModel } from "@/lib/ai/models";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";
import { setFeatureModelOverrideSource } from "@/lib/ai/override-source";

describe("resolveFeatureModel tier expansion", () => {
  beforeEach(() => {
    setFeatureModelOverrideSource(null);
    setModelCatalogSource(() => ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]);
  });

  it("expands $frontier to the newest top-family model", () => {
    expect(resolveFeatureModel("chat")).toEqual({ provider: "anthropic", modelId: "claude-fable-5" });
  });
  it("expands $workhorse to Sonnet", () => {
    expect(resolveFeatureModel("newsletterProcessing")).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-6" });
  });
  it("expands $cheap to Haiku", () => {
    expect(resolveFeatureModel("researchMentionVerification")).toEqual({ provider: "anthropic", modelId: "claude-haiku-4-5" });
  });
  it("frontier falls to Opus when Fable is absent from the catalog", () => {
    setModelCatalogSource(() => ["claude-opus-4-8", "claude-sonnet-4-6"]);
    expect(resolveFeatureModel("chat").modelId).toBe("claude-opus-4-8");
  });
  it("empty catalog → static fallback", () => {
    setModelCatalogSource(() => []);
    expect(resolveFeatureModel("chat").modelId).toBe("claude-opus-4-8");
  });
  it("explicit non-tier spec passes through untouched", () => {
    expect(resolveFeatureModel("alertSuggestion").provider).toBe("workers-ai");
  });
  it("user override beats the tier token", () => {
    setFeatureModelOverrideSource(() => ({ chat: "anthropic/claude-opus-4-7" }));
    expect(resolveFeatureModel("chat").modelId).toBe("claude-opus-4-7");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/ai/resolve-feature-model.test.ts`
Expected: FAIL — `chat` currently resolves to `claude-opus-4-7`, not a tier.

- [ ] **Step 3: Edit `lib/ai/models.ts`**

Change the imports + `FEATURE_MODELS` entries to tier tokens, and teach
`resolveFeatureModel` to expand `$tier`:

```ts
// top of lib/ai/models.ts — replace the claude-models import:
import type { FeatureKey } from "@/lib/ai/feature-keys";
import { getCachedFeatureModelOverrides } from "@/lib/ai/override-source";
import { getCachedModelCatalog } from "@/lib/ai/catalog-source";
import { resolveTier, type Tier } from "@/lib/ai/model-tiers";

const TIER_TOKENS: Record<string, Tier> = {
  "$frontier": "frontier",
  "$workhorse": "workhorse",
  "$cheap": "cheap",
};
```

Set every Anthropic entry to a tier token (full table — replace the object body):

```ts
export const FEATURE_MODELS: Record<FeatureKey, string> = {
  // frontier (was Opus)
  chat: "anthropic/$frontier",
  briefing: "anthropic/$frontier",
  tradeReviewMain: "anthropic/$frontier",
  pdfParsing: "anthropic/$frontier",

  // workhorse (was Sonnet)
  dailyDigestSynthesis: "anthropic/$workhorse",
  tradeReviewMainLarge: "anthropic/$workhorse",
  tradeReviewQA: "anthropic/$workhorse",
  newsletterLevelExtraction: "anthropic/$workhorse",
  newsletterProcessing: "anthropic/$workhorse",
  factorClassification: "anthropic/$workhorse",
  securityClassification: "anthropic/$workhorse",
  analysisFactorNarrative: "anthropic/$workhorse",
  analysisMacroThemes: "anthropic/$workhorse",
  macroEnrichment: "anthropic/$workhorse",
  scheduleVerification: "anthropic/$workhorse",
  filingSectionExtraction: "anthropic/$workhorse",
  researchDocumentExtraction: "anthropic/$workhorse",
  earningsPreview: "anthropic/$workhorse",
  earningsRecap: "anthropic/$workhorse",
  earningsBogeysExtraction: "anthropic/$workhorse",
  etfSectorWeights: "anthropic/$workhorse",

  // cheap (was Haiku)
  researchMentionVerification: "anthropic/$cheap",
  suggestedLevelNarrative: "anthropic/$cheap",

  // explicit experiment — unchanged, NOT tiered
  alertSuggestion: "workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct",
};
```

In `resolveFeatureModel`, after computing `spec` (the string from override or
FEATURE_MODELS), expand a tier token before `parseModelSpec`:

```ts
export function resolveFeatureModel(feature: FeatureKey): ResolvedModel {
  const override = getCachedFeatureModelOverrides()[feature];
  const spec = override ?? FEATURE_MODELS[feature];
  if (!spec) throw new Error(`No model configured for feature "${feature}"`);

  // Expand "anthropic/$frontier" → "anthropic/claude-…" via the live catalog.
  const slash = spec.indexOf("/");
  const maybeToken = slash === -1 ? "" : spec.slice(slash + 1);
  const tier = TIER_TOKENS[maybeToken];
  if (tier) {
    const provider = spec.slice(0, slash); // "anthropic"
    const modelId = resolveTier(tier, getCachedModelCatalog());
    return parseModelSpec(`${provider}/${modelId}`);
  }

  try {
    return parseModelSpec(spec);
  } catch {
    // Malformed override → fall back to the code default.
    return parseModelSpec(FEATURE_MODELS[feature]);
  }
}
```

- [ ] **Step 4: Reduce `lib/claude-models.ts` to re-exports of the static fallback**

```ts
// lib/claude-models.ts
/**
 * Legacy single-source constants. Model selection now lives in
 * lib/ai/model-tiers.ts (tier ladders) + the live catalog. These re-exports
 * remain ONLY for non-feature importers; prefer tiers for anything new.
 */
import { TIER_STATIC_FALLBACK } from "@/lib/ai/model-tiers";

export const OPUS_MODEL = TIER_STATIC_FALLBACK.frontier;
export const SONNET_MODEL = TIER_STATIC_FALLBACK.workhorse;
export const HAIKU_MODEL = TIER_STATIC_FALLBACK.cheap;
```

- [ ] **Step 5: Run to verify it passes + full suite**

Run: `npx vitest run tests/ai/resolve-feature-model.test.ts`
Expected: PASS.
Run: `npx vitest run` and `npx tsc --noEmit`
Expected: green (any test asserting the old `claude-opus-4-7` for `chat` updates to a tier expectation).

- [ ] **Step 6: Commit**

```bash
git add lib/ai/models.ts lib/claude-models.ts tests/ai/resolve-feature-model.test.ts
git commit -m "feat(ai): resolve feature models via tier tokens + live catalog"
```

---

## Phase D — Reactive failover + refusal wrapper

### Task 5: `lib/ai/generate.ts` wrappers

**Files:**
- Create: `lib/ai/generate.ts`
- Test: `tests/ai/generate.test.ts`

**Research step (do first, then implement):** confirm how `@ai-sdk/anthropic`
surfaces (a) a 404 `not_found` and (b) a `refusal` stop reason in the installed
version.

- [ ] **Step 0: Pin the error/finish shapes**

Run:
```bash
npx tsx -e "import {APICallError} from 'ai'; console.log(typeof APICallError?.isInstance)"
grep -rn "finishReason\|APICallError\|NoObjectGeneratedError" node_modules/ai/dist/index.d.ts | head
```
Expected: `APICallError.isInstance` is a function; `finishReason` union includes values like `'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | 'unknown'`. Anthropic `refusal` maps to `finishReason: 'content-filter'` (verify; if it surfaces as `'other'`, widen the set in `isRefusal` below). Record the observed value in a code comment.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ai/generate.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const generateTextMock = vi.fn();
vi.mock("ai", async (orig) => ({ ...(await orig<typeof import("ai")>()), generateText: generateTextMock }));

import { generateTextForFeature, AIRefusalError } from "@/lib/ai/generate";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";
import { setFeatureModelOverrideSource } from "@/lib/ai/override-source";

class FakeNotFound extends Error { statusCode = 404; constructor() { super("model not_found"); } }

describe("generateTextForFeature", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    setFeatureModelOverrideSource(null);
    setModelCatalogSource(() => ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6"]);
  });

  it("returns text on success", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "ok", finishReason: "stop" });
    const r = await generateTextForFeature("chat", { prompt: "hi" });
    expect(r.text).toBe("ok");
  });

  it("on not_found, drops the dead model and retries once with the next rung", async () => {
    generateTextMock
      .mockRejectedValueOnce(new FakeNotFound())                  // fable 404s
      .mockResolvedValueOnce({ text: "ok2", finishReason: "stop" }); // opus succeeds
    const r = await generateTextForFeature("chat", { prompt: "hi" });
    expect(r.text).toBe("ok2");
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it("on refusal finishReason, throws AIRefusalError (graceful, named)", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "", finishReason: "content-filter" });
    await expect(generateTextForFeature("chat", { prompt: "hi" })).rejects.toBeInstanceOf(AIRefusalError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/ai/generate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// lib/ai/generate.ts
/**
 * Feature-aware wrappers around the AI SDK that centralize:
 *   1. Reactive failover — on a not_found / model-unavailable error, drop the
 *      dead model from the in-memory catalog and retry ONCE with the re-resolved
 *      tier (the next available rung). Cadence-independent pull handling.
 *   2. Refusal handling — Fable 5 can finish with a refusal; surface it as a
 *      named AIRefusalError so callers degrade gracefully instead of treating an
 *      empty string as a real answer.
 *
 * Call sites swap `generateText({ model: getModelForFeature(x), ...opts })` for
 * `generateTextForFeature(x, opts)` — same options minus `model`.
 */

import { generateText, generateObject, APICallError } from "ai";
import type { FeatureKey } from "@/lib/ai/feature-keys";
import { getModelForFeature } from "@/lib/ai/provider";
import { resolveFeatureModel } from "@/lib/ai/models";
import { dropModelFromCatalog, invalidateModelCatalogCache } from "@/lib/ai/catalog-source";

export class AIRefusalError extends Error {
  constructor(public feature: FeatureKey, public modelId: string) {
    super(`AI refused request for feature "${feature}" (model ${modelId})`);
    this.name = "AIRefusalError";
  }
}

// Step 0 confirmed Anthropic `refusal` → finishReason 'content-filter'.
// Widen here if a future SDK surfaces it differently.
const REFUSAL_FINISH = new Set(["content-filter"]);

function isModelUnavailable(err: unknown): boolean {
  if (APICallError.isInstance(err) && err.statusCode === 404) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /not_found|model.*(unavailable|does not exist|may not exist)/i.test(msg);
}

type GenTextOpts = Omit<Parameters<typeof generateText>[0], "model">;
type GenObjOpts = Omit<Parameters<typeof generateObject>[0], "model">;

export async function generateTextForFeature(feature: FeatureKey, opts: GenTextOpts) {
  let { modelId } = resolveFeatureModel(feature);
  try {
    const res = await generateText({ ...opts, model: getModelForFeature(feature) });
    if (REFUSAL_FINISH.has(res.finishReason)) throw new AIRefusalError(feature, modelId);
    return res;
  } catch (err) {
    if (err instanceof AIRefusalError) throw err;
    if (!isModelUnavailable(err)) throw err;
    // Reactive failover: drop the dead model, re-resolve, retry once.
    dropModelFromCatalog(modelId);
    invalidateModelCatalogCache();
    const next = resolveFeatureModel(feature).modelId;
    console.warn(`[ai] ${feature}: ${modelId} unavailable → failing over to ${next}`);
    modelId = next;
    const res = await generateText({ ...opts, model: getModelForFeature(feature) });
    if (REFUSAL_FINISH.has(res.finishReason)) throw new AIRefusalError(feature, modelId);
    return res;
  }
}

export async function generateObjectForFeature(feature: FeatureKey, opts: GenObjOpts) {
  const { modelId } = resolveFeatureModel(feature);
  try {
    return await generateObject({ ...opts, model: getModelForFeature(feature) } as Parameters<typeof generateObject>[0]);
  } catch (err) {
    if (!isModelUnavailable(err)) throw err;
    dropModelFromCatalog(modelId);
    invalidateModelCatalogCache();
    console.warn(`[ai] ${feature}: ${modelId} unavailable → retrying with re-resolved model`);
    return await generateObject({ ...opts, model: getModelForFeature(feature) } as Parameters<typeof generateObject>[0]);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/ai/generate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/generate.ts tests/ai/generate.test.ts
git commit -m "feat(ai): generate wrappers with reactive failover + refusal handling"
```

### Task 6: migrate non-streaming call sites to the wrappers

**Files (each: swap the call; remove now-unused `getModelForFeature` import if it becomes unused):**
- `lib/digest/synthesize.ts:169-173`
- `lib/alerts/generate-suggestion.ts:170-171`
- `lib/gmail/process.ts:216-217` (generateObject)
- `lib/research/verify-mentions.ts`
- `lib/securities/classify-option-sectors.ts`
- `lib/apis/filing-extract.ts`
- `lib/calendar/briefing.ts`
- `lib/calendar/macro-events.ts`
- `lib/chart/narrate-levels.ts`
- `lib/alerts/extract-newsletter-levels.ts`
- `lib/trade-review/questions.ts`
- `lib/trade-review/generate.ts`
- `lib/compute/classify-securities.ts`
- `lib/compute/analysis-narratives.ts`
- `lib/compute/macro-themes.ts`
- `lib/compute/classify-factors.ts`

**Excluded from this task:** `app/api/chat/route.ts` (streaming → Task 7),
`lib/ai/provider.ts` + `lib/ai/feature-keys.ts` (definitions, not call sites),
`lib/gmail/process.ts` keeps `generateObject` → use `generateObjectForFeature`.

- [ ] **Step 1: Worked example — `lib/digest/synthesize.ts`**

Before:
```ts
import { generateText } from "ai";
import { getModelForFeature } from "@/lib/ai/provider";
// ...
const model = getModelForFeature("dailyDigestSynthesis");
const result = await generateText({ model, prompt, maxOutputTokens: 8192 });
```
After:
```ts
import { generateTextForFeature } from "@/lib/ai/generate";
// ...
const result = await generateTextForFeature("dailyDigestSynthesis", { prompt, maxOutputTokens: 8192 });
```

- [ ] **Step 2: Apply the identical transform to each file above**

For `generateText` sites: import `generateTextForFeature` from `@/lib/ai/generate`,
replace `generateText({ model: getModelForFeature("KEY"), ...rest })` with
`generateTextForFeature("KEY", { ...rest })`. For the `generateObject` site
(`lib/gmail/process.ts`): import + use `generateObjectForFeature`. Drop the
`getModelForFeature` import where it's no longer referenced.

Find each call shape first:
```bash
grep -n "getModelForFeature\|generateText\|generateObject" <file>
```

- [ ] **Step 3: Decide refusal behavior per site**

A thrown `AIRefusalError` must not crash a pipeline. Wrap each migrated call in
try/catch that logs and returns the site's existing empty/skip result (these
files already have a degraded path for AI errors — route the refusal into it).
Example (`generate-suggestion.ts`): catch `AIRefusalError`, return `null`
suggestion (its existing no-suggestion path).

- [ ] **Step 4: Run the suites for touched areas**

Run: `npx vitest run tests/digest tests/alerts tests/compute tests/calendar tests/research`
Expected: PASS (mock `generateTextForFeature`/`generateObjectForFeature` where tests previously mocked `getModelForFeature` + `generateText`; update those mocks).

- [ ] **Step 5: Run full suite + tsc**

Run: `npx vitest run && npx tsc --noEmit`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add lib/
git commit -m "refactor(ai): route non-streaming call sites through tier-aware wrappers"
```

### Task 7: streaming chat + raw-client refusal handling

**Files:**
- Modify: `app/api/chat/route.ts:136-137`
- Modify: `lib/import/vanguard-pdf.ts` (raw client)
- Modify: `lib/digest/send-earnings-email.ts` (raw client `callClaude`)

- [ ] **Step 1: Chat (streamText) — surface refusal in-stream**

`streamText` can't use the non-streaming wrapper. Add an `onFinish` check and a
not_found `onError`/try-catch:
```ts
const result = streamText({
  model: getModelForFeature("chat"),
  // ...existing options...
  onFinish: ({ finishReason }) => {
    if (finishReason === "content-filter") {
      console.warn("[chat] model refused the request");
    }
  },
});
```
(Chat is interactive; a refusal already streams an empty/short body to the user.
No silent-failure risk — just log. Reactive failover for chat is out of scope
because Fable's interactive 404 would surface to the user, who can retry.)

- [ ] **Step 2: Raw clients — check `stop_reason` before reading content**

In `vanguard-pdf.ts` and `send-earnings-email.ts::callClaude`, after the
`messages.create()` / `messages.stream()` result, add:
```ts
if (response.stop_reason === "refusal") {
  throw new Error(`Claude refused the ${"<feature>"} request`); // routed to existing error path
}
```
Place it before any `response.content[0]` access. Both files already have
retry/error handling that will surface this rather than crash on an empty array.

- [ ] **Step 3: Run suites + tsc**

Run: `npx vitest run tests/import && npx tsc --noEmit`
Expected: green.

- [ ] **Step 4: Confirm 30-day data retention (operational, document it)**

Verify in the Anthropic Console that the org is on ≥30-day retention (a ZDR org
400s on every Fable request). Record the confirmed setting in a comment at the
top of `lib/ai/model-tiers.ts` (`// Org retention: 30-day (confirmed YYYY-MM-DD) — required for Fable`).

- [ ] **Step 5: Commit**

```bash
git add app/api/chat/route.ts lib/import/vanguard-pdf.ts lib/digest/send-earnings-email.ts lib/ai/model-tiers.ts
git commit -m "feat(ai): refusal handling for streaming chat + raw Anthropic clients"
```

---

## Phase E — Weekly refresh + observability

### Task 8: weekly `refreshModelCatalog` hook in the briefing pipeline

**Files:**
- Modify: `lib/digest/send-briefing.ts`

- [ ] **Step 1: Add the refresh call**

Near the top of `sendBriefingEmail` (it already runs `runAutoRefresh(db, "quick")`),
add a best-effort catalog refresh — failures must not block the briefing:
```ts
import { refreshModelCatalog } from "@/lib/ai/model-catalog";
import { invalidateModelCatalogCache } from "@/lib/ai/catalog-source";
// ...inside sendBriefingEmail, after db is available:
try {
  await refreshModelCatalog(db);
  invalidateModelCatalogCache(); // pick up the new list immediately
} catch (e) {
  console.warn(`[send-briefing] model catalog refresh skipped: ${String(e)}`);
}
```

- [ ] **Step 2: Run the briefing test area + tsc**

Run: `npx vitest run tests/digest tests/calendar && npx tsc --noEmit`
Expected: green (mock `refreshModelCatalog` in any test that exercises `sendBriefingEmail`).

- [ ] **Step 3: Commit**

```bash
git add lib/digest/send-briefing.ts
git commit -m "feat(ai): refresh model catalog weekly via the Sunday briefing pipeline"
```

### Task 9: observability — log tier resolution changes

**Files:**
- Modify: `lib/ai/models.ts` (add a logging hook inside the tier-expansion branch)
- Test: `tests/ai/tier-observability.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ai/tier-observability.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolveFeatureModel } from "@/lib/ai/models";
import { setModelCatalogSource, invalidateModelCatalogCache } from "@/lib/ai/catalog-source";
import { setFeatureModelOverrideSource } from "@/lib/ai/override-source";
import { __resetTierLog } from "@/lib/ai/models";

describe("tier resolution observability", () => {
  beforeEach(() => {
    setFeatureModelOverrideSource(null);
    __resetTierLog();
  });
  it("logs once when a tier's resolved model changes", () => {
    const warn = vi.spyOn(console, "log").mockImplementation(() => {});
    setModelCatalogSource(() => ["claude-fable-5", "claude-opus-4-8"]);
    resolveFeatureModel("chat"); // fable
    setModelCatalogSource(() => ["claude-opus-4-8"]); invalidateModelCatalogCache();
    resolveFeatureModel("chat"); // → opus, should log the change
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("frontier"));
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/ai/tier-observability.test.ts`
Expected: FAIL — `__resetTierLog` not exported / no logging.

- [ ] **Step 3: Add the change-logging in `lib/ai/models.ts`**

```ts
const lastResolvedByTier = new Map<Tier, string>();
/** test-only */
export function __resetTierLog() { lastResolvedByTier.clear(); }

// inside resolveFeatureModel, where the tier resolves to `modelId`:
const prev = lastResolvedByTier.get(tier);
if (prev !== modelId) {
  if (prev !== undefined) {
    console.log(`[ai] tier "${tier}" now resolves to ${modelId} (was ${prev})`);
  }
  lastResolvedByTier.set(tier, modelId);
}
```

(Optional Pushover: if `PUSHOVER_*` env is set, `sendPushover` on a frontier
change — left out of the test to keep it pure; wire it as a fire-and-forget if
desired.)

- [ ] **Step 4: Run to verify it passes + full suite**

Run: `npx vitest run tests/ai/tier-observability.test.ts && npx vitest run`
Expected: PASS / green.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/models.ts tests/ai/tier-observability.test.ts
git commit -m "feat(ai): log when a tier's resolved model changes (pull/return visibility)"
```

---

## Phase F — Worker parity

### Task 10: `workers/cron/src/model-tiers.ts` mirror + parity test

**Files:**
- Create: `workers/cron/src/model-tiers.ts` (byte-parity copy of `lib/ai/model-tiers.ts`, minus the `@/` path alias — it's self-contained, so a literal copy works)
- Test: `workers/cron/test/model-tiers.test.ts`

- [ ] **Step 1: Copy the resolver**

Create `workers/cron/src/model-tiers.ts` with the **exact** contents of
`lib/ai/model-tiers.ts` (no imports use the `@/` alias, so it copies verbatim).

- [ ] **Step 2: Write the parity + behavior test**

```ts
// workers/cron/test/model-tiers.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveTier, TIER_STATIC_FALLBACK } from "../src/model-tiers";

describe("worker model-tiers parity", () => {
  it("is byte-identical to the Mac resolver below the header", () => {
    const mac = readFileSync(new URL("../../../lib/ai/model-tiers.ts", import.meta.url), "utf8");
    const wkr = readFileSync(new URL("../src/model-tiers.ts", import.meta.url), "utf8");
    const strip = (s: string) => s.slice(s.indexOf("export type Tier"));
    expect(strip(wkr)).toBe(strip(mac));
  });
  it("resolves frontier to newest available", () => {
    expect(resolveTier("frontier", ["claude-opus-4-8", "claude-sonnet-4-6"])).toBe("claude-opus-4-8");
    expect(resolveTier("frontier", [])).toBe(TIER_STATIC_FALLBACK.frontier);
  });
});
```

- [ ] **Step 3: Run to verify it passes**

Run: `cd workers/cron && npx vitest run test/model-tiers.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add workers/cron/src/model-tiers.ts workers/cron/test/model-tiers.test.ts
git commit -m "feat(worker): byte-parity tier resolver mirror"
```

### Task 11: Worker `ai.ts` — tier tokens, snapshot catalog, reactive failover

**Files:**
- Modify: `workers/cron/src/ai.ts`
- Modify: the three Worker fallbacks that call `getModelForFeature` (`fallback-briefing.ts`, `fallback-digest.ts`, `fallback-evening.ts`, `newsletter-fetch.ts`) to pass the snapshot catalog + handle not_found
- Test: `workers/cron/test/ai.test.ts`

- [ ] **Step 1: Rework `MODEL_FOR_FEATURE` + `getModelForFeature` to tiers**

```ts
import { resolveTier, type Tier } from "./model-tiers";

const FEATURE_TIER: Record<WorkerFeature, Tier> = {
  fallbackBriefing: "frontier",
  fallbackNewsletterProcessing: "workhorse",
  fallbackEvening: "workhorse",
};

export function getModelForFeature(
  env: AIEnv,
  feature: WorkerFeature,
  catalog: string[] = [],
  excluded: Set<string> = new Set(),
): LanguageModel {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error(`ANTHROPIC_API_KEY missing (feature: ${feature})`);
  const modelId = resolveTier(FEATURE_TIER[feature], catalog, excluded);
  const gw = env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_GATEWAY_ID
    ? { accountId: env.CLOUDFLARE_ACCOUNT_ID, gatewayId: env.CLOUDFLARE_GATEWAY_ID } : null;
  const baseURL = gw ? `https://gateway.ai.cloudflare.com/v1/${gw.accountId}/${gw.gatewayId}/anthropic/v1` : undefined;
  const headers: Record<string, string> = {};
  if (gw) headers["cf-aig-metadata"] = JSON.stringify({ feature });
  const anthropic = createAnthropic({ apiKey, baseURL, headers });
  return anthropic(modelId);
}
```

- [ ] **Step 2: Thread the snapshot catalog + a reactive-failover helper**

Add a small helper the fallbacks use (single retry on not_found, excluding the
dead model):
```ts
export async function generateWithFailover<T>(
  env: AIEnv, feature: WorkerFeature, catalog: string[],
  call: (model: LanguageModel) => Promise<T>,
): Promise<T> {
  const excluded = new Set<string>();
  let modelId = resolveTier(FEATURE_TIER[feature], catalog);
  try {
    return await call(getModelForFeature(env, feature, catalog, excluded));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const notFound = (err as { statusCode?: number })?.statusCode === 404 || /not_found|may not exist/i.test(msg);
    if (!notFound) throw err;
    excluded.add(modelId);
    console.warn(`[worker-ai] ${feature}: ${modelId} unavailable → failover`);
    return await call(getModelForFeature(env, feature, catalog, excluded));
  }
}
```
Update each fallback to read `modelCatalog` from the loaded R2 snapshot (Task 12)
and wrap its `generateText`/`generateObject` in `generateWithFailover`.

- [ ] **Step 3: Update tests**

The existing Worker tests mock `getModelForFeature` returning "mock-model"; keep
those mocks. Add a test asserting `getModelForFeature(env,"fallbackBriefing",["claude-opus-4-8"])`
resolves via the catalog and `generateWithFailover` retries on a thrown 404.

```ts
// workers/cron/test/ai.test.ts (new cases)
import { describe, it, expect, vi } from "vitest";
import { generateWithFailover } from "../src/ai";
it("fails over on a 404", async () => {
  const env = { ANTHROPIC_API_KEY: "k" };
  const call = vi.fn()
    .mockRejectedValueOnce(Object.assign(new Error("not_found"), { statusCode: 404 }))
    .mockResolvedValueOnce("ok");
  const out = await generateWithFailover(env as never, "fallbackBriefing", ["claude-fable-5", "claude-opus-4-8"], call);
  expect(out).toBe("ok");
  expect(call).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 4: Run Worker suite + typecheck**

Run: `cd workers/cron && npx vitest run && npx tsc --noEmit`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add workers/cron/src/ai.ts workers/cron/src/fallback-*.ts workers/cron/src/newsletter-fetch.ts workers/cron/test/ai.test.ts
git commit -m "feat(worker): tier resolution + reactive failover for cloud fallbacks"
```

### Task 12: snapshot v6 adds `modelCatalog`

**Files:**
- Modify: `scripts/snapshot-state-to-r2.ts`
- Modify: the Worker snapshot type (wherever `schemaVersion` is read, e.g. `workers/cron/src/state.ts` or inline interfaces in the fallbacks)

- [ ] **Step 1: Add `modelCatalog` to the snapshot**

In `scripts/snapshot-state-to-r2.ts`:
- bump `interface Snapshot { schemaVersion: 5 }` → `6` (both the interface and the
  object literal at the bottom).
- read the cached catalog and include it:
```ts
import { getModelCatalog } from "@/lib/ai/model-catalog";
// ...in the snapshot object:
modelCatalog: getModelCatalog(db), // [] when never refreshed — Worker falls back to static
```

- [ ] **Step 2: Read it on the Worker side**

Where the Worker parses the snapshot, add `modelCatalog?: string[]` to the type
and pass `snapshot.modelCatalog ?? []` into `getModelForFeature` /
`generateWithFailover`. v5 snapshots (no field) degrade to `[]` → static fallback.

- [ ] **Step 3: Run both suites + typechecks**

Run: `npx tsc --noEmit && cd workers/cron && npx tsc --noEmit && npx vitest run`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add scripts/snapshot-state-to-r2.ts workers/cron/src/
git commit -m "feat(snapshot): v6 carries the model catalog for Worker tier resolution"
```

---

## Phase G — Finalize

### Task 13: full verification + docs/memory

**Files:**
- Modify: `CLAUDE.md` (AI model routing bullet — replace the FEATURE_MODELS description with the tier model)
- Modify: `memory/project_ai_gateway.md` (note the tier layer)
- Create: `memory/reference_model_tier_resolution.md` + MEMORY.md index line

- [ ] **Step 1: Full suite + both typechecks**

Run: `npx vitest run && npx tsc --noEmit && (cd workers/cron && npx vitest run && npx tsc --noEmit)`
Expected: all green; report the test counts (Mac + Worker).

- [ ] **Step 2: Build check**

Run: `npx next build`
Expected: compiles (catches issues tests miss).

- [ ] **Step 3: Smoke the resolver against the live catalog**

Run:
```bash
npx tsx -e "import('./lib/ai/model-catalog').then(async m => { const Database = (await import('better-sqlite3')).default; const db = new Database('data/vanguard.db'); const ids = await m.refreshModelCatalog(db); console.log('catalog:', ids); const t = await import('./lib/ai/model-tiers'); console.log('frontier →', t.resolveTier('frontier', ids), '| workhorse →', t.resolveTier('workhorse', ids)); })"
```
Expected: prints the live model ids and the resolved frontier (Opus 4.8 while
Fable is pulled) / workhorse (Sonnet 4.6). Confirms end-to-end resolution.

- [ ] **Step 4: Update docs + memory**

- `CLAUDE.md` AI-routing bullet: document tier tokens (`$frontier`/`$workhorse`/`$cheap`),
  the live catalog + weekly refresh, reactive failover, and the one editable file
  (`lib/ai/model-tiers.ts`).
- New `memory/reference_model_tier_resolution.md`: how to add a feature (pick a
  tier), how to add a brand-new family (edit `FAMILY_LADDERS` + `TIER_STATIC_FALLBACK`),
  and that the Worker mirror must stay byte-parity.
- Add the one-line MEMORY.md index entry.

- [ ] **Step 5: Final commit**

```bash
git add CLAUDE.md memory/ docs/
git commit -m "docs(ai): document tier-based model resolution"
```

---

## Self-review notes (for the implementer)

- **Spec coverage:** Task 1 = §1/§2 (policy + resolver); Task 2 = §3 (catalog cache + weekly cadence); Task 3 = §4 (reader seam); Task 4 = §5/§6 (wiring + feature→tier table); Task 5–7 = §3b (reactive failover) + §8 (Fable readiness); Task 8 = §3 weekly hook; Task 9 = §9 (observability); Tasks 10–12 = §7 (Worker parity + snapshot v6); Task 13 = testing + migration docs.
- **Open items from the spec** are resolved in-plan: refusal/`not_found` shapes in Task 5 Step 0; retention in Task 7 Step 4; `claude-models.ts` kept as thin re-exports in Task 4 Step 4.
- **Streaming caveat:** chat (`streamText`) gets refusal logging only, not reactive failover — documented in Task 7 Step 1 (interactive surface; user can retry).
