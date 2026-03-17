# Chat Scope Selector — Design Spec

**Date:** 2026-03-17
**Status:** Approved

## Problem

The Chat tab queries all accounts but never tells the user which accounts are in scope. When a position is absent from results, users can't tell if it was excluded or just didn't match. There's also no way to ask market-level questions without portfolio context polluting the response.

## Solution

Add a scope selector to the Chat tab's empty state — a row of filter chips between the title/subtitle and prompt buttons. The user picks a scope before their first message; scope locks for the duration of that conversation.

## Scopes

| Scope | Label | System prompt gets | Persona subtitle |
|-------|-------|--------------------|------------------|
| All Accounts | `All Accounts` | Full portfolio context (all accounts) | "Ask about your portfolio..." |
| IBKR | `IBKR` | Only IBKR holdings, transactions, valuations | "Analyzing your IBKR trading account" |
| Vanguard Taxable | `Vanguard Taxable` | Only Vanguard Taxable data | "Analyzing your Vanguard taxable account" |
| Vanguard Roth IRA | `Vanguard Roth IRA` | Only Vanguard Roth IRA data | "Analyzing your Vanguard Roth IRA" |
| Macro | `Macro` | No portfolio context | "Market & macro analysis — no portfolio data by default" |

**Type definition:**
```typescript
type ChatScope = "all" | "ibkr" | "vanguard-taxable" | "vanguard-roth-ira" | "macro";
```

## Scope Locking

- Scope is selectable only on the empty state (before the first message is sent).
- Once the user sends a message, the scope locks for the rest of that conversation.
- The locked scope appears as a gold pill badge in the tab bar row, right-aligned (next to the "Chat" tab label).
- Starting a new conversation (clearing chat) resets scope selection.

## UI Components

### 1. Scope Chip Bar (Empty State)

**Location:** Between the "Portfolio Analyst" title/subtitle and the prompt suggestion buttons.

**Behavior:**
- Horizontally centered row of pill-shaped chips.
- Default selection: "All Accounts" (gold background, gold border).
- Unselected chips: transparent background, `#334155` border, `#94a3b8` text.
- Selected chip: `rgba(201,164,78,0.2)` background, `#c9a44e` border, `#c9a44e` text.
- Single-select only — clicking one deselects the previous.

### 2. Scope Badge (Active Conversation)

**Location:** Tab bar row, right-aligned (same row as Overview | Accounts | Tax Lots | ... | Chat tabs).

**Style:** Small gold pill — `padding: 4px 12px`, `border-radius: 12px`, `font-size: 11px`, `background: rgba(201,164,78,0.15)`, `border: 1px solid rgba(201,164,78,0.3)`, `color: #c9a44e`.

**Shows:** The selected scope label (e.g., "All Accounts", "IBKR", "Macro").

### 3. Dynamic Prompt Buttons

Prompt suggestion buttons change based on the selected scope:

**Portfolio scopes** (All, IBKR, Vanguard Taxable, Vanguard Roth IRA):
- "Give me a full portfolio health check"
- "Analyze my sector concentration"
- "Find tax-loss harvesting opportunities"
- "Which factor am I most exposed to right now?"

**Macro scope:**
- "What's moving markets today?"
- "Compare sector performance YTD"
- "Summarize the current yield curve"
- "What are the biggest macro risks right now?"

### 4. Dynamic Subtitle

The subtitle below "Portfolio Analyst" changes when Macro is selected:
- **Portfolio scopes:** "Ask about your portfolio — concentration risk, tax optimization, performance attribution, income analysis, and more."
- **Macro:** "Market & macro analysis — no portfolio data by default."

The persona title "Portfolio Analyst" changes to "Market Analyst" for Macro scope.

## Data Flow

### Request Payload

ChatInterface sends scope in the POST body:
```typescript
// ChatInterface.tsx
const response = await fetch('/api/chat', {
  method: 'POST',
  body: JSON.stringify({ messages, scope }),  // scope: ChatScope
});
```

### API Route Changes (`app/api/chat/route.ts`)

1. Extract `scope` from request body (default: `"all"`).
2. Map scope to account name filter:
   - `"all"` → no filter (current behavior)
   - `"ibkr"` → `"IBKR"`
   - `"vanguard-taxable"` → `"Vanguard Taxable"`
   - `"vanguard-roth-ira"` → `"Vanguard Roth IRA"`
   - `"macro"` → skip portfolio context entirely
3. Pass filter to `getPortfolioSummaryForChat(db, accountName?)`.
4. Pass scope to `buildSystemPrompt(portfolioContext, currentDate, scope)`.

### Portfolio Summary Changes (`lib/queries/portfolio-summary.ts`)

Add optional `accountName` parameter to `getPortfolioSummaryForChat()`:
```typescript
export function getPortfolioSummaryForChat(
  db: Database.Database,
  accountName?: string
): string
```

When `accountName` is provided, add `WHERE account_name = ?` to all SQL queries that currently aggregate across accounts. When omitted, behavior is unchanged (all accounts).

When scope is `"macro"`, this function is not called — the system prompt gets no portfolio context.

### System Prompt Changes (`lib/chat/system-prompt.ts`)

Add scope parameter to `buildSystemPrompt()`:
```typescript
export function buildSystemPrompt(
  staticContext: string,
  currentDate: string,
  scope: ChatScope
): string
```

**Scope preamble** — prepended to system prompt:
- Portfolio scopes: `"You are analyzing [scope label]. All data below is filtered to this scope. If the user asks about accounts outside this scope, tell them to start a new conversation with a different scope."`
- Macro: `"You are in Macro mode — a market and economic analyst. You have no portfolio data loaded by default. Focus on market trends, economic indicators, sector analysis, and macro themes. If the user explicitly asks you to look at their portfolio, you may use the portfolio tools, but don't do so proactively."`

**Persona swap for Macro:** The existing "portfolio analyst" persona text is replaced with a "market analyst" persona.

**First-response instruction:** System prompt includes: `"In your first response, state which scope you're operating in (e.g., 'Analyzing all accounts' or 'Focused on your IBKR account' or 'Macro mode — no portfolio data loaded')."`

### Tool Availability

All 14 existing tools remain available in every scope. For Macro mode, portfolio tools are accessible (the user can explicitly request portfolio data) but Claude won't use them proactively because the system prompt instructs it not to.

For portfolio scopes, tools that support `account_name` filtering will have it pre-filled by the system prompt guidance — Claude will pass the scoped account name when calling tools.

## Files That Change

| File | Change |
|------|--------|
| `app/dashboard/components/ChatInterface.tsx` | Add scope state, chip bar, dynamic prompts/subtitle, badge, pass scope in POST body |
| `app/api/chat/route.ts` | Extract scope, map to account filter, pass to context builder and prompt builder |
| `lib/queries/portfolio-summary.ts` | Add optional `accountName` param, add WHERE clauses |
| `lib/chat/system-prompt.ts` | Add scope param, scope preamble, macro persona variant, first-response instruction |
| `lib/types.ts` | Add `ChatScope` type |

## Design Decisions

1. **Scope locks at conversation start** — prevents confusing mid-conversation context switches where earlier responses used different data.
2. **Real data isolation, not post-hoc filtering** — the system prompt only contains data for the selected scope, so Claude can't accidentally reference out-of-scope holdings.
3. **Macro keeps tools available** — allows the user to explicitly pull in portfolio data when needed, but Claude doesn't do it proactively.
4. **Badge in tab bar** — persistent but unobtrusive; doesn't consume message area space.
5. **No multi-account selection** — keeps UX simple. "All Accounts" covers the multi-account case.

## Out of Scope

- Account grouping / custom scope creation
- Saving scope preference across sessions
- Scope-specific conversation history
- Benchmark comparison in Macro mode
