# Mobile Chat Enhancements — Design Spec

> Date: 2026-04-14
> Status: Approved

## Problem

The chat is the primary mobile use case — it's what differentiates this app from just using the Claude app directly. But currently: conversations reset when the app is backgrounded, the AI has no awareness of what page the user is viewing, and typing on a phone is slow with no shortcuts. These gaps make the mobile chat experience feel disposable rather than integrated.

## Features

### 1. Conversation History (Persistence)

**Data model:**

```sql
CREATE TABLE chat_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,              -- Auto-generated after first exchange
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id),
  role TEXT NOT NULL,      -- 'user', 'assistant', 'tool'
  content TEXT,            -- Text content
  parts TEXT,              -- JSON: tool calls, tool results, reasoning
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chat_messages_conv ON chat_messages(conversation_id, created_at);
```

**Behavior:**
- Opening chat loads the most recent conversation with full message history
- Messages are persisted as they complete (user on send, assistant on stream end)
- "New conversation" button in chat header starts a fresh conversation
- Auto-title: after the first assistant response, a short title is generated
- Recent conversations accessible via a dropdown/menu (last 20)
- Old conversations are read-only history; active conversation is always the most recent

**API changes:**
- `POST /api/chat` accepts optional `conversationId` in request body
- Server loads prior messages from DB to populate AI context
- New endpoints:
  - `GET /api/chat/conversations` — list recent conversations
  - `POST /api/chat/conversations` — create new conversation
  - `GET /api/chat/conversations/[id]/messages` — load messages for a conversation

### 2. Page Context Injection ("Aware, not assuming")

**Principle:** The AI knows what page the user is on, but doesn't force the topic. It's peripheral awareness — disambiguation for vague pronouns ("this", "here", "it"), not a conversation starter.

**Implementation:**
- `ChatDrawer` receives current pathname from `usePathname()`
- A `getPageContext(pathname, searchParams)` function maps routes to context strings:
  - `/dashboard` → `"User is on the Overview page"`
  - `/dashboard/security/42` → `"User is viewing security detail for AAPL (id: 42, Stock, last price: $198.50)"`
  - `/dashboard/calendar?weekOf=2026-04-14` → `"User is viewing Calendar for week of April 14, 2026"`
  - `/dashboard/research` → `"User is on the Research page"` (+ source filter if active)
  - `/dashboard/analysis` → `"User is on the Analysis page"` (+ account scope if set)
- Context is appended to the system prompt as a `[Current Page Context]` section
- Context updates live as user navigates (even while chat is open)

**Where context is most useful:**
- Security Detail → symbol, price, positions, type
- Calendar → current week, event count
- Research/Feeds → active source filter
- Analysis → account scope, dimension

**Where it's minimal:**
- Overview, Import, Charts, Holdings → just the page name, no specific data

### 3. Quick-Action Chips

**Concept:** A horizontally scrollable row of tap-to-send prompt chips above the chat input.

**Two tiers:**

**Global chips** (shown on generic pages):
- "How's my portfolio today?"
- "What's happening this week?"
- "Show my biggest movers"

**Page-aware chips** (shown when page context is specific):
- Security Detail for AAPL → "What's the outlook for AAPL?", "Show my AAPL positions"
- Calendar → "Summarize this week's events", "What should I watch for?"
- Research/Feeds → "Key takeaways from recent articles", "Any actionable signals?"
- Analysis → "Where is my risk concentrated?", "How am I positioned?"

**Behavior:**
- Visible when input field is empty and conversation has no messages yet (or at start of new conversation)
- Disappear after first message is sent
- Horizontally scrollable, 3-4 visible
- Tapping = send immediately
- Show on both mobile and desktop

## Files to Modify/Create

| File | Change |
|------|--------|
| `lib/db/migrations/025_chat_history.sql` | New migration |
| `lib/queries/chat.ts` | New: CRUD for conversations + messages |
| `lib/mutations/chat.ts` | New: save messages, create conversations |
| `lib/chat/page-context.ts` | New: route → context string mapper |
| `app/api/chat/route.ts` | Add persistence, load history, page context in system prompt |
| `app/api/chat/conversations/route.ts` | New: list/create conversations |
| `app/api/chat/conversations/[id]/messages/route.ts` | New: load messages |
| `app/dashboard/components/ChatInterface.tsx` | Conversation selector, history loading, quick chips |
| `app/dashboard/components/ChatDrawer.tsx` | Pass pathname to ChatInterface |
| `app/dashboard/components/QuickActionChips.tsx` | New: chip row component |

## Out of Scope

- Rich responses (inline charts/tables in chat)
- Conversation search
- Message editing/deletion
- Export/share conversations
- Service worker / offline support
