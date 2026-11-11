import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { createAnthropic } from "@ai-sdk/anthropic";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { runMigrations } from "@/lib/db/migrate";
import { resetChatBudgetStateForTests } from "@/lib/chat/budget";
import { resolveFeatureModel } from "@/lib/ai/models";
import { CHAT_TOOLS } from "@/lib/chat/tools";

// The conversation-tail cache can only hit when the history the client
// re-sends converts to EXACTLY the bytes the provider already saw. Every tool
// carries a compact `toModelOutput`; this pins that the tool_result sent on
// the live step (step 2 of the turn) and the tool_result for the same call
// when the next user message replays the full UI history are byte-identical.
// Real route, real streamText, real installed Anthropic provider; fetch is a
// stub that records request bodies and plays a scripted SSE reply.

type Script = { kind: "tool"; name: string; input: Record<string, unknown>; id: string } | { kind: "text"; text: string };

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  bodies: [] as Record<string, unknown>[],
  script: (() => ({ kind: "text", text: "OK." })) as (call: number) => unknown,
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
  const call = hoisted.bodies.length;
  hoisted.bodies.push(JSON.parse(String(init?.body ?? "{}")));
  const s = hoisted.script(call) as Script;
  const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const ev: { event: string; data: unknown }[] = [
    {
      event: "message_start",
      data: { type: "message_start", message: { id: `m${call}`, type: "message", role: "assistant", model: "stub", content: [], stop_reason: null, usage } },
    },
  ];
  if (s.kind === "tool") {
    ev.push(
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: s.id, name: s.name, input: {} } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(s.input) } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    );
  } else {
    ev.push(
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s.text } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    );
  }
  ev.push(
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: s.kind === "tool" ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  );
  return new Response(sse(ev), { status: 200, headers: { "content-type": "text/event-stream" } });
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

interface ApiBlock {
  type: string;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
}
interface ApiMessage {
  role: string;
  content: string | ApiBlock[];
}

/** The JSON bytes of the tool_result block for `toolUseId` in a request body. */
function toolResultBytes(body: Record<string, unknown>, toolUseId: string): string {
  for (const m of body.messages as ApiMessage[]) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "tool_result" && b.tool_use_id === toolUseId) return JSON.stringify(b);
  }
  throw new Error(`no tool_result for ${toolUseId}`);
}

/** Parse the route's UI message stream (SSE) back into the assistant message the client holds. */
async function assistantMessageFrom(res: Response, message?: UIMessage): Promise<UIMessage> {
  const text = await res.text();
  const chunks: UIMessageChunk[] = text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as UIMessageChunk);
  const stream = new ReadableStream<UIMessageChunk>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
  let last: UIMessage | undefined;
  for await (const m of readUIMessageStream({ stream, message })) last = m;
  if (!last) throw new Error("no assistant message");
  return last;
}

async function post(messages: unknown[], conversationId?: number): Promise<Response> {
  return POST(
    new NextRequest("http://localhost:3099/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, scope: "all", conversationId }),
    }),
  );
}

const u = (id: string, text: string) => ({ id, role: "user", parts: [{ type: "text", text }] });

/** One turn that calls `toolName`, then the next user message with the full UI history. */
async function liveAndReplay(toolName: string, input: Record<string, unknown>) {
  const id = `toolu_${toolName}`;
  hoisted.bodies = [];
  hoisted.script = (call) => (call === 0 ? { kind: "tool", name: toolName, input, id } : { kind: "text", text: "Done." });
  const first = await post([u("u1", "question")]);
  const convId = Number(first.headers.get("X-Conversation-Id"));
  const assistant = await assistantMessageFrom(first);
  expect(hoisted.bodies).toHaveLength(2);
  const live = toolResultBytes(hoisted.bodies[1], id);
  const turnOneBodies = hoisted.bodies;

  hoisted.bodies = [];
  hoisted.script = () => ({ kind: "text", text: "Next." });
  const second = await post([u("u1", "question"), assistant, u("u2", "and then?")], convId);
  await second.text();
  const replay = toolResultBytes(hoisted.bodies[0], id);
  return { live, replay, turnOneBodies, replayBody: hoisted.bodies[0] };
}

describe("tool_result replay is byte-identical (tail cache)", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    resetChatBudgetStateForTests();
    hoisted.db = new Database(":memory:");
    hoisted.db.pragma("foreign_keys = ON");
    runMigrations(hoisted.db);
    const sec = Number(
      hoisted.db
        .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES ('AAA', 'AAA Corp', 'Stock', 'USD')")
        .run().lastInsertRowid,
    );
    hoisted.db
      .prepare(
        "INSERT INTO holdings (account_id, security_id, as_of_date, quantity, cost_basis, source_key) VALUES (3, ?, '2026-11-10', 10, 80, 'test:aaa')",
      )
      .run(sec);
    hoisted.db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, '2026-11-10', 10)").run(sec);
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("a list tool's tool_result replays byte-identical (query_holdings)", async () => {
    const { live, replay } = await liveAndReplay("query_holdings", {});
    expect(live).toContain("AAA");
    expect(replay).toBe(live);
  });

  it("a composite tool's tool_result replays byte-identical (query_risk)", async () => {
    const { live, replay } = await liveAndReplay("query_risk", {});
    expect(replay).toBe(live);
  });

  it("the whole prefix of turn 2 up to the replayed result matches turn 1's last request", async () => {
    const { turnOneBodies, replayBody } = await liveAndReplay("query_holdings", {});
    const prior = turnOneBodies[1];
    expect(JSON.stringify(replayBody.tools)).toBe(JSON.stringify(prior.tools));
    expect(JSON.stringify((replayBody.system as unknown[])[0])).toBe(JSON.stringify((prior.system as unknown[])[0]));
    const priorMessages = JSON.stringify(prior.messages);
    const replayMessages = JSON.stringify((replayBody.messages as unknown[]).slice(0, (prior.messages as unknown[]).length));
    // Only the tail cache mark may move; strip cache_control before comparing.
    const strip = (s: string) => s.replace(/,"cache_control":\{"type":"ephemeral"\}/g, "");
    expect(strip(replayMessages)).toBe(strip(priorMessages));
  });

  it("sends every chat tool in fixed order with the cache mark on the last one only", async () => {
    const { turnOneBodies } = await liveAndReplay("query_holdings", {});
    for (const body of turnOneBodies) {
      const tools = body.tools as { name: string; cache_control?: unknown }[];
      expect(tools.map((t) => t.name)).toEqual(CHAT_TOOLS.map((t) => t.name));
      expect(tools.filter((t) => t.cache_control).map((t) => t.name)).toEqual([tools[tools.length - 1].name]);
    }
    expect(CHAT_TOOLS).toHaveLength(33);
  });

  it("an approved create_note continuation replays byte-identical", async () => {
    const id = "toolu_note";
    hoisted.bodies = [];
    hoisted.script = () => ({ kind: "tool", name: "create_note", input: { note_type: "journal", content: "rates" }, id });
    const first = await post([u("u1", "save a note")]);
    const convId = Number(first.headers.get("X-Conversation-Id"));
    const drafted = await assistantMessageFrom(first);
    const card = drafted.parts.find((p) => p.type === "tool-create_note") as { state: string; approval?: { id: string } };
    expect(card.state).toBe("approval-requested");

    // The owner clicks Save: the client marks the card and resends.
    const approved = {
      ...drafted,
      parts: drafted.parts.map((p) =>
        p === (card as unknown)
          ? { ...card, state: "approval-responded", approval: { id: card.approval!.id, approved: true } }
          : p,
      ),
    } as UIMessage;
    hoisted.bodies = [];
    hoisted.script = () => ({ kind: "text", text: "Saved." });
    const cont = await post([u("u1", "save a note"), approved], convId);
    const merged = await assistantMessageFrom(cont, approved);
    const live = toolResultBytes(hoisted.bodies[0], id);

    hoisted.bodies = [];
    const next = await post([u("u1", "save a note"), merged, u("u2", "thanks")], convId);
    await next.text();
    const replay = toolResultBytes(hoisted.bodies[0], id);
    expect(replay).toBe(live);
    expect((hoisted.db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n).toBe(1);
  });

  it("a turn restored after reload (text-only history) sends no tool blocks", async () => {
    hoisted.bodies = [];
    hoisted.script = () => ({ kind: "text", text: "Next." });
    const res = await post([
      u("u1", "question"),
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Done." }] },
      u("u2", "and then?"),
    ]);
    await res.text();
    const sent = JSON.stringify(hoisted.bodies[0].messages);
    expect(sent).not.toContain("tool_use");
    expect(sent).not.toContain("tool_result");
  });
});
