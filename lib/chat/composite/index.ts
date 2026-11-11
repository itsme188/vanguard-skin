/**
 * The six composite read tools (Portfolio Assistant plan, Task 6).
 *
 * Registration (Task 8, `lib/chat/tools.ts`): append `COMPOSITE_CHAT_TOOLS`
 * to `CHAT_TOOLS`; dispatch a composite name through
 * `runCompositeTool(name, db, input, ctx)` AFTER the dispatcher's own
 * `account_name` resolution, passing `ctx.accountIds` (the resolved ids;
 * `undefined` = every account), `ctx.accountName` (the exact name when one
 * account) and `ctx.today` (`todayET()`); add `COMPOSITE_SCOPE_LIST_TOOLS` to
 * `SCOPE_LIST_TOOLS`. Every definition declares `account_name`, so the scope
 * clamp applies. Every tool is read-only and makes no AI or network call.
 */
import type Database from "better-sqlite3";
import type { CompositeContext, CompositeTool, CompositeToolDefinition } from "./shared";
import { queryRiskTool } from "./risk";
import { queryScenariosTool } from "./scenarios";
import { queryPerformanceVsBenchmarkTool } from "./performance-vs-benchmark";
import { queryRealizedGainsTool } from "./realized-gains";
import { queryOptionsBookTool } from "./options-book";
import { queryDataConfidenceTool } from "./data-confidence";

export type { CompositeContext, CompositeToolDefinition } from "./shared";

const TOOLS: readonly CompositeTool[] = [
  queryRiskTool,
  queryScenariosTool,
  queryPerformanceVsBenchmarkTool,
  queryRealizedGainsTool,
  queryOptionsBookTool,
  queryDataConfidenceTool,
];

const BY_NAME: ReadonlyMap<string, CompositeTool> = new Map(TOOLS.map((t) => [t.definition.name, t]));

/** Tool definitions, same shape as `CHAT_TOOLS` entries. */
export const COMPOSITE_CHAT_TOOLS: CompositeToolDefinition[] = TOOLS.map((t) => t.definition);

/** Composite names whose engines take an account id list (a multi-account scope is answered whole). */
export const COMPOSITE_SCOPE_LIST_TOOLS: ReadonlySet<string> = new Set(
  TOOLS.filter((t) => t.acceptsScopeList).map((t) => t.definition.name),
);

export function isCompositeTool(name: string): boolean {
  return BY_NAME.has(name);
}

/** Run a composite tool. An unknown name is an error result, never a throw. */
export function runCompositeTool(
  name: string,
  db: Database.Database,
  input: Record<string, unknown>,
  ctx: CompositeContext,
): unknown {
  const tool = BY_NAME.get(name);
  if (!tool) return { error: `Unknown composite tool: ${name}` };
  return tool.run(db, input, ctx);
}
