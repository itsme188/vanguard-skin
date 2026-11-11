/**
 * Chat evaluation: what one chat request carries, built from the same
 * library functions the route calls (for --dry-run and the cache check's
 * size estimate). It makes no model call.
 *
 * The route (app/api/chat/route.ts) assembles these parts inline in its
 * POST handler; there is no exported "build the request for a scope"
 * function. This file therefore repeats that short assembly (scope
 * resolution, summary, IBKR dashboard, the two system blocks, the tool
 * list) for an ESTIMATE only. The live run never uses it: it posts to the
 * running app, so it measures exactly what the route sends.
 */

import type Database from "better-sqlite3";
import { buildSystemPromptBlocks } from "../../lib/chat/system-prompt";
import { resolveChatScope, chatScopeAccountIds } from "../../lib/chat/scope";
import { getPortfolioSummaryForChat } from "../../lib/queries/portfolio-summary";
import { computeIbkrTradingContext, type IbkrTradingContext } from "../../lib/chat/ibkr-context";
import { pageNoteFor } from "../../lib/chat/page-context-server";
import { CHAT_TOOLS } from "../../lib/chat/tools";
import { SCOPE_LABELS, type ChatScope } from "../../lib/types";
import { roughTokens } from "./pricing";

export interface RequestPreview {
  scope: ChatScope;
  staticChars: number;
  volatileChars: number;
  toolsChars: number;
  toolCount: number;
  /** Tools + static + volatile, in characters (the base of the worst-case rule). */
  totalChars: number;
  /** Tools + static block: the cached prefix (Contract D marks 1 and 2). */
  prefixTokensEstimate: number;
  /** The volatile block. */
  volatileTokensEstimate: number;
}

export function previewRequest(db: Database.Database, scope: ChatScope, today: string, pagePath?: string): RequestPreview {
  const resolution = resolveChatScope(db, scope);
  const ids = chatScopeAccountIds(resolution);
  const portfolioContext =
    scope === "macro"
      ? ""
      : getPortfolioSummaryForChat(db, ids === undefined ? undefined : { accountIds: ids, label: SCOPE_LABELS[scope] });
  let ibkrContext: IbkrTradingContext | undefined;
  let ibkrNote: string | undefined;
  if (scope === "ibkr" && resolution.kind === "accounts") {
    if (resolution.accounts.length === 1) {
      ibkrContext = computeIbkrTradingContext(db, resolution.accounts[0].id, resolution.accounts[0].name);
    } else {
      ibkrNote = `The IBKR scope covers ${resolution.accounts.length} accounts; the trading dashboard covers one account and is left out.`;
    }
  }
  const { staticBlock, volatileBlock } = buildSystemPromptBlocks({
    scope,
    currentDate: today,
    portfolioContext,
    ibkrContext,
    ibkrNote,
    pageNote: pageNoteFor(db, pagePath ? { path: pagePath } : undefined),
  });
  const toolsJson = JSON.stringify(
    CHAT_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
  );
  return {
    scope,
    staticChars: staticBlock.length,
    volatileChars: volatileBlock.length,
    toolsChars: toolsJson.length,
    toolCount: CHAT_TOOLS.length,
    totalChars: toolsJson.length + staticBlock.length + volatileBlock.length,
    prefixTokensEstimate: roughTokens(toolsJson) + roughTokens(staticBlock),
    volatileTokensEstimate: roughTokens(volatileBlock),
  };
}
