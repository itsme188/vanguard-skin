import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { resetChatBudgetStateForTests } from "@/lib/chat/budget";

// Portfolio Assistant plan, Task 3 item I (B14): an unknown or deleted
// conversation id starts a new conversation (and the header names it); a
// known id whose stored scope differs from the request's is refused with 409
// (OPEN-3 default) and nothing is saved.

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  streamTextMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, streamText: hoisted.streamTextMock };
});

import { POST } from "@/app/api/chat/route";

async function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new NextRequest("http://localhost:3099/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const hello = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }];

function conversation(id: number): { scope: string } | undefined {
  return hoisted.db.prepare("SELECT scope FROM chat_conversations WHERE id = ?").get(id) as { scope: string } | undefined;
}
function messageCount(): number {
  return (hoisted.db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as { n: number }).n;
}

describe("POST /api/chat — conversation id (B14)", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    resetChatBudgetStateForTests();
    hoisted.db = new Database(":memory:");
    hoisted.db.pragma("foreign_keys = ON");
    runMigrations(hoisted.db);
    hoisted.streamTextMock.mockReset();
    hoisted.streamTextMock.mockImplementation(() => ({
      toUIMessageStreamResponse: ({ headers }: { headers?: Record<string, string> }) =>
        new Response("ok", { status: 200, headers }),
    }));
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("an unknown id starts a new conversation in the request's scope", async () => {
    const res = await post({ messages: hello, scope: "macro", conversationId: 999 });
    expect(res.status).toBe(200);
    const id = Number(res.headers.get("X-Conversation-Id"));
    expect(id).toBeGreaterThan(0);
    expect(id).not.toBe(999);
    expect(conversation(id)?.scope).toBe("macro");
    expect(conversation(999)).toBeUndefined();
  });

  it("a deleted id starts a new conversation and the message lands there", async () => {
    const old = Number(hoisted.db.prepare("INSERT INTO chat_conversations (scope) VALUES ('macro')").run().lastInsertRowid);
    hoisted.db.prepare("DELETE FROM chat_conversations WHERE id = ?").run(old);
    const res = await post({ messages: hello, scope: "macro", conversationId: old });
    const id = Number(res.headers.get("X-Conversation-Id"));
    expect(id).not.toBe(old);
    const row = hoisted.db.prepare("SELECT conversation_id FROM chat_messages").get() as { conversation_id: number };
    expect(row.conversation_id).toBe(id);
  });

  it("a malformed id starts a new conversation", async () => {
    const res = await post({ messages: hello, scope: "macro", conversationId: "abc" });
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("X-Conversation-Id"))).toBeGreaterThan(0);
  });

  it("a known id with the same scope is reused", async () => {
    const id = Number(hoisted.db.prepare("INSERT INTO chat_conversations (scope) VALUES ('macro')").run().lastInsertRowid);
    const res = await post({ messages: hello, scope: "macro", conversationId: id });
    expect(Number(res.headers.get("X-Conversation-Id"))).toBe(id);
  });

  it("a known id started in another scope is refused with 409 and nothing is saved", async () => {
    const id = Number(hoisted.db.prepare("INSERT INTO chat_conversations (scope) VALUES ('ibkr')").run().lastInsertRowid);
    const res = await post({ messages: hello, scope: "macro", conversationId: id });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      success: false,
      error: "This conversation was started in the IBKR scope. Start a new conversation to change scope.",
    });
    expect(hoisted.streamTextMock).not.toHaveBeenCalled();
    expect(messageCount()).toBe(0);
    expect(conversation(id)?.scope).toBe("ibkr");
  });
});
