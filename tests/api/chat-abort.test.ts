import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { MockLanguageModelV3 } from "ai/test";
import { runMigrations } from "@/lib/db/migrate";
import {
  resetChatBudgetStateForTests,
  activeStreamCount,
  NO_SESSION_KEY,
  getDailyUsage,
  budgetDayFor,
} from "@/lib/chat/budget";

// Portfolio Assistant plan, Task 3 item D (B13, R6). streamText runs its
// onAbort hook only when it was given an abortSignal, so before this fix a
// closed browser tab left the concurrency slot held until the 10-minute stale
// prune. This test drives the REAL abort path: real streamText, a model whose
// stream waits until the request's signal fires, and an aborted Request. No
// hook is called by hand.

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
  const actual =
    await vi.importActual<typeof import("@/lib/ai/provider")>(
      "@/lib/ai/provider",
    );
  return { ...actual, getModelForFeature: () => hoisted.model };
});

import { POST } from "@/app/api/chat/route";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type Part = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

const USAGE = {
  inputTokens: { total: 3, noCache: 1, cacheRead: 1, cacheWrite: 1 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};

/** A finished first step: text, then a tool call. */
function finishedStep(text: string): Part[] {
  const parts: Part[] = [{ type: "stream-start", warnings: [] }];
  if (text) {
    parts.push({ type: "text-start", id: "s" }, { type: "text-delta", id: "s", delta: text }, { type: "text-end", id: "s" });
  }
  parts.push(
    { type: "tool-call", toolCallId: "c1", toolName: "query_notes", input: "{}" },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: USAGE },
  );
  return parts;
}

/**
 * A model stream that sends a little text, then waits until it is aborted.
 * With `firstStepText`, the first call finishes a whole step and the SECOND
 * call is the one that waits.
 */
function waitingModel(firstStepText?: string): {
  model: MockLanguageModelV3;
  started: Promise<void>;
} {
  let call = 0;
  let markStarted: () => void = () => {};
  const started = new Promise<void>((r) => {
    markStarted = r;
  });
  const model = new MockLanguageModelV3({
    doStream: async ({ abortSignal }) => {
      if (firstStepText !== undefined && call++ === 0) {
        return {
          stream: new ReadableStream<Part>({
            start(c) {
              for (const p of finishedStep(firstStepText)) c.enqueue(p);
              c.close();
            },
          }),
        };
      }
      return {
        stream: new ReadableStream<Part>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({
              type: "text-delta",
              id: "t",
              delta: "Working on it",
            });
            markStarted();
            // Like a real fetch: the stream errors with an AbortError when the
            // signal it was handed fires. With no signal it waits forever.
            abortSignal?.addEventListener("abort", () => {
              controller.error(
                new DOMException("The operation was aborted.", "AbortError"),
              );
            });
          },
        }),
      };
    },
  });
  return { model, started };
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return check();
}

describe("POST /api/chat — abort (B13)", () => {
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

  async function postAndAbort(firstStepText?: string): Promise<void> {
    const { model, started } = waitingModel(firstStepText);
    hoisted.model = model;
    const controller = new AbortController();

    const res = await POST(
      new NextRequest("http://localhost:3099/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              id: "u1",
              role: "user",
              parts: [{ type: "text", text: "hello" }],
            },
          ],
          scope: "macro",
        }),
        signal: controller.signal,
      }),
    );
    expect(res.status).toBe(200);

    // Pull the stream so the model call starts and holds the slot.
    const reader = res.body!.getReader();
    void (async () => {
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        // an aborted stream may end with an error; the slot is what we check
      }
    })();
    await started;
    expect(activeStreamCount(NO_SESSION_KEY, Date.now())).toBe(1);

    controller.abort();
    const released = await waitFor(
      () => activeStreamCount(NO_SESSION_KEY, Date.now()) === 0,
      2000,
    );
    expect(released).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
  }

  const assistantRows = () =>
    (
      hoisted.db
        .prepare("SELECT content FROM chat_messages WHERE role = 'assistant'")
        .all() as { content: string }[]
    ).map((r) => r.content);

  it("aborting the request releases the slot without calling onAbort by hand", async () => {
    await postAndAbort();
    // Nothing was finished, so nothing is saved.
    expect(assistantRows()).toEqual([]);
  });

  // Review R3-4 + R4-7: the finished steps of an aborted turn count toward the
  // daily budget, and their text (which the owner saw, and which the client
  // re-sends as history) is stored.
  it("an aborted turn saves its finished steps' text and charges their output", async () => {
    await postAndAbort("Step one done.");
    expect(assistantRows()).toEqual(["Step one done."]);
    expect(
      getDailyUsage(NO_SESSION_KEY, budgetDayFor(Date.now()))?.outputTokens,
    ).toBe(2);
    expect(activeStreamCount(NO_SESSION_KEY, Date.now())).toBe(0);
  });

  it("an aborted turn with no finished text saves nothing (no cut-off sentence) and charges once", async () => {
    await postAndAbort("");
    expect(assistantRows()).toEqual([]);
    expect(getDailyUsage(NO_SESSION_KEY, budgetDayFor(Date.now()))?.outputTokens).toBe(2);
  });
});
