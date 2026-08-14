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
import { scopeToAccountName, clampToolInputToScope } from "@/lib/chat/scope";
import { buildSystemPrompt } from "@/lib/chat/system-prompt";
import { computeIbkrTradingContext } from "@/lib/chat/ibkr-context";
import { getAccountByName } from "@/lib/queries/accounts";
import { getAnthropicApiKey } from "@/lib/env";
import { getModelForFeature } from "@/lib/ai/provider";
import { VALID_SCOPES, type ChatScope } from "@/lib/types";
import { createConversation, saveMessage, updateConversationTitle } from "@/lib/mutations/chat";
import { todayET } from "@/lib/calendar/date-utils";
import { verifySession } from "@/lib/queries/sessions";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import {
  checkRequestSize,
  checkAndConsumeRateLimit,
  isUnderDailyCeiling,
  recordDailyUsage,
  acquireStreamSlot,
  releaseStreamSlot,
  budgetDayFor,
  NO_SESSION_KEY,
} from "@/lib/chat/budget";

export async function POST(request: NextRequest) {
  // Defense-in-depth budget/rate-limit gate (#35, task 22, spec §G) — purely
  // ADDITIVE on top of the streamText/useChat integration below (CLAUDE.md's
  // "What NOT to Change"): every guard here returns before streamText is
  // ever called, and none of it alters the streamText config, the tool set,
  // or the client wiring. `releaseSlot` is declared here (outer scope, not
  // inside the try) so both the streamText onFinish/onError/onAbort hooks
  // AND the outer catch below can release the same concurrency slot no
  // matter which path the request takes. Tunables live in lib/chat/budget.ts.
  let releaseSlot: () => void = () => {};

  try {
    const { messages, scope: rawScope, conversationId: rawConvId, pageContext } = await request.json();

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return Response.json(
        { error: "Messages array is required" },
        { status: 400 }
      );
    }

    // Session key: the verified session id, read the same cookie->
    // verifySession way as app/api/auth/pin/route.ts. proxy.ts already
    // required a valid human session to reach this route at all (it's
    // "human"-classified by default-deny in lib/auth/route-policy.ts) — this
    // re-check just recovers the session's numeric id (one indexed SELECT)
    // to key the per-session budget on. A missing/expired cookie (local dev
    // without the auth boundary, or an edge-case expiry race) falls back to
    // one shared bucket rather than being unbounded (spec §G: "keying on a
    // per-process/global bucket is an acceptable simpler fallback").
    const nowMs = Date.now();
    const rawSessionToken = request.cookies.get(SESSION_COOKIE)?.value;
    const verifiedSession = rawSessionToken ? verifySession(db, rawSessionToken, nowMs) : null;
    const sessionKey = verifiedSession ? `session:${verifiedSession.id}` : NO_SESSION_KEY;
    const budgetDay = budgetDayFor(nowMs);

    const sizeCheck = checkRequestSize(messages, pageContext);
    if (!sizeCheck.ok) {
      return Response.json({ success: false, error: sizeCheck.reason }, { status: 400 });
    }

    const rateLimit = checkAndConsumeRateLimit(sessionKey, nowMs);
    if (!rateLimit.ok) {
      return Response.json(
        { success: false, error: "Too many chat requests — please wait a moment and try again." },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(rateLimit.retryAfterMs / 1000)) },
        }
      );
    }

    if (!isUnderDailyCeiling(sessionKey, budgetDay)) {
      return Response.json(
        { success: false, error: "Daily chat usage limit reached for this session. Try again tomorrow." },
        { status: 429 }
      );
    }

    const slot = acquireStreamSlot(sessionKey, nowMs);
    if (!slot.ok) {
      return Response.json(
        { success: false, error: "Too many concurrent chat requests for this session." },
        { status: 429 }
      );
    }
    let slotReleased = false;
    releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      releaseStreamSlot(sessionKey, slot.slotId);
    };

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
    // ET-anchored (repo rule): UTC toISOString() rolls to tomorrow after ~8pm ET.
    const currentDate = todayET();

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
    // HARD scope boundary: when scope is a single account, clampToolInputToScope
    // FORCES account_name to that account for every account-bearing tool —
    // overriding any model-supplied value — so a scoped chat can never reach
    // another account's portfolio data (U2c leak fix). undefined for all/macro.
    const scopeAccountName = scopeToAccountName(db, scope);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aiTools: Record<string, any> = {};
    for (const t of CHAT_TOOLS) {
      const name = t.name;
      aiTools[name] = tool({
        description: t.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema: jsonSchema<Record<string, unknown>>(t.input_schema as any),
        execute: async (rawInput) => {
          const input = clampToolInputToScope(
            rawInput as Record<string, unknown>,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            t.input_schema as any,
            scopeAccountName,
          );
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
      onFinish: async ({ text, finishReason, totalUsage }) => {
        // Best-effort daily ceiling accounting (#35, task 22): the AI SDK's
        // actual post-call usage figure, not an estimate — accumulated here
        // because this is the one place streamText hands back real token
        // counts. Release the concurrency slot in the same breath so the
        // next request for this session sees capacity immediately.
        recordDailyUsage(sessionKey, budgetDay, totalUsage?.outputTokens ?? 0);
        releaseSlot();

        if (finishReason === "content-filter") {
          console.warn("[chat] model refused the request");
        }
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
      onError: ({ error }) => {
        // Additive (#35, task 22): streamText's own error hook, independent
        // of toUIMessageStreamResponse's onError below — this only logs +
        // releases the concurrency slot so an in-flight-generation error
        // never leaves the session permanently stuck at the concurrency cap.
        console.error("[chat] streamText error:", error);
        releaseSlot();
      },
      onAbort: () => {
        // Additive (#35, task 22): fires on client disconnect / stream
        // abort — same release, so an abandoned request can't leak a slot.
        releaseSlot();
      },
    });

    return result.toUIMessageStreamResponse({
      sendReasoning: true,
      headers: { "X-Conversation-Id": String(conversationId) },
      onError: (error) =>
        error instanceof Error ? error.message : "Stream error",
    });
  } catch (error) {
    // Covers any synchronous throw between acquiring the concurrency slot
    // and streamText's own callbacks taking over release duty (e.g. a
    // model-resolution error in getModelForFeature) — releaseSlot is a
    // no-op if the slot was already released or never acquired.
    releaseSlot();
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
