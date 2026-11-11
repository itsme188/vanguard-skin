import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { runMigrations } from "@/lib/db/migrate";
import { resetChatBudgetStateForTests } from "@/lib/chat/budget";

// Portfolio Assistant plan, Contract C / Task 3 item N. Security property:
// text inside a tool result can make the model DRAFT a note but never SAVE
// one; only the owner's approval (a click in the app) runs create_note.
// Real streamText, real executeTool, real notes table; only the model is a
// mock.

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  model: null as unknown,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("@/lib/ai/provider", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/provider")>("@/lib/ai/provider");
  return { ...actual, getModelForFeature: () => hoisted.model };
});

import { POST } from "@/app/api/chat/route";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type Part = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const NOTE_INPUT = { note_type: "journal", content: "Rates look toppy into the meeting." };

function draftNoteStep(): Part[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: "call-note", toolName: "create_note", input: JSON.stringify(NOTE_INPUT) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: USAGE },
  ];
}

function textStep(text: string): Part[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage: USAGE },
  ];
}

function modelOf(step: () => Part[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream(step()) }),
  });
}

async function post(body: Record<string, unknown>): Promise<{ status: number; text: string; conversationId: number }> {
  const res = await POST(
    new NextRequest("http://localhost:3099/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  await new Promise((r) => setTimeout(r, 10));
  return { status: res.status, text, conversationId: Number(res.headers.get("X-Conversation-Id")) };
}

function count(sql: string): number {
  return (hoisted.db.prepare(sql).get() as { n: number }).n;
}
const noteCount = () => count("SELECT COUNT(*) AS n FROM notes");
const userRows = () => count("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'user'");

const askMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "save a journal note about rates" }] };

function continuation(approved: boolean) {
  return [
    askMessage,
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-create_note",
          toolCallId: "call-note",
          state: "approval-responded",
          input: NOTE_INPUT,
          approval: approved
            ? { id: "approval-1", approved: true }
            : { id: "approval-1", approved: false, reason: "Owner chose not to save" },
        },
      ],
    },
  ];
}

describe("POST /api/chat — create_note needs the owner's approval (Contract C)", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    resetChatBudgetStateForTests();
    hoisted.db = new Database(":memory:");
    hoisted.db.pragma("foreign_keys = ON");
    runMigrations(hoisted.db);
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("a model call to create_note stops for approval and saves no note", async () => {
    const model = modelOf(draftNoteStep);
    hoisted.model = model;
    const { status, text } = await post({ messages: [askMessage], scope: "all" });
    expect(status).toBe(200);
    expect(text).toContain("tool-approval-request");
    expect(noteCount()).toBe(0);
    // The turn stops at the request: no second model call.
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("an approval continuation saves one note and no user row", async () => {
    const convId = Number(hoisted.db.prepare("INSERT INTO chat_conversations (scope) VALUES ('all')").run().lastInsertRowid);
    hoisted.model = modelOf(() => textStep("Saved your note."));
    const before = userRows();
    const { status } = await post({ messages: continuation(true), scope: "all", conversationId: convId });
    expect(status).toBe(200);
    expect(noteCount()).toBe(1);
    expect(userRows()).toBe(before);
    const assistant = hoisted.db
      .prepare("SELECT content FROM chat_messages WHERE role = 'assistant' AND conversation_id = ?")
      .all(convId) as { content: string }[];
    expect(assistant.map((r) => r.content)).toEqual(["Saved your note."]);
  });

  it("a denial saves no note", async () => {
    hoisted.model = modelOf(() => textStep("Okay, not saved."));
    const { status } = await post({ messages: continuation(false), scope: "all" });
    expect(status).toBe(200);
    expect(noteCount()).toBe(0);
  });

  it("the same continuation posted twice saves one note", async () => {
    // P11: a continuation re-sent after a lost response must not save a
    // second copy (the replay guard lives in create_note, Task 5).
    hoisted.model = modelOf(() => textStep("Saved."));
    const first = await post({ messages: continuation(true), scope: "all" });
    await post({ messages: continuation(true), scope: "all", conversationId: first.conversationId });
    expect(noteCount()).toBe(1);
  });
});
