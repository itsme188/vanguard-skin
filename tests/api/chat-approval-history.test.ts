import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { createAnthropic } from "@ai-sdk/anthropic";
import { runMigrations } from "@/lib/db/migrate";
import { resetChatBudgetStateForTests } from "@/lib/chat/budget";
import { resolveFeatureModel } from "@/lib/ai/models";

// Review R3-1 (blocker): after an approval card, the history the route sends
// the provider must never carry a tool_use without its tool_result, or the API
// answers 400 and the conversation is stuck. This runs the REAL route, real
// streamText and the REAL installed Anthropic provider (its own message
// conversion); only fetch is a stub that records the request body and answers
// with a short text reply. No network.

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

const NOTE = { note_type: "journal", content: "rates" };
const u = (id: string, text: string) => ({ id, role: "user", parts: [{ type: "text", text }] });
const a = (id: string, text: string) => ({ id, role: "assistant", parts: [{ type: "text", text }] });
function noteCard(state: string, approval?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "step-start" },
      { type: "tool-create_note", toolCallId: "toolu_note", state, input: NOTE, ...(approval ? { approval } : {}), ...extra },
    ],
  };
}

interface ApiBlock {
  type: string;
  id?: string;
  tool_use_id?: string;
}
interface ApiMessage {
  role: string;
  content: string | ApiBlock[];
}

/** Every tool_use id in the request whose next message carries no tool_result for it. */
function unpairedToolUses(body: Record<string, unknown>): string[] {
  const messages = body.messages as ApiMessage[];
  const unpaired: string[] = [];
  messages.forEach((m, i) => {
    if (m.role !== "assistant" || typeof m.content === "string") return;
    const next = messages[i + 1];
    const results = new Set(
      next && typeof next.content !== "string"
        ? next.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id)
        : [],
    );
    for (const b of m.content) if (b.type === "tool_use" && !results.has(b.id)) unpaired.push(b.id ?? "?");
  });
  return unpaired;
}

async function send(messages: unknown[]): Promise<{ status: number; body: Record<string, unknown> }> {
  hoisted.bodies = [];
  const res = await POST(
    new NextRequest("http://localhost:3099/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, scope: "all" }),
    }),
  );
  await res.text();
  await new Promise((r) => setTimeout(r, 10));
  expect(hoisted.bodies.length).toBeGreaterThan(0);
  return { status: res.status, body: hoisted.bodies[0] };
}

const noteCount = () => (hoisted.db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n;

describe("approval history reaches the provider paired (R3-1)", () => {
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

  it("approve, the continuation fails, then a new user message", async () => {
    // The approval response was given but the request that would have run it
    // never finished, so the card is still approval-responded.
    const { status, body } = await send([
      u("u1", "save a note"),
      noteCard("approval-responded", { id: "ap1", approved: true }),
      u("u2", "hello again"),
    ]);
    expect(status).toBe(200);
    expect(unpairedToolUses(body)).toEqual([]);
    // The old approval is not run on an unrelated message.
    expect(noteCount()).toBe(0);
  });

  it("approve, reload, then a new message", async () => {
    // A reload rebuilds the history from stored text rows only.
    const { body } = await send([u("u1", "save a note"), a("a1", "Saved your note."), u("u2", "thanks")]);
    expect(unpairedToolUses(body)).toEqual([]);
  });

  it("approve, the continuation ran, then a new message", async () => {
    const { body } = await send([
      u("u1", "save a note"),
      noteCard("output-available", { id: "ap1", approved: true }, { output: { data: { saved: true } } }),
      u("u2", "thanks"),
    ]);
    expect(unpairedToolUses(body)).toEqual([]);
  });

  it("deny, then a new message", async () => {
    for (const state of ["output-denied", "approval-responded"]) {
      const card = noteCard(state, { id: "ap1", approved: false, reason: "Owner chose not to save" });
      const { status, body } = await send([u("u1", "save a note"), card, u("u2", "never mind")]);
      expect(status).toBe(200);
      expect(unpairedToolUses(body), state).toEqual([]);
    }
    expect(noteCount()).toBe(0);
  });

  it("approval pending, then a new message", async () => {
    const { status, body } = await send([
      u("u1", "save a note"),
      noteCard("approval-requested", { id: "ap1" }),
      u("u2", "actually, what moved today?"),
    ]);
    expect(status).toBe(200);
    expect(unpairedToolUses(body)).toEqual([]);
    expect(noteCount()).toBe(0);
  });
});
