# Provider Failover Design — Anthropic outage must never pause the desk

- Date: 2026-11-02
- Branch: `pm/provider-failover` · Worktree: `~/code/vanguard-skin-provider-failover`
- Status: design approved for slice 1 (this branch); slices 2–5 scoped, not built
- Trigger: 2026-11-01/02 incident — Anthropic Console credit exhaustion parked 23
  print-prep steps as `pending` (`AI unavailable (billing)`), hub showed "AI prep is
  paused", no prints armed and no emails until credits were bought by hand.

## 1. Goal and provider order

Any single provider's **account-level** failure (credits exhausted, spend cap,
auth/config breakage) must degrade the desk to the next provider instead of
pausing it. Provider order for every failover-eligible feature:

1. **anthropic** (primary — unchanged defaults everywhere)
2. **openai** (first fallback)
3. **workers-ai** (second fallback, text features only — see §5)

Non-goals: changing any feature's primary provider; chasing transient errors
across providers (rate limits/outages keep today's wait-and-retry semantics on
the same provider — they are minutes-scale and self-healing); making Workers AI
a PDF or native-tool provider.

## 2. The catalog finding — why the lever is tier mappings, not catalog rows

`lib/ai/model-catalog.ts` is **fetched live from Anthropic**: `refreshModelCatalog`
lists `/v1/models`, probes callability, and caches callable Claude IDs in the
`model_catalog` settings row; `resolveTier` only ever walks Claude family
ladders. Adding OpenAI/Workers-AI rows to that cache would be overwritten on
the next refresh and ignored by tier resolution. The repo's own philosophy
("the catalog is live-discovered; the *ordering* lives in code",
`lib/ai/model-tiers.ts`) points at the correct lever:

- **Per-provider tier tables in `lib/ai/model-tiers.ts`** — the one
  human-editable piece of domain knowledge — giving every provider a
  `frontier / workhorse / cheap` mapping.
- **Provider-aware tier expansion in `lib/ai/models.ts`.** Today this is not
  just missing but actively wrong: `expandSpec` expands a `$tier` token against
  the Anthropic catalog *regardless of the spec's provider prefix*, so an
  override of `openai/$workhorse` would resolve to a Claude model ID and hand
  it to OpenAI. Slice 1 fixes this: tier tokens expand per-provider;
  Anthropic expansion is byte-for-byte the current ladder behaviour.

Invariants respected: no model ID is hardcoded outside the tier tables
(features still name tier tokens); `lib/ai` gains no db imports (catalog /
override injection seams untouched); the `workers/cron` mirror of
`model-tiers.ts` stays byte-for-byte identical below its header, per the
parity pin.

## 3. Verified model IDs per provider and tier

Verified 2026-11-02 against the providers' own docs (never from memory):

| Tier | Anthropic (live catalog; static fallback) | OpenAI | Workers AI |
|---|---|---|---|
| frontier | ladder: fable → opus → sonnet (fallback `claude-opus-4-8`) | `gpt-6-astra` — "flagship model for complex reasoning and coding" | `@cf/openai/gpt-oss-120b` — production, high-reasoning open-weight |
| workhorse | ladder: sonnet → haiku (fallback `claude-sonnet-4-6`) | `gpt-6.1-sol` — near-flagship at lower cost | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| cheap | ladder: haiku (fallback `claude-haiku-4-5-20251001`) | `gpt-6-luna` — "most efficient model for focused, high-volume tasks" | `@cf/meta/llama-4-scout-17b-16e-instruct` (already in production for `alertSuggestion`) |

Sources: OpenAI model list, `platform.openai.com/docs/models` (gpt-6-astra,
gpt-6.1-sol, gpt-6.1-terra, gpt-6-luna); Workers AI model list,
`developers.cloudflare.com/workers-ai/models` (gpt-oss-120b/20b,
llama-3.3-70b-instruct-fp8-fast, llama-4-scout-17b-16e-instruct).
`gpt-6.1-terra` is the recorded alternate for the OpenAI workhorse slot if
Sol's latency disappoints. These tables are *defaults for resolution*, exactly
like `TIER_STATIC_FALLBACK` — operators can still pin any explicit
provider-qualified spec per feature via Settings → AI Models.

## 4. Which features fail over, which stay parked

Failover triggers only on **account-level** classifications (`billing`,
`auth`, `config`) from the shared classifier (§6). `rate_limit`, `outage`,
`network` keep today's semantics: the step waits as `pending`, no attempt
counted, retried on the same provider.

**Auto-failover eligible** (plain text / structured-output features already
routed through the `lib/ai` SDK wrappers — `generateTextForFeature`,
`generateObjectForFeature`): chat, dailyDigestSynthesis, overnightCommentary,
briefing, tradeReviewMain, tradeReviewMainLarge, tradeReviewQA,
newsletterLevelExtraction, newsletterProcessing, factorClassification,
securityClassification, sectorVerification, analysisFactorNarrative,
analysisMacroThemes, macroEnrichment, filingSectionExtraction,
researchMentionVerification, suggestedLevelNarrative, earningsDateVerification
(text path), transcriptSummary, earningsDebrief, printWatchFirstPass,
printFilingSummary, newsletterBogeyExtraction (text path).

Eligibility is still gated per feature by the parity validation in §8 — the
list above is the *ceiling*, not the rollout.

**Stay parked on Anthropic account failure** (until their own slice lands):

- **Native Claude `web_search` features** — `scheduleVerification`,
  `earningsPreview`, `earningsRecap`, `etfSectorWeights`. Their specs already
  say "must stay on Anthropic: Claude-native web_search". OpenAI has a web
  search tool, but wiring it is a per-feature port + parity project, not a
  failover flip.
- **Raw-SDK PDF features** — `earningsBogeysExtraction`, `pdfParsing`
  (Vanguard statements), `researchDocumentExtraction`, `armedBogeyDeepRead` —
  until the §5 PDF seam is built and parity-gated. These keep today's
  behaviour exactly: parked as `pending`, hub banner, self-heal on recovery.
- `alertSuggestion` already runs on Workers AI; on a Workers-AI account
  failure it parks (it is the last resort, there is nowhere further to fall).

The `earnings_ai_unavailable` marker and hub banner gain a `provider` field:
the banner names the failing provider and, once failover is live, which
provider is currently carrying prep ("Anthropic unavailable (billing) —
running on OpenAI").

## 5. The PDF path

Today's PDF features call the raw Anthropic client with native document
blocks (`lib/earnings/extract-bogeys.ts`, `lib/import/parsers/vanguard-pdf.ts`,
`lib/calendar/verify-earnings-dates.ts`,
`lib/research-documents/extract-forwarded.ts`).

**OpenAI — viable.** Per OpenAI's file-input docs
(`developers.openai.com/api/docs/guides/file-inputs`): Chat Completions
accepts PDF as `file` content parts (base64 `file_data` or an uploaded
`file_id`); the Responses API accepts `input_file` and, on vision-capable
models, extracts **both text and page images** — the same dual signal the
Claude document block provides. This app's AI SDK OpenAI provider defaults to
the Responses API, so a PDF part can ride the existing
`generateObjectForFeature` message flow. Design: a provider-neutral seam
`extractFromPdf(feature, pdfBytes, schema, prompt)` in `lib/ai`; the
Anthropic implementation is today's raw path (untouched — the PDF parsing
integration is on CLAUDE.md's "What NOT to change" list as the *primary*);
the OpenAI implementation sends a file part at the feature's tier. First
consumer: bogey extraction (`extract-bogeys.ts`), the print-prep heart.
Vanguard statement parsing (streaming, format-sensitive) ports last, if ever.

**Workers AI — cannot, on the current route.** The Gateway
OpenAI-compatible chat endpoint exposes text (and, for multimodal models,
image) inputs; there is no PDF document input. A Workers-AI PDF path would
need local PDF→text/raster pre-processing, changing extraction fidelity —
out of scope. PDF features therefore fail over **anthropic → openai only**
and park if both are down.

## 6. Classifier extension (shared `lib/gmail/enrichment-failure.ts`)

There is one classifier and there stays one: `classifyEnrichmentError` /
`classifyApiCallError`, which `lib/earnings/ai-unavailable.ts` already defers
to. OpenAI error envelopes are the same JSON shape
(`{ error: { message, type, code, param } }`) but the **discriminating field
is `error.code`**, and quota exhaustion arrives as **HTTP 429** — which the
current status fallback would misread as a transient `rate_limit`, so a dead
OpenAI account would never trip failover. Verified against OpenAI's error-code
docs (`platform.openai.com/docs/guides/error-codes`, read 2026-11-02;
"for billing-related errors, inspect `error.code`… the broader `error.type`
can still be `insufficient_quota`"):

| OpenAI signal | Kind |
|---|---|
| code `credit_balance_exhausted` (429) | billing |
| code `organization_spend_limit_exceeded` / `project_spend_limit_exceeded` / `organization_usage_limit_exceeded` (429) | billing |
| type or code `insufficient_quota` (legacy quota shape) | billing |
| code `invalid_api_key` (401, type `invalid_request_error`) | auth |
| code `rate_limit_exceeded`, code `slow_down` (429) | rate_limit |
| code `server_is_overloaded` (503, type `service_unavailable_error`) | outage |

Placement: parse `code` alongside `type` in the envelope reader; check the
OpenAI code map **after** the Anthropic `error.type` map (Anthropic envelopes
carry no `code`, so no collision) and **before** the status-code fallbacks.
Everything else — status fallbacks, billing-prose patterns, network
detection, the deliberate unknown→article-level default — is unchanged.

**Workers AI / Gateway shapes** (slice 2 verification item, not slice 1):
through the Gateway compat endpoint, model errors surface in
OpenAI-compatible shape and the table above applies; Cloudflare-native
errors use `{ success: false, errors: [{ code, message }] }` with HTTP
status. Until a documented Workers-AI billing code exists, an unexplained
Workers-AI 429 classifies as `rate_limit` (waits, retries) — the safe
direction for the last-resort provider.

## 7. Settings / override UX for swapping

Already shipped and reused: Settings → AI Models stores per-feature
provider-qualified specs (`feature_model_overrides`), validated on write by
`MODEL_OVERRIDE_PATTERN` (`lib/queries/ai-model-overrides.ts`) plus
`parseModelSpec`'s provider whitelist. Slice 1 makes tier specs meaningful
for every provider: `expandSpec` expands them per-provider, and the override
pattern now admits `$` (tier-token overrides were previously rejected for
every provider, Anthropic included). So a **manual swap is possible the
moment the keys exist**: set the print-prep features to `openai/$frontier`
etc. and the desk runs on OpenAI — no deploy.

Slice 4 adds the failover-native UX: a per-feature ordered fallback list
(new settings key `feature_provider_fallbacks`, defaulting to
`openai → workers-ai` for eligible features), a hub banner state naming the
active provider, and a one-click "run prep on the fallback" group toggle for
the earnings features. No new env plumbing: keys stay in the app env /
Electron settings store exactly as today.

## 8. Validation plan — parity before eligibility

A feature becomes failover-eligible only after passing, per fallback provider:

1. **Golden inputs**: a frozen corpus per feature (real historical inputs —
   a print filing for bogeys, a newsletter for processing, a transcript for
   summary), stored under `tests/fixtures/failover/<feature>/`.
2. **Figure parity (hard gate)**: for extraction features, every numeric
   field the Anthropic baseline produced must match exactly; any miss keeps
   the feature parked-eligible only. For narrative features, schema validity
   + a rubric check (length, required sections, no invented figures —
   reusing the existing number-trust checks where they exist).
3. **Shadow mode**: the fallback runs in parallel on live inputs, output
   compared and logged, never persisted, for at least one full earnings
   cycle before the feature's eligibility flag flips.
4. **Classifier fixtures**: recorded error envelopes per provider per kind
   (slice 1 ships the OpenAI set) so a provider's error-shape change fails
   tests, not production.
5. Rollout order: one low-stakes text feature (newsletterProcessing) →
   print-prep text features → bogey PDF seam → (separately) web-search
   features.

## 9. Slice plan

- **Slice 1 (this branch)**: per-provider tier tables in `model-tiers.ts`
  (+ Worker mirror), provider-aware tier expansion in `models.ts`, `$`
  admitted in the override pattern, OpenAI code map in the shared
  classifier, unit tests. Feature defaults unchanged; no behaviour change
  on any live path.
- **Slice 2**: failover executor — on an account-level classification for an
  eligible feature, retry once on the next provider (§4), marker/banner
  provider field, Workers-AI envelope verification.
- **Slice 3**: PDF seam (§5) for bogey extraction, parity-gated.
- **Slice 4**: settings UX for fallback lists + group toggle.
- **Slice 5**: the cron Worker's own posture during an Anthropic outage
  (it composes fallback emails from the R2 snapshot; its mirrored tier
  tables arrive with slice 1, its provider routing is separate work).

## 10. Operator steps (Isaac, when ready)

Keys are the only missing piece; nothing in slice 1 needs them to merge.

1. **OpenAI**: create an API key and add `OPENAI_API_KEY` to the app env
   (`.env.local` locally / Electron settings in the packaged app). Ensure the
   OpenAI org has prepaid credits — the failure mode this design defends
   against is per-provider, so an unfunded fallback is no fallback.
2. **Workers AI (third option)**: the app's Workers-AI route runs through
   the Cloudflare AI Gateway compat endpoint and needs
   `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`,
   `CLOUDFLARE_GATEWAY_TOKEN`, and `CLOUDFLARE_WORKERS_AI_TOKEN` —
   env names per `lib/env.ts`. If the gateway values are already set for
   the existing gateway routing, only the Workers AI token may be missing.
