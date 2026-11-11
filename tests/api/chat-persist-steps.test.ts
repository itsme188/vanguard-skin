import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { runMigrations } from "@/lib/db/migrate";
import { resetChatBudgetStateForTests } from "@/lib/chat/budget";
import { CUT_OFF_SENTENCE } from "@/lib/chat/turn-outcome";

// Portfolio Assistant plan, Task 3 item E (B11, Contract B): the saved
// assistant row is every step's text, not only the last step's, and a turn
// with no written reply saves the sentence for why. Real streamText; the
// model is a MockLanguageModelV3 behind getModelForFeature.

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
  inputTokens: { total: 3, noCache: 1, cacheRead: 1, cacheWrite: 1 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};

function stepParts(opts: { text?: string; toolCall?: { id: string; name: string; input: unknown } }): Part[] {
  const parts: Part[] = [{ type: "stream-start", warnings: [] }];
  if (opts.text) {
    parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: opts.text }, { type: "text-end", id: "t" });
  }
  if (opts.toolCall) {
    parts.push({
      type: "tool-call",
      toolCallId: opts.toolCall.id,
      toolName: opts.toolCall.name,
      input: JSON.stringify(opts.toolCall.input),
    });
  }
  parts.push({
    type: "finish",
    finishReason: opts.toolCall ? { unified: "tool-calls", raw: "tool_use" } : { unified: "stop", raw: "end_turn" },
    usage: USAGE,
  });
  return parts;
}

function modelFrom(steps: (call: number) => Part[]): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream(steps(call++)) }),
  });
}

async function post(body: Record<string, unknown>): Promise<{ res: Response; text: string }> {
  const res = await POST(
    new NextRequest("http://localhost:3099/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  // onFinish runs as the stream closes; give its awaited work a tick.
  await new Promise((r) => setTimeout(r, 10));
  return { res, text };
}

function rows(role: string): string[] {
  return (
    hoisted.db.prepare("SELECT content FROM chat_messages WHERE role = ? ORDER BY id").all(role) as {
      content: string;
    }[]
  ).map((r) => r.content);
}

const ask = [{ id: "u1", role: "user", parts: [{ type: "text", text: "what do my notes say?" }] }];

describe("POST /api/chat — assistant row persistence (B11)", () => {
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

  it("text before and after a tool call is saved", async () => {
    hoisted.model = modelFrom((call) =>
      call === 0
        ? stepParts({ text: "Let me check your notes.", toolCall: { id: "c1", name: "query_notes", input: {} } })
        : stepParts({ text: "You have no notes yet." }),
    );
    const { res } = await post({ messages: ask, scope: "all" });
    expect(res.status).toBe(200);
    expect(rows("assistant")).toEqual(["Let me check your notes.\n\nYou have no notes yet."]);
  });

  it("a turn that ends on tool calls saves the cut-off sentence", async () => {
    hoisted.model = modelFrom((call) =>
      stepParts({ toolCall: { id: `c${call}`, name: "query_notes", input: {} } }),
    );
    const { text } = await post({ messages: ask, scope: "all" });
    expect(rows("assistant")).toEqual([CUT_OFF_SENTENCE]);
    // Contract B: the finish part carries the reason and the step count.
    expect(text).toContain('"finishReason":"tool-calls"');
    expect(text).toContain('"stepCount":8');
  });

  it("a turn waiting for approval saves nothing", async () => {
    hoisted.model = modelFrom(() =>
      stepParts({ toolCall: { id: "n1", name: "create_note", input: { note_type: "journal", content: "draft" } } }),
    );
    const { text } = await post({ messages: ask, scope: "all" });
    expect(text).toContain("tool-approval-request");
    expect(rows("assistant")).toEqual([]);
    expect(rows("user")).toEqual(["what do my notes say?"]);
  });

  it("a normal answer carries its finish metadata", async () => {
    hoisted.model = modelFrom(() => stepParts({ text: "Hi." }));
    const { text } = await post({ messages: ask, scope: "all" });
    expect(text).toContain('"finishReason":"stop"');
    expect(text).toContain('"stepCount":1');
    expect(rows("assistant")).toEqual(["Hi."]);
  });

  it("logs one usage line per step and one per turn, with no content (D6)", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    hoisted.model = modelFrom((call) =>
      call === 0
        ? stepParts({ text: "SECRET-STEP-TEXT", toolCall: { id: "c1", name: "query_notes", input: {} } })
        : stepParts({ text: "SECRET-FINAL-TEXT" }),
    );
    await post({ messages: ask, scope: "all" });
    const lines = logs.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[chat-usage] "));
    const parsed = lines.map((l) => JSON.parse(l.slice("[chat-usage] ".length)));
    expect(parsed.map((p) => p.kind)).toEqual(["step", "step", "turn"]);
    expect(parsed[0]).toMatchObject({ step: 0, scope: "all", noCache: 1, cacheRead: 1, cacheWrite: 1, output: 2 });
    expect(parsed[1]).toMatchObject({ step: 1 });
    expect(parsed[2]).toMatchObject({ steps: 2, output: 4, finishReason: "stop" });
    expect(typeof parsed[2].conversationId).toBe("number");
    const all = lines.join("\n");
    expect(all).not.toContain("SECRET");
    expect(all).not.toContain("what do my notes say");
  });

  it("a failed save is logged without content and does not break the stream", async () => {
    hoisted.model = modelFrom(() => stepParts({ text: "SECRET-ANSWER-TEXT" }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    hoisted.db.exec(
      "CREATE TRIGGER fail_assistant BEFORE INSERT ON chat_messages WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    );
    const { res } = await post({ messages: ask, scope: "all" });
    expect(res.status).toBe(200);
    expect(errors).toHaveBeenCalled();
    const printed = errors.mock.calls.flat().map(String).join(" ");
    expect(printed).not.toContain("SECRET-ANSWER-TEXT");
  });
});
