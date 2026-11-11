import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { runMigrations } from "@/lib/db/migrate";
import { resetChatBudgetStateForTests } from "@/lib/chat/budget";
import { LAST_STEP_NOTE } from "@/lib/chat/history";

// Portfolio Assistant plan, Task 3 item G (P4): the eighth model call is told
// it is the last one, in the VOLATILE system block only, so the static block
// and its cache mark are untouched and the cached prefix holds. Tools stay in
// the request (toolChoice "none" would strip them; P4).

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

function toolCallStep(n: number): Part[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: `c${n}`, toolName: "query_notes", input: "{}" },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: USAGE },
  ];
}

interface PromptMessage {
  role: string;
  content: unknown;
  providerOptions?: unknown;
}

describe("POST /api/chat — last-step guard (P4)", () => {
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

  it("step 8 receives the final-step note in the volatile block only", async () => {
    let n = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: convertArrayToReadableStream(toolCallStep(n++)) }),
    });
    hoisted.model = model;

    const res = await POST(
      new NextRequest("http://localhost:3099/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "review everything" }] }],
          scope: "all",
        }),
      }),
    );
    await res.text();

    const calls = model.doStreamCalls;
    expect(calls).toHaveLength(8);
    const systems = calls.map((c) => (c.prompt as PromptMessage[]).filter((m) => m.role === "system"));

    for (const [i, sys] of systems.entries()) {
      expect(sys, `call ${i}`).toHaveLength(2);
      // The static block and its mark are the same on every call.
      expect(sys[0].content).toBe(systems[0][0].content);
      expect(sys[0].providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
      expect(sys[1].providerOptions).toBeUndefined();
      expect(String(sys[0].content)).not.toContain(LAST_STEP_NOTE);
    }
    for (let i = 0; i < 7; i++) expect(String(systems[i][1].content)).not.toContain(LAST_STEP_NOTE);
    expect(String(systems[7][1].content)).toBe(`${systems[0][1].content}\n\n${LAST_STEP_NOTE}`);
    // The note tells the truth at HEAD: tools are still offered on the last
    // step, and a call there ends the turn with no written answer.
    expect(LAST_STEP_NOTE).toBe(
      "This is your last step. A tool call now would end the turn with no written answer, so write the answer from what you have, and say what you could not check.",
    );

    // Tools are still offered on the last call (the cached prefix holds).
    expect(calls[7].tools?.length).toBe(calls[0].tools?.length);
  });
});
