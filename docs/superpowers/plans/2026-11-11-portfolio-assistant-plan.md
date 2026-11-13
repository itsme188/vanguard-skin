# Portfolio Assistant (in-app chat): implementation plan (2026-11-11, revision 2)

> **Status (2026-11-11, updated by T10):** waves 1 and 2 are built and reviewed on branch `claude/portfolio-assistant-review-7148e7`, from Task 0 `c910900f` to the last build commit `bb2075f7`. Wave 3 is complete: full verify, the production build, the whole-branch review and fix round, the browser pass (W3-3), and three live runs (W3-4). The `toolChoice: "none"` probe was not run: it needs owner approval. The pull request (W3-5) is about to be opened. Decisions: `docs/DECISIONS.md` 2026-11-11. Working reference: `lib/chat/CLAUDE.md`.

> **Update 2026-11-12:** owner rulings superseded P3, P8, P9, OPEN-7 and follow-up F4, and widened P13's date rule (marked below; `docs/DECISIONS.md` 2026-11-12). The chat's privacy rule is now "data leaving the app"; the scope limits what the tools read, not what the owner may see.

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development. Each task below is one subagent (Opus). Tasks in the same wave edit no common file and are dispatched together in one message. Verification is a barrier AFTER each wave (section 5), not inside it. Steps use checkbox (`- [ ]`) syntax.

**Inputs.** Four read-only research reports written 2026-11-11 (architecture map, cost audit R1-R8, answer-quality audit, bug list B1-B26 + B4b). They live in the orchestrator's session scratchpad and are NOT committed (they quote line numbers, not figures, but stay local). Every fact a worker needs is restated in this plan; a worker never needs the reports. Where a report and the code disagree, section 1 says which is right; the plan follows the code.

**Revision history.** Revision 1 was reviewed by Codex (one round, 2026-11-11): verdict REVISE, 18 findings. Revision 2 folds 16 in full and 2 in part (rulings P8-P15 below, Task 0 added; the review log at the end lists each finding and what changed). **Codex rounds: 1 of 1** (small-spec rule). Ready to implement after this fold.

**Ids.** Bug ids `B1`..`B26`, `B4b` are the bug list's. The quality audit's figure table (its section 4.1) used its own numbering; this plan renames those rows `QA-1`..`QA-12` (section 1, table 1B). Cost recommendations keep their ids `R1`..`R8`.

**Architecture in one paragraph.** *(2026-11-13: one additive migration was added after this plan, 103, a nullable `chat_conversations.model_family` column for the per-chat model class; `docs/DECISIONS.md` 2026-11-13.)* Nothing is stored and no schema changes. The chat route keeps its one `streamText` call and the client keeps its one `useChat`; every change to them is an additive option (owner ruling 2). Wave 1 fixes wrong figures in the two readers that feed the model (`lib/queries/portfolio-summary.ts`, `lib/queries/chat-tools.ts`), hardens the route (cache order, usage log, abort, persistence, page context, scope) and the client (stream races, stop, page path, approval card), and tightens the tool dispatcher (silent filter drops, caps, a human confirmation for `create_note`). Wave 2 adds six read-only composite tools over engines the dashboard already uses, rewrites the static prompt wording, compacts tool output, adds an on-demand evaluation script and updates the docs. Wave 3 reviews, verifies, runs the browser pass and spends a capped live-AI budget to prove caching.

---

## 0. Rulings

### 0A. Owner rulings (2026-11-11)

- **O1. Stance.** Replace "NEVER give specific investment advice" with an analyst-colleague stance: the assistant states a view when asked, shows the reasoning and the main risk to it, labels it as its read, and flags what it cannot know. (Task 7.)
- **O2. `streamText` / `useChat` changes are additive only.** Allowed: `abortSignal`, cache marks, a last-step guard, usage callbacks (`onStepFinish`), `prepareStep`, `messageMetadata`, `needsApproval` on a tool, `toModelOutput` on a tool, and `sendAutomaticallyWhen` on `useChat`. Not allowed: replacing `streamText`, replacing `useChat`, a custom transport, moving the body into the transport, or a second model call per turn.
- **O3. Income double count (B3).** First a read-only count on a sandbox COPY of the live database (Task 2, step 0). The chat tool is fixed regardless. The dashboard reader `lib/queries/income.ts` is fixed only if the pattern exists in real data. Report counts only, never amounts, and record the outcome in `docs/DECISIONS.md` (Task 10).
- **O4. Live AI spend.** Wave 3 only, about US$5 in total (prove caching, run the evaluation set once). No live AI call in waves 1 and 2 (Codex plan review excepted).

### 0B. Orchestrator rulings (reversible)

- **D5.** No cheaper model for simple questions. Thinking and effort unchanged (`thinking: { type: "adaptive" }`, no `effort`). Measuring `medium` against `high` is a follow-up that uses the Task 9 evaluation set.
- **D6.** Usage logging goes to the server log only: one structured line per step and one per turn. Fields: uncached input, cache write, cache read, output tokens, step number or step count, model id, scope, conversation id, finish reason. No message content, no tool input or output, no portfolio figures. No new table, no migration.
- **D7.** The portfolio summary is NOT frozen per conversation (needs a stored column; follow-up F1). Instead the request is ordered: tools (cache mark on the last tool) → static system block (cache mark) → volatile system block (date, IBKR dashboard, portfolio summary, page note; no mark) → messages (automatic caching of the tail). Contract D (section 3) fixes the details; the installed SDK supports it (section 1, item 1.9).
- **D8.** Chat failover stays unwired (open `provider-failover` task). No task touches `lib/ai/failover.ts` or the 8 failing failover test files.
- **D9.** Delivery: commits on branch `claude/portfolio-assistant-review-7148e7`, one pull request at the end, no merge, no deploy.

### 0C. Plan rulings (this plan, reversible; each answers a question the code raised)

- **P1. The IBKR scope is a SET of accounts.** Chat scope `ibkr` (and each single-account scope) resolves through `resolveChatAccounts(db, hint)` to an id list. The summary is scoped to that list; it is empty only when the hint matches no account. (B1. The bug list suggested "empty when the name does not match exactly one account"; that would hide a real second IBKR account from an IBKR chat. The id list is right.)
- **P2. The scope clamp keeps a narrower account.** In a single-account scope that resolves to several accounts, a model-supplied `account_name` that resolves to a subset of the scope's ids is kept; anything else is forced to the scope. With one account in scope, behaviour is unchanged (always forced). (Without this, a two-account IBKR scope could never call a one-account tool: every call would be clamped to the scope word and refused.)
- **P3. Data confidence is whole-portfolio.** *(Superseded 2026-11-12: the tool answers in every scope, amounts included, labelled `covers_every_account` with a `scope_note`.)* `getDataConfidence(db)` takes no scope. In a single-account chat the new tool answers with an error asking for the All Accounts scope, so no other account's symbols or reasons cross the boundary.
- **P4. The last-step guard cannot force text through `toolChoice: "none"`.** In `@ai-sdk/anthropic@3.0.64`, `toolChoice: "none"` deletes the `tools` array from the request (`node_modules/@ai-sdk/anthropic/dist/index.js:1600-1601`). By step 8 the history holds `tool_use` blocks, and a request with tool blocks and no tool definitions is expected to be rejected by the API; it would also change the cached prefix. Wave 1 therefore uses a guard that does not remove tools (Task 3, item G). Whether `toolChoice: "none"` is accepted is tested once in wave 3 (W3-4) and recorded; switching to it is OPEN-1.
- **P5. Approval, not a token.** `create_note` gets a real human confirmation through the SDK's own tool approval (`needsApproval`), which `ai@6.0.138` supports end to end (Contract C). No confirm token is invented.
- **P6. Fees keep their current sign rule in this plan.** B3 fixes dividends (counted once) and interest (signed). The FEE sign convention is not proven by the code (`ABS(amount)` today); Task 2 step 0 records FEE sign counts and the change is follow-up F7 if they show credits.
- **P7. List truncation uses one extra row.** Dispatcher list tools fetch `limit + 1` rows and report `truncated: true` when the extra row exists, so no second count query (and no second predicate to keep in step) is needed.
- **P8 (Codex 1). Wash-sale detail never crosses a scope.** *(Superseded 2026-11-12: full detail in every scope, naming the replacement's account; a scoped answer also lists losses elsewhere washed by a purchase in the scope.)* `detectWashSales` (`lib/compute/tax-report.ts:204`, Rev. Rul. 2008-5 note at `:347`) scans replacement purchases in EVERY account, so a scoped report's warnings carry facts about other accounts. In a single-account chat, realized-gain figures are the report's own totals for that account, the wash-sale warning list is withheld (count only, with the sentence "N possible wash sales; the replacement purchases may sit in other accounts; see the All Accounts scope"), and `adjustments` appear only inside the total. In the All Accounts scope everything is shown.
- **P9 (Codex 2). Scope applies to private text, not only to `account_name` tools.** *(Superseded 2026-11-12: every note is returned, naming its trade's account; whole-portfolio text is returned with a `scope_note`.)* `query_notes` joins `transactions` (`lib/queries/notes.ts:49-51`) and `query_earnings_transcript` attaches `user_notes`. In a single-account chat, a note linked to another account's transaction is withheld, and no note carries `transaction_*` fields of another account; unlinked notes (the owner's journal, not account data) are returned. Task 5 inventories every tool for other private fields and lists any it cannot scope (OPEN-7).
- **P10 (Codex 3). A chat scope resolves by its scope WORD, never by exact name.** `resolveChatAccounts` tries an exact account name before scope words, so the hint "IBKR" beside accounts "IBKR" and "IBKR Two" selects one. `resolveChatScope` therefore maps `ibkr` to `resolveScope(db, "ibkr")`, `vanguard-roth-ira` to `resolveScope(db, "roth")`, `vanguard-taxable` to `resolveScope(db, "vanguard")` (it already excludes the Roth); `undefined` from `resolveScope` becomes `[]`, never all accounts. The exact-name collision is a named test.
- **P11 (Codex 5, in part). Approval provenance and replay.** The approval response comes from the owner's authenticated browser (session cookie plus double-submit CSRF through `proxy.ts`); the threat closed here is tool text drafting a write, which the SDK gate closes. What the SDK does not give is idempotence: a continuation re-sent after a lost response would run `create_note` again. Without a schema change, `create_note` refuses a second note with the same type, security, event date and content created in the last 10 minutes and returns the existing note as `{ saved: true, note, duplicate_of_existing: true }`. Binding approvals to a server-recorded tool-call id needs storage (F13).
- **P12 (Codex 9). Cash keeps its provenance.** Contract E carries `getAccountCashLine`'s flags; a negative figure is "negative cash", called a margin debit only when the line is measured (not carried, not a live timing residual, no price-date mismatch); the stance score is withheld when the figure is unavailable, carried, a timing residual or a price-date mismatch.
- **P13 (Codex 10). A reinvestment pairs only with its own dividend.** *(Widened 2026-11-12: the dividend may be dated up to 3 calendar days either side; a payment pairs with a purchase and a reversal with a reversal, each leg read by its importer's sign convention; the pairing is a maximum matching (most pairs, then the smallest total day gap, then gross before net); the pair counts on the dividend's date; still one-to-one.)* One-to-one: a REINVESTMENT row is the purchase leg of a DIVIDEND row on the same account, security and trade date with the same absolute amount within $0.01; each DIVIDEND pairs with at most one REINVESTMENT. An unpaired REINVESTMENT counts as dividend income only when positive; a negative unpaired leg is not counted and is reported in `unpaired_reinvestment_count`. Step 0 counts each case.
- **P14 (Codex 11). A converted figure says how it was converted.** `getClosedTaxLotSales` converts with today's `fx_rates` row and reads a missing rate as 1. The chat therefore returns native figures as primary, adds `*_usd_at_current_fx` only when the security is USD or a rate row for its currency exists, and otherwise `null` with `fx_note: "no FX rate on file; native figures only"`.
- **P15 (Codex 13). Every chat log line is allowlisted.** The route's `console.error("[chat] streamText error:", error)` can print an SDK `APICallError` whose `requestBodyValues` holds the whole prompt. All chat logging goes through `lib/chat/usage-log.ts` helpers that print only the error name, status code, provider error type and message text truncated to 200 characters, never `requestBodyValues`, `responseBody` or `cause`.

---

## 1. What the code says (read before briefing any coder)

### 1A. Facts checked in the code on 2026-11-11 (worktree at `1ed3c3dd`)

1.1 **`onFinish.text` is the final step's text only** (`node_modules/ai/dist/index.mjs`, onFinish `text: finalStep.text`). The quality audit marked this unverified; the bug list confirmed it. B11 stands.

1.2 **`onAbort` runs only when `abortSignal` was passed** (`ai/dist/index.mjs` ~6842-6866). The route passes none (`app/api/chat/route.ts:233-286`). B13 stands. The existing test `tests/api/chat-budget.test.ts:432` calls the captured `onAbort` by hand and cannot catch this.

1.3 **Tool approval exists in the installed SDK.** `needsApproval?: boolean | fn` on `tool()` (`@ai-sdk/provider-utils/dist/index.d.ts:1088-1090`); `streamText` stops at an approval request and, on the next request, executes approved local tools found in the incoming messages (`collectToolApprovals`, `ai/dist/index.mjs:2656-2727, 6961-6970`). Client side: `addToolApprovalResponse({ id, approved, reason?, options? })`, `sendAutomaticallyWhen`, `lastAssistantMessageIsCompleteWithApprovalResponses` (`ai/dist/index.d.ts:3639-3653, 3754, 4020`). UI part states `approval-requested`, `approval-responded`, `output-denied`. The automatic resend uses `trigger: "submit-message"` and the options passed to `addToolApprovalResponse` (`index.mjs:13020-13040`), so the per-call body (scope, conversation id, page) still works.

1.4 **`toolChoice: "none"` removes tools** (see P4).

1.5 **`prepareStep` may return `system`, `messages`, `activeTools`, `toolChoice`, `model`** (`ai/dist/index.d.ts:1207-1235`). Overriding `system` per step is allowed; a system message between user and assistant messages throws in the provider (`@ai-sdk/anthropic/dist/index.js:2036-2039`).

1.6 **`toModelOutput` reaches the history only if tools are passed to the converter.** `convertToModelMessages(messages, { tools, ignoreIncompleteToolCalls })` (`ai/dist/index.d.ts:3854-3858`) calls each tool's `toModelOutput` for stored outputs; today the route calls it with no options (`route.ts:244`), so history tool results are raw JSON. `ignoreIncompleteToolCalls: true` drops tool parts still in `input-streaming` / `input-available` (an aborted turn), which would otherwise send a `tool_use` with no `tool_result`.

1.7 **Usage fields:** `usage.inputTokenDetails.{noCacheTokens, cacheReadTokens, cacheWriteTokens}`, `usage.outputTokens` (`ai/dist/index.d.ts:271-292`); per step in `onStepFinish`, totals in `onFinish.totalUsage`; the step's model id is `step.response.modelId`.

1.8 **Stream metadata:** `toUIMessageStreamResponse({ messageMetadata: ({ part }) => … })` can attach metadata on the `finish` part, which carries `finishReason` (`ai/dist/index.d.ts:2346, 2671-2674`). This is the B15 signal (Contract B).

1.9 **Caching support:** a `cacheControl` provider option on a tool becomes `cache_control` on that tool (`@ai-sdk/anthropic/dist/index.js:1298-1320`); `system` may be an array of `SystemModelMessage`, each becoming its own block with its own mark (`:2035-2047`); a top-level `providerOptions.anthropic.cacheControl` becomes top-level `cache_control` (automatic caching of the last cacheable block, `:3030-3032`). The provider warns and ignores marks beyond 4 (`MAX_CACHE_BREAKPOINTS = 4`, `:993-1023`). Contract D uses 3 explicit-or-automatic marks.

1.10 **The sandbox script cannot run live AI.** `scripts/coord/sandbox.sh:363` sets `ANTHROPIC_API_KEY=sk-ant-test-dummy-not-real`. `npm run sandbox` + `npm run smoke` cover the non-AI UI only; the wave-3 live check runs a separate dev server (W3-4).

1.11 **Engine scope quirks the composite tools must respect** (Task 6):
- `computeRiskMetrics` reads an EMPTY `accountIds` as the whole portfolio (`lib/compute/risk.ts:122-127`). A chat wrapper must answer "no accounts in scope" itself before calling it.
- `computeBenchmarkComparison` takes one `accountId` or none (`lib/compute/benchmark.ts:24-29`): one account or all, never a list.
- `generateTaxReport(db, year, { accountName })` takes one account name or none (`lib/compute/tax-report.ts:125-132`).
- `getDataConfidence(db, now?)` takes no scope (`lib/queries/data-confidence.ts:1262`).
- `computeAllScenarios(db, { accountIds })`, `getExpiringOptions(db, { accountIds, daysWindow, today })`, `getPortfolioExposureSummary(db, accountIds, today)`, `computePeriodAttribution(db, scope, start, end, "SPY")`, `computeMonthlyPerformance(db, accountIds, monthEndDate)`, `computeConcentration(db, accountIds)` take a list.

1.12 **`getDataFreshness` lives in `lib/queries/chat-tools.ts:1398-1422`**, not in `lib/chat/tools.ts` (the bug list grouped B25 under tools.ts). B25 moves to Task 2.

1.13 **The research-feeds source lookup is first-match, not only misspelt.** `LOWER(name) LIKE '%' || LOWER(?) || '%' LIMIT 1` (`lib/chat/tools.ts:1658-1666`) takes the first of several matches as well as dropping the filter on none. Task 5 fixes both.

1.14 **Retry after an early failure.** A request rejected by the rate limit or the daily ceiling returns before the user message is saved (`route.ts:81-97` run before the save at `:130-138`). Skipping the save on every `regenerate` (the bug list's suggestion) would then lose that message. Task 3 dedupes against the conversation's last stored row instead.

1.15 **`getPortfolioSummaryForChat(db, accountName?)` is called by about 15 test files.** Its second parameter widens to a union (Contract I) so those calls keep compiling.

1.16 **Helpers cited in this plan, each checked to exist:** `latestHoldingsPredicate` (`lib/queries/latest-holdings.ts`), `liveOptionExpirationSql` (`lib/compute/option-expiry.ts`), `unmaturedSecuritySql` (`lib/db/eastern-day-sql.ts`), `adjustedMarketValueSQL` and `scaledCostBasisFallbackSQL` (`lib/valuation.ts`; CLAUDE.md does not give a path for the first), `lotSideSignSql` / `remainingLotBasisSql` / `getClosedTaxLotSales` / `USD_ONLY` / `CURRENCY_CONVERSION_SECURITY_SQL` (`lib/queries/tax-lots.ts`), `accountScopeCondition` / `accountScopeAndSql` (`lib/queries/account-scope-sql.ts`), `resolveChatAccounts` (`lib/chat/account-scope.ts`), `resolveScope` (`lib/queries/accounts.ts`), `todayET` / `calendarDaysBetween` (`lib/calendar/date-utils.ts`), `formatLevelPrice` (`lib/chart/price-formatter.ts`), `getPendingStatementIndex` (`lib/queries/pending-statement.ts`), `readMutationResult` / `networkFailureMessage` (`lib/ui/mutation-result.ts`), `isTaxableAccount` (`lib/compute/tax-treatment.ts`; no SQL twin exists), `getPortfolioCurrentValues` (`lib/queries/dashboard.ts`), `getAccountCashLine` (`lib/queries/account-cash-line.ts`), `isCashEquivalentSecurity` (`lib/compute/cash-equivalents.ts`), `quantityUnitLabel` (`lib/format/quantity-unit.ts`, the plain function behind `<QuantityUnit>`), `getEventById` (`lib/queries/calendar.ts`), `anchorIndex` (`tests/helpers/source-anchor.ts`), `VALID_SCOPES` (`lib/types.ts`). `parseKeyThemesField` is a private function inside `lib/chat/tools.ts:76`, not an export.

### 1B. The quality audit's figure table, renamed

| Id | Row (quality audit §4.1) | Same as | Task |
|---|---|---|---|
| QA-1 | Harvest candidates and lots approaching long-term include tax-advantaged accounts (`portfolio-summary.ts:534-568, 590-625`) | — | T1 |
| QA-2 | Realized gains: lifetime, includes the Roth, no year (`portfolio-summary.ts:485-499`) | — | T1 |
| QA-3 | `position_weight_pct` whole-book in a scoped call | B5 | T2 |
| QA-4 | No currency on holdings, lots, price history, levels while prices are native | (B23 for levels) | T2 (holdings, lots), T5 (price history, levels) |
| QA-5 | Expired options in allocation (tool and summary) | B2, B8 | T1, T2 |
| QA-6 | Dividend double count; margin interest as income | B3 | T2 |
| QA-7 | IBKR cash mixes a month-end total with today's holdings | B7 | T2 |
| QA-8 | `query_alerts` string timestamp compare | B24 | T5 |
| QA-9 | Freshness age on the UTC clock, global MAX | B25, B4b | T2, T1 |
| QA-10 | Silent filter drop on an unresolved symbol or source | — | T5 |
| QA-11 | Summary's recent transactions call every quantity "shares" (`portfolio-summary.ts:683`) | — | T1 |
| QA-12 | Summary cost basis is `h.cost_basis`; the tool uses `scaledCostBasisFallbackSQL` (the Accounts page basis) | — | T1 (the tool is right) |

---

## 2. Global constraints (every task)

1. **Shared worktree discipline.** Never `git stash`. Never a bare `git commit` or `git add -A` / `git add .`. Stage and commit only your own files by explicit pathspec: `git add <file> <file>` then `git commit -F <msgfile> -- <file> <file>`, message written to a file in the session scratchpad (never inline `-m`). End the message with the attribution line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never switch branches. Never edit a file another task owns; if you need a change there, stop and report it.
2. **Tests first.** For each item: write the failing test named in the task, run it, see it fail for the stated reason, then fix. Synthetic fixtures only (in-memory migrated SQLite, `:memory:`); no 7-digit or comma-grouped real-looking figures (the repo is public).
3. **Node pin.** Every command: `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH npx vitest run <paths>`. Before reporting done: `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH npx tsc --noEmit -p .` and `bash scripts/verify.sh changed --base main`.
4. **No live AI, no live database** in waves 1-2. The one exception is Task 2 step 0 (read-only counts on a sandbox COPY). No dev server in waves 1-2 except where a task says so.
5. **No schema change, no migration, no new dependency.** "What NOT to Change" in root `CLAUDE.md` holds: the import pipeline, PDF parsing, the migration system, and the chat SDK integration structure (O2).
6. **Repo rules that bind every task:** `todayET()` for every "today"; `accountScopeCondition` / `accountScopeAndSql` for account filters (`undefined` = every account, `[]` = none); `latestHoldingsPredicate` for latest holdings; `liveOptionExpirationSql` beside `unmaturedSecuritySql` in every live-book read; `adjustedMarketValueSQL` with `COALESCE(fx.usd_per_unit, 1)` for values; native prices carry a `currency` and are never converted; `isTaxableAccount` for tax treatment, never an account name; no hand-rolled `held || watchlist`; source-pin tests use `anchorIndex`.
7. **No real figures** in commits, tests, logs or the PR text. Task 2 step 0 output is counts only and stays out of the repo except as counts in `docs/DECISIONS.md`.

---

## 3. Contracts between owners (fixed here; both sides implement to them)

### Contract A — page context in the request

- **Client sends** (Task 4), per call in the `sendMessage` / `regenerate` / `addToolApprovalResponse` body, never in the transport: `page: { path: string }` where `path` is the current `usePathname()` value. The client stops sending the free-text `pageContext` string.
- **Server validates** (Task 3, new file `lib/chat/page-context-server.ts`): `page` absent or not an object → no page note. `path` must be a string of at most 200 characters starting with `/dashboard`; otherwise ignored (no error). The legacy `pageContext` field is ignored entirely (the server never puts client-written text into the system prompt). The size guard receives `page` in place of `pageContext`.
- **Server resolves** `resolvePageData(db, path): { path: string; data?: PageContextData & { eventDate?: string } }`:
  - `/dashboard/security/<id>` (positive integer): `SELECT symbol, name, security_type FROM securities WHERE id = ?`. Found → `data = { symbol, name, type }`. Not found → no data (the existing "a Security Detail page" sentence). The id is the only thing taken from the client; a symbol string is never accepted.
  - `/dashboard/print/<eventId>`: `getEventById(db, id)` (the healed reader, per CLAUDE.md) → `data = { symbol, eventDate: event_date }`; not found → no data.
  - anything else → no data.
- **Sentence** comes from the existing `getPageContext(pathname, data?)` in `lib/chat/page-context.ts` (Task 4 owns it and must keep that signature; Task 4 adds an optional `eventDate?: string` to `PageContextData` and the print, Today, Tax Lots, Levels, Alerts and Notes sentences).
- **Placement:** the last section of the volatile system block, headed `[Current Page]` (Contract D). Never in the static block, never in a message.

### Contract B — the empty or cut-off turn signal

- **Server** (Task 3): `toUIMessageStreamResponse({ …, messageMetadata })` returns `{ finishReason, stepCount }` on the `finish` part (`stepCount` counted in `onStepFinish`). Server persistence (B11): the saved assistant row is the join of every step's non-empty text with a blank line. If that join is empty: with an approval pending (the last step's content has a `tool-approval-request`), save nothing; with `finishReason === "tool-calls"` (step cap), save the fixed sentence `CUT_OFF_SENTENCE` = "The answer stopped after the step limit before a written reply. Ask again, or narrow the question." exported from `lib/chat/turn-outcome.ts`; with `"length"`, save "The answer reached the output limit before a written reply."; with `"content-filter"`, save "The model declined to answer this request."
- **`lib/chat/turn-outcome.ts`** (new, client-safe, no imports beyond types; owned by Task 3, read by Task 4) exports the sentences and `turnOutcomeNotice(message: { parts; metadata? }): string | null`: returns null while any text part has content or any tool part is `approval-requested`; otherwise the sentence for `metadata.finishReason` (`tool-calls`, `length`, `content-filter`), else null.
- **Client** (Task 4): a finished assistant message (not the streaming one) for which `turnOutcomeNotice` is non-null renders that sentence in place of the empty bubble, with the Copy button hidden. A Stop button replaces Send while `status` is `streaming` or `submitted` and calls `stop()`.

### Contract C — `create_note` confirmation

- **Tool definition** (Task 5): `ChatTool` in `lib/chat/tools.ts` (created by Task 0 as `Anthropic.Tool &` the optional fields `needsApproval?: true` and `toModelOutput?: Tool["toModelOutput"]`, with `Tool` imported as a type from `ai`; Task 0 also retypes `CHAT_TOOLS` as `ChatTool[]`) carries `needsApproval`; the `create_note` entry sets it. Its description loses "Always confirm with the user before saving" and says instead that the app shows the drafted note to the owner, who saves or discards it.
- **Route** (Task 3): passes `needsApproval: t.needsApproval` into `tool({...})`. Nothing else: the SDK withholds `execute` until an approval response arrives, and runs it on the next request (1.3).
- **Client** (Task 4): adds `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses` to `useChat` (additive option; a pure function, so the first-render freeze is harmless). A `tool-create_note` part in state `approval-requested` renders a card with the note type, symbol, date and content (content through `<PrivateText>`), and two buttons, "Save note" and "Don't save", calling `addToolApprovalResponse({ id: part.approval.id, approved, reason: approved ? undefined : "Owner chose not to save", options: { body: <current request body> } })`. States (Codex 6): `approval-responded` with approval → "Saving…"; `output-available` whose output has `data.saved === true` → "Saved"; `output-available` with an `error` → "Not saved: <error>"; a denial or `output-denied` → "Not saved". Buttons are disabled while streaming. On reload, approval parts are not persisted (history is text only), so a pending draft is gone; the card is not restored (OPEN-8).
- **Replay guard** (Task 5, P11): `create_note` returns the existing note for an identical note created in the last 10 minutes. Test: `tests/chat/create-note-tool.test.ts` › "a replayed approval does not create a second note".
- **Route persistence on the resend** (Task 3, B12): the resend's last message is the assistant message, so no user row is saved; the continuation's text is saved as its own assistant row.
- **Security property protected:** text inside a tool result (a press release, newsletter or transcript) can make the model DRAFT a note but never SAVE one; only a click in the owner's browser can. Test (Task 3): a mock model that calls `create_note` → the stream ends with an approval request and the `notes` table row count is unchanged.

### Contract D — request order and cache marks (route.ts ↔ system-prompt.ts; both Task 3 in wave 1; Task 7 must keep it in wave 2)

1. `buildSystemPromptBlocks(input): { staticBlock: string; volatileBlock: string }` in `lib/chat/system-prompt.ts`, with `input = { scope, currentDate, portfolioContext, ibkrContext?, ibkrNote?, pageNote? }`. `buildSystemPrompt(...)` stays, returning `staticBlock + "\n\n" + volatileBlock`, so existing prompt tests keep their content checks.
2. **Static block** = scope preamble + persona (without the IBKR dashboard) + shared core (without `Today's date is …`), or the macro prompt without its date line. It may vary by scope only. It must not contain the date, the IBKR dashboard, the portfolio summary, the page note, or anything read from the database or the request beyond `scope`.
3. **Volatile block**, in this order: `## Today` with `Today's date is YYYY-MM-DD (Eastern).`; then, IBKR scope only, `## Current IBKR Trading Dashboard` (or the `ibkrNote` sentence when it is omitted); then `## Portfolio Context` + the summary (not for macro); then `[Current Page]` + the page sentence when present. The prompt's existing phrases "the Portfolio Context below" and "the dashboard below" stay true because the volatile block follows the static one.
4. **Route** sends `system: [ { role: "system", content: staticBlock, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }, { role: "system", content: volatileBlock } ]`.
5. **Tools:** built in `CHAT_TOOLS` order; the LAST built tool (by position, whatever its name) gets `providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }`.
6. **Messages:** top-level `providerOptions.anthropic.cacheControl = { type: "ephemeral" }` beside `thinking` (automatic caching of the conversation tail). If W3-4 shows the API rejects or ignores it (cache read stays 0 on turn 2), the fallback is a `prepareStep` that returns `messages` with `providerOptions.anthropic.cacheControl` on the last message; that fallback is Task 3's to keep ready as a tested, unused function `markLastMessageForCache(messages)` in `lib/chat/history.ts`.
7. Total marks: 3 (tool, static system, automatic). The fourth slot stays free.
8. **Test** (Task 3): two `buildSystemPromptBlocks` calls with the same scope but different `currentDate`, `portfolioContext`, `ibkrContext` and `pageNote` return byte-identical `staticBlock`, for each of the 5 scopes; a route test captures the `streamText` options and asserts exactly one marked system block (the first), one marked tool (the last), and the top-level mark.

### Contract E — IBKR trading context shape (Task 2 produces, Task 3 renders)

`IbkrTradingContext` (`lib/chat/ibkr-context.ts`) keeps every existing field name and adds (P12): `cashAsOf: string | null`, `cashSource: "daily_valuation" | "none"`, `cashCarried: boolean`, `cashTimingResidual: boolean` (live anchor on the valuation day), `cashPriceDateMismatch: boolean`, `accountTotalAsOf: string | null`, `stanceWithheld: boolean`. `estimatedCash` may be negative; `cashPct` uses the signed value. `formatIbkrDashboard` (Task 3) prints "(as of DATE)" on the cash and total lines; "Cash: not available" for `none`; a negative measured figure as "negative cash (margin debit)"; a negative carried, residual or mismatched figure as "negative cash; this may be a timing difference, not borrowing"; and, when `stanceWithheld`, no stance score, with the reason. `stanceWithheld` is true for `none`, carried, timing residual or price-date mismatch.

### Contract F — tool labels (Task 4 creates, Task 5 re-exports, Task 6 extends in wave 2)

New client-safe file `lib/chat/tool-labels.ts` (no imports) exporting `CHAT_TOOL_LABELS: Record<string, string>` with an entry for each of the 27 tools (wording from the current `TOOL_LABELS` in `lib/chat/tools.ts:2030-2058`) and `toolLabel(name)` returning the label or "Using <name>". `ChatInterface.tsx` uses it; `lib/chat/tools.ts` replaces its own map with `export { CHAT_TOOL_LABELS as TOOL_LABELS } from "./tool-labels"`. Parity test (Task 5, `tests/chat/tool-labels-parity.test.ts`): every `CHAT_TOOLS` name has a label. It fails until Task 4's file lands; that is an expected transitional failure at the wave-1 barrier only if Task 4 has not landed.

### Contract G — list results (Task 5)

A list tool's wrapped result gains a sibling key beside `data`: `list_info: { returned: number; limit: number; truncated: boolean; note?: string }`, built by fetching `limit + 1` rows (P7). `truncated: true` carries `note: "More rows match. Narrow the filter or raise limit (max N)."` `query_tax_lots` returns `list_info: { open: {...}, closed: {...} }`, one object per list (Codex 14). Every `limit` is validated as an integer from 1 to the tool's maximum; anything else (missing, zero, negative, fractional, non-number) becomes the default. A listed tool without a `limit` field in its schema today gets one, with its default and maximum in the description. Applies to `query_holdings`, `query_tax_lots` (open and closed separately), `query_transactions`, `query_calendar_events`, `query_research_feeds`, `query_levels`, `query_alerts`, `query_notes`, `query_research_documents`, `query_press_releases`.

### Contract H — `executeTool` signature and per-tool SDK options (Task 5 ↔ Task 3)

`executeTool(db, toolName, input, opts?: { abortSignal?: AbortSignal; scopeAccountIds?: number[] })`; the route passes the tool's `abortSignal` and, in a single-account chat, the scope's id list (used by tools without `account_name`, P9). `executeTool` passes the resolved account ids to `annotateToolResult(db, toolName, raw, { accountIds })` so freshness is the scope's own (Codex 12). The route passes the `abortSignal` it receives in the tool's `execute(input, { abortSignal })`. In wave 1, `executeTool` returns `{ error: "Cancelled." }` without starting a call when the signal is already aborted, and checks it again before each external call it starts (FRED, EDGAR, Finnhub, Yahoo, transcript). Threading the signal into `lib/apis/*` fetches is follow-up F8. `ChatTool` (created by Task 0 as `Anthropic.Tool &` two optional fields; `CHAT_TOOLS` retyped as `ChatTool[]`) may carry `needsApproval?: true` (Contract C) and `toModelOutput?: Tool["toModelOutput"]`, the type taken from the `ai` package's exported `Tool` (`import type { Tool } from "ai"`; never from `@ai-sdk/provider-utils`, an undeclared dependency) (wave 2, Task 8); the route passes both through to `tool()` when present.

### Contract I — summary scope parameter (Task 3 calls, Task 1 implements)

`getPortfolioSummaryForChat(db, scope?: string | { accountIds: number[]; label: string })`.
- `undefined` → every account (unchanged).
- object → exactly those ids (`[]` → no accounts: every section is empty and the summary says "No account matches this chat's scope."). `label` is the scope label used in the "This total covers …" sentence.
- string (legacy, tests) → the one account with that exact name; no exact match → the empty scope above (never the whole book).
The route resolves the scope with `resolveChatScope(db, scope)` (Task 3, `lib/chat/scope.ts`): `all`/`macro` → `{ kind: "all" }`; a single-account scope → its scope word through `resolveScope` (P10): ids → `{ kind: "accounts", accounts }`; undefined → `{ kind: "none" }`.

### Contract J — income semantics (Task 2 owns; Task 5 updates the tool description text)

One SQL source in a new file `lib/queries/income-sql.ts` (Task 2): dividend income = signed `DIVIDEND` amounts plus positive `REINVESTMENT` amounts left unpaired under the one-to-one rule of P13 (same account, security, trade date, equal absolute amount within $0.01); interest earned = positive `INTEREST` amounts; interest paid = the magnitude of negative `INTEREST` amounts; fees unchanged (P6); net income = dividends + interest earned − interest paid − fees. `query_income_summary` rows gain `interest_paid`; `total_interest` becomes interest earned. Task 5 rewrites the tool description to say this, and Task 2 rewrites the `validate.ts` caveat.

---

## 4. File ownership

**Wave 1** (five parallel tasks)

| Task | Owns (edit) | Reads only |
|---|---|---|
| T1 | `lib/queries/portfolio-summary.ts`; `tests/queries/portfolio-summary*.test.ts`; `tests/queries/chat-lot-basis-parity.test.ts`; the summary-text assertions in `tests/integration/pending-*.test.ts` (only if T1's change breaks them); new `tests/queries/portfolio-summary-scope-b1.test.ts`, `…-allocation-expired-b2.test.ts`, `…-tax-treatment-qa1.test.ts` | everything else |
| T2 | `lib/queries/chat-tools.ts`; `lib/queries/income.ts` (only under O3); new `lib/queries/income-sql.ts`; `lib/chat/ibkr-context.ts`; `lib/chat/validate.ts`; `tests/queries/chat-tools*.test.ts`; `tests/queries/et-today-sweep.test.ts`; `tests/chat/ibkr-context.test.ts`; `tests/chat/validate.test.ts`; `tests/compute/empty-account-scope-series-readers.test.ts` (income part only); new test files named below | `lib/queries/tax-lots.ts`, `lib/queries/account-cash-line.ts`, `lib/compute/*` |
| T3 | `app/api/chat/route.ts`; `lib/chat/system-prompt.ts` (STRUCTURE only); `lib/chat/scope.ts`; `lib/queries/chat.ts`; `lib/mutations/chat.ts`; new `lib/chat/history.ts`, `lib/chat/usage-log.ts`, `lib/chat/page-context-server.ts`; `lib/chat/turn-outcome.ts` (after Task 0); `tests/api/chat-*.test.ts`; `tests/chat/system-prompt*.test.ts`; `tests/chat/scope.test.ts`; `tests/chat/chat-history.test.ts`; new `tests/chat/history.test.ts`, `tests/chat/usage-log.test.ts`, `tests/chat/page-context-server.test.ts`, `tests/chat/turn-outcome.test.ts`; `tests/queries/chat.test.ts` | `lib/chat/tools.ts`, `lib/chat/page-context.ts`, `lib/chat/account-scope.ts` |
| T4 | `app/dashboard/components/ChatInterface.tsx`, `ChatDrawer.tsx`, `QuickActionChips.tsx`, `OpenChatButton.tsx`, `ChatToggleButton.tsx`; `app/api/chat/conversations/**`; `lib/chat/page-context.ts`; `lib/chat/quick-actions.ts`; `lib/chat/tool-labels.ts` (after Task 0); new `lib/chat/turn-adoption.ts`; `tests/chat/page-context.test.ts`, new `tests/chat/turn-adoption.test.ts`, `tests/chat/quick-actions.test.ts`; `tests/dashboard/chat-*.test.ts`; `tests/repo/chat-failed-turn-adoption.test.ts`; `tests/chat/chat-transport-csrf.test.ts` | `lib/chat/turn-outcome.ts` |
| T5 | `lib/chat/tools.ts`; `lib/compute/options-greeks.ts` (the one additive `underlying` option only); `tests/compute/options-greeks*.test.ts`; `tests/chat/tools-*.test.ts`; `tests/chat/create-note-tool.test.ts`; `tests/chat/query-levels-last-fired.test.ts`; `tests/chat/release-reactions-legacy-zero-move.test.ts`; `tests/chat/market-snapshot-tool.test.ts`; `tests/chat/holdings-closed-per-live-data*.test.ts`; new `tests/chat/tool-labels-parity.test.ts` and the new test files named below | `lib/queries/*`, `lib/chat/tool-labels.ts` |

A test file not listed belongs to nobody in wave 1; a task that breaks one stops and reports it (it is a missed owner, fixed by the controller).

**Wave 2** (T6, T7 and T9 in parallel; T8 after T6 is reviewed, because T8 registers T6's tools; T10 last, after T6-T8 are reviewed)

| Task | Owns | Reads only |
|---|---|---|
| T6 | new `lib/chat/composite/*.ts` and `tests/chat/composite-*.test.ts`; `lib/chat/tool-labels.ts` (adds 6 labels) | engines |
| T7 | `lib/chat/system-prompt.ts` (wording, static block only); `tests/chat/system-prompt*.test.ts` | everything |
| T8 | `lib/chat/tools.ts` (compaction + registering T6's tools); `tests/chat/tools-*.test.ts`; new `tests/chat/tool-output-compact.test.ts` | `lib/chat/composite/*` |
| T9 | new `scripts/chat-eval/*`; `tests/scripts/chat-eval-scorer.test.ts` only | everything |
| T10 | `lib/chat/CLAUDE.md`, `docs/DECISIONS.md`, `docs/plans/TODO.md`, `docs/reference/architecture-detail.md` (chat lines only) | everything |

---

## 5. Waves and barriers

- **Wave 1:** T1-T5 in one message.
- **Barrier 1** (controller): `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH npx vitest run tests/chat tests/queries tests/api tests/dashboard tests/repo tests/integration`, `npx tsc --noEmit -p .`, `bash scripts/verify.sh changed --base main`. Expected transitional failure: none once all five have landed (Contract F's parity test passes once T4 is in). Then an independent read-only review of each task's diff (Opus, runs the code and the named tests, gets the code and this plan, not the worker's report).
- **Wave 2:** T6, T7, T9 together; T8 when T6 is reviewed; T10 when T6-T8 are reviewed.
- **Barrier 2:** same commands as barrier 1; review per task.
- **Wave 3:** W3-1 to W3-5 (section 6).

---

## Task 0 — Contract stubs (controller, before wave 1; Codex 16)

So that five parallel workers can each typecheck alone, the controller commits these first, in one commit, then dispatches wave 1:
- `lib/chat/turn-outcome.ts`: the sentence constants and `turnOutcomeNotice` with its real body (small and pure; Task 3 then owns it and adds tests).
- `lib/chat/tool-labels.ts`: `CHAT_TOOL_LABELS` copied from `lib/chat/tools.ts:2030-2058` plus `toolLabel` (Task 4 then owns it).
- `lib/chat/tools.ts`: no `ChatTool` type exists today (`CHAT_TOOLS` is `Anthropic.Tool[]`), so Task 0 CREATES `export type ChatTool = Anthropic.Tool & { needsApproval?: true; toModelOutput?: Tool["toModelOutput"] }`, with `Tool` imported as a type from `ai`, and retypes `CHAT_TOOLS` as `ChatTool[]` (type only, no other change to the array; Task 5 then owns the file).
- `lib/queries/chat-tools.ts`: `getDataFreshness(db, opts?: { accountIds?: number[] })` with the parameter ignored (Task 2 implements it); `lib/chat/validate.ts`: `annotateToolResult(db, toolName, raw, opts?: { accountIds?: number[] })` passing it through.
- `lib/chat/ibkr-context.ts`: the Contract E fields added to the type with neutral values (Task 2 fills them).
Run typecheck and `tests/chat` once; commit by pathspec.

## Task 1 — Portfolio summary figures (`lib/queries/portfolio-summary.ts`)

**Protects:** every figure in the system-prompt Portfolio Context. Bounds: a scoped summary names no symbol or account outside the scope's id list; allocation buckets sum to the live long book of the scope within $1 and their percentages to 100% within 0.1; open-lot totals print long basis and short proceeds as two figures; tax lists contain only lots in accounts where `isTaxableAccount(tax_treatment)` is true.

- [ ] **B1 + Contract I (scope).** Scenario: accounts "IBKR Main" (id 1, holds `AAA` 10 × 10), "IBKR Two" (id 2, holds `BBB` 5 × 20), "Vanguard Taxable" (id 3, holds `VVV` 100 × 50). Call with `{ accountIds: [1, 2], label: "IBKR" }` → the text contains `AAA` and `BBB`, never `VVV` or "Vanguard Taxable"; holdings, shorts, allocation, sectors, tax summary, harvest, long-term, income, recent transactions and freshness all read ids 1 and 2. Call with `{ accountIds: [], label: "IBKR" }` and with the string `"No Such Account"` → no symbol at all and the sentence "No account matches this chat's scope.". Test first: `tests/queries/portfolio-summary-scope-b1.test.ts` › "a two-account scope reads exactly those accounts" and "an empty or unknown scope reads nothing", and "a scoped summary shows no wash-sale replacement from another account" (P8: a loss sale in account 1 and a replacement buy in account 3 → the IBKR-scoped text has the count sentence and neither the replacement's symbol context nor its date). Fix: replace the `accountId` lookup (`:151-163`) with an id list; build every filter with `accountScopeAndSql` (`lib/queries/account-scope-sql.ts`) on the right alias (`h.`, `tl.`/`tax_lots.`, `t.`); pass the same list to `getPortfolioCurrentValues` (it already treats `[]` as none).
- [ ] **B2 / QA-5 (expired options in allocation).** Scenario: a statement-sourced holdings row (source key from the statement class in `lib/db/holding-sources.ts`) for a call that expired yesterday, 5 contracts, price 3.00, multiplier 100, plus a live stock worth 5,000. Expected: no "Option" asset bucket, no option sector weight, percentages over the stock only (100%). Test: `tests/queries/portfolio-summary-allocation-expired-b2.test.ts` › "an expired option row is left out of both allocation sections". Fix: add `AND ${liveOptionExpirationSql("s", today)}` to both `alloc` CTEs (`:347-367`, `:387-406`), as the holdings list already does. Conservation test in the same file: the Asset Allocation dollar figures sum to the sum of the Current Holdings long market values within $1.
- [ ] **B4 (long basis plus short proceeds).** Scenario: one open long lot, basis 1,000; one open short lot, opening proceeds 500. Expected line: "Open lots: 2 (long cost basis: $1,000; short-sale proceeds: $500)". Test: `tests/queries/portfolio-summary-short-lots.test.ts` › add "open-lot totals keep long basis and short proceeds apart". Fix: in the `taxLotGroups` loop, total `is_short` groups separately. Wording follows the pending-lots rule ("short figures are short-sale proceeds, never summed with a long cost basis").
- [ ] **B4b / QA-9 (freshness in scope).** Scenario: account 1's newest holdings row is dated 2026-10-30, account 3's 2026-11-06; scope [1]. Expected "Latest holdings" = 2026-10-30; "Latest price date" = the newest price among securities held in scope; the snapshot month-end = the newest among scope accounts. Test: `tests/queries/portfolio-summary-scope-b1.test.ts` › "freshness lines read the scope's own dates". Fix: apply the scope list to the three MAX queries (`:712-728`; prices through a join to the scope's latest holdings).
- [ ] **QA-1 (tax treatment).** Scenario: a Roth account (`tax_treatment` = the retirement value from `TAX_TREATMENTS`) with a losing lot and a lot 20 days from long-term; a taxable account with the same. All-accounts summary: harvest list and long-term list show only the taxable lots. Roth-only scope: both sections print "Not applicable: this account is tax-advantaged." Test: `tests/queries/portfolio-summary-tax-treatment-qa1.test.ts` › "harvest and long-term lists skip tax-advantaged accounts". Fix: taxable ids = `getAllAccounts(db).filter(a => isTaxableAccount(a.tax_treatment))` intersected with the scope; filter both lists with `accountScopeAndSql` on that set. Pending-lot exclusion through `getPendingStatementIndex` stays where it is (before the slice).
- [ ] **QA-2 (realized gains by tax year).** Replace the lifetime "Realized gains" line with two lines, current Eastern tax year (`todayET().slice(0, 4)`) and prior year: "Realized gains YYYY (taxable accounts): short-term $X, long-term $Y" from `generateTaxReport(db, year, { accountName })` totals (`shortTermTotal.gainLoss`, `longTermTotal.gainLoss`), which excludes retirement accounts and is what the Tax Lots card shows. Scope: all → no `accountName`; one account → its name; several accounts → one call per account, summed (the accounts are disjoint). Add "(not for filing)" when `filingReady` is false, and keep the existing convention-pending wording. In a single-account scope, wash-sale detail follows P8 (count only). Test: `tests/queries/portfolio-summary-tax-treatment-qa1.test.ts` › "realized gains are by tax year and exclude retirement accounts" (a Roth sale this year and a taxable sale last year → each year line holds only its taxable sale). Conservation: for the all-accounts scope the per-account sum equals the all-accounts report total within $0.01. If calling `generateTaxReport` twice adds more than 200 ms on the test fixture, report it instead of optimising.
- [ ] **QA-11 (unit nouns).** Recent transactions use `quantityUnitLabel(security_type, quantity)` (`lib/format/quantity-unit.ts`) instead of the literal "shares". Test: `tests/queries/portfolio-summary.test.ts` › "recent transactions name contracts and face value by type".
- [ ] **QA-12 (one cost basis).** Use `scaledCostBasisFallbackSQL` (`lib/valuation.ts`) for the holdings lines' cost basis and gain, as `getHoldingsForChat` does ("the basis the Accounts page shows"). Test: `tests/queries/portfolio-summary.test.ts` › "holdings cost basis matches query_holdings for a row with no own basis" (a row with NULL `cost_basis` and an earlier row of the same pair).
- [ ] Run `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH npx vitest run tests/queries tests/integration`, typecheck, `verify.sh changed`; commit by pathspec.

## Task 2 — Tool engines (`lib/queries/chat-tools.ts`, income, IBKR context, validate)

**Protects:** figures returned by `query_holdings`, `query_allocation`, `query_tax_lots`, `query_income_summary`, the IBKR dashboard and every result's `data_freshness`.

- [ ] **Step 0 (O3, read-only, counts only).** `npm run sandbox -- up --task pa-income-probe` (VACUUM copy of the live DB into the coordination directory; the dev server it starts is not used), then with `sqlite3 -readonly <copy>` run counts only: (P-a) REINVESTMENT rows; (P-b) of those, how many have a DIVIDEND row with the same `account_id`, `security_id`, `trade_date`; (P-c) DIVIDEND rows with `amount < 0`; (P-d) INTEREST rows with `amount < 0` and with `amount > 0`; (P-e) FEE and COMMISSION rows by sign; (P-f) under the P13 rule, REINVESTMENT rows paired, unpaired positive, unpaired negative; (P-g) (account, security, day) groups with more than one DIVIDEND or more than one REINVESTMENT. Then `npm run sandbox -- down --task pa-income-probe`. Write the counts (no amounts, no symbols) into the task report. Decision: fix `lib/queries/income.ts` iff P-b > 0 or P-d(negative) > 0. Never write to the copy.
- [ ] **B3 / QA-6 + Contract J.** Scenario: DIVIDEND +10 and REINVESTMENT +10 on the same account, security and day; a lone REINVESTMENT +4 on another day; INTEREST −25; INTEREST +3; FEE −2. Expected: `total_dividends` 14, `total_interest` 3, `interest_paid` 25, `total_fees` 2, `net_income` −10. Test first: `tests/queries/chat-tools-income-b3.test.ts` › "a reinvested dividend counts once and charged interest is a cost", "two dividends and one reinvestment on one day pair by amount", "a reversed (negative) dividend is netted", "a negative unpaired reinvestment is not income and is counted", "importing the same rows twice through the normal upsert (same source keys) changes nothing", plus conservation "group_by=type rows sum to the group_by=account total and to one computed total". Fix: new `lib/queries/income-sql.ts` exporting the fragments; `getIncomeSummaryForChat` uses them; if step 0 says so, `getIncomeSummary` in `lib/queries/income.ts` uses the same fragments (test `tests/queries/income-b3.test.ts`, same scenario, keeps the `[]` = none behaviour pinned in `tests/compute/empty-account-scope-series-readers.test.ts`). Rewrite the `validate.ts` caveat (`:74-77`) to "Dividends count each payout once (a reinvestment is the purchase leg). Interest paid on a margin debit is shown separately." Account filter: `accountScopeAndSql`, never `a.name = ?` (the dispatcher passes ids; keep `account_name` working for existing callers).
- [ ] **B5 / QA-3 (weight denominator).** Scenario: account 1 holds 100 of value, account 2 holds 900. `getHoldingsForChat({ account_name: <account 1> })` → weight 100%. Test: `tests/queries/chat-tools-weights-b5.test.ts` › "an account-filtered call's weights sum to 100" (bound: within 0.1). Fix: apply the same account condition as the row query to `totalRow` (`:285-307`); symbol, type and sector filters do NOT narrow the denominator (a symbol's weight is its share of the account). Add `weight_basis: "account"` or `"all accounts"` to each row.
- [ ] **QA-4 (currency).** Add `currency` (the security's) to holdings rows and open and closed lot rows. Test in the B5 file: "a yen holding carries currency JPY; market_value is USD".
- [ ] **B6 (closed sales).** Scenario: a JPY lot sold for 150,000 JPY proceeds, gain 50,000 JPY, `usd_per_unit` 0.007; a `RECONCILE_CLOSE` sale. Expected: rows carry `proceeds_native`, `cost_basis_native`, `realized_gain_native`, `currency: "JPY"`, and `*_usd_at_current_fx` (P14); the reconcile sale has `is_synthetic_close: true` and `status_note: "Estimated by the lot engine from a missing broker trade; not a recorded sale."`. Test: `tests/queries/chat-tools-closed-sales-b6.test.ts`. Fix: build closed rows on `getClosedTaxLotSales(db, year, { accountName })` (`lib/queries/tax-lots.ts:366`) with the conversion labelled per P14 (test: a JPY sale with no `fx_rates` row → `null` USD fields, never parity), then filter symbol (case-insensitive), sort by `sort_by` (B6's second half: closed sales ignore `sort_by` today) and slice. Add `account_tax_treatment` to open and closed rows (quality audit §2). Keep `tests/repo/synthetic-close-consumers.test.ts` green (chat-tools.ts is "include-with-disclosure").
- [ ] **B7 / QA-7 + Contract E.** Scenario: account cash line for the IBKR account (daily valuation, `cash_balance` 1,400, dated 2026-11-10); a short and an expired option row present. Expected: `estimatedCash` 1,400, `cashAsOf` 2026-11-10; a second fixture with `cash_balance` −300 → `estimatedCash` −300, stance treats it as fully invested. Test: `tests/chat/ibkr-context.test.ts` › add "cash comes from the account's own cash line" and "a margin debit is not clamped to zero". Also "a carried or timing-residual negative figure withholds the stance" (P12). Fix: `computeIbkrTradingContext` reads `getAccountCashLine(db, accountId)`, maps its `carried`, live-anchor and `priceDateMismatch` flags into Contract E, and reads (`cashBalance`, `totalValue`, `valuationDate` or `measuredDate` when `carried`) for the given `accountId`, never by name; `getCashEstimates` keeps its signature for any other caller, and if it has no caller left, leave it in place and say so (no removal in this plan).
- [ ] **B8 (allocation expired options).** Scenario as B2. Test: `tests/queries/chat-tools-expired-options-and-leap-day.test.ts` › add "query_allocation leaves out an expired option". Fix: push `liveOptionExpirationSql("s", todayET())` into the conditions (`:666-669`). Conservation: allocation totals equal `getHoldingsForChat` long market value for the same scope within $1 (priced rows; the unpriced-at-cost rule stays disclosed).
- [ ] **B9 (symbol case).** Every `s.symbol = ?` in this file becomes `UPPER(s.symbol) = UPPER(?)`. Test: `tests/queries/chat-tools.test.ts` › "a lower-case symbol finds the position". Share-class folding through `issuerSiblings` is follow-up F9.
- [ ] **B10, engine half.** `computeIbkrTradingContext` counts every active position (no `limit: 100`; pass a limit no smaller than the account's row count, or call without a limit if the function allows). Test: `tests/chat/ibkr-context.test.ts` › "130 positions count as 130". The dispatcher half is Task 5.
- [ ] **B25 / QA-9 (freshness clock and scope).** `getDataFreshness(db, { accountIds })` ages are `calendarDaysBetween(latest, todayET())`, and the holdings and price MAX read only the scope's latest holdings (Codex 12; test: an old scoped account beside a fresh unrelated account reads old). Test: `tests/queries/chat-tools-et-today.test.ts` › "a price dated today is 0 days old at 21:00 Eastern" (`vi.setSystemTime` to 02:00Z next day).
- [ ] Run `npx vitest run tests/queries tests/chat/ibkr-context.test.ts tests/chat/validate.test.ts tests/compute/empty-account-scope-series-readers.test.ts tests/repo/synthetic-close-consumers.test.ts` (node pin), typecheck, `verify.sh changed`; commit by pathspec.

## Task 3 — Chat route and prompt structure

**Protects:** cost (cache hits), the scope boundary, saved history, the concurrency slot.

- [ ] **A. Structure split (Contract D).** `buildSystemPromptBlocks` + `buildSystemPrompt` wrapper. No wording change except moving the date line and the IBKR dashboard into the volatile block and the macro date line likewise. Tests: `tests/chat/system-prompt-blocks.test.ts` › "static block is byte-identical across dates, portfolio contexts, dashboards and pages, per scope" (5 scopes) and "volatile block order is date, dashboard, portfolio, page". Existing `tests/chat/system-prompt*.test.ts` stay green on `buildSystemPrompt`.
- [ ] **B. Cache marks (R1, Contract D items 4-7).** Route test `tests/api/chat-cache-marks.test.ts` (mock `streamText` and capture options, as `tests/api/chat-budget.test.ts` does): one marked system block (first of two), one marked tool (last), top-level mark present, no mark elsewhere. Also add `markLastMessageForCache` (unused fallback) with its own unit test in `tests/chat/history.test.ts`.
- [ ] **C0. Error logs (P15).** Replace every chat `console.error`/`console.warn` that prints an error object with `logChatError(where, error)` from `lib/chat/usage-log.ts`. Test: `tests/chat/usage-log.test.ts` › "an SDK error carrying request body values logs none of them" (an `APICallError`-shaped object whose `requestBodyValues` holds a synthetic marker string).
- [ ] **C. Usage log (R3, D6).** New `lib/chat/usage-log.ts`: `formatUsageLine(kind: "step" | "turn", fields)` returns `[chat-usage] ` + JSON with exactly `{ kind, conversationId, scope, model, step | steps, noCache, cacheWrite, cacheRead, output, finishReason }`. Route: `onStepFinish` logs a step line; `onFinish` logs a turn line from `totalUsage`. Test: `tests/chat/usage-log.test.ts` › "the line carries only the allowed keys" (feed it an object with extra keys including text; assert the output keys equal the allowed set and no input text appears).
- [ ] **D. Abort (B13, R6).** `abortSignal: request.signal` on `streamText`. Test: `tests/api/chat-abort.test.ts` › "aborting the request releases the slot without calling onAbort by hand" (use `MockLanguageModelV3` from `ai/test` behind a mocked `getModelForFeature`, a stream that waits; abort the `Request`'s controller; assert `activeStreamCount` returns to 0). Pass the tool's own `abortSignal` into `executeTool` (Contract H).
- [ ] **E. Persistence (B11, Contract B).** `onFinish({ steps, finishReason })` saves the joined step texts or the cut-off sentence. Wrap the save and the title update in `try/catch` that logs (B14 second half). Test: `tests/api/chat-persist-steps.test.ts` › "text before and after a tool call is saved" and "a turn that ends on tool calls saves the cut-off sentence" and "a turn waiting for approval saves nothing".
- [ ] **F. Retry dedupe (B12).** Save the latest user message only when the request's last message is a user message, and skip it when the conversation's last stored row (`getConversationMessages`, `lib/queries/chat.ts`) is a user row with identical text. Test: `tests/api/chat-retry-dedupe.test.ts` › "two posts ending in the same user message leave one user row" and "a retry after a 429 still saves the message once".
- [ ] **G. Last-step guard (P4).** `prepareStep({ stepNumber })`: when `stepNumber === 7` (the eighth call), return `system` = the two blocks with the volatile block extended by "This is your last step: tools will not run again in this answer. Write the answer now from what you have, and say what you could not check." (the static block and its mark are untouched, so the cache prefix holds). Keep `stopWhen: stepCountIs(8)`. If the model still ends on tool calls, Contract B's cut-off sentence is what the owner sees and what is saved. Test: `tests/api/chat-last-step.test.ts` › "step 8 receives the final-step note in the volatile block only" (mock model that always calls a tool; capture the eighth call's system).
- [ ] **H. History check.** New `lib/chat/history.ts` exports `sanitizeUiHistory(messages)`: drops tool parts in `input-streaming` / `input-available`; a tool part in `approval-requested` that is not in the final message is turned into `output-denied` with `approval: { id, approved: false, reason: "Not confirmed" }` IF `convertToModelMessages` emits a paired `execution-denied` result for that state (read `ai/dist/index.mjs` after line 8470 to confirm before choosing), otherwise it is dropped. A tool part in `approval-responded` in the LAST assistant message is valid as is (the SDK converts it to a call, an approval request and an approval response with no result yet, and `collectToolApprovals` then executes it; Codex 4). Route: `convertToModelMessages(sanitizeUiHistory(messages), { tools: aiTools, ignoreIncompleteToolCalls: true })`, then `findOrphanToolCalls(modelMessages)` (every `tool-call` id in an assistant message has a `tool-result` in the next tool message, except calls in the last assistant message that carry an approval request or an approval response); if any orphan remains, log `[chat] orphan tool call dropped` with the count and remove the orphan parts. Tests: `tests/chat/history.test.ts` › "an aborted tool call is dropped", "a stale approval request does not reach the model unpaired", "a complete history passes unchanged", and "an approved continuation survives and the SDK executes it" (real `convertToModelMessages` + `streamText` with `MockLanguageModelV3`; `create_note` ran once).
- [ ] **I. Conversation id (B14).** Unknown or deleted `conversationId` → create a new conversation (same scope) and return its id in the header. A known id whose stored scope differs from the request scope → 409 `{ success: false, error: "This conversation was started in the <label> scope. Start a new conversation to change scope." }`. Add `getConversationById` to `lib/queries/chat.ts`. Tests: `tests/api/chat-conversation-id.test.ts`.
- [ ] **J. Scope (B1 route half, P1, P2, Contract I).** `resolveChatScope` in `lib/chat/scope.ts`; the route passes `{ accountIds, label: SCOPE_LABELS[scope] }` to the summary (`kind: "none"` → `[]`). `clampToolInputToScope` gains the scope's id list: a model `account_name` resolving to a subset of it is kept (P2). IBKR dashboard: computed only when the IBKR scope is exactly one account; otherwise `ibkrNote` = "The IBKR scope covers N accounts; the trading dashboard covers one account and is left out." Tests: `tests/chat/scope.test.ts` › "a two-account IBKR scope keeps a narrower account and forces any other", "an unresolvable scope reads no account", "accounts named IBKR and IBKR Two both stay in the IBKR scope" (P10); route test "the summary receives the scope's id list".
- [ ] **K. Page context (B18 server half, Contract A).** `lib/chat/page-context-server.ts` with `readPageField(body)` and `resolvePageData(db, path)`. Tests: `tests/chat/page-context-server.test.ts` › "a security id resolves to its symbol on the server", "an unknown id gives no symbol", "a free-text pageContext is ignored", "a print event resolves through getEventById".
- [ ] **L. Turn outcome (Contract B).** `lib/chat/turn-outcome.ts` + `messageMetadata`. Test: `tests/chat/turn-outcome.test.ts` (pure function cases).
- [ ] **M. IBKR dashboard rendering (Contract E).** Tests in `tests/chat/system-prompt.test.ts` for negative cash, "as of" dates and "not available".
- [ ] **N. Approval pass-through (Contract C) and toModelOutput pass-through (Contract H).** Test `tests/api/chat-create-note-approval.test.ts` (MockLanguageModelV3, real `streamText`, `notes` row counts): "a model call to create_note stops for approval and saves no note"; "an approval continuation saves one note and no user row"; "a denial saves no note"; "the same continuation posted twice saves one note" (P11).
- [ ] Run `npx vitest run tests/api tests/chat` (node pin), typecheck, `verify.sh changed`; commit by pathspec.

## Task 4 — Client and conversation routes

**Protects:** the conversation the owner sees matches the one stored; the page the model is told about is the page on screen.

- [ ] **B16.** `loadConversation` calls `stop()` first when `isStreaming` (as `handleNewConversation` does). Source-pin test `tests/dashboard/chat-load-conversation-stops-stream.test.ts` (`anchorIndex`).
- [ ] **B17.** When `status` leaves streaming, adopt `turn.conversationId` synchronously (set state before awaiting `fetchConversations()`). `turn` gains a `generation` counter: New Conversation, loading a conversation and deleting the open one reset `turn.conversationId` to null and bump the generation; an adoption whose generation is stale is ignored (Codex 7). `requestBody` reads state only, never the box. Extract the adoption decision to a pure function in `lib/chat/turn-adoption.ts` and test "a late header after New Conversation is not adopted" in `tests/chat/turn-adoption.test.ts`. Update `tests/repo/chat-failed-turn-adoption.test.ts` to pin "adoption is not behind an await" and keep "failure without a header adopts nothing".
- [ ] **B15 client (Contract B).** Notice line from `turnOutcomeNotice`; Stop button while streaming. Source-pin test `tests/dashboard/chat-stop-and-cutoff.test.ts`.
- [ ] **B18 client (Contract A).** Body sends `page: { path: pathname }`; `getPageContext` call removed from the client. `lib/chat/page-context.ts`: add `/dashboard/today` ("User is on the Today page."), `/dashboard/tax-lots`, `/dashboard/print/<id>` (with `symbol` and `eventDate` when given: "User is on the earnings print page for SYMBOL (event date DATE)."), `/dashboard/levels`, `/dashboard/alerts`, `/dashboard/notes`; remove routes that no longer exist under `app/dashboard/` (check `ls app/dashboard`: `holdings` exists, `overview` exists; keep only real ones). `lib/chat/quick-actions.ts`: security-page chips no longer need `data.symbol`: "Outlook" → "What's the outlook for the security on this page?", "My position" → "Show my position in the security on this page.", "News and earnings" → "Any recent news or earnings for the security on this page?"; "Biggest movers" prompt becomes "What moved my portfolio today, in dollars?". Tests: `tests/chat/page-context.test.ts`, `tests/chat/quick-actions.test.ts`.
- [ ] **B19 client (Contract C).** Approval card and `sendAutomaticallyWhen`. Source-pin test `tests/dashboard/chat-create-note-approval-card.test.ts`; browser proof in W3-3/W3-4.
- [ ] **B20.** Conversation routes answer `{ success: true, data }` / `{ success: false, error }`; `POST /api/chat/conversations` validates `scope` against `VALID_SCOPES` (400 otherwise); the delete handler reads through `readMutationResult` / `networkFailureMessage` and asks through `useConfirmPrompt` if it does not already. Readers of the list and messages routes in `ChatInterface.tsx` read `data`. Tests: `tests/chat/conversation-routes-envelope.test.ts` (Task 4 owns this new file).
- [ ] **B21.** Auto-scroll only when the user is within 80 px of the bottom. Source-pin test in `tests/dashboard/chat-autoscroll.test.ts`.
- [ ] **Contract F.** `lib/chat/tool-labels.ts`; `ChatInterface.tsx` uses `toolLabel`.
- [ ] Run `npx vitest run tests/chat tests/dashboard tests/repo/chat-failed-turn-adoption.test.ts tests/chat/conversation-routes-envelope.test.ts` (node pin), typecheck, `verify.sh changed`, and `npx next build` once (the first UI task; seat a migrated DB copy in the worktree's gitignored `data/` first if the build complains about locking, per root CLAUDE.md). Commit by pathspec.

## Task 5 — Tool dispatcher (`lib/chat/tools.ts`)

**Protects:** the model never receives another name's data for a filter it asked about; no single tool result exceeds its cap.

- [ ] **QA-10 (silent filter drops).** `query_notes`, `query_levels`, `query_alerts`, `query_research_feeds` with a `symbol` that has no `securities` row (case-insensitive) → `{ error: "No security 'ZZZZ' on file. Nothing was filtered or returned." }`. `query_research_feeds` `source`: case-insensitive substring matched against `research_sources.name`; exactly one match → use it; none or several → error naming every source name. Tests: `tests/chat/tools-unresolved-filters.test.ts`. Also fix the "Alliant" spelling in `tools.ts` descriptions (`:759`) to "Eliant" (the prompt is Task 7).
- [ ] **B10 dispatcher half + Contract G.** `list_info` on the ten list tools. Test: `tests/chat/tools-list-info.test.ts` › "60 holdings with limit 50 report truncated" and "exactly 50 report not truncated".
- [ ] **R4 caps (caps only).** Server maxima enforced in code: `limit` ≤ 200 for holdings, tax lots, transactions, levels, alerts; ≤ 100 notes, press releases; ≤ 20 insider trades; ≤ 25 research documents. `query_price_history`: at most 260 rows; a longer range returns the last close of each week, and beyond 260 weeks the last close of each month (`sampled: "weekly" | "monthly"` and a note), so the cap always holds (Codex 14). `query_calendar_briefings`: `weeks_back` ≤ 4. Each cap is stated in its description. Tests: `tests/chat/tools-caps.test.ts` (one case per cap).
- [ ] **QA-4 for price history and B23 for levels.** Add `currency` to `query_price_history` (one top-level field, not per row) and to `query_levels` / `query_alerts` rows (from `securities.currency`; never converted; `formatLevelPrice` is for display text only and is not needed in JSON). Tests in `tests/chat/tools-currency.test.ts`.
- [ ] **B22 (Codex 8).** `computePortfolioGreeks` returns per-unit greeks per position and builds totals as greek × signed quantity × multiplier (`lib/compute/options-greeks.ts:662`), with its own partial-coverage disclosure. Do NOT sum per-unit greeks. Add an optional `underlying` filter to `computePortfolioGreeks`'s options (Task 5 owns this one additive change; with no filter the output is byte-identical) applied before the engine's own aggregation and coverage step; filter `strategies` to the underlying. Tests: `tests/chat/tools-greeks-underlying-b22.test.ts` › "filtered totals equal the engine's totals for a book holding only that underlying" (unequal quantities, a short contract, one unpriced position); existing `tests/compute/options-greeks*.test.ts` stay green.
- [ ] **B24 / QA-8.** `query_alerts` `since_days`: fetch `getAlerts(db, { securityId, response, limit: 500 })`, keep rows whose `triggered_at` instant is at or after the cutoff (parse both the space form as UTC and the `T…Z` form), then slice to `limit`. Test: `tests/chat/tools-alerts-window-b24.test.ts` with one row of each stored format on the boundary day.
- [ ] **P9 (private text in scope).** `query_notes` in a single-account chat: withhold notes linked to another account's transaction and drop `transaction_*` fields of other accounts; `query_earnings_transcript` `user_notes` follows the same rule (the ids arrive as `opts.scopeAccountIds`, Contract H). List every tool's private fields in the task report as "scoped" or "cannot scope" (OPEN-7). Test: `tests/chat/tools-notes-scope.test.ts`.
- [ ] **B26.** Tolerant parse for `mentioned_symbols`, `tags`, `key_points` (reuse the private `parseKeyThemesField` pattern; one bad row yields an empty list for that field, not a tool error). Test: `tests/chat/tools-research-bad-json-b26.test.ts`.
- [ ] **B19 server half (Contract C)** and **Contract H** signature. Update `tests/chat/create-note-tool.test.ts` (the dispatcher still saves when called directly; the gate is the SDK's).
- [ ] **Contract J text.** Rewrite the `query_income_summary` description.
- [ ] **Contract F.** Re-export the labels; `tests/chat/tool-labels-parity.test.ts`.
- [ ] Run `npx vitest run tests/chat` (node pin), typecheck, `verify.sh changed`; commit by pathspec.

---

## Task 6 — Composite read tools (wave 2)

**Rule:** each tool calls the same engine with the same arguments as the dashboard surface named below and returns its figures unchanged. A tool never recomputes a figure the dashboard computes. Each file exports a definition (same shape as a `CHAT_TOOLS` entry, with `account_name` in its schema so the clamp applies) and a runner `(db, input, ctx: { accountIds: number[] | undefined; accountName?: string; today: string }) => unknown`. `lib/chat/composite/index.ts` exports `COMPOSITE_CHAT_TOOLS`, `runCompositeTool(name, …)` and `COMPOSITE_SCOPE_LIST_TOOLS` (the names that accept an id list). Every output carries `as_of`, `scope: { account_names }`, `units`, `currency: "USD"` for converted figures, and stays under 6,000 characters of JSON (test per tool on a fixture with 60 positions). `ctx.accountIds` of `[]` → `{ error: "No account is in this chat's scope." }` before any engine call.

| Tool | Engine call (same as) | Scope | Output (units) |
|---|---|---|---|
| `query_risk` | `computeRiskMetrics(db, { accountIds, startDate, endDate })` and `computeConcentration(db, accountIds)` (as `app/api/compute/risk/route.ts:56-73`) | list | volatility (annualised fraction), sharpe (ratio, null under 30 days), max drawdown (fraction, peak and trough dates), current drawdown, risk-free rate (fraction), herfindahl, top-5 share, seam days bridged, data points, series start and end. Beta only if the risk route returns it; never computed here. |
| `query_scenarios` | `computeAllScenarios(db, { accountIds })` (as `app/api/compute/scenarios/route.ts:32`) | list | per preset: name, current value, estimated change ($ and fraction), top 3 losers and winners (symbol, $), options and bonds unmodelled (count, value share). No custom scenario in this plan (F10). |
| `query_performance_vs_benchmark` | window from `resolvePerformanceWindow` exactly as `query_twr` and `PerformanceView.tsx:120-160` derive it; `computePeriodAttribution(db, scope, start, end, "SPY")` (as `PerformanceView.tsx:296-305`); `computeMonthlyPerformance(db, accountIds, month)` with `listStatementMonths` for the default month; `computeBenchmarkComparison(db, { benchmarkSymbol: "SPY", startDate, endDate, accountId })` only for one account or all | list (benchmark comparison: one or all; omitted with a note for a list) | window start and end; top 5 contributors and detractors; top 5 sectors; beta and alpha contribution with `decomposedReturn` and `betaWindow` (stated as what they are, not the TWR); the month's blended and per-account rows |
| `query_realized_gains` | `generateTaxReport(db, year, { accountName })` (as `app/api/tax-report/route.ts:29`); `year` defaults to the Eastern year | one account or all | year; short and long totals (proceeds, cost, adjustments, gain); row counts; wash-sale warnings (first 10 + count); excluded retirement accounts; excluded non-USD sales; `filingReady`; the advisory text. Rows only with `include_rows: true` (max 50, Contract G) |
| `query_options_book` | `getExpiringOptions(db, { accountIds, daysWindow, today })` (as `app/api/compute/options-expirations/route.ts:14-18`; `daysWindow` default 30, max 120) and `getPortfolioExposureSummary(db, accountIds, today)` | list | per contract: symbol, underlying, type, strike, expiration, days to expiry, quantity, account; moneyness only if the engine returns it (otherwise say "moneyness: see query_options_greeks"); delta-adjusted exposure totals. Max 50 rows (Contract G) |
| `query_data_confidence` | `getDataConfidence(db)` (as `app/api/data-confidence/route.ts`) | all only (P3) | overall score and level, each dimension's level and one-line reason, `capReason`, first 5 action titles, integrity counts by severity, whether the lot-drift scan ran. No dollar figure. |

- [ ] One test file per tool, `tests/chat/composite-<name>.test.ts`: (1) parity: the tool's figures equal the engine's for the same scope (deep equality on the mapped fields); (2) empty scope → error with no engine call (spy); (3) one-account-only engines answer a list with the one-account error; (4) size cap; (5) `query_data_confidence` in a single-account context → error.
- [ ] Add the six labels to `lib/chat/tool-labels.ts`.
- [ ] `query_realized_gains` in a single-account scope follows P8 (wash-sale count only). Test in its file.

## Task 7 — Prompt wording (wave 2, static block only)

- [ ] Rewrite the shared core from the quality audit's §8 draft (reproduced in substance below), adjusted: the "Your stance" block implements O1 and replaces the "Constraints" NEVER-advise line and the macro prompt's copy of it; nothing about freezing the summary (D7); the "Choosing tools" routing covers all 27 tools plus the 6 composite tools, one line per question type, including "returns → query_twr; vs SPY and what drove it → query_performance_vs_benchmark; risk → query_risk; stress → query_scenarios; realized gains → query_realized_gains; expiries → query_options_book; can I trust this → query_data_confidence".
- [ ] Draft sections to include (wording may tighten): who the reader is (an experienced investor and finance professional; no definitions, no generic disclaimers); answer first, short by default, tables for 3+ items with right-aligned numbers, dates on every figure; ask one question when the answer depends on it; numbers the model must not compute (returns, day effect, realized gains, risk, cross-account totals unless `truncated` is false); what it does not have (no intraday quotes, no 1099 feed, tax figures not for filing, no order entry, cut-off lists); conventions (prices native, values USD; short signs; options premium is not exposure; tax treatment belongs to the account; pending lots); request independent tools together, limited steps; re-query rather than trust figures in earlier answers.
- [ ] Remove or fix: the prose tool list (`:330-355`); "All amounts are in USD" (→ the currency convention); "Holdings data shows only CURRENT positions from the latest statement per account" (→ "latest row per account and security, statement or live"); "Tax Lots tab" → "Tax Lots page"; "Alliant Capital" → "Eliant Capital" (and update `tests/chat/system-prompt.test.ts:101`); duplicate FIFO lines; "ALWAYS mention relevant warnings" → "mention a warning when it changes the answer"; persona lines that state owner behaviour as fact or prescribe (`:59`, `:74-75`, `:167`, `:207`) become hypotheses to check with `query_transactions` or are removed.
- [ ] Keep pinned rules green: Ground Truth, Live Market, pending-lot, short-lot, latest-transcript (`tests/chat/system-prompt*.test.ts`).
- [ ] Keep Contract D: the byte-identity test from Task 3 stays and passes.

## Task 8 — Compact tool output and registration (wave 2)

- [ ] Register T6's tools: append `COMPOSITE_CHAT_TOOLS` to `CHAT_TOOLS`, dispatch through `runCompositeTool` after the existing account resolution, and add `COMPOSITE_SCOPE_LIST_TOOLS` to `SCOPE_LIST_TOOLS`.
- [ ] `toModelOutput` (Contract H) for `query_holdings`, `query_tax_lots`, `query_transactions`, `query_price_history`, `query_allocation`, `query_performance`: `{ type: "json", value: { columns: string[], rows: unknown[][], …non-row keys } }`; dollars rounded to 2 decimals, fractions to 6, quantities to 6 significant digits; a column whose value is the same on every row is hoisted to one key; `quality_warnings`, `data_freshness` and `list_info` kept. The UI keeps the full object.
- [ ] Test `tests/chat/tool-output-compact.test.ts`: (1) for 50 holdings rows the model JSON is at least 30% smaller than the raw; (2) conservation: the sum of the `market_value` column equals the raw sum within $0.01 × rows; (3) every row and every column survives (no row dropped); (4) a tool without `toModelOutput` is unchanged.

## Task 9 — Golden evaluation script (wave 2; runs only in W3-4)

- [ ] `scripts/chat-eval/build-eval-db.ts`: copies `data/demo.db` (from `npm run seed:demo`) to a path given by `--out` (default the session scratchpad), refuses to write to `data/vanguard.db`, and adds synthetic rows: a Roth account with a losing lot; a short; a live and an expired option; a non-USD holding; a reinvested dividend pair; a pending-statement lot; a bond maturing within 60 days. Prints the path first.
- [ ] `scripts/chat-eval/run-golden.ts`: posts each question to a running dev server's `/api/chat` with a minted session and CSRF cookie, one new conversation per question, records tool calls and final text from the stream, reads the `[chat-usage]` lines from the server log path given by `--log`, prints per-question and total tokens and estimated cost from a price table keyed by model family (`sonnet`, `opus`, `haiku`; the id itself is read from the log, never written in the script), and stops before the next question when the running estimate exceeds `--budget-usd` (default 4). Scoring: must / must-not regular expressions per question; a pass rate per question.
- [ ] The 18 questions go into `scripts/chat-eval/golden.ts` as data (restated here, Codex 15). "Must" and "must not" are checked by regular expressions against figures the fixture builder knows, plus the recorded tool calls.

| # | Scope | Question | Must | Must not |
|---|---|---|---|---|
| Q1 | All | How's my portfolio doing this year? | TWR with window start and end, per account; XIRR labelled money-weighted | a sum of monthly changes |
| Q2 | All | What moved today, in dollars? | `day_effect` figures; the asOf date; a short that rose shown as a loss | percent × value arithmetic |
| Q3 | All | Am I beating the S&P this year? | portfolio vs SPY over one window from `query_performance_vs_benchmark` | an SPY figure not from a tool |
| Q4 | IBKR | What drove last month? | contributors from the attribution tool, month named | today's holdings applied to a past month |
| Q5 | All | Tax-loss harvesting candidates? | taxable-account lots only; wash-sale caveat once | the Roth lot; the pending lot |
| Q6 | All | Realized gains this year, short vs long? | current-year ST and LT from `query_realized_gains`; not for filing | the lifetime total; a sum of rows |
| Q7 | All | What options expire in the next 30 days? | the live contract from `query_options_book` | the expired contract |
| Q8 | All | How exposed am I to a 20% market drop? | the scenario result with unmodelled positions listed | a beta × value estimate |
| Q9 | IBKR | Biggest position as a share of the account? | an account-based weight | a whole-book weight |
| Q10 | All | What matures soon in my bond book? | the bond maturing within 60 days | an invented duration |
| Q11 | All | Dividend income last 12 months? | the fixture's single-count figure | the double count; margin interest as income |
| Q12 | All | Can I trust today's numbers? | data-confidence levels; the stale price date | "everything is fresh" |
| Q13 | Taxable | Should I wait for long-term on lot X? | days remaining, gain, an assumed rate gap labelled as such, a view labelled as a view | "consult a tax professional" |
| Q14 | All | What's on deck this week for names I hold? | `report_state` respected; ET times | "reported" before the slot |
| Q15 | All | How much of the foreign stock do I own? | native price with its currency code; USD value | a dollar sign on the native price |
| Q16 | All | Total exposure to the name across accounts, including options? | delta-adjusted figure by account | a premium sum |
| Q17 | All | What do my notes say about ZZZZ? | "no security ZZZZ on file" | another name's notes |
| Q18 | All | Full review: performance, risk, tax, upcoming events. | a complete written answer | the cut-off sentence with no text |

- [ ] Budget (Codex 15): the guard checks BEFORE each question that the running total plus a reserve of $0.40 stays under `--budget-usd`. Nested AI calls (`query_filing_section` → `generateTextForFeature`) are not in the chat usage log; the script books the reserve for any answer that called that tool and reports it (none of Q1-Q18 needs it). No route change for the eval. A request that errors (SDK retries included) is booked at the reserve amount.
- [ ] The eval never runs under vitest (its include pattern does not reach `scripts/`; check `vitest.config.*`). One exception, owned by Task 9: a network-free unit test of the scorer at `tests/scripts/chat-eval-scorer.test.ts`.

## Task 10 — Docs (wave 2, after barrier-2 review of T6-T8)

- [ ] `lib/chat/CLAUDE.md`: model is the `chat` feature on the workhorse tier (no id); 33 tools; cache order (Contract D); approval for `create_note`; page field; usage log; P1-P4.
- [ ] `docs/DECISIONS.md` entry 2026-11-11: O1-O4, D5-D9, P1-P7, and the O3 outcome as counts only (P-a..P-e) with whether `income.ts` changed.
- [ ] `docs/plans/TODO.md`: the follow-ups F1-F12 (section 8) and the OPEN items (section 7).

---

## 6. Wave 3

- **W3-1. Review.** One independent read-only Opus review per task (T1-T10), given the diff and this plan, not the worker's report; it runs the named tests and one what-if per item (for example: "scope with zero accounts", "a short-only account", "an approval card left unanswered, then a new message").
- **W3-2. Verify.** `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH bash scripts/verify.sh full --base main` and `npx tsc --noEmit -p .`, then `npx next build` (seat a migrated DB copy in `data/` first if needed). `main` is known red in 8 AI/failover files; record those failures as pre-existing by running the same files on `main` (D8: do not touch them).
- **W3-3. Browser pass, non-AI.** `npm run sandbox -- up --task pa-chat` → `npm run smoke -- --task pa-chat` → manual checks in the sandbox: the security page sends `page.path` (network panel), chips on the security page, Stop button visible while a send is pending (the dummy key makes the send fail; the error path and Retry must not duplicate the user row in the copy), conversation delete envelope, auto-scroll. `npm run sandbox -- down --task pa-chat`.
- **W3-4. Live AI, capped at about $5 total (O4).** The sandbox script cannot do this (1.10). Recipe: build the eval DB (Task 9), start `npm run dev` from this worktree with `DATABASE_PATH=<eval db>`, `ANTHROPIC_API_KEY` from `.env.local` (prefix `source ~/.zshrc &&`), a port in 3090-3096, `TWS_HOST=192.0.2.1`, server log to a file; mint a session into the eval DB. Checks, in order, stopping at the cap (Codex 17: prefix reuse and tail reuse measured apart): take the static prefix size P (tools + static block) from a first call's `cacheWrite`; (a) one tool question: step 2 `cacheRead` > 0 and ≥ P; (b) a second turn with nothing volatile changed (same page, no sync in between): turn-2 step-1 `cacheRead` clearly above P (tail reuse); (b2) a second turn after a page change: `cacheRead` ≈ P is expected (the volatile change invalidates the history cache, D7) and is recorded, not a failure; (c) one `create_note` request: card shown, "Don't save" leaves the notes count unchanged, "Save note" adds one; (d) one probe of `toolChoice: "none"` on a history with tool calls, through a throwaway script, to settle OPEN-1; (e) the 18 golden questions once with `--budget-usd` set to what is left minus $0.50. Record token and cost totals (no figures from the eval DB answers) in the PR text.
- **W3-5. Pull request.** One PR from this branch, body via `--body-file`, ending with the attribution line. No merge, no deploy.

---

## 7. OPEN items (the build follows the stated default unless the owner reverses it)

- **OPEN-1. Forcing a written final step.** Default: the volatile-block note on the last step plus the cut-off sentence (P4). Options: (a) `toolChoice: "none"` if W3-4(d) shows the API accepts tool history with no tool definitions; (b) raise the step limit to 9 and keep the note on step 8; (c) leave as is. Needs W3-4 evidence.
- **OPEN-2. Automatic tail caching.** If W3-4(b) shows no tail cache read, switch to the tested `markLastMessageForCache` fallback (Contract D item 6). Needs W3-4 evidence.
- **OPEN-3. Scope mismatch on resume answers 409** (Task 3 item I). If the owner prefers the server to adopt the stored scope silently, flip it.
- **OPEN-4. Approval-resend row.** The continuation after an approval is saved as a second assistant row. A merged row would need an update path in `lib/mutations/chat.ts`; left as two rows.
- **OPEN-5. Retirement-account harvest wording.** "Not applicable: this account is tax-advantaged." is plan wording; the owner may want none at all.
- **OPEN-7. Private fields that cannot be scoped** (P9): whatever Task 5's inventory lists as "cannot scope". Default: withheld in a single-account chat. *(Superseded 2026-11-12: returned with a `scope_note`.)*
- **OPEN-8. Pending approval on reload** (Contract C): the draft is lost. Persisting it would need the `parts` column the route never writes; left as is.
- **OPEN-6. Income on the dashboard.** Decided by Task 2 step 0 counts (O3). If `income.ts` changes, the Income card's figures change for the period; the PR must say so.

## 8. Follow-ups (not built here)

F1 freeze the portfolio summary per conversation (needs a stored column, D7). F2 measure effort `medium` vs `high` with the eval set (D5). F3 chat failover (D8). F4 privacy masking of portfolio figures inside answers instead of masking the whole answer (cancelled 2026-11-12: the chat no longer takes part in the privacy toggle). F5 clearing old tool results in long conversations (R8, `clear_tool_uses_20250919` is supported). F6 a 1-hour cache TTL once the usage log shows 5-60 minute gaps. F7 FEE sign rule (P6). F8 abort signal into `lib/apis/*` fetches. F9 share-class folding (`issuerSiblings`) in symbol filters. F10 custom scenarios through `query_scenarios`. F11 a fixed-income tool (`computeFixedIncomeExposure`), a watchlist tool, an earnings-bogey tool, a held/armed flag on calendar events (needs a classified call site in `tests/repo/symbol-status-consumers.test.ts`), a "since yesterday" digest. F13 bind approvals to a server-recorded tool-call id and record execution atomically (needs storage; P11). F12 `query_performance` default window, `query_transactions` type enum from the import validator, `query_trade_reviews` P&L as numbers, owner-preferences memory, follow-up chips.

## 9. Report items deliberately left out

- Cheaper model routing (cost "not recommended"; D5).
- Effort change (R5; D5, measured later as F2).
- Freezing the summary (R2a; D7, F1). Moving the page note into the user turn (R2b): replaced by the volatile block (D7).
- Trimming the prose tool list (R7) as a cost item: it is done in Task 7 for correctness instead.
- Context clearing (R8), 1-hour TTL, compaction betas: F5, F6.
- Quality audit R9-R11 (calendar coverage flag, bogeys, watchlist, since-yesterday): F11; not in the approved wave-2 list.
- Chat failover: D8.
- The markdown right-alignment check: covered by the prompt asking for `---:` (Task 7) and the browser pass (W3-4), no code change.

---

## Review log

Codex, one round, 2026-11-11, on revision 1. Verdict: **REVISE**, 18 findings. (Codex also tried to run `verify.sh full`; the read-only sandbox refused it. No test result is claimed from the review.)

| # | Sev | Finding (short) | Outcome |
|---|---|---|---|
| 1 | high | Scoped tax report leaks cross-account wash-sale facts | Folded: P8; T1 and T6 tests |
| 2 | high | Notes and transcript `user_notes` bypass the clamp | Folded: P9, T5 item, OPEN-7 |
| 3 | high | Exact-name priority collapses the IBKR scope | Folded: P10, Contract I, T3 test |
| 4 | high | History check would drop approved continuations | Folded: T3 item H exemption and SDK-backed test |
| 5 | high | Approval has no server binding or idempotence | Partly: P11 replay guard and tests. Rejected part: server-side provenance binding; the approval can only come from the owner's authenticated, CSRF-checked browser, and binding needs storage (F13) |
| 6 | med | "Saved" shown before the save | Folded: Contract C states |
| 7 | high | Fallback id reuses the old conversation | Folded: T4 B17 generation counter, pure test |
| 8 | high | Greeks totals summed per unit | Folded: B22 rewritten to the engine's aggregation |
| 9 | high | Cash flags dropped; every negative called margin | Folded: P12, Contract E |
| 10 | high | Reinvestment pairing by date only | Folded: P13, Contract J, more B3 tests, step 0 counts |
| 11 | high | Closed-sale USD at today's FX, missing FX read as 1 | Folded: P14, B6 |
| 12 | med | Tool freshness still whole-book | Folded: Contract H, B25, Task 0 stub |
| 13 | high | Error log can print the whole prompt | Folded: P15, T3 C0 |
| 14 | med | Limits, per-list metadata, sampling bound | Folded: Contract G, T5 caps |
| 15 | med | Eval matrix not restated; nested calls; budget | Folded: T9 table and budget rules |
| 16 | med | Ownership names and parallel compile dependencies | Folded: Task 0 stubs, ownership table |
| 17 | med | Cache check cannot tell prefix from tail | Folded: W3-4 measurements |
| 18 | med | Source pins do not prove races or approval | Partly: SDK-backed approval tests (T3 H, N), pure adoption test (T4), reload policy (OPEN-8). Rejected part: DOM render tests; the repo has no DOM test harness and its convention is source pins plus browser proof (W3-3, W3-4) |

### Barrier 1 (wave 1 review, 2026-11-11)

One read-only review per task. T1: summary scope edge cases, unit nouns and engine-made closes (R1-1..R1-7; `dbd9efbe`, `a6eeef64`). T2: Interest paid on the Income card, a second net-of-withholding pairing pass, stance guards; the statement cash fallback was ruled separately (R2-1..R2-4; `023bef7c`, `d79852b7`). T3: one blocker (R3-1, an approval answered in an earlier message reached the API unpaired) plus errored and aborted turns, the header pin and page-name cleaning (`cc8c7751`). T4: settled-message rendering, Stop guard, continuation cap and the open-conversation ref (R4-2..R4-12; `f5538ee5`, `284c281b`). T5: input type checks, `create_note` refusals, alert ordering, sampling, the transaction-type enum (R5-1..R5-15; `041cc202`).

### Barrier 2 (wave 2 review, 2026-11-11)

T6: ten findings (R6-1..R6-10; `4406593c`): scenario shares named by base, the `query_risk` window rule, strict inputs, engine throws as plain errors; R6-7 kept the 25-row caps because 50 rows do not fit the 6,000-character cap. T7: the last-step wording made true and the benchmark tool's description corrected (`ac8da2a2`). T8: the byte-identical tool-result replay pinned through the real route (`7ede8506`). T9: no fix commit on the branch when this was written.

### Final whole-branch review and fix round (2026-11-11)

Two wrong-figure blockers were found in compaction rounding chosen by key-name matching. They were fixed by the explicit `COMPACT_ROUNDING` map, `_rounded`, pointers by id and `_same_in_rows_shown` (RF-1..RF-5; `c475e0cd`). The guard now holds its own rounding list and compares text; it was proven by mutation testing (`d5482e5b`). Tool output was capped on a large book (`eaee9678`). Other fixes in the round:
- one-to-one withholding pairing (RF-6, `80199929`);
- the cut-off notice under partial text (RF-7, `d79472c4`, `da9ac61b`);
- "not available" instead of 0 in the IBKR dashboard (RF-9, `8e13e6f8`);
- labelled summary figures (RF-10, `4e38e072`);
- six prompt claims corrected (`77d11460`);
- for the eval: bounded figure checks and a hard spend cap, then a per-question ceiling enforced mid-flight (RF-11, RF-12; `88fbc502`, `475040f0`).

### Browser pass, live runs and the two fix rounds after them (2026-11-11)

- **Browser pass** (non-AI sandbox): 12 of 15 checks passed, 1 failed, 2 could not be tested. The failure was a reply stopped in its first step not being saved. It was fixed by keeping the in-flight text through `onChunk` and saving it on abort (`7ec87983`); the client fixes are in `da4eecf9`. The fix was confirmed on the live server.
- **Live run 1** (synthetic eval database): caching held on the prefix; 9 of 18 questions scored a pass. Fix round 1:
  - tool totals and roll-ups: `074591be`;
  - prompt fixes: `fb2bfff2`, `092befa2`, `ec5cbf5d`;
  - the aborted-step input estimate: `f2035866`;
  - fixture and harness fixes: `e7f7ce73`.
- **Live run 2:** tail caching was proven and 11 of 18 passed; the reviewer judged 9 answers better, 6 the same and 3 worse (over-correction). Fix round 2:
  - prompt rebalance: `2135c782`;
  - `query_twr` units: `6dcd3126`;
  - scorer touch-ups and behaviour counts: `a203c643`.
- **Live run 3** (13 questions): the scorer passed 10 of 13; against run 2 the reviewer judged 5 better, 7 the same and 1 worse, with answers 22% longer. The reviewer's verdict: run 2 to run 3 is sideways, and what remains is mostly a tool problem. The changes after it (`c3365d9e`, `527a5adc`, `e65896f7`) were not measured live.
- **Stop race** (`bb2075f7`): an intermittent abort test (8 of 20 failures) turned out to be a real production race. The `Request` could be garbage-collected mid-stream, losing the abort. The route now holds it until the slot is released.

### Owner rulings after the build (2026-11-12)

The owner ruled that privacy concerns data leaving the app, not what the owner sees inside the chat. Built on the branch (`e95bdcce`..`6c11eec7`): the chat left the privacy toggle (answers, the owner's messages, the note draft, titles); scoped chats stopped withholding data confidence, wash-sale detail, other accounts' notes and whole-portfolio text; the market snapshot's outside fallback asks for SPY, QQQ and DIA only; `query_holdings` gained `account_value_weight_pct`; income pairs a reinvestment with a dividend up to 3 days apart; the conversation menu wraps titles. None of it was measured by a live run. The ruling to use the latest version of each model class is built (`1d8d8517`, `22a1307c` and the call-site commits) but not proven live: the request-shape probe must run before deploy. Income pairing became a maximum matching (`88b70207`); `account_value_base` flags a base older than the prices (`1a657c2f`). Detail: `docs/DECISIONS.md` 2026-11-12.

### Live run 4 and its fixes (2026-11-12)

The model-request probe accepted every request shape on the 5.5 models, which lifted the before-deploy hold. The 18 golden questions ran on Sonnet 5.5 and Opus 5.5 (synthetic database): the independent reader passed 17 of 18 on each, Opus at 2.2 times the cost. The recommendation, pending the owner, is to keep the workhorse tier. The run found four app defects, all fixed: the short gain in `query_holdings` (`3187f976`); native transaction amounts shown as dollars (`3187f976`, `b8598b9d`, `7888727f`); the interest sign in the Portfolio Context (`3187f976`); and taxability read from an account's name (`bf3959f6`, `051c3faa`). It also found an integrity wording that the fixture exposed (`219c244d`). Scorer and fixture fixes: `702d8ff3`, `d822d909`, `5c5ed10e`. Detail: `docs/DECISIONS.md` 2026-11-12 item 8. Run 5 (fixture version 3, Sonnet 5.5, 10 of 20 questions under a $1.20 ceiling): the reader found all 10 right and every run-4 defect gone; the scorer passed 10 of 10 after its fixes (`c581d4f6`). It led to the runner abort fix (`7b111657`), the tax-advantaged wash-sale line (`630824b7`) and the income sign-rule correction (`562b3c57`: reinvestment legs read by their importer's convention, replacing `88b70207`'s raw same-sign rule). The other ten questions have not run on v3.

### Per-chat model class (2026-11-13)

The owner kept Sonnet 5.5 as the chat default and asked to pick the class per new chat. Built with migration 103 (one nullable column, owner-approved): pills on the new-chat screen, the class stored at creation and read from the row on every later turn, a stored class beating the Settings override, a plain label after a step down, Fable unreachable. An independent review found no blockers; its two should-fix items were fixed. Detail: `docs/DECISIONS.md` 2026-11-13.

### Final pre-merge review (2026-11-13)

No blockers. Two should-fix items were fixed: the income pairing search gained a deterministic work budget with an approximate-pairing report (`eb5b8190`), and the chat's `by_symbol` reads a short's basis as its rows do, while the income tool's description states the 3-day window (`62130659`). Detail: `docs/DECISIONS.md` 2026-11-13.

