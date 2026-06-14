# Tier-based AI model resolution

**Date:** 2026-06-14
**Status:** Design approved; implementation plan pending
**Author:** session with Yitzi

## Problem

Every AI call site routes through a concrete, hardcoded Claude model ID
(`lib/claude-models.ts` → `FEATURE_MODELS` → `resolveFeatureModel`; the Worker
has its own constants in `workers/cron/src/ai.ts`). Two recurring pains:

1. **New releases require manual edits.** A new model means hand-editing model
   strings in two source-of-truth files. Today `OPUS_MODEL` is still
   `claude-opus-4-7` — the app isn't even on Opus 4.8, let alone Fable 5.
2. **A pulled model strands the app.** On 2026-06-13 Fable 5 was pulled by a US
   government order over cyber capabilities. The nightly deep-QA cron (which
   inherited a floating default of `claude-fable-5`) died for two nights because
   it had no failover. A pinned in-app model would break the same way — and
   silently, since failures surface as "emails stopped arriving."

The user wants the app to **automatically use the most intelligent currently
available model** for high-value work and the **current good-enough model** for
routine work, with **zero manual edits** for either a new release or a rollback.

## Key constraint

The Anthropic Messages API requires **concrete model IDs** — there is no
server-side "latest opus" alias (the `opus`/`sonnet`/`fable` family aliases are a
*Claude Code CLI* feature, not an API feature). The Models API (`GET /v1/models`)
lists which models **exist** (so a pulled model vanishes from the list — useful
for auto-failover) but does **not** rank them by capability or expose pricing.

Therefore the **ordering** of capability tiers (Fable > Opus > Sonnet > Haiku)
is irreducible domain knowledge the code must hold. It changes far less often
than specific versions: a version bump (Opus 4.8 → 4.9) and a pull are both
handled automatically; only a brand-new *family name* needs a one-line edit.

## Chosen approach

**Live discovery + ordered family ladders** (selected over static-ladder and
static-map alternatives because it is the only option that auto-handles both new
releases and pulls with zero touch).

Each tier is an ordered ladder of model **families**. At resolution time, read a
cached snapshot of the live model catalog, drop any family member that has been
pulled, and pick the newest available version of the highest-priority family
that still has at least one model. If the catalog is empty/unavailable, use a
hardcoded static fallback per tier so the app never hard-fails.

```
frontier:  [fable, opus, sonnet]   static fallback → claude-opus-4-8
workhorse: [sonnet, haiku]         static fallback → claude-sonnet-4-6
cheap:     [haiku]                 static fallback → claude-haiku-4-5-20251001

Fable pulled   → frontier = claude-opus-4-8   (auto)
Fable returns  → frontier = claude-fable-5    (auto)
Opus 4.9 ships → frontier = claude-opus-4-9   (auto)
Brand-new family → 1-line ladder edit (deliberate — review before routing spend)
```

Static fallback for `frontier` is **Opus 4.8, not Fable**, because the fallback
is what's used when the catalog is unknown — it must be a model that is reliably
available, and Fable's availability is exactly what's uncertain.

## Components

### 1. Tier policy — `lib/ai/model-tiers.ts`

The single human-editable file. Exports:

- `TIER_LADDERS: Record<Tier, Family[]>` — the ordered ladders above.
- `TIER_STATIC_FALLBACK: Record<Tier, string>` — concrete IDs used when the
  catalog is empty/unavailable.
- `Tier = "frontier" | "workhorse" | "cheap"`.
- `resolveTier(tier, catalogIds): string` — **pure function** (see below).
- Version parsing helpers (`parseModelId`, `compareVersions`).

### 2. Resolver — `resolveTier(tier, catalogIds)` (pure)

Algorithm:
1. For each family in the tier's ladder, in order:
   - Collect catalog IDs whose family matches (e.g. `claude-opus-*`).
   - If any, return the one with the highest version.
2. If no family had a hit (or `catalogIds` is empty), return
   `TIER_STATIC_FALLBACK[tier]`.

Version parsing: `claude-opus-4-8` → `{ family: "opus", version: [4, 8] }`;
`claude-fable-5` → `{ family: "fable", version: [5, 0] }`;
`claude-haiku-4-5-20251001` → `{ family: "haiku", version: [4, 5] }` (date suffix
ignored for ordering, but the **full ID string is preserved** for use). Compare
by numeric version tuples, longest-common-prefix then length.

Pure and dependency-free → exhaustively unit-testable.

### 3. Model catalog cache — `lib/ai/model-catalog.ts`

Mirrors the established `getRiskFreeRate` pattern exactly:

- Cached in the `settings` table under key `model_catalog` as
  `{ ids: string[], fetchedAt: ISO8601 }`.
- `getModelCatalog(db): string[]` — read cached list (empty array if absent).
- `isModelCatalogStale(db): boolean` — true if missing or older than the
  staleness guard (~14d — a safety net for when the weekly job hasn't run, e.g.
  Mac off; **not** the primary cadence).
- `refreshModelCatalog(db): Promise<string[]>` — calls Anthropic
  `models.list()` (via the existing `getRawAnthropicClient` path or a fresh
  client), writes `{ ids, fetchedAt }` to settings, returns the ids. Graceful:
  on API error it logs and leaves the prior cache intact (no clobber).

**Refresh cadence — proactive discovery is intentionally loose.** The proactive
refresh only needs to discover *new* models, which ship weeks-to-months apart, so
checking often adds noise for no benefit. Pulls are **not** handled by this
cadence — they're handled reactively (below). Therefore:

- **Primary:** piggyback on the **weekly Sunday briefing** pipeline
  (`lib/digest/send-briefing.ts`) — add one `refreshModelCatalog` call. Weekly.
  (No new launchd plist; no daily job.)
- **Safety net only:** if `isModelCatalogStale` (>~14d, e.g. the Mac was off for
  the Sunday run), allow one best-effort non-blocking refresh. There is **no**
  per-resolve / per-call proactive refresh — resolution is never blocked on, or
  coupled to, a network call.

### 3b. Reactive failover — the pull safety net (cadence-independent)

A pull is sudden (Fable went live → gone over a weekend) and must **not** wait
for the weekly proactive refresh. This is the in-app analog of the cron's
`--fallback-model`:

- When any AI call errors with `not_found` / model-unavailable for the resolved
  model ID, the wrapper:
  1. **invalidates the catalog cache** (and drops the dead ID from the in-memory
     working set), then
  2. **re-resolves the tier excluding the dead model** (`resolveTier` walks to
     the next available rung), and
  3. for **non-streaming** calls, **retries once inline** with the re-resolved
     model so even the failing call recovers. Streaming calls (chat) surface the
     re-resolved model on the next request; an unattended pipeline's next
     scheduled run picks up the corrected resolution.
- The invalidation also schedules a best-effort `refreshModelCatalog` so the
  cache reflects reality going forward.

Net: a new model is adopted within a week (proactive, fine); a **pull fails over
on the next call** (reactive, instant), regardless of how stale the catalog is.

Implementation note: the wrapper lives at the resolution/instantiation layer
(around `getModelForFeature` / the `generateText` call) so it applies uniformly
without editing every call site. Exact placement and the AI-SDK error shape for
`not_found` are a planning research item.

### 4. Reader seam — `lib/ai/catalog-source.ts`

Exact mirror of `lib/ai/override-source.ts`: a registered synchronous reader so
`lib/ai/models.ts` (imported at module top-level by many AI modules) never
imports the `lib/db` singleton. `lib/db.ts` registers a SQLite-backed reader
after the singleton is created; in-memory test DBs and the Worker fall back to an
empty catalog → static fallback. 30s TTL cache + explicit invalidation, same as
the overrides source.

### 5. Wiring into `resolveFeatureModel` — `lib/ai/models.ts`

`FEATURE_MODELS` entries gain **tier tokens** in the model-id slot:

```ts
chat: "anthropic/$frontier",
dailyDigestSynthesis: "anthropic/$workhorse",
researchMentionVerification: "anthropic/$cheap",
alertSuggestion: "workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct", // explicit, unchanged
```

`resolveFeatureModel`: if the parsed model-id is a `$tier` token, expand it to a
concrete ID via `resolveTier(tier, getCachedModelCatalog())` **before** returning
`ResolvedModel`. Everything downstream (`provider.ts`, `getModelForFeature`, every
call site) is unchanged. Precedence is preserved:

```
user override (feature_model_overrides)  →  tier token OR explicit spec  →  static fallback
```

A stored override can itself be a `$tier` token or a concrete spec.

### 6. Feature → tier assignment

Mirrors today's model choices (Opus→frontier, Sonnet→workhorse, Haiku→cheap):

| Tier | Features |
|---|---|
| **frontier** | `chat`, `briefing`, `tradeReviewMain`, `pdfParsing` |
| **workhorse** | `dailyDigestSynthesis`, `tradeReviewMainLarge`, `tradeReviewQA`, `newsletterLevelExtraction`, `newsletterProcessing`, `factorClassification`, `securityClassification`, `analysisFactorNarrative`, `analysisMacroThemes`, `macroEnrichment`, `scheduleVerification`, `filingSectionExtraction`, `researchDocumentExtraction`, `earningsPreview`, `earningsRecap`, `earningsBogeysExtraction`, `etfSectorWeights` |
| **cheap** | `researchMentionVerification`, `suggestedLevelNarrative` |
| **explicit (untiered)** | `alertSuggestion` (deliberate Workers-AI cost experiment — stays `workers-ai/…`) |

The web-search-locked features (`scheduleVerification`, `earningsPreview`,
`earningsRecap`, `etfSectorWeights`) are Anthropic-only regardless; tiering them
just tracks the Sonnet-class version. `web_search` is supported on Fable, so no
conflict if any were ever promoted to frontier.

### 7. Worker parity — `workers/cron/`

- `workers/cron/src/ai.ts` constants → tier tokens.
- `workers/cron/src/model-tiers.ts` — **byte-parity** mirror of the Mac ladders +
  resolver, with a parity test (`workers/cron/test/model-tiers.test.ts`),
  following the existing Worker-mirror convention (e.g. `editions.ts`,
  `presence-position.ts`).
- Catalog source for the Worker: add `modelCatalog: string[]` to the **R2 state
  snapshot (bump to schemaVersion 6)** written by the 2 AM job. The snapshot just
  carries whatever the weekly refresh last wrote to settings (≤~1 week stale —
  fine, since it's only for new-model discovery). The Worker resolves tiers from
  the snapshot catalog with the same static fallback. (Chosen over a Worker-side
  Models API call to avoid extra subrequests under the 50/run free-tier cap.)
- **Worker reactive failover:** the Worker fallbacks (digest/briefing/evening/
  earnings) already wrap AI Gateway calls in try/catch; on a `not_found`/
  model-unavailable error, re-resolve the tier excluding the dead model (walking
  to the next rung / static fallback) and retry once — same pull-safety net as
  the Mac, scoped to the single run. No snapshot rewrite mid-run.

### 8. Fable-5 readiness pass

So `frontier` can safely auto-route to Fable the moment it returns, audit all
Anthropic call sites:

- **Refusal handling:** add `stop_reason === "refusal"` handling — graceful
  (log + skip/empty-result, never crash). Pre-output refusal = empty content;
  mid-stream = discard partial.
  - **Research item (resolve in the plan before writing handlers):** how
    `@ai-sdk/anthropic` surfaces the refusal stop-reason (the AI SDK abstracts
    `stop_reason`; confirm the field/finishReason mapping). The two raw-client
    sites (`vanguard-pdf.ts`, `send-earnings-email.ts`) use the Anthropic SDK
    directly and check `stop_reason` natively.
- **No disabled thinking:** confirm no call site sends `thinking:{type:"disabled"}`
  (a 400 on Fable). The chat route already uses adaptive thinking (Fable-safe).
- **Data retention:** verify (and document) the org is on 30-day retention; a
  ZDR/under-30-day org 400s on *every* Fable request.

Call sites in scope: the 11 `getModelForFeature` callers + `vanguard-pdf.ts`
(raw) + `send-earnings-email.ts` (raw).

### 9. Observability

Kills the silent-failure mode that hid both the cron outage and past email
outages. When a tier resolves to a **different concrete model than the prior
resolution**, or **falls back to the static safety net** (catalog empty/stale),
emit a log line (and an optional Pushover via the existing `sendPushover`
no-op-safe helper). So a Fable pull or return is visible, not discovered by
noticing something stopped.

Implementation: a tiny module-level `Map<Tier, lastResolvedId>`; on change, log.
Cheap, no new infra.

## Testing

- **Pure resolver units** (`tests/ai/model-tiers.test.ts`): ladder walk order;
  newest-version pick within a family; pulled-model failover to next rung;
  empty-catalog → static fallback; version parsing incl. date suffix and
  multi-digit; `frontier` static fallback is Opus (not Fable).
- **Resolution integration** (`tests/ai/resolve-feature-model.test.ts`):
  `$tier` expansion; override precedence preserved (override beats tier);
  explicit `workers-ai/…` passes through untiered; malformed override falls back.
- **Worker parity** (`workers/cron/test/model-tiers.test.ts`): ladders +
  resolver byte-identical to Mac.
- **Catalog cache** (`tests/ai/model-catalog.test.ts`): staleness boundary;
  refresh writes settings; API error leaves prior cache intact.
- **Refusal handling**: per-call-site tests asserting graceful behavior on a
  mocked `stop_reason: "refusal"`.
- **Reactive failover**: a mocked `not_found` error re-resolves the tier
  excluding the dead model and retries once (non-streaming); catalog cache is
  invalidated; static fallback is used when no rung remains.

## Migration effects (intended)

- `chat` / `briefing` / `tradeReviewMain` / `pdfParsing` move from the stale
  Opus 4.7 to **Opus 4.8** immediately (and to Fable 5 automatically when it
  returns). No behavior change expected for Opus 4.7 → 4.8 beyond intelligence;
  same request surface.
- `lib/claude-models.ts` constants (`OPUS_MODEL`/`SONNET_MODEL`/`HAIKU_MODEL`)
  are absorbed into `TIER_STATIC_FALLBACK`. Keep thin re-exports if any
  non-feature code imports them, or migrate those imports.

## Out of scope

- Re-ranking by live pricing (Models API doesn't expose it).
- Auto-adopting a brand-new *family* without a code edit (deliberate — a new
  flagship should be reviewed before production spend routes to it).
- Changing the Workers-AI / OpenAI experiment entries (they stay explicit).

## Open items to resolve during planning

1. Exact `@ai-sdk/anthropic` refusal-surfacing mechanism (field/finishReason).
2. Confirm the org's current data-retention setting (operational, not code).
3. Whether `lib/claude-models.ts` keeps thin re-export shims or all importers
   migrate to `TIER_STATIC_FALLBACK`.
4. AI-SDK error shape for `not_found`/model-unavailable, and the cleanest single
   layer to host the reactive-failover wrapper (around `getModelForFeature` /
   `generateText`) so it covers all non-streaming call sites without per-site
   edits.
