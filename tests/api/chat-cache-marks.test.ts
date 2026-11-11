import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { resetChatBudgetStateForTests } from "@/lib/chat/budget";
import { buildSystemPromptBlocks } from "@/lib/chat/system-prompt";

// Portfolio Assistant plan, Contract D items 4-7 (cost fix R1): the request is
// ordered tools (mark on the last) -> static system block (mark) -> volatile
// system block (no mark) -> messages (top-level automatic mark). Three marks
// in all; the fourth slot stays free.

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  streamTextMock: vi.fn(),
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

import { POST } from "@/app/api/chat/route";

const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } };

interface CapturedOptions {
  system: { role: string; content: string; providerOptions?: unknown }[];
  tools: Record<string, { providerOptions?: unknown; needsApproval?: unknown }>;
  providerOptions: { anthropic: Record<string, unknown> };
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new NextRequest("http://localhost:3099/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function capture(body: Record<string, unknown>): Promise<CapturedOptions> {
  let captured: CapturedOptions | undefined;
  hoisted.streamTextMock.mockImplementation((opts: CapturedOptions) => {
    captured = opts;
    return { toUIMessageStreamResponse: () => new Response("ok", { status: 200 }) };
  });
  const res = await post(body);
  expect(res.status).toBe(200);
  if (!captured) throw new Error("streamText was not called");
  return captured;
}

const hello = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }];

describe("POST /api/chat — cache marks (Contract D)", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    resetChatBudgetStateForTests();
    hoisted.db = new Database(":memory:");
    hoisted.db.pragma("foreign_keys = ON");
    runMigrations(hoisted.db);
    hoisted.streamTextMock.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("marks exactly the first of two system blocks", async () => {
    const opts = await capture({ messages: hello, scope: "all" });
    expect(Array.isArray(opts.system)).toBe(true);
    expect(opts.system).toHaveLength(2);
    expect(opts.system[0].providerOptions).toEqual(EPHEMERAL);
    expect(opts.system[1].providerOptions).toBeUndefined();
  });

  it("the marked block is the static block; the date lives in the unmarked one", async () => {
    const opts = await capture({ messages: hello, scope: "macro" });
    const expected = buildSystemPromptBlocks({ scope: "macro", currentDate: "2000-01-01", portfolioContext: "" });
    expect(opts.system[0].content).toBe(expected.staticBlock);
    expect(opts.system[1].content).toMatch(/^## Today\n\nToday's date is \d{4}-\d{2}-\d{2} \(Eastern\)\./);
  });

  it("marks exactly one tool, the last by position", async () => {
    const opts = await capture({ messages: hello, scope: "all" });
    const names = Object.keys(opts.tools);
    expect(names.length).toBeGreaterThan(1);
    const marked = names.filter((n) => opts.tools[n].providerOptions !== undefined);
    expect(marked).toEqual([names[names.length - 1]]);
    expect(opts.tools[names[names.length - 1]].providerOptions).toEqual(EPHEMERAL);
  });

  it("sets the top-level automatic mark beside thinking, and nothing else is marked", async () => {
    const opts = await capture({ messages: hello, scope: "all" });
    expect(opts.providerOptions.anthropic.cacheControl).toEqual({ type: "ephemeral" });
    expect(opts.providerOptions.anthropic.thinking).toEqual({ type: "adaptive" });
    // Total marks: tool + static system + automatic = 3.
    const marks =
      opts.system.filter((s) => s.providerOptions).length +
      Object.values(opts.tools).filter((t) => t.providerOptions).length +
      (opts.providerOptions.anthropic.cacheControl ? 1 : 0);
    expect(marks).toBe(3);
  });

  it("keeps an explicit output cap and passes the request's abort signal", async () => {
    const opts = await capture({ messages: hello, scope: "all" });
    expect(opts.maxOutputTokens).toBeGreaterThan(0);
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("passes create_note's approval gate through to the SDK tool", async () => {
    const opts = await capture({ messages: hello, scope: "all" });
    expect(opts.tools.create_note.needsApproval).toBe(true);
    expect(opts.tools.query_holdings.needsApproval).toBeUndefined();
  });

  it("the page note is resolved on the server; client text never reaches the prompt", async () => {
    const id = Number(
      hoisted.db
        .prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('AAA', 'AAA Corp', 'Stock')")
        .run().lastInsertRowid,
    );
    const opts = await capture({
      messages: hello,
      scope: "all",
      page: { path: `/dashboard/security/${id}` },
      pageContext: "INJECTED-CLIENT-TEXT",
    });
    const all = opts.system.map((s) => s.content).join("\n");
    expect(all).not.toContain("INJECTED-CLIENT-TEXT");
    expect(opts.system[0].content).not.toContain("AAA");
    expect(opts.system[1].content).toContain("[Current Page]\nUser is viewing the Security Detail page for AAA");
  });
});
