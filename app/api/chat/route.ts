import { NextRequest } from "next/server";
import {
  streamText,
  tool,
  jsonSchema,
  convertToModelMessages,
  stepCountIs,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { db } from "@/lib/db";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { CHAT_TOOLS, executeTool, resolveAccountName } from "@/lib/chat/tools";
import { buildSystemPrompt } from "@/lib/chat/system-prompt";
import { getAnthropicApiKey } from "@/lib/env";
import { VALID_SCOPES, type ChatScope } from "@/lib/types";

export async function POST(request: NextRequest) {
  try {
    const { messages, scope: rawScope } = await request.json();

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
    const systemPrompt = buildSystemPrompt(portfolioContext, currentDate, scope);

    // Create Anthropic provider with explicit API key
    const anthropic = createAnthropic({ apiKey });

    // Convert existing Anthropic tool definitions to AI SDK tool format.
    // Each tool wraps the existing executeTool() dispatcher, preserving all
    // tool logic and data quality annotations without any rewrite.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aiTools: Record<string, any> = {};
    for (const t of CHAT_TOOLS) {
      const name = t.name;
      aiTools[name] = tool({
        description: t.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema: jsonSchema<Record<string, unknown>>(t.input_schema as any),
        execute: async (input) => executeTool(db, name, input),
      });
    }

    // Stream with automatic agentic tool loop (up to 8 model calls)
    const result = streamText({
      model: anthropic("claude-opus-4-6"),
      maxOutputTokens: 16000,
      system: {
        role: "system",
        content: systemPrompt,
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
    });

    return result.toUIMessageStreamResponse({
      sendReasoning: true,
      onError: (error) =>
        error instanceof Error ? error.message : "Stream error",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
