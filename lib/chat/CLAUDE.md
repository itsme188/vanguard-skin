# Portfolio Analyst Chat — Domain Rules

Rules specific to the Claude-powered chat system. See root CLAUDE.md for project-wide conventions.

## Architecture (AI SDK v6)

- **Server** (`app/api/chat/route.ts`): Uses `streamText` from `ai` with `@ai-sdk/anthropic` provider
- **Client** (`ChatInterface.tsx`): Uses `useChat` from `@ai-sdk/react` with `DefaultChatTransport`
- **Streaming**: `toUIMessageStreamResponse({ sendReasoning: true })` — handles the entire stream protocol
- **Tool loop**: `stopWhen: stepCountIs(8)` — AI SDK handles the agentic loop automatically (no manual iteration)

## Model Configuration

- **Model:** `claude-opus-4-6` via `createAnthropic({ apiKey })` (direct, no AI Gateway)
- **Thinking:** `providerOptions: { anthropic: { thinking: { type: "adaptive" } } }`
- **Cache control:** System prompt wrapped in `{ role: "system", content, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }`
- **Max output:** `maxOutputTokens: 16000`

## Tool Definitions

- `tools.ts` — 14 Anthropic-format tool definitions (`CHAT_TOOLS`) + `executeTool()` dispatcher
- `route.ts` dynamically wraps each `CHAT_TOOLS` entry into an AI SDK `tool()` with `jsonSchema()` + `execute`
- No tool logic was rewritten — `executeTool()` is called from within each AI SDK tool's `execute` function

## File Layout

- `tools.ts` — 14 tool definitions + `executeTool()` dispatcher
- `system-prompt.ts` — analyst persona prompt (scope-aware: portfolio vs macro)
- `validate.ts` — data quality annotations (`quality_warnings[]` + `data_freshness`)
- `lib/queries/chat-tools.ts` — 7 query functions + cash estimates + data freshness

## Client Message Format

- Messages use `UIMessage` with `parts` array (text, reasoning, tool-*, step-start)
- Scope is passed via `DefaultChatTransport({ body: { scope } })`
- `regenerate()` for retry, `setMessages([])` for new conversation
- `MarkdownMessage` renders text parts (not AI Elements — project has its own design system)

## Gotchas

- Case-insensitive account matching: exact match first, then `LOWER(name) LIKE '%' || LOWER(?) || '%'`
- Data quality annotations wrap every tool result — check `quality_warnings` in responses
- `jsonSchema<Record<string, unknown>>()` type parameter is required for `execute` to be allowed
- `convertToModelMessages()` is async — must be awaited
- **Account scope is a HARD boundary, enforced in code (2026-06-15, U2c).** When scope is a single account, `lib/chat/scope.ts::clampToolInputToScope` force-overrides `account_name` to the scoped account for every account-bearing tool — overriding any model-supplied value, not just filling blanks. `scopeToAccountName(db, scope)` is the single resolver. The system prompt states the hard boundary + defers cross-account/asset-location to "All Accounts"; the Taxable persona's "compare to the Roth IRA" line was removed (it invited the leak). Don't rely on the prompt alone — the clamp is the guarantee.
- **NEVER put dynamic request body (scope/conversationId/pageContext) in `DefaultChatTransport`.** `useChat` captures the transport from the FIRST render and ignores later transport objects, so a memoized body freezes at mount-time `scope:"all"` and the scope selector becomes cosmetic (the 2026-06-15 leak — chat ran fully unscoped). Keep the transport api-only + stable; pass the live body per call via `sendMessage(msg, { body })` and `regenerate({ body })`. See `memory/reference_usechat_transport_gotcha.md`.
