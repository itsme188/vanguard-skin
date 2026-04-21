import { NextRequest } from "next/server";
import {
  streamText,
  tool,
  jsonSchema,
  convertToModelMessages,
  stepCountIs,
} from "ai";
import { db } from "@/lib/db";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { CHAT_TOOLS, executeTool, resolveAccountName } from "@/lib/chat/tools";
import { buildSystemPrompt } from "@/lib/chat/system-prompt";
import { computeIbkrTradingContext } from "@/lib/chat/ibkr-context";
import { getAccountByName } from "@/lib/queries/accounts";
import { getAnthropicApiKey } from "@/lib/env";
import { getModelForFeature } from "@/lib/ai/provider";
import { VALID_SCOPES, type ChatScope } from "@/lib/types";
import { createConversation, saveMessage, updateConversationTitle } from "@/lib/mutations/chat";

export async function POST(request: NextRequest) {
  try {
    const { messages, scope: rawScope, conversationId: rawConvId, pageContext } = await request.json();

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return Response.json(
        { error: "Messages array is required" },
        { status: 400 }
      );
    }

    // Validate scope — missing defaults to "all", invalid returns 400
    let scope: ChatScope = "all";
    if (rawScope !== undefined && rawScope !== null) {
      if (!VALID_SCOPES.includes(rawScope)) {
        return Response.json(
          {
            error: `Invalid scope: ${rawScope}. Valid: ${VALID_SCOPES.join(", ")}`,
          },
          { status: 400 }
        );
      }
      scope = rawScope;
    }

    let conversationId = rawConvId ? Number(rawConvId) : null;
    if (!conversationId) {
      conversationId = createConversation(db, scope);
    }

    // Save latest user message
    const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
    if (lastUserMsg) {
      const textContent = lastUserMsg.parts
        ?.filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("") ?? "";
      if (textContent) saveMessage(db, conversationId, "user", textContent, null);
    }

    const apiKey = getAnthropicApiKey();
    if (!apiKey) {
      return Response.json(
        {
          error:
            "ANTHROPIC_API_KEY not configured. Add it to .env.local to enable chat.",
        },
        { status: 500 }
      );
    }

    // Build portfolio context filtered to scope
    let portfolioContext = "";
    if (scope !== "macro") {
      const scopeToAccountHint: Record<string, string> = {
        ibkr: "IBKR",
        "vanguard-taxable": "Vanguard Taxable",
        "vanguard-roth-ira": "Vanguard Roth IRA",
      };
      const accountHint = scopeToAccountHint[scope];
      const accountName = accountHint
        ? resolveAccountName(db, accountHint)
        : undefined;
      portfolioContext = getPortfolioSummaryForChat(db, accountName);
    }
    const currentDate = new Date().toISOString().slice(0, 10);

    // Compute IBKR dynamic trading context when scoped to IBKR
    const ibkrContext = scope === "ibkr"
      ? (() => {
          const ibkrAccountName = resolveAccountName(db, "IBKR");
          if (!ibkrAccountName) return undefined;
          const ibkrAccount = getAccountByName(db, ibkrAccountName);
          if (!ibkrAccount) return undefined;
          return computeIbkrTradingContext(db, ibkrAccount.id, ibkrAccount.name);
        })()
      : undefined;

    let systemPromptText = buildSystemPrompt(portfolioContext, currentDate, scope, ibkrContext);
    if (pageContext) {
      systemPromptText += `\n\n[Current Page Context]\n${pageContext}`;
    }

    // Convert existing Anthropic tool definitions to AI SDK tool format.
    // Each tool wraps the existing executeTool() dispatcher, preserving all
    // tool logic and data quality annotations without any rewrite.
    // When scope is set to a specific account, auto-inject account_name into
    // tool inputs so the AI can't accidentally query all accounts.
    const scopeAccountName = scope !== "all" && scope !== "macro"
      ? resolveAccountName(db, { ibkr: "IBKR", "vanguard-taxable": "Vanguard Taxable", "vanguard-roth-ira": "Vanguard Roth IRA" }[scope] ?? "")
      : undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aiTools: Record<string, any> = {};
    for (const t of CHAT_TOOLS) {
      const name = t.name;
      aiTools[name] = tool({
        description: t.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema: jsonSchema<Record<string, unknown>>(t.input_schema as any),
        execute: async (rawInput) => {
          // Enforce scope: inject account_name if scoped and tool accepts it
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let input = rawInput as Record<string, any>;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (scopeAccountName && !input.account_name && (t.input_schema as any)?.properties?.account_name) {
            input = { ...input, account_name: scopeAccountName };
          }
          return executeTool(db, name, input);
        },
      });
    }

    // Stream with automatic agentic tool loop (up to 8 model calls)
    const result = streamText({
      model: getModelForFeature("chat"),
      maxOutputTokens: 16000,
      system: {
        role: "system",
        content: systemPromptText,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      },
      tools: aiTools,
      messages: await convertToModelMessages(messages),
      stopWhen: stepCountIs(8),
      providerOptions: {
        anthropic: {
          thinking: { type: "adaptive" },
        },
      },
      onFinish: async ({ text }) => {
        if (text && conversationId) {
          saveMessage(db, conversationId, "assistant", text, null);
          // Auto-title from first exchange
          const msgCount = messages.filter((m: any) => m.role === "user").length;
          if (msgCount <= 1) {
            const title = text.slice(0, 80).split("\n")[0].replace(/[#*_`]/g, "").trim();
            if (title) updateConversationTitle(db, conversationId, title);
          }
        }
      },
    });

    return result.toUIMessageStreamResponse({
      sendReasoning: true,
      headers: { "X-Conversation-Id": String(conversationId) },
      onError: (error) =>
        error instanceof Error ? error.message : "Stream error",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
