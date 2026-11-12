/**
 * probe-tool-choice-none.ts: the one-off W3-4(d) check behind OPEN-1.
 *
 * Question: does the provider accept a request whose history holds a tool
 * call and its result while `toolChoice: "none"` is set? In
 * @ai-sdk/anthropic 3.0.64 `toolChoice: "none"` drops the `tools` array from
 * the request (plan P4), so the API sees tool_use / tool_result blocks with
 * no tool definitions. If it is accepted with a written reply, `toolChoice:
 * "none"` on the last step is a stronger last-step guard than the note.
 *
 * NEEDS SEPARATE OWNER APPROVAL. This probe calls the provider from its
 * OWN process, so it needs ANTHROPIC_API_KEY outside the app's server, which
 * the 2026-11-11 run rules do not allow. It refuses a live call unless
 * --owner-approved is passed (only the owner may pass it); --dry-run is
 * always allowed. The in-app alternative is a normal chat request that
 * reaches the route's last step, which cannot set toolChoice from outside
 * without a route change.
 *
 * ONE small live call (a few thousand tokens), on the chat feature's own
 * model: `getModelForFeature("chat")`, resolved against the eval database
 * the same way the server resolves it. Never a hardcoded model id. The tool
 * definition and history are synthetic (no portfolio data is sent).
 *
 *   npx tsx scripts/chat-eval/probe-tool-choice-none.ts --db data/chat-eval/eval.db --dry-run
 *   source ~/.zshrc && npx tsx scripts/chat-eval/probe-tool-choice-none.ts --db data/chat-eval/eval.db [--max-usd 0.1]
 *
 * Prints one verdict line: ACCEPTED (with the finish reason and whether text
 * came back) or REJECTED (status code and provider error type, through the
 * route's own allowlisted error formatter).
 */

import Database from "better-sqlite3";
import { generateText, jsonSchema, tool, type ModelMessage } from "ai";
import { setFeatureModelOverrideSource } from "../../lib/ai/override-source";
import { setModelCatalogSource } from "../../lib/ai/catalog-source";
import { getFeatureModelOverrides } from "../../lib/queries/ai-model-overrides";
import { getModelCatalog } from "../../lib/ai/model-catalog";
import { resolveFeatureModel } from "../../lib/ai/models";
import { getModelForFeature } from "../../lib/ai/provider";
import { formatChatError, usageTokenFields } from "../../lib/chat/usage-log";
import { EVAL_FIXTURE_VERSION, liveDbRefusal, readEvalMarker, resolvedDbPath } from "./db-guard";
import { budgetAllows, costOf, priceFor } from "./pricing";

const PROBE_MAX_OUTPUT = 300;

export const PROBE_MESSAGES: ModelMessage[] = [
  { role: "user", content: "What is the weather code for station A?" },
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "probe-call-1", toolName: "lookup_station", input: { station: "A" } }],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "probe-call-1",
        toolName: "lookup_station",
        output: { type: "json", value: { station: "A", code: "CLEAR-7" } },
      },
    ],
  },
];

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const dbArg = arg(argv, "--db");
  const refusal = liveDbRefusal(dbArg);
  if (refusal) {
    console.error(`probe: ${refusal}`);
    return 2;
  }
  const dbPath = resolvedDbPath(dbArg!);
  console.log(`database: ${dbPath}`);
  process.env.DATABASE_PATH = dbPath;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (readEvalMarker(db) !== EVAL_FIXTURE_VERSION) {
      console.error(`probe: refusing ${dbPath}: no eval marker (build it with build-eval-db.ts)`);
      return 2;
    }
    setFeatureModelOverrideSource(() => getFeatureModelOverrides(db));
    setModelCatalogSource(() => getModelCatalog(db));
    const modelId = resolveFeatureModel("chat").modelId;
    const price = priceFor(modelId);
    console.log(`chat model: ${modelId}`);
    if (!price) {
      console.error(`probe: refusing: model ${modelId} has no price in scripts/chat-eval/pricing.ts`);
      return 2;
    }
    const maxUsd = Number(arg(argv, "--max-usd") ?? 0.1);
    // Worst case: ~3k input written to cache at the write rate, full output.
    const estimate = costOf({ noCache: 3000, cacheWrite: 3000, cacheRead: 0, output: PROBE_MAX_OUTPUT }, price);
    const decision = budgetAllows(0, estimate, maxUsd);
    console.log(`budget: ${decision.reason}`);
    console.log(`request: toolChoice "none", 1 tool defined in the call (dropped by the provider), history = user, assistant tool-call, tool result; thinking adaptive; maxOutputTokens ${PROBE_MAX_OUTPUT}`);
    if (argv.includes("--dry-run")) return 0;
    if (!argv.includes("--owner-approved")) {
      console.error("probe: refusing the live call: it needs the API key outside the app server and separate owner approval (--owner-approved). Use --dry-run to print the request.");
      return 2;
    }
    if (!decision.run) return 2;

    const tools = {
      lookup_station: tool({
        description: "Look up a weather station's current code.",
        inputSchema: jsonSchema<{ station: string }>({
          type: "object",
          properties: { station: { type: "string" } },
          required: ["station"],
          additionalProperties: false,
        }),
        execute: async () => ({ station: "A", code: "CLEAR-7" }),
      }),
    };
    try {
      const result = await generateText({
        model: getModelForFeature("chat"),
        maxOutputTokens: PROBE_MAX_OUTPUT,
        tools,
        toolChoice: "none",
        messages: PROBE_MESSAGES,
        providerOptions: { anthropic: { thinking: { type: "adaptive" } } },
        maxRetries: 0,
      });
      const u = usageTokenFields(result.totalUsage);
      const spent = costOf({ noCache: u.noCache ?? 0, cacheWrite: u.cacheWrite ?? 0, cacheRead: u.cacheRead ?? 0, output: u.output ?? 0 }, price);
      console.log(
        `verdict: ACCEPTED: finish ${result.finishReason}; text ${result.text.trim().length > 0 ? "returned" : "EMPTY"}; tool calls ${result.toolCalls.length}; cost $${spent.toFixed(4)}`,
      );
      return 0;
    } catch (error) {
      const e = formatChatError(error);
      console.log(`verdict: REJECTED: status ${e.statusCode ?? "?"}, type ${e.providerErrorType ?? "?"}, ${e.name}: ${e.message}`);
      return 1;
    }
  } finally {
    db.close();
  }
}

if (process.argv[1] && /probe-tool-choice-none\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
