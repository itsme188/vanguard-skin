# Portfolio Assistant (in-app chat): working reference

Rules for the chat drawer and right rail. Root `CLAUDE.md` holds the project-wide rules; this file is what the next person touching the chat needs. Rewritten 2026-11-11 after the Portfolio Assistant build (plan `docs/superpowers/plans/2026-11-11-portfolio-assistant-plan.md`, decisions in `docs/DECISIONS.md` 2026-11-11). Every name below was checked against the code on that date.

## The pieces

| File | Role |
|---|---|
| `app/api/chat/route.ts` | The one `streamText` call: gates, scope, prompt, tools, history check, persistence, usage log. |
| `app/dashboard/components/ChatInterface.tsx` | The one `useChat` call: per-call body, Stop, approval card, conversation list. |
| `lib/chat/system-prompt.ts` | `buildSystemPromptBlocks` (static + volatile) and the IBKR dashboard formatter. |
| `lib/chat/tools.ts` | `CHAT_TOOLS` (33 tools), `executeTool` dispatcher, list limits, compact model output. |
| `lib/chat/composite/` | The six composite read tools over dashboard engines. |
| `lib/chat/scope.ts` | `resolveChatScope`, `chatScopeAccountIds`, `scopeClampName`, `clampToolInputToScope`. |
| `lib/chat/account-scope.ts` | `resolveChatAccounts`: how a model-supplied `account_name` resolves. |
| `lib/chat/history.ts` | `sanitizeUiHistory`, `findOrphanToolCalls`, `dropOrphanToolCalls`, `MAX_CHAT_STEPS`, `LAST_STEP_NOTE`, unwired `markLastMessageForCache`. |
| `lib/chat/turn-outcome.ts` | Client-safe: the empty-turn sentences, `turnOutcomeNotice`, `assistantRowText`, `joinStepTexts`. |
| `lib/chat/turn-adoption.ts` | Client-safe: conversation-id adoption by generation, `shouldAutoContinue` (cap 3), settled-message view. |
| `lib/chat/page-context-server.ts` | `readPageField`, `resolvePageData`, `pageNoteFor`: the page path, resolved on the server. |
| `lib/chat/page-context.ts` | `getPageContext(path, data?)`: the page sentence. |
| `lib/chat/usage-log.ts` | Allowlisted `[chat-usage]` lines and `logChatError` / `logChatWarning`. |
| `lib/chat/ibkr-context.ts` | `computeIbkrTradingContext` and `statementCashFallback`. |
| `lib/chat/tool-labels.ts` | Client-safe `CHAT_TOOL_LABELS` and `toolLabel`; re-exported from `tools.ts` as `TOOL_LABELS`. |
| `lib/chat/validate.ts` | `annotateToolResult`: `quality_warnings` and `data_freshness` on every result. |
| `lib/chat/budget.ts` | Size check, rate limit, daily output ceiling, concurrency slot. |
| `lib/queries/portfolio-summary.ts` | `getPortfolioSummaryForChat`: the Portfolio Context in the prompt. |
| `lib/queries/chat-tools.ts` | Readers behind the base tools (holdings, allocation, tax lots, income, freshness). |
| `scripts/chat-eval/` | On-demand golden evaluation and cache proof (never in the suite). |

## Request lifecycle, in order (`app/api/chat/route.ts`)

1. Parse the body: `messages`, `scope`, `conversationId`, `page`. Only `page.path` is read (`readPageField`); the legacy free-text `pageContext` field is ignored.
2. Session key from the verified session cookie (shared bucket when none). Size check, then rate limit, then the daily ceiling. Each rejection returns before anything is saved.
3. Scope: missing is `all`; a value outside `VALID_SCOPES` is 400.
4. Conversation: an unknown or deleted id starts a new conversation in this scope; a known id stored under another scope is 409 (OPEN-3 default). From here on every response carries `X-Conversation-Id`, failures included; the client adopts a conversation only from that header.
5. Save the user message only when the request ends with a user message, and not when the conversation's last stored row is a user row with identical text (a retry).
6. API key check (500 if missing).
7. Resolve the scope (`resolveChatScope`), build the Portfolio Context (not for macro), the IBKR dashboard (IBKR scope with exactly one account), the page note, then the two system blocks.
8. Build the AI SDK tools from `CHAT_TOOLS`; each `execute` clamps the input to the scope and calls `executeTool` with the tool's abort signal and the scope's ids.
9. History check: `convertToModelMessages(sanitizeUiHistory(messages), { tools, ignoreIncompleteToolCalls: true })`, then `findOrphanToolCalls` / `dropOrphanToolCalls` (logged as `orphan tool call dropped (N)`).
10. Acquire the concurrency slot immediately before `streamText`, so no early `return` can leak it.
11. `streamText`, then `toUIMessageStreamResponse({ sendReasoning: true, messageMetadata })`. The `finish` part carries `{ finishReason, stepCount }`.

## The model

- `getModelForFeature("chat")`: the `chat` feature on the `$workhorse` tier (`lib/ai/models.ts`). Never write a model id here; the usage log reports the id the step actually used.
- `providerOptions.anthropic.thinking = { type: "adaptive" }`, no `effort` (ruling D5; measuring medium against high is a TODO follow-up).
- `maxOutputTokens: 16000`, explicit (pinned in `tests/api/chat-cache-marks.test.ts`).
- `stopWhen: stepCountIs(MAX_CHAT_STEPS)` with `MAX_CHAT_STEPS = 8`. On the last step (`stepNumber === 7`) `prepareStep` returns the same static block and the volatile block plus `LAST_STEP_NOTE`. Tools stay defined: `toolChoice: "none"` deletes the tools array in `@ai-sdk/anthropic`, which the API rejects when the history holds tool calls and which changes the cached prefix (P4, OPEN-1). A tool call on the last step therefore ends the turn with no text, and the cut-off sentence is shown and saved. Guard: `tests/api/chat-last-step.test.ts`.
- No failover (ruling D8). Chat is not routed through `lib/ai/failover.ts`; that belongs to the open `provider-failover` task. Do not wire it from here.
- `abortSignal: request.signal`: without it `streamText` never runs `onAbort`, and a closed tab held its slot until the stale prune. Guard: `tests/api/chat-abort.test.ts`.

## Request order and cache marks (Contract D)

The request is, in order: tools (mark on the LAST tool by position) → static system block (mark) → volatile system block (no mark) → messages (top-level `providerOptions.anthropic.cacheControl`, automatic caching of the tail). Three marks; the provider ignores more than four. Guard: `tests/api/chat-cache-marks.test.ts`.

- **Static block**: scope preamble, persona, shared core (stance, how to answer, numbers not to compute, conventions, tool routing, earnings). It may vary by scope only. Nothing read from the database or the request beyond `scope` may enter it: no date, figure, account value, page or dashboard. Guards: `tests/chat/system-prompt-blocks.test.ts` › "static block is byte-identical across dates, portfolio contexts, dashboards and pages, per scope", and `tests/chat/system-prompt.test.ts` › "the static block holds no ISO date, no dollar figure and no digit outside the rule constants".
- **Volatile block**, in this order: `## Today` (`Today's date is YYYY-MM-DD (Eastern).`); IBKR scope only, `## Current IBKR Trading Dashboard` or the note saying why it is left out; `## Portfolio Context` (not for macro); `[Current Page]` plus the page sentence when there is one. The static text's "the Portfolio Context below" stays true because the volatile block follows it.
- **What breaks the cache.** Any change to a tool definition, the tool order or the static text invalidates everything. A change in the volatile block (a new date, a sync that changes the summary, another page) keeps the tools + static prefix but invalidates the message tail, because the tail sits after it. The last-step note changes the volatile block on step 8, so that step rereads the tail uncached. Freezing the summary per conversation is follow-up F1 (needs a stored column).
- **Tool results must replay byte-identical.** The live step sends each tool result through `toModelOutput`; the next request rebuilds history from UI messages, and `convertToModelMessages` gets the same `tools` so it runs the same `toModelOutput`. Any non-determinism in a tool's compact output (key order, clock, random) breaks the tail cache. Guard: `tests/api/chat-tool-result-replay.test.ts` (list tool, composite tool, approved `create_note`, and the whole turn-2 prefix).
- `markLastMessageForCache` (`lib/chat/history.ts`) is a tested, unwired fallback if the automatic tail mark proves ignored (OPEN-2).

## Scope

- Chat scopes: `all`, `macro`, `ibkr`, `vanguard-taxable`, `vanguard-roth-ira`. A single-account scope resolves by its scope WORD through `resolveScope` (`ibkr`, `vanguard`, `roth`), never by exact account name, so accounts "IBKR" and "IBKR Two" both stay in the IBKR scope (P10).
- `resolveChatScope` returns `{kind:"all"}` (all, macro), `{kind:"accounts", accounts}` or `{kind:"none"}`. `chatScopeAccountIds` maps these to `undefined` (every account), the id list, or `[]` (no account). `[]` reads nothing anywhere; never let it fall back to the whole book.
- The summary receives `{ accountIds, label }`; an empty list prints "No account matches this chat's scope." Guards: `tests/api/chat-scope.test.ts`, `tests/queries/portfolio-summary-scope-b1.test.ts`.
- **Clamp (first line).** `clampToolInputToScope` forces `account_name` to `scopeClampName(...)` on every tool whose schema declares `account_name`: the one account's exact name, or the scope word when the scope holds several. With several accounts, a model-supplied name that resolves to a non-empty subset of the scope is kept (P2). Guard: `tests/chat/scope.test.ts`.
- **Second guard (in `executeTool`).** With `scopeAccountIds` set, an account tool answers "No account is in this chat's scope." for `[]`, and refuses any resolved account outside the scope. A one-account tool handed several accounts answers with a sentence listing them; only `SCOPE_LIST_TOOLS` (`query_twr`, `query_options_greeks` and the list-taking composites) read a list. Guards: `tests/chat/tools-composite-registration.test.ts`, `tests/chat/tools-one-account-scope-error.test.ts`.
- Private text with no `account_name` (P9): `query_notes` and transcript `user_notes` withhold notes linked to another account's transaction (`notesInScope`); whole-book fields (`portfolio_relevance` on research feeds, `suggested_action` on alerts, briefing content) are withheld with a `scope_note`. Calendar events and newsletter tickers stay visible. Guard: `tests/chat/tools-notes-scope.test.ts`.
- `query_data_confidence` is whole-portfolio only and errors in any account-scoped chat (P3).

## Page context (Contract A)

The client sends only `page: { path }` (its `usePathname()`), per call. The server accepts a string of at most 200 characters starting with `/dashboard` and resolves data itself: `/dashboard/security/<id>` reads the symbol, name and type by id; `/dashboard/print/<eventId>` reads through `getEventById`. A stored name is flattened and capped before it reaches the sentence. Nothing written by the client enters the prompt. Guards: `tests/chat/page-context-server.test.ts`, `tests/dashboard/chat-page-path-body.test.ts`.

## Portfolio Context and the IBKR dashboard

- Every figure in the summary carries its own label (RF-10). A holdings line reads value, cost basis, gain/loss with its percent of cost (the `query_holdings` `unrealized_gain_pct` formula), weight, and sector. The base of the weight (the scope's priced long market value) is stated once in the section header. A short line reads "value … (liability)". Allocation lines read "(P% share, N positions)", with the base in each header. Recent transactions read "amount $X". An unlabelled percent next to a gain was once quoted as a return. Guard: `tests/queries/portfolio-summary-line-labels.test.ts`, pinned to `getHoldingsForChat`.
- The summary's allocation sections group label variants as `query_allocation` does (see Tools below).
- The IBKR dashboard (`formatIbkrDashboard`, `lib/chat/system-prompt.ts`) prints "not available" for an unknown account total and "share of account not available" for an unknown cash share, never a 0 (RF-9). Each cash line states its source and date; the stance is withheld with its reason when the figure cannot carry it.

## Tools

33 tools: 27 base tools in `BASE_CHAT_TOOLS`, then the six composites (`query_risk`, `query_scenarios`, `query_performance_vs_benchmark`, `query_realized_gains`, `query_options_book`, `query_data_confidence`). `CHAT_TOOLS` is built once at module load in that fixed order; the route puts the cache mark on the last one, so the order is part of the cached prefix. Guard: `tests/chat/tools-composite-registration.test.ts` › "two builds of the tool list are identical in order and content".

**Adding a tool**

1. Definition in `BASE_CHAT_TOOLS` (or a composite file): `name`, a description that says when to use it AND which look-alike not to use, `input_schema`. Declare `account_name` if it reads account data, so the clamp applies.
2. Schema rules (`tests/chat/tools-schema-rules.test.ts`): no `maxItems`, no `minItems` above 1; every `limit` description states its default and `max N`; every `*_date` / `week_of` names `YYYY-MM-DD`. Enforce counts in code.
3. Dispatcher: a `case` in `executeTool`. Input is already checked against the schema types (`validateToolInput`: a wrong type or a missing required field is an error naming the parameter); counts go through `readCount` (bad value = default, above max = max). A filter that cannot resolve (unknown symbol, ambiguous source) is an error, never a silently dropped filter.
4. A list tool fetches `limit + 1` rows and returns `list_info: { returned, limit, truncated, note? }` beside `data` (`takeList`, P7). Add its default and maximum to `LIST_LIMITS`. Guard: `tests/chat/tools-list-info.test.ts`, caps in `tests/chat/tools-caps.test.ts`.
5. External calls check `cancelled()` before they start (threading the signal into `lib/apis/*` fetches is follow-up F8).
6. Compact output is automatic: every tool gets `toModelOutput` (`compactToolOutput`). Lists of two or more records become `{_cols, _rows}`; a column identical on every row shown goes in `_same_in_rows_shown` (rows not shown may differ when the list is truncated); empty keys are dropped. **Rounding comes only from the explicit per-tool field map `COMPACT_ROUNDING`** (`cents`, `pct2`, `price4`, by exact field name); every unmapped number is returned exactly as the engine gave it, and each compact result names its rounded fields in `_rounded`. Long text listed in `COMPACT_TEXT_LIMITS` is cut with a marker that names a call by stable id which returns it whole. The client keeps the full object. Keep the output deterministic (replay test above).
7. **A new numeric field is exact unless you add it to BOTH `COMPACT_ROUNDING` and the guard's own list** (`ALLOWED_ROUNDING` in `tests/chat/tools-output-size-guard.test.ts`). The guard keeps its list separately on purpose: a guard that trusted the map it checks could not catch a wrong entry. Mutation testing proved this. A return contribution or a FRED value mapped as cents passed a map-trusting guard, and so did a non-uniform text column hoisted into `_same_in_rows_shown`, because only numbers were compared. The guard now compares every numeric leaf of all 33 tools with the full result, and compares text and flags too (a cut text must be a prefix of the full text). Earlier, key-name pattern matching rounded return contributions, an FX value and a scenario share to two places (final review RF-1/RF-2).
8. **Size bound.** On a large synthetic book the compact form of every tool's worst call stays at or under 30,000 characters, except the full earnings transcript, which stays whole on purpose (`tests/chat/tools-output-size-guard.test.ts`). The FULL form is not bounded this way.
9. A label in `lib/chat/tool-labels.ts` (`tests/chat/tool-labels-parity.test.ts`) and a routing line in the static prompt's "Choosing Tools" section (`tests/chat/system-prompt.test.ts` › "the portfolio routing section names every chat tool and every composite tool").
10. Native prices carry `currency` and are never converted; USD values say so.

The defaults and maxima live in `LIST_LIMITS` and in each schema description, and they are still being tuned to the output size; read them there, never copy them into docs or the prompt.

**Allocation labels fold once.** `query_allocation` (`getAllocationBreakdown`) and the summary's allocation sections group raw labels the same way: security types fold on case onto the stored spelling (not `mapSecurityType`, which merges Stock and ETF), sectors through `normalizeSector` with a `normalizeFundCategory` fallback. The summary restates the rules (the tool's helpers are private); `tests/queries/portfolio-summary-allocation-labels.test.ts` pins the two together, `tests/queries/chat-tools-allocation-labels.test.ts` the tool.

**Composite tools never recompute.** Each calls the engine the dashboard surface calls, with the same arguments, and returns its figures unchanged; an empty scope is answered before any engine runs (some engines read `[]` as the whole book). The contract and sale lists cap at 25 rows. `COMPOSITE_MAX_JSON_CHARS` (6,000) is checked on the tests' own fixture only; the full form is NOT bounded by it in general (`query_scenarios` reaches about 10,600 characters on the size guard's large book). The bound that holds is the size guard's limit on the compact form (item 8). One test file per tool, `tests/chat/composite-query-*.test.ts`, pins parity with the engine. `query_risk` uses the Diagnostics card's common floor for All Accounts and the scope's own history for a narrower scope. `query_performance_vs_benchmark` does not use `computeBenchmarkComparison` (raw daily values, so a deposit reads as a return).

## Note approval (`create_note`, Contract C)

1. The definition carries `needsApproval: true`; the route passes it to `tool()`. The SDK stops the turn at an approval request and does not run `execute`. Text written before the pending approval is saved, because the owner saw it. A turn with no text saves nothing, and no finish sentence is added (`assistantRowText`).
2. The client renders a card (type, symbol, date, content through `<PrivateText>`) with "Save note" and "Don't save", calling `addToolApprovalResponse` with the current per-call body.
3. `sendAutomaticallyWhen` (`lastAssistantMessageIsCompleteWithApprovalResponses`, capped at 3 automatic continuations per owner action) resends; the request ends with the assistant message, so no user row is saved; the SDK runs the approved call; the continuation's text is saved as its own assistant row (OPEN-4).
4. `create_note` refuses an identical note (type, security, event date, content, tags, sentiment) created in the last 10 minutes and returns it with `duplicate_of_existing: true` (P11 replay guard).
5. What this protects: text inside a tool result can make the model DRAFT a note but never SAVE one. Guards: `tests/api/chat-create-note-approval.test.ts`, `tests/api/chat-approval-history.test.ts`, `tests/chat/create-note-tool.test.ts`.
6. On reload, history is text only, so a pending card is gone (OPEN-8).

## Persistence

- `onFinish`: the saved assistant row is every step's non-empty text joined with a blank line (`onFinish.text` is the last step only). A turn that stopped early adds the sentence for its finish reason after a blank line (`tool-calls` → `CUT_OFF_SENTENCE`, `length`, `content-filter`); with no text the row is the sentence alone. With an approval pending, the row is the text only, or nothing. The first exchange sets the title.
- Client side, `turnOutcomeNotice` returns the finish sentence whether or not text exists (null only while an approval is pending, and for a normal finish). The client shows it on a quieter line below the text, or alone; Copy copies the text only. A reloaded row is text only and carries no metadata, so the sentence shows once, from the saved text. The notice is never shown on the live message, an errored turn or a pending approval.
- `onError`: marks the turn errored; `onFinish` then saves the finished steps' text (never the cut-off sentence) and charges their output tokens.
- `onAbort`: releases the slot, saves the finished steps' text (nothing if empty) and charges their output. The SDK can run `onAbort` and then `onFinish` for one turn; the `settled` flag makes the charge and save happen once.
- Every save is wrapped and logged through `logChatError`.
- Guards: `tests/api/chat-persist-steps.test.ts`, `tests/api/chat-abort.test.ts`, `tests/api/chat-retry-dedupe.test.ts`, `tests/api/chat-conversation-id.test.ts`.
- History check (`lib/chat/history.ts`): tool parts in `input-streaming` / `input-available` are dropped; an unanswered or answered approval card in any message but the last becomes a paired denial; any `tool-call` left without a `tool-result` is removed, except an approval in the final message (the continuation). A `tool_use` without its `tool_result` is an HTTP 400. Guard: `tests/chat/history.test.ts`.

## Usage log

`[chat-usage] ` + JSON, one line per step and one per turn, from `lib/chat/usage-log.ts`. Fields: `kind`, `conversationId`, `scope`, `model`, `step` (zero-based) or `steps`, `noCache`, `cacheWrite`, `cacheRead`, `output`, `finishReason`. Built key by key from an allowlist. Read it in the dev server's output, or `~/Library/Logs/Vanguard Dashboard/server.log` in the packaged app. It must never hold message text, prompt text, tool input or output, or a portfolio figure. Errors go through `logChatError`: name, status code, provider error type, message cut to 200 characters; never `requestBodyValues`, `responseBody` or `cause` (an `APICallError` carries the whole prompt there). Guard: `tests/chat/usage-log.test.ts`.

## Privacy

Assistant answers render through `PrivateMarkdown`: in privacy mode the whole answer is hidden, not masked figure by figure (masking inside answers is a TODO follow-up). The approval card's content goes through `<PrivateText>`. Chat titles mask figures per `lib/chat/conversation-title.ts`. The panel footer's "does not provide investment advice" line is the app's legal line and stays, although the prompt now states views (ruling O1).

## The evaluation script (`scripts/chat-eval/`)

On demand only. It spends real money through the running app's chat route and is never part of the suite (only the pure scorer is, `tests/scripts/chat-eval-scorer.test.ts`). Run from the repo root with the node pin (`PATH=/opt/homebrew/opt/node@24/bin:$PATH`).

1. `npm run seed:demo` (in a worktree where the npm script cannot find tsx: `npx tsx scripts/seed-demo.ts`), then `npx tsx scripts/chat-eval/build-eval-db.ts --force`. This makes a VACUUM copy of `data/demo.db` plus synthetic rows (Roth loser, harvest candidate, pending lot, short, live and expired option, JPY holding, reinvested dividend pair, margin interest, bill maturing soon, lot short of long-term), recomputes lots and valuations, and writes an eval marker and a symbols-only manifest. Default output: `data/chat-eval/eval.db` (git-ignored).
2. Start a dev server on that copy bound to 127.0.0.1. The recipe is in the header of `run-golden.ts`: `DATABASE_PATH`, `TWS_HOST=192.0.2.1`, `APP_EXTRA_HOSTS`/`APP_EXTRA_ORIGINS` for `127.0.0.1:<port>`, `next dev -H 127.0.0.1`, log to a file. The server needs `ANTHROPIC_API_KEY` in its own environment. `npm run sandbox` cannot do this: it sets a dummy key. On a fresh database the `chat` feature resolves to the tier's static fallback model (no stored catalog or override), so results are for that model; the usage log names it.
3. `run-golden.ts --db <eval db> --dry-run` builds every request and prints the plan, the estimate and the guaranteed maximum; nothing is sent.
4. `--mode cache-proof --max-usd N` measures prefix reuse and tail reuse separately.
5. The golden run: 18 questions, `--only Q1,Q5` for a subset.
- **Spend rule.** `--max-usd` (default 4) is the run cap. A question starts only if the money spent so far plus `--max-usd-per-question` (default 0.60) fits under the cap; otherwise it is skipped and listed. While a question runs, the runner tails the server's per-step `[chat-usage]` lines and aborts the HTTP request (which stops the route's model call) once the running cost plus the worst the in-flight step can cost would pass the ceiling. That question is reported `aborted-cost-ceiling` and scored as failed. The guaranteed maximum is the run cap plus one step in flight; it is printed up front, and `--hard-ceiling-usd` refuses to start above it. A tool result over the character bound (`--tool-result-chars`, default 22,000), or a step with no usage line, stops the run.
- **Scorer.** Number checks can require a unit or a label next to the figure. Each of the 18 questions has a right and a wrong answer in `tests/scripts/chat-eval-scorer.test.ts`, so every check is shown to fail a wrong answer.
- Refusals: a missing `--db`, any file named `vanguard.db` (after symlinks), a database without the eval marker, an output path inside the repo that is not git-ignored, a model id not in the price table.
- Prices are per model id, read from the usage log (`pricing.ts`); the table is not yet checked against the live pricing page.
- `request-preview.ts` repeats the route's prompt assembly for the dry-run estimate only (follow-up: a shared `buildChatRequestParts`).
- `probe-tool-choice-none.ts` is the one-off check behind OPEN-1.

## Traps (each one cost time)

- **`useChat` freezes its options at first render.** The transport, its `fetch`, and `sendAutomaticallyWhen` are built once in a `useMemo([])`; anything live (scope, conversation id, page path) goes in the per-call body (`sendMessage(msg, { body })`, `regenerate({ body })`, `addToolApprovalResponse({ options: { body } })`). The 2026-06-15 leak ran every chat unscoped. See `memory/reference_usechat_transport_gotcha.md`.
- **`onAbort` runs only when `abortSignal` is passed, and then `onFinish` may run too.** Charge and save behind one flag.
- **`onFinish.text` is the last step's text only.** Join `steps`.
- **`toolChoice: "none"` strips the tools array** in `@ai-sdk/anthropic`; with tool history the API rejects it.
- **`convertToModelMessages` needs `{ tools }`** or stored tool results replay as raw JSON, not their `toModelOutput` form, and the tail cache misses.
- **A system message between user and assistant messages throws** in the provider: `prepareStep` may only replace the `system` array.
- **Next refuses extra exports from a route file**: `route.ts` exports only its handler, so shared request-building code has to live in `lib/` (the eval preview copies the route's assembly for that reason).
- **`resolveChatAccounts` tries an exact name first**; a chat scope must go through its scope word.
- **Some engines read `[]` as the whole book** (`computeRiskMetrics`): answer an empty scope before the call.
- **Source-pin tests break when their anchor moves.** They locate code with `anchorIndex` (`tests/helpers/source-anchor.ts`); re-pin them in the same change (`tests/repo/chat-failed-turn-adoption.test.ts` pins every route response that sets `X-Conversation-Id`).
- **`ChatInterface` logic is hash-pinned.** `tests/dashboard/chat-mobile-header-controls.test.ts` pins the `useChat` block byte for byte and a sha256 of everything from `export function ChatInterface(` to its `return (`. Any edit to a hook, effect or handler there fails it; update the pin deliberately, with the reason.
- **A dollar figure or a date in the static prompt** breaks both the cache and a test; put it in the volatile block.
