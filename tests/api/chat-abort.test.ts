import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { MockLanguageModelV3 } from "ai/test";
import v8 from "node:v8";
import vm from "node:vm";
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
  /** When set, every tool call waits for its abort signal (a slow tool). */
  blockTools: false,
  toolStarted: null as null | (() => void),
  toolSawAbort: false,
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

vi.mock("@/lib/chat/tools", async () => {
  const actual = await vi.importActual<typeof import("@/lib/chat/tools")>("@/lib/chat/tools");
  return {
    ...actual,
    executeTool: async (...args: Parameters<typeof actual.executeTool>) => {
      if (!hoisted.blockTools) return actual.executeTool(...args);
      const signal = args[3]?.abortSignal;
      hoisted.toolStarted?.();
      await new Promise<void>((resolve) => {
        if (!signal) return; // never resolves: the test then fails on the slot
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      hoisted.toolSawAbort = signal?.aborted ?? false;
      return { error: "Cancelled." };
    },
  };
});

import { POST } from "@/app/api/chat/route";

// A forced garbage collection, to make the abort-reach race deterministic.
v8.setFlagsFromString("--expose-gc");
const forceGc = vm.runInNewContext("gc") as () => void;

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

interface WaitingOptions {
  /** A first call that finishes a whole step (text, then a tool call). */
  firstStepText?: string;
  /** Text deltas the waiting step streams before it waits (default one delta). */
  inFlight?: string[];
  /** Reasoning streamed in the waiting step (never saved). */
  reasoning?: string;
}

interface AbortOptions extends WaitingOptions {
  /** Force garbage collection after the step starts, before the abort. */
  gcBeforeAbort?: boolean;
}

/**
 * A model stream that sends a little text, then waits until it is aborted.
 * With `firstStepText`, the first call finishes a whole step and the SECOND
 * call is the one that waits.
 */
function waitingModel(opts: WaitingOptions = {}): {
  model: MockLanguageModelV3;
  started: Promise<void>;
} {
  const { firstStepText, inFlight = ["Working on it"], reasoning } = opts;
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
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (reasoning) {
              controller.enqueue({ type: "reasoning-start", id: "r" });
              controller.enqueue({ type: "reasoning-delta", id: "r", delta: reasoning });
              controller.enqueue({ type: "reasoning-end", id: "r" });
            }
            if (inFlight.length > 0) {
              controller.enqueue({ type: "text-start", id: "t" });
              // Streamed slowly, a delta at a time, like a real answer.
              for (const delta of inFlight) {
                controller.enqueue({ type: "text-delta", id: "t", delta });
                await new Promise((r) => setTimeout(r, 5));
              }
            }
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
    hoisted.blockTools = false;
    hoisted.toolStarted = null;
    hoisted.toolSawAbort = false;
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

  /** Text deltas the client received, from the UI stream. */
  function clientText(raw: string): string {
    return raw
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)) as { type: string; delta?: string })
      .filter((c) => c.type === "text-delta")
      .map((c) => c.delta ?? "")
      .join("");
  }

  async function postAndAbort(opts: AbortOptions = {}): Promise<{ seen: string; model: MockLanguageModelV3 }> {
    const { model, started } = waitingModel(opts);
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
              parts: [{ type: "text", text: "Explain my bond ladder in detail" }],
            },
          ],
          scope: "macro",
        }),
        signal: controller.signal,
      }),
    );
    expect(res.status).toBe(200);

    // Pull the stream so the model call starts and holds the slot, keeping
    // what the client was shown.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += decoder.decode(value, { stream: true });
        }
      } catch {
        // an aborted stream may end with an error; the slot is what we check
      }
    })();
    await started;
    await new Promise((r) => setTimeout(r, 20));
    expect(activeStreamCount(NO_SESSION_KEY, Date.now())).toBe(1);

    if (opts.gcBeforeAbort) {
      for (let i = 0; i < 3; i++) {
        forceGc();
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    controller.abort();
    const released = await waitFor(
      () => activeStreamCount(NO_SESSION_KEY, Date.now()) === 0,
      2000,
    );
    expect(released).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    return { seen: clientText(raw), model };
  }

  const assistantRows = () =>
    (
      hoisted.db
        .prepare("SELECT content FROM chat_messages WHERE role = 'assistant'")
        .all() as { content: string }[]
    ).map((r) => r.content);

  const daily = () => getDailyUsage(NO_SESSION_KEY, budgetDayFor(Date.now()))?.outputTokens;

  function usageLines(): Record<string, unknown>[] {
    const spy = console.log as unknown as { mock: { calls: unknown[][] } };
    return spy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith("[chat-usage] "))
      .map((l) => JSON.parse(l.slice("[chat-usage] ".length)) as Record<string, unknown>);
  }

  it("aborting the request releases the slot without calling onAbort by hand", async () => {
    await postAndAbort({ inFlight: [] });
    // Nothing was streamed, so nothing is saved.
    expect(assistantRows()).toEqual([]);
  });

  // Browser pass FAIL: most Stops land mid-stream on step 1. The text the
  // owner saw (and that the client re-sends as history) must be stored.
  it("a stop during the first step saves exactly the text streamed before the abort", async () => {
    const { seen } = await postAndAbort({ inFlight: ["Your ladder has ", "three rungs; ", "the first matures"] });
    expect(seen).toBe("Your ladder has three rungs; the first matures");
    expect(assistantRows()).toEqual([seen]);
  });

  it("reasoning streamed before a stop is never saved", async () => {
    await postAndAbort({ inFlight: ["Short answer."], reasoning: "SECRET-REASONING" });
    expect(assistantRows()).toEqual(["Short answer."]);
  });

  // Review R3-4 + R4-7: the finished steps of an aborted turn count toward the
  // daily budget, and their text is stored, followed by the in-flight text.
  it("an aborted turn saves its finished steps' text, then the in-flight text", async () => {
    await postAndAbort({ firstStepText: "Step one done." });
    expect(assistantRows()).toEqual(["Step one done.\n\nWorking on it"]);
    expect(activeStreamCount(NO_SESSION_KEY, Date.now())).toBe(0);
  });

  it("an aborted turn with no text at all saves nothing (no cut-off sentence)", async () => {
    await postAndAbort({ firstStepText: "", inFlight: [] });
    expect(assistantRows()).toEqual([]);
  });

  // Item 4: the provider reports no usage for an aborted step. The turn line
  // says so, and the budget is charged an estimate for it.
  it("an aborted turn writes one turn usage line marking the aborted step and its estimate", async () => {
    await postAndAbort({ firstStepText: "Step one done.", inFlight: ["Working on it"], reasoning: "Thinking hard" });
    const lines = usageLines();
    const turns = lines.filter((l) => l.kind === "turn");
    expect(turns).toHaveLength(1);
    // 13 text + 13 reasoning characters at 4 characters per token, rounded up.
    expect(turns[0]).toMatchObject({ steps: 1, output: 2, abortedSteps: 1, abortedOutputEstimate: 7, finishReason: "abort" });
    const all = JSON.stringify(lines);
    expect(all).not.toContain("Working on it");
    expect(all).not.toContain("Thinking hard");
    expect(all).not.toContain("Step one done");
  });

  // The aborted call was accepted by the provider and wrote its prefix to the
  // cache (seen live): its INPUT is spend too. The line carries an estimate,
  // with the cache status unknown; the output budget is not charged for it.
  it("an aborted step's input is estimated on the turn line, cache status unknown", async () => {
    const { model } = await postAndAbort({ firstStepText: "Step one done.", inFlight: ["Working on it"] });
    const turn = usageLines().find((l) => l.kind === "turn")!;
    // The size of what the model was actually handed for the aborted (second) call.
    const sent = model.doStreamCalls[model.doStreamCalls.length - 1];
    const realChars = JSON.stringify(sent.prompt).length + JSON.stringify(sent.tools ?? []).length;
    const realTokens = realChars / 3.7;
    expect(typeof turn.abortedInputEstimate).toBe("number");
    expect(turn.abortedInputEstimate as number).toBeGreaterThan(realTokens * 0.5);
    expect(turn.abortedInputEstimate as number).toBeLessThan(realTokens * 2);
    expect(turn.abortedInputCache).toBe("unknown");
    expect(turn.abortedStepProcessed).toBe("chunks-received");
    // The output budget counts output only.
    expect(daily()).toBe(2 + 4);
  });

  it("an abort before the step's first chunk is marked as possibly unprocessed", async () => {
    await postAndAbort({ inFlight: [] });
    const turn = usageLines().find((l) => l.kind === "turn")!;
    expect(turn).toMatchObject({
      steps: 0,
      abortedSteps: 1,
      abortedOutputEstimate: 0,
      abortedInputCache: "unknown",
      abortedStepProcessed: "maybe-not",
    });
    expect(turn.abortedInputEstimate as number).toBeGreaterThan(0);
    expect(daily()).toBe(0);
  });

  it("the budget is charged the finished steps' real output plus the aborted step's estimate, once", async () => {
    await postAndAbort({ firstStepText: "", inFlight: ["Working on it"] }); // 13 chars -> 4
    expect(daily()).toBe(2 + 4);
  });

  // Item 5: onAbort and then onFinish both fire for one aborted turn in this
  // SDK version; the turn still settles once and releases its slot once.
  it("an aborted turn settles once: one row, one charge, one turn line, slot back to zero", async () => {
    const { acquireStreamSlot } = await import("@/lib/chat/budget");
    await postAndAbort({ firstStepText: "Step one done." });
    expect(assistantRows()).toHaveLength(1);
    expect(daily()).toBe(2 + 4);
    expect(usageLines().filter((l) => l.kind === "turn")).toHaveLength(1);
    expect(activeStreamCount(NO_SESSION_KEY, Date.now())).toBe(0);
    // A double release would have freed a slot it did not hold; the count
    // stays exact as new slots are taken.
    acquireStreamSlot(NO_SESSION_KEY, Date.now());
    expect(activeStreamCount(NO_SESSION_KEY, Date.now())).toBe(1);
  });

  // Item 3: a stopped first turn still gets its title.
  it("a stopped first turn still titles the conversation", async () => {
    await postAndAbort({ inFlight: [] });
    const row = hoisted.db.prepare("SELECT title FROM chat_conversations").get() as { title: string | null };
    expect(row.title).toBe("Explain my bond ladder in detail");
  });

  // The flake (8 of 20 runs): nothing held the Request after POST returned,
  // so a garbage collection could take the Request and with it the internal
  // controller that forwards the caller's abort to request.signal. The abort
  // then never reached streamText and the slot stayed held. Forcing the
  // collection makes that deterministic.
  it("an abort still reaches the route after a garbage collection", async () => {
    const { seen } = await postAndAbort({ inFlight: ["Partial answer"], gcBeforeAbort: true });
    expect(assistantRows()).toEqual([seen]);
  });

  // Abort while a tool is running. In this SDK version a step's tools run
  // INSIDE the step: onStepFinish (with the provider's usage) fires only after
  // its tool results. So the step counts as aborted: its text is saved, its
  // output is the character estimate (the model's real count never surfaces),
  // and the tool receives the abort signal and stops.
  it("an abort during a tool's execution reaches the tool; the step's text is saved and estimated", async () => {
    hoisted.blockTools = true;
    const toolStarted = new Promise<void>((r) => {
      hoisted.toolStarted = r;
    });
    let call = 0;
    hoisted.model = new MockLanguageModelV3({
      doStream: async () => {
        call++;
        return {
          stream: new ReadableStream<Part>({
            start(c) {
              for (const p of finishedStep("Checking your notes.")) c.enqueue(p);
              c.close();
            },
          }),
        };
      },
    });
    const controller = new AbortController();
    const res = await POST(
      new NextRequest("http://localhost:3099/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "notes?" }] }], scope: "macro" }),
        signal: controller.signal,
      }),
    );
    const reader = res.body!.getReader();
    void (async () => {
      try {
        for (;;) if ((await reader.read()).done) break;
      } catch {
        // ignore
      }
    })();
    await toolStarted; // event-driven: the tool is running now
    controller.abort();
    expect(await waitFor(() => activeStreamCount(NO_SESSION_KEY, Date.now()) === 0, 2000)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.toolSawAbort).toBe(true);
    expect(call).toBe(1); // no second model call after the abort
    expect(assistantRows()).toEqual(["Checking your notes."]);
    // 20 characters of text at 4 per token, rounded up; charged once.
    expect(daily()).toBe(5);
    const turns = usageLines().filter((l) => l.kind === "turn");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      steps: 0,
      abortedSteps: 1,
      abortedOutputEstimate: 5,
      abortedInputCache: "unknown",
      abortedStepProcessed: "chunks-received",
    });
  });

  // Abort after the model's last chunk (its finish part, with usage) but
  // before its stream closed: the text is saved once and the turn settles once.
  it("an abort after the final chunk but before the stream closed saves the text once", async () => {
    let sent: () => void = () => {};
    const allSent = new Promise<void>((r) => {
      sent = r;
    });
    hoisted.model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream<Part>({
          start(c) {
            c.enqueue({ type: "stream-start", warnings: [] });
            c.enqueue({ type: "text-start", id: "t" });
            c.enqueue({ type: "text-delta", id: "t", delta: "All done." });
            c.enqueue({ type: "text-end", id: "t" });
            c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage: USAGE });
            sent();
            abortSignal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
          },
        }),
      }),
    });
    const controller = new AbortController();
    const res = await POST(
      new NextRequest("http://localhost:3099/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "done?" }] }], scope: "macro" }),
        signal: controller.signal,
      }),
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += decoder.decode(value, { stream: true });
        }
      } catch {
        // ignore
      }
    })();
    await allSent;
    // Event-driven: wait until the client has the text, then abort.
    expect(await waitFor(() => raw.includes("All done."), 2000)).toBe(true);
    controller.abort();
    expect(await waitFor(() => activeStreamCount(NO_SESSION_KEY, Date.now()) === 0, 2000)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(assistantRows()).toEqual(["All done."]);
    expect(usageLines().filter((l) => l.kind === "turn")).toHaveLength(1);
  });
});
