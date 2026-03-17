# Chat Scope Selector — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add account-scoped filtering and a Macro mode to the Chat tab, so users can focus conversations on a single account or switch to market-only analysis.

**Architecture:** A `ChatScope` type flows from the UI chip bar → POST body → API route, which filters portfolio context and adjusts the system prompt. Scope locks after the first message. All state lives inside `ChatInterface` — no cross-component coordination needed.

**Tech Stack:** React 19 (useState), Next.js App Router API routes, SQLite (better-sqlite3), Anthropic SDK streaming, Vitest

**Spec:** `docs/superpowers/specs/2026-03-17-chat-scope-selector-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/types.ts` | Modify | Add `ChatScope` type and `SCOPE_LABELS` map |
| `lib/chat/tools.ts` | Modify | Export `resolveAccountName()` (currently private) |
| `lib/queries/portfolio-summary.ts` | Modify | Add optional `accountName` param + per-query filtering |
| `lib/chat/system-prompt.ts` | Modify | Add `scope` param, preamble, macro persona, first-response instruction |
| `app/api/chat/route.ts` | Modify | Extract scope, validate, map to account filter, pass to builders |
| `app/dashboard/components/ChatInterface.tsx` | Modify | Scope state, chip bar, badge, dynamic prompts/subtitle, "New Conversation" button |
| `tests/queries/portfolio-summary.test.ts` | Modify | Add account-filtered tests |
| `tests/chat/system-prompt.test.ts` | Create | Test scope preambles and macro persona |
| `tests/api/chat-route.test.ts` | Create | Test scope validation and mapping |

---

## Chunk 1: Data Layer (types, account resolution, portfolio filtering)

### Task 1: Add ChatScope type to lib/types.ts

**Files:**
- Modify: `lib/types.ts:175` (append after last type)

- [ ] **Step 1: Add the ChatScope type and scope label map**

```typescript
// At end of lib/types.ts
export type ChatScope = "all" | "ibkr" | "vanguard-taxable" | "vanguard-roth-ira" | "macro";

export const SCOPE_LABELS: Record<ChatScope, string> = {
  all: "All Accounts",
  ibkr: "IBKR",
  "vanguard-taxable": "Vanguard Taxable",
  "vanguard-roth-ira": "Vanguard Roth IRA",
  macro: "Macro",
};

export const VALID_SCOPES: ChatScope[] = ["all", "ibkr", "vanguard-taxable", "vanguard-roth-ira", "macro"];
```

- [ ] **Step 2: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add lib/types.ts
git commit -m "feat(chat): add ChatScope type and scope label map"
```

---

### Task 2: Export resolveAccountName from tools.ts

**Files:**
- Modify: `lib/chat/tools.ts:450` (change `function` to `export function`)

- [ ] **Step 1: Export the function**

Change line 450 from:
```typescript
function resolveAccountName(
```
to:
```typescript
export function resolveAccountName(
```

- [ ] **Step 2: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add lib/chat/tools.ts
git commit -m "refactor(chat): export resolveAccountName for reuse in route"
```

---

### Task 3: Add account filtering to getPortfolioSummaryForChat

This is the largest task. The function has 8 SQL queries that all need conditional WHERE clauses when `accountName` is provided.

**Files:**
- Modify: `lib/queries/portfolio-summary.ts:59` (function signature + all queries)
- Modify: `tests/queries/portfolio-summary.test.ts` (add filtered tests)

- [ ] **Step 1: Write the failing tests for account-filtered summary**

Add to `tests/queries/portfolio-summary.test.ts`:

```typescript
describe("account-filtered summary", () => {
  const VANGUARD_TAXABLE_ID = 1;
  const ROTH_IRA_ID = 2;
  const IBKR_ID = 3;

  beforeEach(() => {
    // Seed holdings in two different accounts
    const vti = seedSecurity(db, "VTI", "Vanguard Total Market");
    const aapl = seedSecurity(db, "AAPL", "Apple Inc");
    seedHolding(db, VANGUARD_TAXABLE_ID, vti, 100, "2025-01-31");
    seedHolding(db, IBKR_ID, aapl, 50, "2025-01-31");
    seedPrice(db, vti, "2025-01-31", 250);
    seedPrice(db, aapl, "2025-01-31", 200);
    seedSnapshot(db, VANGUARD_TAXABLE_ID, "2025-01-31", 25000);
    seedSnapshot(db, IBKR_ID, "2025-01-31", 10000);
  });

  it("filters to single account when accountName provided", () => {
    const summary = getPortfolioSummaryForChat(db, "IBKR");
    expect(summary).toContain("AAPL");
    expect(summary).not.toContain("VTI");
    // Should only show IBKR account value
    expect(summary).toContain("IBKR");
    expect(summary).not.toContain("Vanguard Taxable");
  });

  it("shows all accounts when no accountName provided", () => {
    const summary = getPortfolioSummaryForChat(db);
    expect(summary).toContain("VTI");
    expect(summary).toContain("AAPL");
    expect(summary).toContain("IBKR");
    expect(summary).toContain("Vanguard Taxable");
  });

  it("computes position weights relative to filtered account total", () => {
    // AAPL is 100% of IBKR, not 100*200/(100*250+50*200) = 28.6% of portfolio
    const summary = getPortfolioSummaryForChat(db, "IBKR");
    expect(summary).toContain("100.0%");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/queries/portfolio-summary.test.ts`
Expected: FAIL — `getPortfolioSummaryForChat` doesn't accept `accountName` param yet

- [ ] **Step 3: Implement account filtering**

Modify `getPortfolioSummaryForChat` in `lib/queries/portfolio-summary.ts`:

1. Change signature to `getPortfolioSummaryForChat(db: Database.Database, accountName?: string): string`
2. At top of function, resolve accountName to accountId:
```typescript
let accountId: number | undefined;
if (accountName) {
  const row = db.prepare("SELECT id FROM accounts WHERE name = ?").get(accountName) as { id: number } | undefined;
  accountId = row?.id;
}
```
3. For the **Account Values** query (line 65-75): add `WHERE a.name = ?` when filtering (or `WHERE 1=1` when not). Use a helper:
```typescript
const accountFilter = accountName ? `WHERE a.name = ?` : `WHERE 1=1`;
const accountParams = accountName ? [accountName] : [];
```
4. For the **Holdings** query (line 92-146): add `AND h.account_id = ?` to both the `portfolio_total` CTE and the main query WHERE clause when `accountId` is set.
5. For the **Asset Allocation** query (line 167-197): add `AND h.account_id = ?` when filtering.
6. For the **Sector Allocation** query (line 209-239): add `AND h.account_id = ?` when filtering.
7. For the **Tax Summary** query (line 259-266): bare `tax_lots` table with no alias — add `AND tax_lots.account_id = ${accountId}` to the existing `WHERE quantity_remaining > 0` clause.
8. For the **Realized Gains** query (line 268-276): bare `tax_lot_sales` with no alias — add `JOIN tax_lots ON tax_lots.id = tax_lot_sales.tax_lot_id` and `WHERE tax_lots.account_id = ${accountId}` when filtering.
9. For the **Harvest Candidates** query (line 285-311): add `AND tl.account_id = ?` when filtering.
10. For the **Approaching LT** query (line 323-351): add `AND tl.account_id = ?` when filtering.
11. For the **Income Summary** query (line 366-375): bare `monthly_snapshots` with no alias — add `AND monthly_snapshots.account_id = ${accountId}` to the existing WHERE clause.
12. For the **Recent Transactions** query (line 389-399): add `AND t.account_id = ?` when filtering.

**Implementation pattern** — use a consistent approach across all queries. Define helpers at the top of the function:

```typescript
// Inside getPortfolioSummaryForChat, after accountId resolution
const holdingsFilter = accountId != null ? `AND h.account_id = ${accountId}` : "";
const taxLotsFilter = accountId != null ? `AND tl.account_id = ${accountId}` : "";
const txnFilter = accountId != null ? `AND t.account_id = ${accountId}` : "";
```

Then interpolate into each SQL template string. This is safe because `accountId` comes from our own DB lookup (integer), not user input.

**Important alias notes** — some queries use bare table names (no alias). Match the actual SQL:
- Tax Summary (line 259): bare `tax_lots` → use `AND tax_lots.account_id = ${accountId}` (no `tl` alias exists here)
- Realized Gains (line 268): bare `tax_lot_sales` → must add a JOIN: `JOIN tax_lots ON tax_lots.id = tax_lot_sales.tax_lot_id` then `AND tax_lots.account_id = ${accountId}`
- Income Summary (line 366): bare `monthly_snapshots` → use `AND monthly_snapshots.account_id = ${accountId}` (no `ms` alias exists here)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/queries/portfolio-summary.test.ts`
Expected: All PASS including new account-filtered tests

- [ ] **Step 5: Commit**

```bash
git add lib/queries/portfolio-summary.ts tests/queries/portfolio-summary.test.ts
git commit -m "feat(chat): add account filtering to getPortfolioSummaryForChat"
```

---

## Chunk 2: System Prompt + API Route

### Task 4: Add scope to buildSystemPrompt

**Files:**
- Modify: `lib/chat/system-prompt.ts:5` (signature + prompt content)
- Create: `tests/chat/system-prompt.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/chat/system-prompt.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "@/lib/chat/system-prompt";

describe("buildSystemPrompt", () => {
  const fakeContext = "## Portfolio Summary\n- Test data";
  const today = "2026-03-17";

  it("includes scope preamble for 'all'", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "all");
    expect(prompt).toContain("All Accounts");
    expect(prompt).toContain("filtered to this scope");
  });

  it("includes scope preamble for single account", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "ibkr");
    expect(prompt).toContain("IBKR");
    expect(prompt).toContain("filtered to this scope");
  });

  it("uses macro persona when scope is macro", () => {
    const prompt = buildSystemPrompt("", today, "macro");
    expect(prompt).toContain("Macro mode");
    expect(prompt).toContain("market and economic analyst");
    // Should NOT contain portfolio analyst identity
    expect(prompt).not.toContain("portfolio analyst for a personal investment dashboard");
  });

  it("includes first-response instruction", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "all");
    expect(prompt).toContain("first response");
    expect(prompt).toContain("scope");
  });

  it("includes portfolio context for non-macro scopes", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "ibkr");
    expect(prompt).toContain(fakeContext);
  });

  it("has no portfolio context section for macro", () => {
    const prompt = buildSystemPrompt("", today, "macro");
    // Macro still gets the prompt, just without portfolio data
    expect(prompt).toContain("market");
  });

  // Backwards compat: if scope is omitted (undefined), treat as "all"
  it("defaults to 'all' when scope is undefined", () => {
    const prompt = buildSystemPrompt(fakeContext, today, undefined as any);
    expect(prompt).toContain("All Accounts");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/chat/system-prompt.test.ts`
Expected: FAIL — `buildSystemPrompt` doesn't accept 3rd param

- [ ] **Step 3: Implement scope-aware system prompt**

Modify `lib/chat/system-prompt.ts`:

1. Import `ChatScope` and `SCOPE_LABELS` from `@/lib/types`.
2. Change signature: `buildSystemPrompt(staticContext: string, currentDate: string, scope?: ChatScope): string`
3. Default `scope` to `"all"` if undefined.
4. Add scope preamble at the top of the prompt (before the persona paragraph).
5. For macro scope, replace the "portfolio analyst" opening paragraph with a "market analyst" variant and skip the `## Portfolio Context` section at the bottom.
6. Add first-response instruction to `## Communication Style` section.

Scope preamble (inserted as first paragraph):
```
For portfolio scopes:
"[SCOPE] You are analyzing ${SCOPE_LABELS[scope]}. All data below is filtered to this scope. If the user asks about accounts outside this scope, tell them to start a new conversation with a different scope."

For macro:
"[SCOPE] You are in Macro mode — a market and economic analyst. You have no portfolio data loaded by default. Focus on market trends, economic indicators, sector analysis, and macro themes. If the user explicitly asks you to look at their portfolio, you may use the portfolio tools, but don't do so proactively."
```

First-response instruction (add to Communication Style section):
```
"- In your first response, state which scope you're operating in (e.g., 'Analyzing all accounts' or 'Focused on your IBKR account' or 'Macro mode — no portfolio data loaded')"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/chat/system-prompt.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/chat/system-prompt.ts tests/chat/system-prompt.test.ts
git commit -m "feat(chat): add scope-aware system prompt with macro persona"
```

---

### Task 5: Add scope handling to the API route

**Files:**
- Modify: `app/api/chat/route.ts:11-35` (extract scope, validate, map, pass)

- [ ] **Step 1: Implement scope extraction and validation**

Modify `app/api/chat/route.ts`:

1. Add imports:
```typescript
import { VALID_SCOPES, type ChatScope, SCOPE_LABELS } from "@/lib/types";
import { resolveAccountName } from "@/lib/chat/tools";
```

2. Change line 13 to extract scope:
```typescript
const { messages, scope: rawScope } = await request.json();
```

3. After messages validation (line 20), add scope validation. Per spec, explicitly provided but invalid scopes should return 400; missing/undefined scope defaults to `"all"`:
```typescript
// Validate scope — missing defaults to "all", invalid returns 400
let scope: ChatScope = "all";
if (rawScope !== undefined && rawScope !== null) {
  if (!VALID_SCOPES.includes(rawScope)) {
    return new Response(
      JSON.stringify({ error: `Invalid scope: ${rawScope}. Valid: ${VALID_SCOPES.join(", ")}` }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  scope = rawScope;
}
```

4. Replace lines 32-35 (portfolio context building) with scope-aware logic:
```typescript
// Build portfolio context filtered to scope
let portfolioContext = "";
if (scope !== "macro") {
  const scopeToAccountHint: Record<string, string> = {
    ibkr: "IBKR",
    "vanguard-taxable": "Vanguard Taxable",
    "vanguard-roth-ira": "Vanguard Roth IRA",
  };
  const accountHint = scopeToAccountHint[scope];
  const accountName = accountHint ? resolveAccountName(db, accountHint) : undefined;
  portfolioContext = getPortfolioSummaryForChat(db, accountName);
}
const currentDate = new Date().toISOString().slice(0, 10);
const systemPrompt = buildSystemPrompt(portfolioContext, currentDate, scope);
```

- [ ] **Step 2: Run existing tests to verify no regressions**

Run: `npx vitest run`
Expected: All existing tests PASS (the route change is backwards-compatible — missing `scope` defaults to `"all"`)

- [ ] **Step 3: Commit**

```bash
git add app/api/chat/route.ts
git commit -m "feat(chat): add scope extraction and account filtering to chat route"
```

---

## Chunk 3: UI Components (ChatInterface)

### Task 6: Add scope state, chip bar, dynamic content, badge, and "New Conversation" button

**Files:**
- Modify: `app/dashboard/components/ChatInterface.tsx`

- [ ] **Step 1: Add imports and scope config constants**

At top of file, add imports and config:

```typescript
import type { ChatScope } from "@/lib/types";

// Scope configuration — labels, prompts, and personas
const SCOPE_OPTIONS: { value: ChatScope; label: string }[] = [
  { value: "all", label: "All Accounts" },
  { value: "ibkr", label: "IBKR" },
  { value: "vanguard-taxable", label: "Vanguard Taxable" },
  { value: "vanguard-roth-ira", label: "Vanguard Roth IRA" },
  { value: "macro", label: "Macro" },
];

const SCOPE_SUBTITLES: Record<ChatScope, string> = {
  all: "Ask about your portfolio — concentration risk, tax optimization, performance attribution, income analysis, and more.",
  ibkr: "Analyzing your IBKR trading account.",
  "vanguard-taxable": "Analyzing your Vanguard taxable account.",
  "vanguard-roth-ira": "Analyzing your Vanguard Roth IRA.",
  macro: "Market & macro analysis — no portfolio data by default.",
};

const PORTFOLIO_SUGGESTIONS = [
  "Give me a full portfolio health check",
  "Analyze my sector concentration",
  "Find tax-loss harvesting opportunities",
  "Which factor am I most exposed to right now?",
];

const MACRO_SUGGESTIONS = [
  "What's moving markets today?",
  "Compare sector performance YTD",
  "Summarize the current yield curve",
  "What are the biggest macro risks right now?",
];
```

Remove the old `SUGGESTIONS` constant (lines 22-27).

- [ ] **Step 2: Add scope state and derive config**

Inside `ChatInterface()`, after existing `useState` declarations, add:

```typescript
const [scope, setScope] = useState<ChatScope>("all");
const isLocked = messages.length > 0;
const suggestions = scope === "macro" ? MACRO_SUGGESTIONS : PORTFOLIO_SUGGESTIONS;
const scopeLabel = SCOPE_OPTIONS.find((s) => s.value === scope)?.label ?? "All Accounts";
```

- [ ] **Step 3: Pass scope in the POST body**

Modify the `fetch` call (line 62) to include scope:

```typescript
body: JSON.stringify({ messages: newMessages, scope }),
```

- [ ] **Step 4: Add "New Conversation" handler**

After `handleKeyDown`:

```typescript
function handleNewConversation() {
  setMessages([]);
  setScope("all");
  setInput("");
  setError(null);
  setToolStatus(null);
}
```

- [ ] **Step 5: Add scope badge + "New Conversation" header (active conversation)**

Inside the messages area `<div>`, before the `messages.map(...)` block, add:

```tsx
{/* Scope badge header (shown when conversation is active) */}
{isLocked && (
  <div className="flex items-center justify-between pb-3 mb-3 border-b border-edge">
    <span
      className="px-3 py-1 rounded-full text-[11px] border"
      style={{
        background: "rgba(201,164,78,0.15)",
        borderColor: "rgba(201,164,78,0.3)",
        color: "#c9a44e",
      }}
    >
      {scopeLabel}
    </span>
    <button
      onClick={handleNewConversation}
      className="text-xs text-ink-faint hover:text-ink-dim transition-colors"
    >
      New Conversation
    </button>
  </div>
)}
```

- [ ] **Step 6: Modify the empty state to include scope chips and dynamic content**

Replace the existing empty state block (`messages.length === 0 && (...)`, lines 149-174) with:

```tsx
{messages.length === 0 && (
  <div className="flex items-center justify-center h-full">
    <div className="text-center max-w-md">
      <div className="text-3xl text-ink-faint mb-4 font-serif italic">Analyst</div>
      <h3 className="text-ink font-medium mb-2">
        {scope === "macro" ? "Market Analyst" : "Portfolio Analyst"}
      </h3>
      <p className="text-ink-dim text-sm mb-6">
        {SCOPE_SUBTITLES[scope]}
      </p>

      {/* Scope chip bar */}
      <div className="flex flex-wrap justify-center gap-2 mb-6">
        {SCOPE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setScope(opt.value)}
            className={`px-4 py-1.5 rounded-full text-xs border transition-all ${
              scope === opt.value
                ? "border-gold text-gold"
                : "border-edge text-ink-dim hover:text-ink hover:border-edge-strong"
            }`}
            style={
              scope === opt.value
                ? { background: "rgba(201,164,78,0.2)", borderColor: "#c9a44e", color: "#c9a44e" }
                : undefined
            }
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Dynamic prompt suggestions */}
      <div className="flex flex-wrap justify-center gap-2">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            onClick={() => {
              setInput(suggestion);
              inputRef.current?.focus();
            }}
            className="px-3 py-1.5 rounded-lg border border-edge text-xs text-ink-dim hover:text-ink hover:border-edge-strong transition-all"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 7: Update placeholder text based on scope**

Change the textarea `placeholder` (line 230) from hardcoded to dynamic:

```tsx
placeholder={scope === "macro" ? "Ask about markets and macro..." : "Ask your portfolio analyst..."}
```

- [ ] **Step 8: Verify in browser**

Run: `npm run dev` (dev server on port 3099)

1. Navigate to Chat tab — should see scope chips between title and prompt buttons
2. Click "IBKR" — chip should highlight gold, prompts stay same (portfolio set)
3. Click "Macro" — persona title changes to "Market Analyst", subtitle changes, prompts change to macro set
4. Click "All Accounts" to go back — everything resets
5. Type a message and send — chips disappear, scope badge appears at top with "New Conversation" button
6. Click "New Conversation" — returns to empty state with chips

- [ ] **Step 9: Commit**

```bash
git add app/dashboard/components/ChatInterface.tsx
git commit -m "feat(chat): add scope selector UI with chip bar, badge, and dynamic content"
```

---

### Task 7: End-to-end verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Verify build compiles**

Run: `npx next build`
Expected: Build succeeds with no errors

- [ ] **Step 3: Test scope filtering end-to-end in browser**

On the running dev server (port 3099):

1. **All Accounts scope**: Send "Give me a full portfolio health check" — response should mention all three accounts and state "Analyzing all accounts" at the start
2. **IBKR scope**: New conversation → select IBKR → send "What are my biggest positions?" — should only show IBKR holdings, response should state "Focused on your IBKR account"
3. **Macro scope**: New conversation → select Macro → send "What's moving markets today?" — should NOT reference any portfolio data, should state "Macro mode"
4. **Scope locking**: After sending a message, verify chips are gone and badge shows. Verify "New Conversation" resets to empty state with chips.

- [ ] **Step 4: Commit any fixes from e2e testing**

If fixes needed, commit them separately with descriptive messages.

- [ ] **Step 5: Final commit with all changes**

If no additional fixes needed, this step is a no-op. All tasks are individually committed.
