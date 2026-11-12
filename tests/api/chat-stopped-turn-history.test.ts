import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { createAnthropic } from "@ai-sdk/anthropic";
import { runMigrations } from "@/lib/db/migrate";
import { resetChatBudgetStateForTests } from "@/lib/chat/budget";
import { resolveFeatureModel } from "@/lib/ai/models";
import { UNANSWERED_PRIOR_NOTE } from "@/lib/chat/history";

// Browser pass, item 2: a reply stopped before it wrote any text stays in the
// client's history as an assistant message with nothing in it (the panel shows
// "Stopped."), so the next request carries two questions in a row. Live, the
// model answered the OLD question first. The route drops the empty assistant
// message (the provider gets a valid request) and tells the model, in the
// volatile block for that request only, to answer the latest message. Real
// route, real streamText, real installed Anthropic provider; fetch is a stub.

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  bodies: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

function sse(events: { event: string; data: unknown }[]): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
}

async function stubFetch(_url: unknown, init?: RequestInit): Promise<Response> {
  hoisted.bodies.push(JSON.parse(String(init?.body ?? "{}")));
  const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const body = sse([
    {
      event: "message_start",
      data: { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "stub", content: [], stop_reason: null, usage } },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK." } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

vi.mock("@/lib/ai/provider", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/provider")>("@/lib/ai/provider");
  return {
    ...actual,
    getModelForFeature: (feature: Parameters<typeof resolveFeatureModel>[0]) =>
      createAnthropic({ apiKey: "sk-test-not-real", fetch: stubFetch as typeof fetch })(
        resolveFeatureModel(feature).modelId,
      ),
  };
});

import { POST } from "@/app/api/chat/route";


const u = (id: string, text: string) => ({ id, role: "user", parts: [{ type: "text", text }] });

interface ApiMessage {
  role: string;
  content: string | { type: string; text?: string }[];
}

async function send(messages: unknown[]): Promise<{ status: number; body: Record<string, unknown> }> {
  hoisted.bodies = [];
  const res = await POST(
    new NextRequest("http://localhost:3099/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, scope: "macro" }),
    }),
  );
  await res.text();
  await new Promise((r) => setTimeout(r, 10));
  expect(hoisted.bodies.length).toBeGreaterThan(0);
  return { status: res.status, body: hoisted.bodies[0] };
}

const volatileOf = (body: Record<string, unknown>) => (body.system as { text: string }[])[1].text;
const staticOf = (body: Record<string, unknown>) => JSON.stringify((body.system as unknown[])[0]);

describe("a stopped reply with no text, then a new question (browser pass item 2)", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    resetChatBudgetStateForTests();
    hoisted.db = new Database(":memory:");
    hoisted.db.pragma("foreign_keys = ON");
    runMigrations(hoisted.db);
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  // The shapes a stopped-before-text reply can take in the client's history.
  const emptyReplies = [
    { id: "a1", role: "assistant", parts: [] },
    { id: "a1", role: "assistant", parts: [{ type: "step-start" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [{ type: "step-start" }, { type: "reasoning", text: "half a thought", state: "streaming" }],
    },
  ];

  it("the request is valid and the model is told to answer the latest message", async () => {
    for (const empty of emptyReplies) {
      const { status, body } = await send([u("u1", "old question"), empty, u("u2", "new question")]);
      expect(status).toBe(200);
      const messages = body.messages as ApiMessage[];
      // No assistant message with nothing in it reaches the provider.
      for (const m of messages) {
        if (m.role === "assistant") expect(Array.isArray(m.content) ? m.content.length : 1).toBeGreaterThan(0);
      }
      expect(JSON.stringify(messages)).not.toContain("half a thought");
      // The last user content is the new question.
      const last = messages[messages.length - 1];
      expect(last.role).toBe("user");
      expect(JSON.stringify(last.content)).toContain("new question");
      expect(volatileOf(body).endsWith(UNANSWERED_PRIOR_NOTE)).toBe(true);
    }
  });

  it("two questions in a row after a reload (nothing was saved) get the same note", async () => {
    const { body } = await send([u("u1", "old question"), u("u2", "new question")]);
    expect(volatileOf(body).endsWith(UNANSWERED_PRIOR_NOTE)).toBe(true);
  });

  it("a normal history carries no note, and the static block is untouched", async () => {
    const normal = await send([
      u("u1", "old question"),
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Old answer." }] },
      u("u2", "new question"),
    ]);
    expect(volatileOf(normal.body)).not.toContain(UNANSWERED_PRIOR_NOTE);
    const stopped = await send([u("u1", "old question"), u("u2", "new question")]);
    expect(staticOf(stopped.body)).toBe(staticOf(normal.body));
  });
});
