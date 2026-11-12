import { describe, it, expect } from "vitest";
import {
  convertToModelMessages,
  streamText,
  tool,
  jsonSchema,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import {
  sanitizeUiHistory,
  findOrphanToolCalls,
  dropOrphanToolCalls,
  markLastMessageForCache,
  dropEmptyAssistantMessages,
  unansweredPriorNote,
  UNANSWERED_PRIOR_NOTE,
} from "@/lib/chat/history";

// Portfolio Assistant plan, Task 3 item H: the history the route sends the
// model must never carry a tool call without its result (an aborted turn, a
// stale approval card), while an approved continuation must survive intact so
// the SDK can execute it.

// The provider's stream-part type, derived from the mock (the provider spec
// package is not a declared dependency).
type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type LanguageModelV3StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function textStream(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage: USAGE },
  ];
}

const user = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

const completedToolTurn: UIMessage = {
  id: "a1",
  role: "assistant",
  parts: [
    { type: "step-start" },
    {
      type: "tool-query_holdings",
      toolCallId: "call-done",
      state: "output-available",
      input: { symbol: "AAA" },
      output: { data: [] },
    },
    { type: "step-start" },
    { type: "text", text: "No position.", state: "done" },
  ],
} as UIMessage;

describe("sanitizeUiHistory", () => {
  it("an aborted tool call is dropped", async () => {
    const aborted = {
      id: "a2",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: "Checking.", state: "done" },
        { type: "tool-query_holdings", toolCallId: "call-aborted", state: "input-available", input: {} },
        { type: "tool-query_fred", toolCallId: "call-streaming", state: "input-streaming", input: undefined },
      ],
    } as UIMessage;
    const out = sanitizeUiHistory([user("u1", "hi"), aborted, user("u2", "again")]);
    const parts = out[1].parts.map((p) => p.type);
    expect(parts).toEqual(["step-start", "text"]);

    const model = await convertToModelMessages(out);
    expect(findOrphanToolCalls(model)).toEqual([]);
  });

  it("a stale approval request does not reach the model unpaired", async () => {
    const stale = {
      id: "a3",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-create_note",
          toolCallId: "call-stale",
          state: "approval-requested",
          input: { content: "draft" },
          approval: { id: "approval-stale" },
        },
      ],
    } as UIMessage;
    // The owner ignored the card and typed a new message.
    const out = sanitizeUiHistory([user("u1", "save a note"), stale, user("u2", "never mind")]);
    const part = out[1].parts[1] as { state: string; approval?: { id: string; approved?: boolean; reason?: string } };
    expect(part.state).toBe("output-denied");
    expect(part.approval).toEqual({ id: "approval-stale", approved: false, reason: "Not confirmed" });

    const model = await convertToModelMessages(out);
    expect(findOrphanToolCalls(model)).toEqual([]);
    // The model is told the call was not run.
    const toolMsg = model.find((m) => m.role === "tool");
    expect(JSON.stringify(toolMsg)).toContain("Not confirmed");
  });

  it("a complete history passes unchanged", async () => {
    const history = [user("u1", "hi"), completedToolTurn, user("u2", "and now?")];
    const out = sanitizeUiHistory(history);
    expect(out).toEqual(history);
    expect(findOrphanToolCalls(await convertToModelMessages(out))).toEqual([]);
  });

  it("an approval card in the final message is left alone", () => {
    const pending = {
      id: "a4",
      role: "assistant",
      parts: [
        {
          type: "tool-create_note",
          toolCallId: "call-pending",
          state: "approval-responded",
          input: { content: "draft" },
          approval: { id: "approval-1", approved: true },
        },
      ],
    } as UIMessage;
    const history = [user("u1", "save it"), pending];
    expect(sanitizeUiHistory(history)).toEqual(history);
  });
});

describe("findOrphanToolCalls / dropOrphanToolCalls", () => {
  it("finds a tool call with no result and removes it", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking." },
          { type: "tool-call", toolCallId: "orphan", toolName: "query_holdings", input: {} },
          { type: "tool-call", toolCallId: "paired", toolName: "query_fred", input: {} },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "paired", toolName: "query_fred", output: { type: "json", value: {} } }],
      },
      { role: "user", content: "next" },
    ];
    expect(findOrphanToolCalls(messages)).toEqual(["orphan"]);
    const cleaned = dropOrphanToolCalls(messages, ["orphan"]);
    expect(findOrphanToolCalls(cleaned)).toEqual([]);
    const assistant = cleaned[1] as { content: { type: string; toolCallId?: string }[] };
    expect(assistant.content.map((p) => p.toolCallId ?? p.type)).toEqual(["text", "paired"]);
  });

  it("an approval followed by a later user message is an orphan, not exempt (R3-1)", () => {
    const approved: ModelMessage[] = [
      { role: "user", content: "save a note" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "n1", toolName: "create_note", input: {} },
          { type: "tool-approval-request", approvalId: "ap1", toolCallId: "n1" },
        ],
      },
      { role: "tool", content: [{ type: "tool-approval-response", approvalId: "ap1", approved: true }] },
    ];
    // As the continuation (final messages): exempt, the SDK executes it.
    expect(findOrphanToolCalls(approved)).toEqual([]);
    // With a new user message after it: it will never run, so it is an orphan.
    expect(findOrphanToolCalls([...approved, { role: "user", content: "hello again" }])).toEqual(["n1"]);
  });

  it("an approval-responded card before the final message becomes a paired denial (R3-1)", async () => {
    const card = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-create_note",
          toolCallId: "n1",
          state: "approval-responded",
          input: {},
          approval: { id: "ap1", approved: true },
        },
      ],
    } as UIMessage;
    const out = sanitizeUiHistory([user("u1", "save"), card, user("u2", "hello again")]);
    const part = out[1].parts[0] as { state: string; approval: { approved: boolean } };
    expect(part.state).toBe("output-denied");
    expect(part.approval.approved).toBe(false);
    expect(findOrphanToolCalls(await convertToModelMessages(out))).toEqual([]);
  });

  it("an assistant message left empty by the drop is removed", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "orphan", toolName: "q", input: {} }] },
      { role: "user", content: "next" },
    ];
    const cleaned = dropOrphanToolCalls(messages, findOrphanToolCalls(messages));
    expect(cleaned.map((m) => m.role)).toEqual(["user", "user"]);
  });
});

describe("approved continuation", () => {
  it("an approved continuation survives and the SDK executes it", async () => {
    let runs = 0;
    const tools = {
      create_note: tool({
        description: "save a note",
        inputSchema: jsonSchema<Record<string, unknown>>({ type: "object", properties: { content: { type: "string" } } }),
        needsApproval: true,
        execute: async () => {
          runs++;
          return { saved: true };
        },
      }),
    };
    const continuation = {
      id: "a5",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-create_note",
          toolCallId: "call-approved",
          state: "approval-responded",
          input: { content: "draft" },
          approval: { id: "approval-ok", approved: true },
        },
      ],
    } as UIMessage;

    const sanitized = sanitizeUiHistory([user("u1", "save a note saying draft"), continuation]);
    const model = await convertToModelMessages(sanitized, { tools, ignoreIncompleteToolCalls: true });
    expect(findOrphanToolCalls(model)).toEqual([]);

    const mock = new MockLanguageModelV3({
      doStream: async () => ({ stream: convertArrayToReadableStream(textStream("Saved.")) }),
    });
    const result = streamText({ model: mock, tools, messages: model });
    await result.consumeStream();
    expect(runs).toBe(1);
    expect(await result.text).toBe("Saved.");
  });
});

describe("markLastMessageForCache (unused fallback, Contract D item 6)", () => {
  it("marks only the last message and leaves the input untouched", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three", providerOptions: { other: { keep: true } } },
    ];
    const marked = markLastMessageForCache(messages);
    expect(marked[0]).toBe(messages[0]);
    expect(marked[1]).toBe(messages[1]);
    expect(marked[2].providerOptions).toEqual({
      other: { keep: true },
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(messages[2].providerOptions).toEqual({ other: { keep: true } });
    expect(markLastMessageForCache([])).toEqual([]);
  });
});


describe("stopped replies with no text (browser pass item 2)", () => {
  const empty = { id: "a1", role: "assistant", parts: [{ type: "step-start" }, { type: "reasoning", text: "x" }] } as UIMessage;
  const answered = { id: "a2", role: "assistant", parts: [{ type: "text", text: "Answer." }] } as UIMessage;

  it("an empty assistant message is dropped; a real one is kept", () => {
    const out = dropEmptyAssistantMessages([user("u1", "q1"), empty, user("u2", "q2")]);
    expect(out.map((m) => m.id)).toEqual(["u1", "u2"]);
    const history = [user("u1", "q1"), answered, user("u2", "q2")];
    expect(dropEmptyAssistantMessages(history)).toBe(history);
  });

  it("two questions in a row get the note; an answered one does not", () => {
    expect(unansweredPriorNote([user("u1", "q1"), empty, user("u2", "q2")])).toBe(UNANSWERED_PRIOR_NOTE);
    expect(unansweredPriorNote([user("u1", "q1"), user("u2", "q2")])).toBe(UNANSWERED_PRIOR_NOTE);
    expect(unansweredPriorNote([user("u1", "q1"), answered, user("u2", "q2")])).toBeUndefined();
    expect(unansweredPriorNote([user("u1", "q1")])).toBeUndefined();
  });
});
