# Portfolio Analyst Chat — Domain Rules

Rules specific to the Claude-powered chat system. See root CLAUDE.md for project-wide conventions.

## Model Configuration

- **Model:** `claude-opus-4-6` with `thinking: { type: "adaptive" }`
- Adaptive thinking requires **temperature = 1.0** — you cannot set a lower temperature
- `cache_control: { type: "ephemeral" }` on system prompt for cost reduction
- `max_tokens: 16000`, `effort` defaults to `high`

## Agentic Loop

- Stream → detect `stop_reason: "tool_use"` → execute server-side → append full `finalMessage.content` (including thinking blocks) → re-stream
- **Max 8 iterations** per user message
- Thinking blocks filtered from SSE stream; client sees `{ status: "thinking" }`, `{ text }`, and `{ status: "analyzing", tool }` events

## File Layout

- `tools.ts` — 14 tool definitions + `executeTool()` dispatcher
- `system-prompt.ts` — analyst persona prompt
- `validate.ts` — data quality annotations (`quality_warnings[]` + `data_freshness`)
- `lib/queries/chat-tools.ts` — 7 query functions + cash estimates + data freshness

## Gotchas

- Always strip ` ```json ``` ` wrappers from Claude API responses before `JSON.parse`
- Case-insensitive account matching: exact match first, then `LOWER(name) LIKE '%' || LOWER(?) || '%'` (e.g., "roth" → "Vanguard Roth IRA")
- Data quality annotations wrap every tool result — check `quality_warnings` in responses
