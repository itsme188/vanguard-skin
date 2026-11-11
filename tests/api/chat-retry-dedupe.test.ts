import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import {
  resetChatBudgetStateForTests,
  checkAndConsumeRateLimit,
  RATE_LIMIT_MAX_REQUESTS,
  NO_SESSION_KEY,
} from "@/lib/chat/budget";

// Portfolio Assistant plan, Task 3 item F (B12): a retry re-sends the same
// last user message. It is saved once. A request rejected before the save
// (rate limit) still gets its message saved by the retry that succeeds.

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

const u = (id: string, text: string) => ({ id, role: "user", parts: [{ type: "text", text }] });
const a = (id: string, text: string) => ({ id, role: "assistant", parts: [{ type: "text", text }] });

function userRows(convId: number): string[] {
  return (
    hoisted.db
      .prepare("SELECT content FROM chat_messages WHERE conversation_id = ? AND role = 'user' ORDER BY id")
      .all(convId) as { content: string }[]
  ).map((r) => r.content);
}

describe("POST /api/chat — retry dedupe (B12)", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  let convId: number;

  beforeEach(() => {
    resetChatBudgetStateForTests();
    hoisted.db = new Database(":memory:");
    hoisted.db.pragma("foreign_keys = ON");
    runMigrations(hoisted.db);
    hoisted.streamTextMock.mockReset();
    hoisted.streamTextMock.mockImplementation(() => ({
      toUIMessageStreamResponse: () => new Response("ok", { status: 200 }),
    }));
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    convId = Number(hoisted.db.prepare("INSERT INTO chat_conversations (scope) VALUES ('macro')").run().lastInsertRowid);
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("two posts ending in the same user message leave one user row", async () => {
    const body = { messages: [u("u1", "what changed?")], scope: "macro", conversationId: convId };
    expect((await post(body)).status).toBe(200);
    // The stream failed before an answer was saved; the owner presses Retry.
    expect((await post(body)).status).toBe(200);
    expect(userRows(convId)).toEqual(["what changed?"]);
  });

  it("a retry after a 429 still saves the message once", async () => {
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) checkAndConsumeRateLimit(NO_SESSION_KEY, Date.now());
    const body = { messages: [u("u1", "what changed?")], scope: "macro", conversationId: convId };
    expect((await post(body)).status).toBe(429);
    expect(userRows(convId)).toEqual([]);

    resetChatBudgetStateForTests();
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(200);
    expect(userRows(convId)).toEqual(["what changed?"]);
  });

  it("the same question asked again after an answer is a new row", async () => {
    hoisted.db.prepare("INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, 'user', 'ping')").run(convId);
    hoisted.db.prepare("INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, 'assistant', 'pong')").run(convId);
    await post({ messages: [u("u1", "ping"), a("a1", "pong"), u("u2", "ping")], scope: "macro", conversationId: convId });
    expect(userRows(convId)).toEqual(["ping", "ping"]);
  });

  it("a request whose last message is the assistant's saves no user row", async () => {
    await post({ messages: [u("u1", "save a note"), a("a1", "draft")], scope: "macro", conversationId: convId });
    expect(userRows(convId)).toEqual([]);
  });
});
