import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { MockLanguageModelV3 } from "ai/test";
import { runMigrations } from "@/lib/db/migrate";
import { resetChatBudgetStateForTests, activeStreamCount, NO_SESSION_KEY } from "@/lib/chat/budget";

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
  const actual = await vi.importActual<typeof import("@/lib/ai/provider")>("@/lib/ai/provider");
  return { ...actual, getModelForFeature: () => hoisted.model };
});

import { POST } from "@/app/api/chat/route";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type Part = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

/** A model stream that sends a little text, then waits until it is aborted. */
function waitingModel(): { model: MockLanguageModelV3; started: Promise<void> } {
  let markStarted: () => void = () => {};
  const started = new Promise<void>((r) => {
    markStarted = r;
  });
  const model = new MockLanguageModelV3({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream<Part>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({ type: "text-delta", id: "t", delta: "Working on it" });
          markStarted();
          // Like a real fetch: the stream errors with an AbortError when the
          // signal it was handed fires. With no signal it waits forever.
          abortSignal?.addEventListener("abort", () => {
            controller.error(new DOMException("The operation was aborted.", "AbortError"));
          });
        },
      }),
    }),
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

  it("aborting the request releases the slot without calling onAbort by hand", async () => {
    const { model, started } = waitingModel();
    hoisted.model = model;
    const controller = new AbortController();

    const res = await POST(
      new NextRequest("http://localhost:3099/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }],
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
    const released = await waitFor(() => activeStreamCount(NO_SESSION_KEY, Date.now()) === 0, 2000);
    expect(released).toBe(true);
  });
});
