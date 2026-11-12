/**
 * The per-conversation model class on the server (owner-approved
 * 2026-11-13). The server is the authority:
 *   - the client sends `modelFamily` only when it creates a conversation;
 *   - the route validates it (an unknown value is a 400 naming the valid
 *     classes, before anything is saved), stores it on the NEW row, and for
 *     every later turn reads the class from the row and ignores the body;
 *   - no request can change a stored class.
 * The request is the same for every class except the model: the cache order
 * and the three marks are untouched, and the chat's request shape (adaptive
 * thinking, no effort, 16,000 output cap) is the same on Haiku 5.5, Sonnet
 * 5.5 and Opus 5.5 (Claude API reference, checked 2026-11-13). Account
 * failures are not failed over for any class (ruling D8: the chat is not
 * routed through lib/ai/failover.ts), exactly as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { resetChatBudgetStateForTests } from "@/lib/chat/budget";
import { CURRENT_CLASS_MODELS } from "@/lib/ai/model-tiers";
import { resolveFeatureModel } from "@/lib/ai/models";
import { USAGE_LINE_PREFIX } from "@/lib/chat/usage-log";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  streamTextMock: vi.fn(),
  failoverSpy: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, streamText: hoisted.streamTextMock };
});

// Every export of the failover module is a spy: the chat must touch none.
vi.mock("@/lib/ai/failover", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/ai/failover");
  const spied: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(actual)) {
    spied[k] = typeof v === "function" ? (...args: unknown[]) => { hoisted.failoverSpy(k, ...args); return (v as (...a: unknown[]) => unknown)(...args); } : v;
  }
  return spied;
});

import { POST } from "@/app/api/chat/route";
import { GET as listGET, POST as createPOST } from "@/app/api/chat/conversations/route";

const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } };

interface Captured {
  model: { modelId: string; provider: string };
  system: { role: string; content: string; providerOptions?: unknown }[];
  tools: Record<string, { providerOptions?: unknown }>;
  providerOptions: unknown;
  maxOutputTokens?: number;
  stopWhen?: unknown;
  onStepFinish: (step: unknown) => void;
}

let streamMeta: Array<(arg: { part: { type: string } }) => unknown> = [];

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new NextRequest("http://localhost:3099/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const hello = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }];

let captured: Captured[] = [];

function storedFamily(id: number): string | null {
  return (hoisted.db.prepare("SELECT model_family FROM chat_conversations WHERE id = ?").get(id) as {
    model_family: string | null;
  }).model_family;
}
function conversationCount(): number {
  return (hoisted.db.prepare("SELECT COUNT(*) AS n FROM chat_conversations").get() as { n: number }).n;
}
async function send(body: Record<string, unknown>) {
  const res = await post(body);
  return { res, id: Number(res.headers.get("X-Conversation-Id")), opts: captured[captured.length - 1] };
}

describe("POST /api/chat — the conversation's model class", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    resetChatBudgetStateForTests();
    hoisted.db = new Database(":memory:");
    hoisted.db.pragma("foreign_keys = ON");
    runMigrations(hoisted.db);
    captured = [];
    streamMeta = [];
    hoisted.failoverSpy.mockReset();
    hoisted.streamTextMock.mockReset();
    hoisted.streamTextMock.mockImplementation((opts: Captured) => {
      captured.push(opts);
      return {
        toUIMessageStreamResponse: ({
          headers,
          messageMetadata,
        }: {
          headers?: Record<string, string>;
          messageMetadata: (arg: { part: { type: string } }) => unknown;
        }) => {
          streamMeta.push(messageMetadata);
          return new Response("ok", { status: 200, headers });
        },
      };
    });
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("a deleted conversation's next turn recreates it on the class the client sends (review item 2)", async () => {
    const first = await send({ messages: hello, scope: "all", modelFamily: "opus" });
    hoisted.db.prepare("DELETE FROM chat_conversations WHERE id = ?").run(first.id);
    // As the client now sends it: the open conversation's id and its known class.
    const next = await send({ messages: hello, scope: "all", conversationId: first.id, modelFamily: "opus" });
    expect(next.id).not.toBe(first.id);
    expect(storedFamily(next.id)).toBe("opus");
    expect(next.opts.model.modelId).toBe(CURRENT_CLASS_MODELS.opus);
  });

  it("the stream's start names the resolved model for the header (review item 4)", async () => {
    await send({ messages: hello, scope: "all", modelFamily: "opus" });
    const meta = streamMeta[streamMeta.length - 1];
    expect(meta({ part: { type: "start" } })).toEqual({ modelLabel: "Opus 5.5" });
    // The finish part is unchanged apart from the label it already had on start.
    expect(meta({ part: { type: "text-delta" } })).toBeUndefined();
  });

  it("a conversation with no class sends no label", async () => {
    await send({ messages: hello, scope: "all" });
    const meta = streamMeta[streamMeta.length - 1];
    expect(meta({ part: { type: "start" } })).toBeUndefined();
  });

  it.each(["haiku", "sonnet", "opus"] as const)("creating with %s stores the class and runs on its current id", async (family) => {
    const { res, id, opts } = await send({ messages: hello, scope: "all", modelFamily: family });
    expect(res.status).toBe(200);
    expect(storedFamily(id)).toBe(family);
    // A fresh test database has no stored catalog: the class's current id.
    expect(opts.model.modelId).toBe(CURRENT_CLASS_MODELS[family]);
    expect(opts.model.provider).toMatch(/^anthropic/);
  });

  it("creating with no class stores NULL and runs exactly as before (the chat default)", async () => {
    const { id, opts } = await send({ messages: hello, scope: "all" });
    expect(storedFamily(id)).toBeNull();
    expect(opts.model.modelId).toBe(resolveFeatureModel("chat").modelId);
  });

  it("an explicit null is the same as no class", async () => {
    const { id } = await send({ messages: hello, scope: "all", modelFamily: null });
    expect(storedFamily(id)).toBeNull();
  });

  it.each(["gpt", "Opus", "fable", "claude-opus-5-5", 3, ""])("an unknown class %j is a 400 naming the valid ones; nothing is saved", async (bad) => {
    const res = await post({ messages: hello, scope: "all", modelFamily: bad });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Valid: haiku, sonnet, opus\./);
    expect(conversationCount()).toBe(0);
    expect(hoisted.streamTextMock).not.toHaveBeenCalled();
  });

  it("a later turn reads the class from the row and ignores the body", async () => {
    const first = await send({ messages: hello, scope: "all", modelFamily: "opus" });
    const later = await send({ messages: hello, scope: "all", conversationId: first.id, modelFamily: "haiku" });
    expect(later.id).toBe(first.id);
    expect(later.opts.model.modelId).toBe(CURRENT_CLASS_MODELS.opus);
    expect(storedFamily(first.id)).toBe("opus");
    const noBody = await send({ messages: hello, scope: "all", conversationId: first.id });
    expect(noBody.opts.model.modelId).toBe(CURRENT_CLASS_MODELS.opus);
    expect(storedFamily(first.id)).toBe("opus");
  });

  it("an older conversation with no class stays on the default even when a class is sent", async () => {
    const old = Number(hoisted.db.prepare("INSERT INTO chat_conversations (scope) VALUES ('all')").run().lastInsertRowid);
    const { id, opts } = await send({ messages: hello, scope: "all", conversationId: old, modelFamily: "opus" });
    expect(id).toBe(old);
    expect(storedFamily(old)).toBeNull();
    expect(opts.model.modelId).toBe(resolveFeatureModel("chat").modelId);
  });

  it("an unknown conversation id starts a new conversation on the class sent", async () => {
    const { id } = await send({ messages: hello, scope: "all", conversationId: 999, modelFamily: "haiku" });
    expect(id).not.toBe(999);
    expect(storedFamily(id)).toBe("haiku");
  });

  it("the request is identical across classes except the model: cache order, marks, thinking, cap", async () => {
    const shapes = [];
    for (const family of ["haiku", "sonnet", "opus", null] as const) {
      const { opts } = await send({ messages: hello, scope: "all", ...(family ? { modelFamily: family } : {}) });
      const toolNames = Object.keys(opts.tools);
      shapes.push({
        system: opts.system,
        toolNames,
        lastToolMark: opts.tools[toolNames[toolNames.length - 1]].providerOptions,
        otherMarks: toolNames.slice(0, -1).filter((n) => opts.tools[n].providerOptions !== undefined),
        providerOptions: opts.providerOptions,
        maxOutputTokens: opts.maxOutputTokens,
      });
    }
    for (const s of shapes.slice(1)) expect(s).toEqual(shapes[0]);
    const s = shapes[0];
    expect(s.system[0].providerOptions).toEqual(EPHEMERAL);
    expect(s.system[1].providerOptions).toBeUndefined();
    expect(s.lastToolMark).toEqual(EPHEMERAL);
    expect(s.otherMarks).toEqual([]);
    expect(s.providerOptions).toEqual({
      anthropic: { thinking: { type: "adaptive" }, cacheControl: { type: "ephemeral" } },
    });
    expect(s.maxOutputTokens).toBe(16000);
  });

  it.each(["haiku", "sonnet", "opus", null] as const)(
    "an Anthropic account failure on %s is not failed over (as before)",
    async (family) => {
      const authError = Object.assign(new Error("invalid x-api-key"), {
        name: "AI_APICallError",
        statusCode: 401,
        data: { error: { type: "authentication_error" } },
      });
      hoisted.streamTextMock.mockImplementationOnce(() => {
        throw authError;
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await post({ messages: hello, scope: "all", ...(family ? { modelFamily: family } : {}) });
        expect(res.status).toBe(500);
        // One call, no second provider, and the failover module untouched.
        expect(hoisted.streamTextMock).toHaveBeenCalledTimes(1);
        expect(hoisted.failoverSpy).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    },
  );

  it("the usage log records the chosen class and the id the step used", async () => {
    const { opts, id } = await send({ messages: hello, scope: "all", modelFamily: "opus" });
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      opts.onStepFinish({
        text: "hi",
        usage: { outputTokens: 3, inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        response: { modelId: "claude-opus-5-5" },
        finishReason: "stop",
      });
      const line = logs.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith(USAGE_LINE_PREFIX));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line!.slice(USAGE_LINE_PREFIX.length));
      expect(parsed).toMatchObject({ conversationId: id, model: "claude-opus-5-5", modelFamily: "opus", modelFellBackFrom: null });
    } finally {
      logs.mockRestore();
    }
  });
});

describe("the conversation routes and the model class", () => {
  beforeEach(() => {
    hoisted.db = new Database(":memory:");
    hoisted.db.pragma("foreign_keys = ON");
    runMigrations(hoisted.db);
  });

  function createReq(body: unknown) {
    return new Request("http://localhost/api/chat/conversations", { method: "POST", body: JSON.stringify(body) });
  }

  it("POST /api/chat/conversations stores a valid class and refuses an unknown one", async () => {
    const ok = await (await createPOST(createReq({ scope: "all", modelFamily: "haiku" }))).json();
    expect(ok.success).toBe(true);
    expect(storedFamily(ok.data.id)).toBe("haiku");
    const none = await (await createPOST(createReq({ scope: "all" }))).json();
    expect(storedFamily(none.data.id)).toBeNull();
    const res = await createPOST(createReq({ scope: "all", modelFamily: "gpt" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Valid: haiku, sonnet, opus\./);
    expect(conversationCount()).toBe(2);
  });

  it("GET never lists a class row without a label, even when the resolver throws (live-run follow-up)", async () => {
    hoisted.db.prepare("INSERT INTO chat_conversations (scope, model_family) VALUES ('all', 'haiku')").run();
    const spy = vi.spyOn(await import("@/lib/chat/model-resolve"), "resolveChatModel").mockImplementation(() => {
      throw new Error("catalog read failed");
    });
    try {
      const body = await (await listGET()).json();
      expect(body.data.conversations[0].model_label).toBe("Haiku");
    } finally {
      spy.mockRestore();
    }
  });

  it("GET lists each conversation's class and its label; no class, no label", async () => {
    hoisted.db.prepare("INSERT INTO chat_conversations (scope, model_family) VALUES ('all', 'opus')").run();
    hoisted.db.prepare("INSERT INTO chat_conversations (scope) VALUES ('all')").run();
    const body = await (await listGET()).json();
    const rows = body.data.conversations as { model_family: string | null; model_label: string | null }[];
    const opus = rows.find((r) => r.model_family === "opus")!;
    const plain = rows.find((r) => r.model_family === null)!;
    expect(opus.model_label).toBe("Opus 5.5");
    expect(plain.model_label).toBeNull();
  });
});
