# Mobile Chat Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add conversation persistence, page-aware context, and quick-action chips to the chat, making it the primary mobile experience.

**Architecture:** New `chat_conversations` + `chat_messages` SQLite tables store history. The chat API route loads prior messages from DB and saves new ones after each exchange. A `getPageContext()` function maps the current pathname to a context string injected into the system prompt. Quick-action chips render above the input based on page context.

**Tech Stack:** SQLite (better-sqlite3), AI SDK v6 (`useChat`, `streamText`), Next.js App Router, React

**Spec:** `docs/superpowers/specs/2026-04-14-mobile-chat-enhancements-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/db/migrations/025_chat_history.sql` | Create | Tables for conversations + messages |
| `lib/queries/chat.ts` | Create | Read conversations + messages |
| `lib/mutations/chat.ts` | Create | Create/update conversations, save messages |
| `lib/chat/page-context.ts` | Create | Map pathname to context string for system prompt |
| `lib/chat/quick-actions.ts` | Create | Map pathname to prompt chip definitions |
| `app/api/chat/route.ts` | Modify | Load history, save messages, inject page context |
| `app/api/chat/conversations/route.ts` | Create | GET list / POST create conversation |
| `app/api/chat/conversations/[id]/messages/route.ts` | Create | GET messages for a conversation |
| `app/dashboard/components/ChatInterface.tsx` | Modify | Conversation loading, new-chat, history picker, chips |
| `app/dashboard/components/ChatDrawer.tsx` | Modify | Pass pathname to ChatInterface |
| `app/dashboard/components/QuickActionChips.tsx` | Create | Horizontally scrollable chip row |
| `tests/chat/chat-history.test.ts` | Create | DB persistence tests |
| `tests/chat/page-context.test.ts` | Create | Page context mapping tests |
| `tests/chat/quick-actions.test.ts` | Create | Quick action chip tests |

---

### Task 1: Database Migration

**Files:**
- Create: `lib/db/migrations/025_chat_history.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Chat conversation history
CREATE TABLE chat_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  scope TEXT NOT NULL DEFAULT 'all',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT,
  parts TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chat_messages_conv ON chat_messages(conversation_id, created_at);
CREATE INDEX idx_chat_conversations_updated ON chat_conversations(updated_at DESC);
```

- [ ] **Step 2: Verify migration applies**

Run: `npx vitest run tests/db` (migrations auto-apply in test DBs)

- [ ] **Step 3: Commit**

```
feat: add chat_conversations + chat_messages tables (migration 025)
```

---

### Task 2: Database Query and Mutation Functions

**Files:**
- Create: `lib/queries/chat.ts`
- Create: `lib/mutations/chat.ts`
- Create: `tests/chat/chat-history.test.ts`

- [ ] **Step 1: Write failing tests for conversation CRUD**

```typescript
// tests/chat/chat-history.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getRecentConversations, getConversationMessages } from "@/lib/queries/chat";
import { createConversation, saveMessage, updateConversationTitle } from "@/lib/mutations/chat";

describe("chat history", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  describe("createConversation", () => {
    it("creates a conversation with scope", () => {
      const id = createConversation(db, "all");
      expect(id).toBeGreaterThan(0);
      const convos = getRecentConversations(db, 10);
      expect(convos).toHaveLength(1);
      expect(convos[0].scope).toBe("all");
      expect(convos[0].title).toBeNull();
    });
  });

  describe("saveMessage + getConversationMessages", () => {
    it("saves and retrieves messages in order", () => {
      const convId = createConversation(db, "all");
      saveMessage(db, convId, "user", "What is my portfolio value?", null);
      saveMessage(db, convId, "assistant", "Your portfolio is worth $1.8M.", null);

      const messages = getConversationMessages(db, convId);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("What is my portfolio value?");
      expect(messages[1].role).toBe("assistant");
    });
  });

  describe("saveMessage with parts", () => {
    it("stores and retrieves JSON parts", () => {
      const convId = createConversation(db, "all");
      const parts = JSON.stringify([
        { type: "text", text: "Let me check." },
        { type: "tool-query_holdings", state: "output-available" }
      ]);
      saveMessage(db, convId, "assistant", "Let me check.", parts);

      const messages = getConversationMessages(db, convId);
      expect(messages[0].parts).toBe(parts);
    });
  });

  describe("updateConversationTitle", () => {
    it("updates title and updated_at", () => {
      const id = createConversation(db, "ibkr");
      updateConversationTitle(db, id, "Portfolio overview");
      const convos = getRecentConversations(db, 10);
      expect(convos[0].title).toBe("Portfolio overview");
    });
  });

  describe("getRecentConversations", () => {
    it("returns conversations ordered by updated_at desc", () => {
      const id1 = createConversation(db, "all");
      const id2 = createConversation(db, "ibkr");
      saveMessage(db, id1, "user", "hello", null);
      updateConversationTitle(db, id1, "First");
      updateConversationTitle(db, id2, "Second");

      const convos = getRecentConversations(db, 10);
      expect(convos).toHaveLength(2);
      expect(convos[0].title).toBe("First");
    });

    it("respects limit", () => {
      createConversation(db, "all");
      createConversation(db, "all");
      createConversation(db, "all");
      const convos = getRecentConversations(db, 2);
      expect(convos).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/chat/chat-history.test.ts`
Expected: FAIL (modules don't exist yet)

- [ ] **Step 3: Write query functions**

```typescript
// lib/queries/chat.ts
import type Database from "better-sqlite3";

export interface ChatConversation {
  id: number;
  title: string | null;
  scope: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface ChatMessage {
  id: number;
  conversation_id: number;
  role: string;
  content: string | null;
  parts: string | null;
  created_at: string;
}

export function getRecentConversations(
  db: Database.Database,
  limit: number = 20,
): ChatConversation[] {
  return db
    .prepare(
      `SELECT c.*, COUNT(m.id) as message_count
       FROM chat_conversations c
       LEFT JOIN chat_messages m ON m.conversation_id = c.id
       GROUP BY c.id
       ORDER BY c.updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as ChatConversation[];
}

export function getConversationMessages(
  db: Database.Database,
  conversationId: number,
): ChatMessage[] {
  return db
    .prepare(
      `SELECT * FROM chat_messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC`,
    )
    .all(conversationId) as ChatMessage[];
}
```

- [ ] **Step 4: Write mutation functions**

```typescript
// lib/mutations/chat.ts
import type Database from "better-sqlite3";

export function createConversation(
  db: Database.Database,
  scope: string,
): number {
  const result = db
    .prepare(`INSERT INTO chat_conversations (scope) VALUES (?)`)
    .run(scope);
  return result.lastInsertRowid as number;
}

export function saveMessage(
  db: Database.Database,
  conversationId: number,
  role: string,
  content: string | null,
  parts: string | null,
): number {
  const result = db
    .prepare(
      `INSERT INTO chat_messages (conversation_id, role, content, parts)
       VALUES (?, ?, ?, ?)`,
    )
    .run(conversationId, role, content, parts);
  db.prepare(
    `UPDATE chat_conversations SET updated_at = datetime('now') WHERE id = ?`,
  ).run(conversationId);
  return result.lastInsertRowid as number;
}

export function updateConversationTitle(
  db: Database.Database,
  conversationId: number,
  title: string,
): void {
  db.prepare(
    `UPDATE chat_conversations SET title = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(title, conversationId);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/chat/chat-history.test.ts`
Expected: ALL PASS (6 tests)

- [ ] **Step 6: Commit**

```
feat: chat history query and mutation functions
```

---

### Task 3: Page Context Mapper

**Files:**
- Create: `lib/chat/page-context.ts`
- Create: `tests/chat/page-context.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/chat/page-context.test.ts
import { describe, it, expect } from "vitest";
import { getPageContext } from "@/lib/chat/page-context";

describe("getPageContext", () => {
  it("returns generic context for overview", () => {
    expect(getPageContext("/dashboard")).toBe("User is on the Overview page.");
  });

  it("returns security context with symbol", () => {
    const ctx = getPageContext("/dashboard/security/42", {
      symbol: "AAPL", name: "Apple Inc.", type: "Stock",
    });
    expect(ctx).toContain("AAPL");
    expect(ctx).toContain("Apple Inc.");
    expect(ctx).toContain("Stock");
  });

  it("returns calendar context with weekOf", () => {
    const ctx = getPageContext("/dashboard/calendar", { weekOf: "2026-04-14" });
    expect(ctx).toContain("Calendar");
    expect(ctx).toContain("2026-04-14");
  });

  it("returns research context", () => {
    expect(getPageContext("/dashboard/research")).toContain("Research");
  });

  it("returns analysis context with scope", () => {
    const ctx = getPageContext("/dashboard/analysis", { accountScope: "IBKR" });
    expect(ctx).toContain("Analysis");
    expect(ctx).toContain("IBKR");
  });

  it("returns generic context for import", () => {
    expect(getPageContext("/dashboard/import")).toBe("User is on the Import page.");
  });

  it("handles unknown paths gracefully", () => {
    expect(getPageContext("/dashboard/something-new")).toBe(
      "User is browsing the dashboard.",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/chat/page-context.test.ts`

- [ ] **Step 3: Implement page context mapper**

```typescript
// lib/chat/page-context.ts

export interface PageContextData {
  symbol?: string;
  name?: string;
  type?: string;
  weekOf?: string;
  accountScope?: string;
  sourceFilter?: string;
}

export function getPageContext(
  pathname: string,
  data?: PageContextData,
): string {
  if (pathname.match(/^\/dashboard\/security\/\d+/)) {
    if (data?.symbol) {
      const parts = [
        `User is viewing the Security Detail page for ${data.symbol}`,
      ];
      if (data.name) parts[0] += ` (${data.name})`;
      if (data.type) parts.push(`Security type: ${data.type}.`);
      return parts.join(". ") + ".";
    }
    return "User is viewing a Security Detail page.";
  }

  if (pathname.startsWith("/dashboard/calendar")) {
    if (data?.weekOf)
      return `User is viewing the Calendar for the week of ${data.weekOf}.`;
    return "User is on the Calendar page.";
  }

  if (pathname.startsWith("/dashboard/research")) {
    if (data?.sourceFilter)
      return `User is on the Research page, filtered to ${data.sourceFilter}.`;
    return "User is on the Research page.";
  }

  if (pathname.startsWith("/dashboard/analysis")) {
    if (data?.accountScope)
      return `User is on the Analysis page, scoped to ${data.accountScope}.`;
    return "User is on the Analysis page.";
  }

  const simplePages: Record<string, string> = {
    "/dashboard": "User is on the Overview page.",
    "/dashboard/accounts": "User is on the Accounts page.",
    "/dashboard/holdings": "User is on the Holdings page.",
    "/dashboard/charts": "User is on the Charts page.",
    "/dashboard/import": "User is on the Import page.",
    "/dashboard/data-health": "User is on the Data Health page.",
  };

  return simplePages[pathname] ?? "User is browsing the dashboard.";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/chat/page-context.test.ts`
Expected: ALL PASS (7 tests)

- [ ] **Step 5: Commit**

```
feat: page context mapper for chat system prompt
```

---

### Task 4: Quick-Action Chip Definitions

**Files:**
- Create: `lib/chat/quick-actions.ts`
- Create: `tests/chat/quick-actions.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/chat/quick-actions.test.ts
import { describe, it, expect } from "vitest";
import { getQuickActions } from "@/lib/chat/quick-actions";

describe("getQuickActions", () => {
  it("returns global actions for overview", () => {
    const actions = getQuickActions("/dashboard");
    expect(actions.length).toBeGreaterThanOrEqual(3);
    expect(actions.some((a) => a.label.includes("portfolio"))).toBe(true);
  });

  it("returns security-specific actions", () => {
    const actions = getQuickActions("/dashboard/security/42", {
      symbol: "AAPL",
    });
    expect(actions.some((a) => a.label.includes("AAPL"))).toBe(true);
  });

  it("returns calendar-specific actions", () => {
    const actions = getQuickActions("/dashboard/calendar");
    expect(actions.some((a) => a.prompt.toLowerCase().includes("week"))).toBe(
      true,
    );
  });

  it("returns analysis-specific actions", () => {
    const actions = getQuickActions("/dashboard/analysis");
    expect(actions.some((a) => a.prompt.toLowerCase().includes("risk"))).toBe(
      true,
    );
  });

  it("always includes some global actions", () => {
    const actions = getQuickActions("/dashboard/security/42", {
      symbol: "AAPL",
    });
    expect(actions.length).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement quick actions**

```typescript
// lib/chat/quick-actions.ts
import type { PageContextData } from "./page-context";

export interface QuickAction {
  label: string;
  prompt: string;
}

const GLOBAL_ACTIONS: QuickAction[] = [
  { label: "Portfolio today", prompt: "How's my portfolio doing today?" },
  { label: "This week's events", prompt: "What's happening this week?" },
  { label: "Biggest movers", prompt: "Show my biggest movers recently." },
];

export function getQuickActions(
  pathname: string,
  data?: PageContextData,
): QuickAction[] {
  const pageActions: QuickAction[] = [];

  if (pathname.match(/^\/dashboard\/security\/\d+/) && data?.symbol) {
    pageActions.push(
      { label: `${data.symbol} outlook`, prompt: `What's the outlook for ${data.symbol}?` },
      { label: `${data.symbol} positions`, prompt: `Show my positions in ${data.symbol}.` },
      { label: `${data.symbol} news`, prompt: `Any recent news or earnings for ${data.symbol}?` },
    );
  }

  if (pathname.startsWith("/dashboard/calendar")) {
    pageActions.push(
      { label: "Week summary", prompt: "Summarize this week's events and what I should watch for." },
      { label: "Earnings impact", prompt: "Which upcoming earnings could affect my portfolio?" },
    );
  }

  if (pathname.startsWith("/dashboard/research")) {
    pageActions.push(
      { label: "Key takeaways", prompt: "What are the key takeaways from recent research articles?" },
      { label: "Actionable signals", prompt: "Any actionable signals from the latest newsletters?" },
    );
  }

  if (pathname.startsWith("/dashboard/analysis")) {
    pageActions.push(
      { label: "Risk concentration", prompt: "Where is my risk concentrated?" },
      { label: "Portfolio positioning", prompt: "How am I positioned across sectors and asset classes?" },
    );
  }

  if (pageActions.length > 0) {
    const remaining = 5 - pageActions.length;
    return [...pageActions, ...GLOBAL_ACTIONS.slice(0, Math.max(0, remaining))];
  }

  return GLOBAL_ACTIONS;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/chat/quick-actions.test.ts`
Expected: ALL PASS (5 tests)

- [ ] **Step 5: Commit**

```
feat: quick-action chip definitions for chat
```

---

### Task 5: API Routes — Conversations + Chat Route Modifications

**Files:**
- Create: `app/api/chat/conversations/route.ts`
- Create: `app/api/chat/conversations/[id]/messages/route.ts`
- Modify: `app/api/chat/route.ts`

- [ ] **Step 1: Create conversation list/create endpoint**

```typescript
// app/api/chat/conversations/route.ts
import { db } from "@/lib/db";
import { getRecentConversations } from "@/lib/queries/chat";
import { createConversation } from "@/lib/mutations/chat";

export async function GET() {
  const conversations = getRecentConversations(db, 20);
  return Response.json({ conversations });
}

export async function POST(req: Request) {
  const { scope = "all" } = await req.json();
  const id = createConversation(db, scope);
  return Response.json({ id });
}
```

- [ ] **Step 2: Create messages endpoint**

```typescript
// app/api/chat/conversations/[id]/messages/route.ts
import { db } from "@/lib/db";
import { getConversationMessages } from "@/lib/queries/chat";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const messages = getConversationMessages(db, Number(id));
  return Response.json({ messages });
}
```

- [ ] **Step 3: Modify chat route for persistence and page context**

In `app/api/chat/route.ts`, make these changes:

**Add imports:**
```typescript
import { createConversation, saveMessage, updateConversationTitle } from "@/lib/mutations/chat";
```

**Update POST handler to extract new fields from body:**
```typescript
const { messages, scope: rawScope, conversationId: rawConvId, pageContext } = await req.json();
```

**After scope validation, resolve or create conversation:**
```typescript
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
```

**Inject page context into system prompt** (after `buildSystemPrompt()`):
```typescript
let systemPromptText = buildSystemPrompt(staticContext, today, scope);
if (pageContext) {
  systemPromptText += `\n\n[Current Page Context]\n${pageContext}`;
}
```

**Add `onFinish` callback to `streamText` for assistant message persistence:**
```typescript
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
```

**Return conversationId in response headers:**
```typescript
return result.toUIMessageStreamResponse({
  sendReasoning: true,
  headers: { "X-Conversation-Id": String(conversationId) },
});
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```
feat: chat API persistence + conversation endpoints + page context injection
```

---

### Task 6: ChatDrawer — Pass Pathname

**Files:**
- Modify: `app/dashboard/components/ChatDrawer.tsx`

- [ ] **Step 1: Import usePathname and pass to ChatInterface**

Add `usePathname` import, get pathname, pass as prop:
```typescript
import { usePathname } from "next/navigation";
// Inside component:
const pathname = usePathname();
// In JSX:
<ChatInterface pathname={pathname} />
```

- [ ] **Step 2: Commit**

```
feat: pass current pathname from ChatDrawer to ChatInterface
```

---

### Task 7: QuickActionChips Component

**Files:**
- Create: `app/dashboard/components/QuickActionChips.tsx`

- [ ] **Step 1: Create the component**

```tsx
"use client";

import type { QuickAction } from "@/lib/chat/quick-actions";

interface Props {
  actions: QuickAction[];
  onSelect: (prompt: string) => void;
}

export function QuickActionChips({ actions, onSelect }: Props) {
  if (actions.length === 0) return null;
  return (
    <div className="flex gap-2 overflow-x-auto pb-2 px-1 -mx-1 scrollbar-none">
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={() => onSelect(action.prompt)}
          className="shrink-0 px-3 py-2 rounded-xl border border-edge bg-panel text-sm text-ink-dim hover:text-ink hover:border-edge-strong transition-colors"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```
feat: QuickActionChips component
```

---

### Task 8: ChatInterface — Full Integration

This is the largest task. Modify `ChatInterface.tsx` to load/save conversations, show history picker, inject page context into transport, and render quick-action chips.

**Files:**
- Modify: `app/dashboard/components/ChatInterface.tsx`

- [ ] **Step 1: Add pathname prop and new imports**

```typescript
interface ChatInterfaceProps {
  pathname?: string;
}

import { getPageContext } from "@/lib/chat/page-context";
import { getQuickActions } from "@/lib/chat/quick-actions";
import { QuickActionChips } from "./QuickActionChips";
```

- [ ] **Step 2: Add conversation state variables**

```typescript
const [conversationId, setConversationId] = useState<number | null>(null);
const [conversations, setConversations] = useState<Array<{
  id: number; title: string | null; scope: string; message_count: number;
}>>([]);
const [showHistory, setShowHistory] = useState(false);
```

- [ ] **Step 3: Load most recent conversation on mount**

```typescript
useEffect(() => {
  fetch("/api/chat/conversations")
    .then((r) => r.json())
    .then((data) => {
      if (data.conversations?.length > 0) {
        setConversations(data.conversations);
        const latest = data.conversations[0];
        setConversationId(latest.id);
        setScope(latest.scope as ChatScope);
        return fetch(`/api/chat/conversations/${latest.id}/messages`);
      }
    })
    .then((r) => r?.json())
    .then((data) => {
      if (data?.messages?.length > 0) {
        const uiMessages = data.messages.map((m: any) => ({
          id: String(m.id),
          role: m.role as "user" | "assistant",
          parts: m.parts
            ? JSON.parse(m.parts)
            : [{ type: "text" as const, text: m.content ?? "" }],
        }));
        setMessages(uiMessages);
      }
    })
    .catch(() => {});
}, []);
```

- [ ] **Step 4: Update transport with conversationId and pageContext**

```typescript
const pageContext = pathname ? getPageContext(pathname) : undefined;

const transport = useMemo(
  () => new DefaultChatTransport({
    api: "/api/chat",
    body: { scope, conversationId, pageContext },
  }),
  [scope, conversationId, pageContext],
);
```

- [ ] **Step 5: Capture conversationId from streaming response**

The AI SDK v6 `useChat` uses transport, so we need to extract the header from the response. Add response header handling — check if `useChat` provides `onResponse` or if we need to intercept via a custom transport wrapper. If `onResponse` is not available in v6, wrap the transport's `send` method to capture the response header and call `setConversationId`.

- [ ] **Step 6: Update "New Conversation" handler**

```typescript
const handleNewConversation = useCallback(() => {
  setMessages([]);
  setScope("all");
  setConversationId(null);
  setInputText("");
  setShowHistory(false);
  fetch("/api/chat/conversations")
    .then((r) => r.json())
    .then((data) => setConversations(data.conversations ?? []));
}, [setMessages]);
```

- [ ] **Step 7: Add conversation history dropdown in header area**

Replace the current "New Conversation" button area with a dropdown showing recent conversations:
- Current conversation title (or scope label) as the trigger
- Dropdown lists recent 20 conversations with title + message count
- Clicking a conversation loads its messages via fetch
- "+ New" button at the top right

- [ ] **Step 8: Replace hardcoded suggestion buttons with QuickActionChips**

In the empty state (messages.length === 0), replace the existing 4 hardcoded suggestions with:
```tsx
<QuickActionChips
  actions={getQuickActions(pathname ?? "/dashboard")}
  onSelect={(prompt) => sendMessage({ text: prompt })}
/>
```

Keep the scope selector above the chips.

- [ ] **Step 9: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS (790+ tests)

- [ ] **Step 10: Commit**

```
feat: chat persistence, page context, and quick-action chips in ChatInterface
```

---

### Task 9: End-to-End Verification

- [ ] **Step 1: Rebuild Electron app**

Run: `npm run electron:pack`

- [ ] **Step 2: Test on desktop**

Verify:
- Open chat -> empty state with quick-action chips
- Send a message -> conversation persisted
- Close and reopen chat -> conversation restored with full history
- Click "+ New" -> fresh conversation, old one in dropdown
- Switch conversations via dropdown
- Navigate to security page -> open chat -> security-specific chips
- Navigate to calendar -> open chat -> calendar-specific chips

- [ ] **Step 3: Test on iPhone via Tailscale**

At `http://100.88.9.46:3099/dashboard`:
- Tap chat (gold button) -> full-screen with chips
- Tap a chip -> sends prompt, response streams in
- Background the app, reopen -> conversation still there
- Navigate to a security page -> open chat -> see security-specific chips

- [ ] **Step 4: Commit any fixes from testing**

```
fix: chat enhancement adjustments from E2E testing
```
