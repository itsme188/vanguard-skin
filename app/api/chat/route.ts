import { NextRequest } from "next/server";
import {
  streamText,
  tool,
  jsonSchema,
  convertToModelMessages,
  stepCountIs,
  type SystemModelMessage,
  type Tool,
  type UIMessage,
} from "ai";
import { db } from "@/lib/db";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { CHAT_TOOLS, executeTool } from "@/lib/chat/tools";
import {
  resolveChatScope,
  chatScopeAccountIds,
  scopeClampName,
  clampToolInputToScope,
} from "@/lib/chat/scope";
import { buildSystemPromptBlocks } from "@/lib/chat/system-prompt";
import { computeIbkrTradingContext, type IbkrTradingContext } from "@/lib/chat/ibkr-context";
import { getAnthropicApiKey } from "@/lib/env";
import { getModelForFeature } from "@/lib/ai/provider";
import { SCOPE_LABELS, VALID_SCOPES, type ChatScope } from "@/lib/types";
import { createConversation, saveMessage, updateConversationTitle } from "@/lib/mutations/chat";
import { getConversationById, getLastConversationMessage } from "@/lib/queries/chat";
import { todayET } from "@/lib/calendar/date-utils";
import { conversationTitleFromMessages } from "@/lib/chat/conversation-title";
import { verifySession } from "@/lib/queries/sessions";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { readPageField, pageNoteFor } from "@/lib/chat/page-context-server";
import {
  sanitizeUiHistory,
  dropEmptyAssistantMessages,
  unansweredPriorNote,
  findOrphanToolCalls,
  dropOrphanToolCalls,
  LAST_STEP_NOTE,
  MAX_CHAT_STEPS,
} from "@/lib/chat/history";
import { assistantRowText, joinStepTexts } from "@/lib/chat/turn-outcome";
import {
  logChatError,
  logChatWarning,
  logUsageStep,
  logUsageTurn,
  usageTokenFields,
  estimateAbortedOutputTokens,
  estimateAbortedInputTokens,
} from "@/lib/chat/usage-log";
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

/** One cache breakpoint (Contract D). Three are used: last tool, static system block, automatic tail. */
const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" as const } } };

/**
 * Requests whose stream is still running. `request.signal` is fed by an
 * abort controller that the Request object owns, and the platform forwards
 * the caller's abort to it only while that controller is reachable: nothing
 * else references the Request once POST returns, so a garbage collection
 * mid-stream could drop it and the abort never reached `streamText` (no
 * onAbort, slot held; 8 of 20 test runs). Holding the Request here until its
 * slot is released keeps the abort path alive. Entries leave when the turn
 * settles (finish, error, abort) or the route throws.
 */
const STREAMING_REQUESTS = new Set<Request>();

/** The text of a UI message's text parts, joined. */
function messageText(message: unknown): string {
  const parts = (message as { parts?: unknown })?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

/** A positive integer id from the request, or null (unknown text starts a new conversation). */
function requestedConversationId(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

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

  // Set once this turn has a conversation row. EVERY response sent after that
  // point names it in X-Conversation-Id (failures included), because the
  // client adopts a conversation only from this header: a post-create failure
  // without it would leave Retry opening a second conversation.
  let conversationHeaders: Record<string, string> | undefined;
  try {
    const body = (await request.json()) as Record<string, unknown> | null;
    const messages = body?.messages as UIMessage[] | undefined;
    const rawScope = body?.scope;
    const rawConvId = body?.conversationId;
    // Contract A: only the page PATH is read from the client. The legacy
    // free-text `pageContext` field is ignored entirely.
    const page = readPageField(body);

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

    const sizeCheck = checkRequestSize(messages, page);
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

    // NOTE: the concurrency slot is deliberately NOT acquired here. The
    // size/rate/daily checks above are cheap and side-effect-free on
    // rejection, so it's fine to run them before acquiring anything. But
    // scope validation and the API-key check below both `return` (not
    // throw) on failure — a slot acquired before them would never reach
    // streamText's onFinish/onError/onAbort OR the outer catch (which only
    // fires on a throw), leaking a slot on every invalid-scope or
    // missing-API-key request until the 10-minute stale-slot prune. Acquire
    // the slot immediately before the streamText call instead, once every
    // early-return path that doesn't throw has already passed.

    // Validate scope — missing defaults to "all", invalid returns 400
    let scope: ChatScope = "all";
    if (rawScope !== undefined && rawScope !== null) {
      if (!VALID_SCOPES.includes(rawScope as ChatScope)) {
        return Response.json(
          {
            error: `Invalid scope: ${String(rawScope)}. Valid: ${VALID_SCOPES.join(", ")}`,
          },
          { status: 400 }
        );
      }
      scope = rawScope as ChatScope;
    }

    // Conversation id (B14). An unknown or deleted id starts a new
    // conversation in this scope (the header names it); a known id stored
    // under another scope is refused, so a scoped conversation never carries
    // on under a wider scope (OPEN-3 default).
    let conversationId: number | null = null;
    let untitled = true;
    const requestedId = requestedConversationId(rawConvId);
    if (requestedId !== null) {
      const existing = getConversationById(db, requestedId);
      if (existing) {
        if (existing.scope !== scope) {
          const label = SCOPE_LABELS[existing.scope as ChatScope] ?? existing.scope;
          return Response.json(
            {
              success: false,
              error: `This conversation was started in the ${label} scope. Start a new conversation to change scope.`,
            },
            { status: 409 }
          );
        }
        conversationId = existing.id;
        untitled = existing.title === null;
      }
    }
    if (conversationId === null) {
      conversationId = createConversation(db, scope);
    }
    const convId: number = conversationId;
    conversationHeaders = { "X-Conversation-Id": String(convId) };

    // Title from the first user message, set as soon as the row exists, so a
    // first turn that is stopped or fails still titles the conversation
    // (browser pass item 3). The title is the user's own first line, cut at a
    // word boundary and stored as written: no figures are masked (owner
    // ruling 2026-11-12, lib/chat/conversation-title.ts).
    if (untitled) {
      try {
        const title = conversationTitleFromMessages(messages);
        if (title) updateConversationTitle(db, convId, title);
      } catch (error) {
        logChatError("set conversation title", error);
      }
    }

    // Save the latest user message (B12) only when the request ends with one
    // (an approval continuation ends with the assistant message), and not
    // again when a retry re-sends the message already stored last. A request
    // rejected before this point (rate limit, daily ceiling) saved nothing,
    // so its retry saves the message once.
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === "user") {
      const textContent = messageText(lastMessage);
      if (textContent) {
        const stored = getLastConversationMessage(db, convId);
        const isRetry = stored?.role === "user" && stored.content === textContent;
        if (!isRetry) saveMessage(db, convId, "user", textContent, null);
      }
    }

    const apiKey = getAnthropicApiKey();
    if (!apiKey) {
      return Response.json(
        {
          error:
            "ANTHROPIC_API_KEY not configured. Add it to .env.local to enable chat.",
        },
        { status: 500, headers: conversationHeaders }
      );
    }

    // Scope (Contract I, P1, P10): a single-account scope is its scope word's
    // whole id list; one that matches no account reads nothing.
    const scopeResolution = resolveChatScope(db, scope);
    const scopeAccountIds = chatScopeAccountIds(scopeResolution);

    let portfolioContext = "";
    if (scope !== "macro") {
      portfolioContext = getPortfolioSummaryForChat(
        db,
        scopeAccountIds === undefined
          ? undefined
          : { accountIds: scopeAccountIds, label: SCOPE_LABELS[scope] },
      );
    }
    // ET-anchored (repo rule): UTC toISOString() rolls to tomorrow after ~8pm ET.
    const currentDate = todayET();

    // IBKR trading dashboard: it describes one account, so it is built only
    // when the IBKR scope is exactly one account.
    let ibkrContext: IbkrTradingContext | undefined;
    let ibkrNote: string | undefined;
    if (scope === "ibkr" && scopeResolution.kind === "accounts") {
      const accounts = scopeResolution.accounts;
      if (accounts.length === 1) {
        ibkrContext = computeIbkrTradingContext(db, accounts[0].id, accounts[0].name);
      } else {
        ibkrNote = `The IBKR scope covers ${accounts.length} accounts; the trading dashboard covers one account and is left out.`;
      }
    }

    // Contract D: the static block is the same for every request in this
    // scope and carries the cache mark; everything that changes per request
    // (date, dashboard, summary, page) is in the volatile block after it.
    const blocks = buildSystemPromptBlocks({
      scope,
      currentDate,
      portfolioContext,
      ibkrContext,
      ibkrNote,
      pageNote: pageNoteFor(db, page),
    });
    const staticBlock = blocks.staticBlock;

    // Item H: never send a tool call without its result (an aborted turn, a
    // stale approval card); an approved continuation passes intact. A reply
    // stopped before any text is dropped (browser pass item 2); when that, or
    // a reload with nothing saved, leaves two owner messages in a row, this
    // request's volatile block says to answer the latest one.
    const history = dropEmptyAssistantMessages(sanitizeUiHistory(messages));
    const priorNote = unansweredPriorNote(history);
    const volatileBlock = priorNote ? `${blocks.volatileBlock}\n\n${priorNote}` : blocks.volatileBlock;
    const staticSystem: SystemModelMessage = {
      role: "system",
      content: staticBlock,
      providerOptions: EPHEMERAL,
    };
    const systemBlocks: SystemModelMessage[] = [staticSystem, { role: "system", content: volatileBlock }];
    // Item G (P4): the last allowed step is told so in the volatile block
    // only; the static block and its mark are untouched.
    const lastStepSystem: SystemModelMessage[] = [
      staticSystem,
      { role: "system", content: `${volatileBlock}\n\n${LAST_STEP_NOTE}` },
    ];

    // Convert existing Anthropic tool definitions to AI SDK tool format.
    // Each tool wraps the existing executeTool() dispatcher, preserving all
    // tool logic and data quality annotations without any rewrite.
    // HARD scope boundary: in a single-account scope clampToolInputToScope
    // FORCES account_name to the scope for every account-bearing tool
    // (overriding any model-supplied value; a narrower account inside a
    // several-account scope is kept, P2), so a scoped chat can never reach
    // another account's portfolio data (U2c leak fix). Undefined for all/macro.
    const scopeAccountName = scopeClampName(scope, scopeResolution);
    const clampIds =
      scopeAccountIds && scopeAccountIds.length > 1 ? { db, accountIds: scopeAccountIds } : undefined;

    const aiTools: Record<string, Tool> = {};
    CHAT_TOOLS.forEach((t, index) => {
      const name = t.name;
      const isLast = index === CHAT_TOOLS.length - 1;
      aiTools[name] = tool({
        description: t.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema: jsonSchema<Record<string, unknown>>(t.input_schema as any),
        // Contract C: the SDK withholds execute until the owner approves.
        ...(t.needsApproval ? { needsApproval: t.needsApproval } : {}),
        // Contract H: compact model-facing output, when a tool defines one.
        ...(t.toModelOutput ? { toModelOutput: t.toModelOutput } : {}),
        // Contract D item 5: the cache mark on the LAST tool by position.
        ...(isLast ? { providerOptions: EPHEMERAL } : {}),
        execute: async (rawInput, { abortSignal }) => {
          const input = clampToolInputToScope(
            rawInput as Record<string, unknown>,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            t.input_schema as any,
            scopeAccountName,
            clampIds,
          );
          return executeTool(db, name, input, { abortSignal, scopeAccountIds });
        },
      }) as Tool;
    });

    let modelMessages = await convertToModelMessages(history, {
      tools: aiTools,
      ignoreIncompleteToolCalls: true,
    });
    const orphans = findOrphanToolCalls(modelMessages);
    if (orphans.length > 0) {
      logChatWarning(`orphan tool call dropped (${orphans.length})`);
      modelMessages = dropOrphanToolCalls(modelMessages, orphans);
    }

    // Acquire the concurrency slot HERE — immediately before streamText —
    // now that every early-return path that doesn't throw (scope
    // validation, the API-key check) has already passed. Anything past
    // this point either reaches streamText's onFinish/onError/onAbort or
    // throws into the outer catch, so releaseSlot is guaranteed a call site.
    const slot = acquireStreamSlot(sessionKey, nowMs);
    if (!slot.ok) {
      return Response.json(
        { success: false, error: "Too many concurrent chat requests for this session." },
        { status: 429, headers: conversationHeaders }
      );
    }
    let slotReleased = false;
    STREAMING_REQUESTS.add(request);
    releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      STREAMING_REQUESTS.delete(request);
      releaseStreamSlot(sessionKey, slot.slotId);
    };

    let loggedSteps = 0;
    // What the finished steps produced, collected as they finish, so an
    // errored or aborted turn can still charge and save them (R3-2, R3-4).
    const finishedStepTexts: string[] = [];
    let finishedStepOutput = 0;
    // Token counts of the finished steps, summed, for an aborted turn's line.
    const finishedTokens = { noCache: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    let lastModelId: string | undefined;
    // The step being streamed (browser pass item 1): its text so far, saved
    // if the owner presses Stop mid-step, and its characters (text and
    // reasoning) for the output estimate. Reset when the step finishes.
    let inFlightText = "";
    let inFlightChars = 0;
    // The step that was sent and has not finished: whether any chunk of its
    // reply arrived, and the size of what was sent for it (tool definitions,
    // system blocks, messages), for the aborted step's input estimate.
    let stepInFlight = false;
    let inFlightChunks = 0;
    let inFlightInputChars = 0;
    const toolDefinitionChars = JSON.stringify(
      CHAT_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    ).length;
    let errored = false;
    let aborted = false;
    // The turn is charged and its row saved exactly once: onAbort and
    // onFinish can both run for one aborted turn.
    let settled = false;
    const saveAssistantRow = (text: string | null) => {
      try {
        if (!text) return;
        saveMessage(db, convId, "assistant", text, null);
      } catch (error) {
        logChatError("save assistant message", error);
      }
    };
    let streamedSteps = 0;

    // Stream with automatic agentic tool loop (up to MAX_CHAT_STEPS model calls)
    const result = streamText({
      model: getModelForFeature("chat"),
      maxOutputTokens: 16000,
      system: systemBlocks,
      tools: aiTools,
      messages: modelMessages,
      stopWhen: stepCountIs(MAX_CHAT_STEPS),
      // B13: without a signal streamText never runs onAbort, so a closed tab
      // held its concurrency slot until the stale prune.
      abortSignal: request.signal,
      prepareStep: ({ stepNumber, messages: stepMessages }) => {
        const isLastStep = stepNumber === MAX_CHAT_STEPS - 1;
        stepInFlight = true;
        inFlightChunks = 0;
        inFlightInputChars =
          toolDefinitionChars +
          JSON.stringify(isLastStep ? lastStepSystem : systemBlocks).length +
          JSON.stringify(stepMessages).length;
        return isLastStep ? { system: lastStepSystem } : undefined;
      },
      providerOptions: {
        anthropic: {
          thinking: { type: "adaptive" },
          // Contract D item 6: automatic caching of the conversation tail.
          cacheControl: { type: "ephemeral" },
        },
      },
      // Installed SDK (ai 6.0.138): onChunk receives `{ chunk }` for each
      // text-delta (`chunk.text`), reasoning-delta, tool and raw part, as the
      // stream is read. Only the text is kept for saving; reasoning and tool
      // input only count toward the estimate.
      onChunk: ({ chunk }) => {
        inFlightChunks++;
        if (chunk.type === "text-delta") {
          inFlightText += chunk.text;
          inFlightChars += chunk.text.length;
        } else if (chunk.type === "reasoning-delta") {
          inFlightChars += chunk.text.length;
        } else if (chunk.type === "tool-input-delta") {
          inFlightChars += chunk.delta.length;
        }
      },
      onStepFinish: (step) => {
        finishedStepTexts.push(step.text ?? "");
        finishedStepOutput += step.usage?.outputTokens ?? 0;
        const tokens = usageTokenFields(step.usage);
        finishedTokens.noCache += tokens.noCache ?? 0;
        finishedTokens.cacheWrite += tokens.cacheWrite ?? 0;
        finishedTokens.cacheRead += tokens.cacheRead ?? 0;
        finishedTokens.output += tokens.output ?? 0;
        lastModelId = step.response?.modelId ?? lastModelId;
        inFlightText = "";
        inFlightChars = 0;
        stepInFlight = false;
        logUsageStep({
          conversationId: convId,
          scope,
          model: step.response?.modelId,
          step: loggedSteps++,
          ...usageTokenFields(step.usage),
          finishReason: step.finishReason,
        });
      },
      onFinish: async ({ steps, finishReason, totalUsage }) => {
        // Release the concurrency slot first so the next request for this
        // session sees capacity immediately.
        releaseSlot();
        // An abort already logged, charged and saved this turn (the SDK runs
        // onAbort and then onFinish for one aborted turn).
        if (aborted) return;

        const allSteps = steps ?? [];
        logUsageTurn({
          conversationId: convId,
          scope,
          model: allSteps[allSteps.length - 1]?.response?.modelId,
          steps: allSteps.length,
          ...usageTokenFields(totalUsage),
          finishReason,
        });
        if (finishReason === "content-filter") {
          logChatWarning("model refused the request");
        }

        if (settled) return; // an abort already charged and saved this turn
        settled = true;

        if (errored) {
          // R3-2: a later step failed. Charge what the finished steps
          // produced (the SDK's total reads 0 here) and save their text, never
          // the step-limit sentence.
          recordDailyUsage(sessionKey, budgetDay, finishedStepOutput);
          saveAssistantRow(joinStepTexts(finishedStepTexts) || null);
          return;
        }

        // Best-effort daily ceiling accounting (#35, task 22): the AI SDK's
        // actual post-call usage figure, not an estimate.
        recordDailyUsage(sessionKey, budgetDay, totalUsage?.outputTokens ?? finishedStepOutput);
        // B11: every step's text, or the sentence for an empty turn (Contract B).
        saveAssistantRow(assistantRowText(allSteps, finishReason));
      },
      onError: ({ error }) => {
        // Additive (#35, task 22): streamText's own error hook, independent
        // of toUIMessageStreamResponse's onError below — this logs, marks the
        // turn errored for onFinish, and releases the concurrency slot so an
        // in-flight-generation error never leaves the session stuck at the cap.
        errored = true;
        logChatError("streamText", error);
        releaseSlot();
      },
      onAbort: () => {
        // Fires on client disconnect (abortSignal above) — same release, so
        // an abandoned request can't leak a slot. Browser pass items 1 and 4,
        // R3-4 / R4-7: save the finished steps' text plus the text of the step
        // that was streaming (what the owner saw; nothing when both are
        // empty); charge the finished steps' real output plus an ESTIMATE for
        // the aborted step, whose usage the provider never reports; log one
        // turn line that says so.
        releaseSlot();
        aborted = true;
        if (settled) return;
        settled = true;
        const abortedSteps = stepInFlight ? 1 : 0;
        const estimate = abortedSteps ? estimateAbortedOutputTokens(inFlightChars) : null;
        logUsageTurn({
          conversationId: convId,
          scope,
          model: lastModelId,
          steps: finishedStepTexts.length,
          ...finishedTokens,
          finishReason: "abort",
          abortedSteps,
          abortedOutputEstimate: estimate,
          // Input spend is logged, not charged: the daily budget counts output.
          abortedInputEstimate: abortedSteps ? estimateAbortedInputTokens(inFlightInputChars) : null,
          abortedInputCache: abortedSteps ? "unknown" : null,
          abortedStepProcessed: abortedSteps ? (inFlightChunks > 0 ? "chunks-received" : "maybe-not") : null,
        });
        recordDailyUsage(sessionKey, budgetDay, finishedStepOutput + (estimate ?? 0));
        saveAssistantRow(joinStepTexts([...finishedStepTexts, inFlightText]) || null);
      },
    });

    return result.toUIMessageStreamResponse({
      sendReasoning: true,
      headers: conversationHeaders,
      // Contract B: the finish part tells the client why an empty turn ended.
      messageMetadata: ({ part }) => {
        if (part.type === "finish-step") streamedSteps++;
        if (part.type === "finish") {
          return { finishReason: part.finishReason, stepCount: streamedSteps };
        }
        return undefined;
      },
      onError: (error) =>
        error instanceof Error ? error.message : "Stream error",
    });
  } catch (error) {
    // Covers any synchronous throw between acquiring the concurrency slot
    // and streamText's own callbacks taking over release duty (e.g. a
    // model-resolution error in getModelForFeature) — releaseSlot is a
    // no-op if the slot was already released or never acquired.
    releaseSlot();
    logChatError("route", error);
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500, headers: conversationHeaders });
  }
}
