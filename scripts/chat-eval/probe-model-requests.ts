/**
 * probe-model-requests.ts: does each distinct request SHAPE the app sends
 * get accepted by each model id? (2026-11-12, the move to the latest model
 * of each class.)
 *
 * NOT RUN BY ANYONE YET. It spends real money and needs the owner's
 * approval. It refuses to run unless --confirm-spend is passed, and it
 * reads the key from the ANTHROPIC_API_KEY environment variable ONLY (it
 * never reads .env.local or the app's settings).
 *
 *   source ~/.zshrc && npx tsx scripts/chat-eval/probe-model-requests.ts --confirm-spend [--max-usd 3] [--models a,b] [--only extractor,chat]
 *
 * Default models: the tier static fallbacks (lib/ai/model-tiers.ts) - the
 * ids a fresh database resolves to. To probe the older generation too, pass
 * them with --models (for example the Sonnet 4.6 / Opus 4.8 / Haiku 4.5 ids).
 *
 * One minimal request per shape and model; synthetic prompts only, no
 * portfolio data. Every request is booked at its WORST case (whole input at
 * the dearer input rate, the full max_tokens of output, plus web-search
 * results and search fees) before it is sent; a request that would pass
 * --max-usd is SKIPPED, never sent. Prints one line per (shape, model):
 *   ACCEPTED  stop=<reason> in=<n> out=<n> $<cost>
 *   REJECTED  <status> <error type>: <first 200 characters of the message>
 *   SKIPPED   <why>
 *
 * Shapes (each mirrors a real call site; keep them in step):
 *   extractor          lib/print-watch/extract.ts: native structured output
 *                      (output_config.format) + fastStructuredRequestOptions
 *                      (thinking disabled / between_tools / effort low)
 *   web-search-basic   macro-events, enrich-actuals, verify-earnings-dates,
 *                      etf/sector-weights, send-earnings-email:
 *                      web_search_20250305, no thinking field, 16,000 cap
 *   web-search-frontier verify-sector-tags: web_search_20250305 +
 *                      output_config.effort high
 *   web-search-newer   web_search_20260209 (the version the API reference
 *                      prefers on these models; no call site uses it yet)
 *   preprocess-stream  scripts/preprocess-to-canonical.ts: streamed, 64,000 cap
 *   chat               app/api/chat/route.ts through the AI SDK: adaptive
 *                      thinking, cacheControl ephemeral, one tool, 16,000 cap
 *   chat-haiku         the same request on a Haiku id: since 2026-11-13 a
 *                      conversation can be started on the Haiku class. NOT
 *                      RUN YET; the docs say Haiku 5.5 accepts it (adaptive
 *                      on by default, effort default medium, 128K output).
 *   frontier-effort    AI SDK providerOptions effort high (deep read,
 *                      first-pass read); the SDK adds the effort beta header
 *   structured         generateObjectForFeature through the AI SDK:
 *                      structuredOutputMode "outputFormat"
 *   cheap-short        narrate-levels / generate-suggestion: AI SDK, 2048 cap
 */

import Anthropic from "@anthropic-ai/sdk";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText, jsonSchema, streamText, tool } from "ai";
import { TIER_STATIC_FALLBACK, parseModelId } from "../../lib/ai/model-tiers";
import { fastStructuredRequestOptions, supportsEffort } from "../../lib/claude-request-options";
import { budgetAllows, priceFor, type ModelPrice } from "./pricing";

/** $10 per 1,000 searches (first-party pricing page). */
const WEB_SEARCH_USD_PER_SEARCH = 0.01;
/** Booked per search for the results the model reads back as input. */
const WEB_SEARCH_RESULT_INPUT_TOKENS = 30_000;
/** Booked for any prompt (all synthetic prompts here are far smaller). */
const PROMPT_INPUT_TOKENS = 2_000;

export const SHAPES = [
  "extractor",
  "web-search-basic",
  "web-search-frontier",
  "web-search-newer",
  "preprocess-stream",
  "chat",
  "chat-haiku",
  "frontier-effort",
  "structured",
  "cheap-short",
] as const;
export type Shape = (typeof SHAPES)[number];

interface ShapeSpec {
  maxTokens: number;
  searches: number;
  /** Which models a call site can actually send this shape to. */
  appliesTo: (modelId: string) => boolean;
}

const family = (id: string) => parseModelId(id)?.family ?? "";
const workhorseOrFrontier = (id: string) => ["sonnet", "opus"].includes(family(id));

export const SHAPE_SPECS: Record<Shape, ShapeSpec> = {
  extractor: { maxTokens: 16_384, searches: 0, appliesTo: () => true },
  "web-search-basic": { maxTokens: 16_000, searches: 1, appliesTo: workhorseOrFrontier },
  "web-search-frontier": { maxTokens: 16_000, searches: 1, appliesTo: (id) => workhorseOrFrontier(id) && supportsEffort(id) },
  "web-search-newer": { maxTokens: 16_000, searches: 1, appliesTo: workhorseOrFrontier },
  "preprocess-stream": { maxTokens: 64_000, searches: 0, appliesTo: (id) => family(id) === "sonnet" },
  chat: { maxTokens: 16_000, searches: 0, appliesTo: workhorseOrFrontier },
  "chat-haiku": { maxTokens: 16_000, searches: 0, appliesTo: (id) => family(id) === "haiku" },
  "frontier-effort": { maxTokens: 16_000, searches: 0, appliesTo: (id) => workhorseOrFrontier(id) && supportsEffort(id) },
  structured: { maxTokens: 2_048, searches: 0, appliesTo: () => true },
  "cheap-short": { maxTokens: 2_048, searches: 0, appliesTo: (id) => family(id) === "haiku" },
};

/** The most a probe request can cost, booked before it is sent. Pure. */
export function probeWorstCase(spec: ShapeSpec, price: ModelPrice): number {
  const inputTokens = PROMPT_INPUT_TOKENS + spec.searches * WEB_SEARCH_RESULT_INPUT_TOKENS;
  return (
    (inputTokens * Math.max(price.input, price.cacheWrite) + spec.maxTokens * price.output) / 1_000_000 +
    spec.searches * WEB_SEARCH_USD_PER_SEARCH
  );
}

const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { metric_id: { type: "string" }, not_disclosed: { type: "boolean" }, value: { type: "number" } },
        required: ["metric_id", "not_disclosed"],
      },
    },
  },
  required: ["candidates"],
};
const SEARCH_PROMPT = "Using one web search, what is the publication date of the most recent ISM Manufacturing report? Answer in one line.";

interface Outcome {
  verdict: "ACCEPTED" | "REJECTED";
  detail: string;
  usd: number;
}

function rawCost(usage: Anthropic.Usage | undefined, price: ModelPrice): number {
  if (!usage) return 0;
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  return (
    ((usage.input_tokens ?? 0) * price.input +
      (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
      (usage.output_tokens ?? 0) * price.output) /
      1_000_000 +
    searches * WEB_SEARCH_USD_PER_SEARCH
  );
}

function rawAccepted(msg: Anthropic.Message, price: ModelPrice): Outcome {
  const usd = rawCost(msg.usage, price);
  return {
    verdict: "ACCEPTED",
    detail: `stop=${msg.stop_reason} in=${msg.usage.input_tokens} out=${msg.usage.output_tokens}`,
    usd,
  };
}

function sdkAccepted(
  res: { finishReason: string; usage: { inputTokens?: number; outputTokens?: number } },
  price: ModelPrice,
): Outcome {
  const i = res.usage.inputTokens ?? 0;
  const o = res.usage.outputTokens ?? 0;
  // Cache writes are booked at the dearer write rate so the reported cost is never low.
  const usd = (i * Math.max(price.input, price.cacheWrite) + o * price.output) / 1_000_000;
  return { verdict: "ACCEPTED", detail: `finish=${res.finishReason} in=${i} out=${o}`, usd };
}

function rejected(err: unknown): Outcome {
  const e = err as { status?: number; statusCode?: number; error?: { error?: { type?: string } }; responseBody?: string; message?: string };
  const status = e?.status ?? e?.statusCode ?? "no-status";
  let type = e?.error?.error?.type ?? "";
  if (!type && typeof e?.responseBody === "string") {
    const m = /"type"\s*:\s*"([a-z_]+_error)"/.exec(e.responseBody);
    if (m) type = m[1];
  }
  const message = String(e?.message ?? err).replace(/\s+/g, " ").slice(0, 200);
  return { verdict: "REJECTED", detail: `${status} ${type || "unknown_error"}: ${message}`, usd: 0 };
}

async function runShape(shape: Shape, modelId: string, apiKey: string, price: ModelPrice): Promise<Outcome> {
  const raw = new Anthropic({ apiKey, maxRetries: 0 });
  const sdk = createAnthropic({ apiKey })(modelId);
  try {
    switch (shape) {
      case "extractor": {
        const fast = fastStructuredRequestOptions(modelId);
        const msg = await raw.messages.create({
          model: modelId,
          max_tokens: SHAPE_SPECS.extractor.maxTokens,
          ...(fast.thinking ? { thinking: fast.thinking as Anthropic.ThinkingConfigParam } : {}),
          output_config: {
            format: { type: "json_schema", schema: EXTRACT_SCHEMA },
            ...(fast.effort ? { effort: fast.effort } : {}),
          },
          system: "Report one candidate per metric_id from the document.",
          messages: [{ role: "user", content: 'Contract: ["revenue_q"]. Document: "Total revenue: $1,234 million."' }],
        });
        return rawAccepted(msg, price);
      }
      case "web-search-basic":
      case "web-search-frontier":
      case "web-search-newer": {
        const type = shape === "web-search-newer" ? "web_search_20260209" : "web_search_20250305";
        const msg = await raw.messages.create({
          model: modelId,
          max_tokens: SHAPE_SPECS[shape].maxTokens,
          ...(shape === "web-search-frontier" ? { output_config: { effort: "high" as const } } : {}),
          tools: [{ type, name: "web_search", max_uses: 1 } as Anthropic.WebSearchTool20250305],
          messages: [{ role: "user", content: SEARCH_PROMPT }],
        });
        return rawAccepted(msg, price);
      }
      case "preprocess-stream": {
        const msg = await raw.messages
          .stream({
            model: modelId,
            max_tokens: SHAPE_SPECS["preprocess-stream"].maxTokens,
            system: "Convert the data to CSV with a header row.",
            messages: [{ role: "user", content: "date,amount\n2026-01-02,10" }],
          })
          .finalMessage();
        return rawAccepted(msg, price);
      }
      case "chat":
      case "chat-haiku": {
        const result = streamText({
          model: sdk,
          maxOutputTokens: SHAPE_SPECS.chat.maxTokens,
          system: "You answer in one sentence.",
          tools: {
            lookup_station: tool({
              description: "Look up a weather station code.",
              inputSchema: jsonSchema({
                type: "object",
                additionalProperties: false,
                properties: { station: { type: "string" } },
                required: ["station"],
              }),
            }),
          },
          messages: [{ role: "user", content: "Say hello in one sentence. Do not use the tool." }],
          providerOptions: { anthropic: { thinking: { type: "adaptive" }, cacheControl: { type: "ephemeral" } } },
          maxRetries: 0,
        });
        let error: unknown = null;
        await result.consumeStream({ onError: (e) => { error = e; } });
        if (error) throw error;
        return sdkAccepted({ finishReason: await result.finishReason, usage: await result.usage }, price);
      }
      case "frontier-effort": {
        const res = await generateText({
          model: sdk,
          maxOutputTokens: SHAPE_SPECS["frontier-effort"].maxTokens,
          prompt: "Name one prime number above 100, in one line.",
          providerOptions: { anthropic: { effort: "high" } },
          maxRetries: 0,
        });
        return sdkAccepted(res, price);
      }
      case "structured": {
        const res = await generateObject({
          model: sdk,
          maxOutputTokens: SHAPE_SPECS.structured.maxTokens,
          schema: jsonSchema<{ answer: string }>({
            type: "object",
            additionalProperties: false,
            properties: { answer: { type: "string" } },
            required: ["answer"],
          }),
          prompt: "Answer with the word ok.",
          providerOptions: { anthropic: { structuredOutputMode: "outputFormat" } },
          maxRetries: 0,
        });
        return sdkAccepted(res, price);
      }
      case "cheap-short": {
        const res = await generateText({
          model: sdk,
          maxOutputTokens: SHAPE_SPECS["cheap-short"].maxTokens,
          prompt: "Write one short sentence about a support level at 100.",
          maxRetries: 0,
        });
        return sdkAccepted(res, price);
      }
    }
  } catch (err) {
    return rejected(err);
  }
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export interface ProbeDeps {
  env: Record<string, string | undefined>;
  print: (line: string) => void;
  run: (shape: Shape, modelId: string, apiKey: string, price: ModelPrice) => Promise<Outcome>;
}

export async function main(
  argv: string[],
  deps: ProbeDeps = { env: process.env, print: (l) => console.log(l), run: runShape },
): Promise<number> {
  const { print } = deps;
  if (!argv.includes("--confirm-spend")) {
    print("probe-model-requests: refusing to run. This spends real money; pass --confirm-spend once the owner has approved the run.");
    return 2;
  }
  const apiKey = deps.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    print("probe-model-requests: ANTHROPIC_API_KEY is not set in the environment (the key is read from there only).");
    return 2;
  }
  const maxUsd = Number(arg(argv, "--max-usd") ?? "3");
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
    print("probe-model-requests: --max-usd must be a positive number");
    return 2;
  }
  const models = (arg(argv, "--models")?.split(",") ?? [...new Set(Object.values(TIER_STATIC_FALLBACK))])
    .map((m) => m.trim())
    .filter(Boolean);
  const onlyArg = arg(argv, "--only");
  const shapes = onlyArg ? (onlyArg.split(",").map((s) => s.trim()) as Shape[]) : [...SHAPES];
  const unknown = shapes.filter((s) => !SHAPES.includes(s));
  if (unknown.length > 0) {
    print(`probe-model-requests: unknown shape(s): ${unknown.join(", ")}`);
    return 2;
  }

  print(`models: ${models.join(", ")}`);
  print(`spend ceiling: $${maxUsd.toFixed(2)} (each request booked at its worst case before it is sent)`);
  let spent = 0;
  let rejectedCount = 0;
  for (const shape of shapes) {
    const spec = SHAPE_SPECS[shape];
    for (const modelId of models) {
      const label = `${shape.padEnd(20)} ${modelId.padEnd(28)}`;
      if (!spec.appliesTo(modelId)) {
        print(`${label} SKIPPED   no call site sends this shape to this model`);
        continue;
      }
      const price = priceFor(modelId);
      if (!price) {
        print(`${label} SKIPPED   no price for this id in pricing.ts (never guessed)`);
        continue;
      }
      const worst = probeWorstCase(spec, price);
      const decision = budgetAllows(spent, worst, maxUsd);
      if (!decision.run) {
        print(`${label} SKIPPED   ${decision.reason}`);
        continue;
      }
      const out = await deps.run(shape, modelId, apiKey, price);
      // Accepted: its measured cost. A 4xx rejection is refused before any
      // tokens are generated, so it costs nothing. Anything else (a 5xx, a
      // dropped connection, a mid-stream error) may have been billed: book
      // its worst case so the ceiling can never be under-counted.
      spent += out.verdict === "ACCEPTED" ? out.usd : /^4\d\d /.test(out.detail) ? 0 : worst;
      if (out.verdict === "REJECTED") rejectedCount++;
      print(`${label} ${out.verdict.padEnd(9)} ${out.detail}${out.verdict === "ACCEPTED" ? ` $${out.usd.toFixed(4)}` : ""}`);
    }
  }
  print(`spent: $${spent.toFixed(4)} of $${maxUsd.toFixed(2)}; rejected: ${rejectedCount}`);
  return rejectedCount > 0 ? 1 : 0;
}

if (process.argv[1] && /probe-model-requests\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`probe-model-requests: ${(err as Error)?.message ?? err}`);
      process.exit(2);
    },
  );
}
