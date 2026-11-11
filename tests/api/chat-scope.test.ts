import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { resetChatBudgetStateForTests } from "@/lib/chat/budget";

// Portfolio Assistant plan, Task 3 item J (B1 route half, P1, P2, P10,
// Contracts H and I). The route resolves the chat scope to an id list by its
// scope word, hands that list to the summary, and clamps every tool call to
// it. Migration 002 seeds Vanguard Taxable (1), Vanguard Roth IRA (2), IBKR (3).

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  streamTextMock: vi.fn(),
  summaryMock: vi.fn((...args: unknown[]) => (args.length > 0 ? "SUMMARY-MARKER" : "")),
  ibkrMock: vi.fn(),
  executeToolMock: vi.fn(async (...args: unknown[]) => ({ data: [], argCount: args.length })),
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

vi.mock("@/lib/queries/portfolio-summary", () => ({
  getPortfolioSummaryForChat: hoisted.summaryMock,
}));

vi.mock("@/lib/chat/ibkr-context", () => ({
  computeIbkrTradingContext: hoisted.ibkrMock,
}));

vi.mock("@/lib/chat/tools", async () => {
  const actual = await vi.importActual<typeof import("@/lib/chat/tools")>("@/lib/chat/tools");
  return { ...actual, executeTool: hoisted.executeToolMock };
});

import { POST } from "@/app/api/chat/route";

interface CapturedTool {
  execute: (input: Record<string, unknown>, opts: { abortSignal?: AbortSignal; toolCallId: string; messages: [] }) => Promise<unknown>;
}
interface Captured {
  system: { content: string }[];
  tools: Record<string, CapturedTool>;
}

async function capture(scope: string): Promise<Captured> {
  let captured: Captured | undefined;
  hoisted.streamTextMock.mockImplementation((opts: Captured) => {
    captured = opts;
    return { toUIMessageStreamResponse: () => new Response("ok", { status: 200 }) };
  });
  const res = await POST(
    new NextRequest("http://localhost:3099/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }], scope }),
    }),
  );
  expect(res.status).toBe(200);
  if (!captured) throw new Error("streamText not called");
  return captured;
}

function addAccount(name: string): number {
  return Number(hoisted.db.prepare("INSERT INTO accounts (name) VALUES (?)").run(name).lastInsertRowid);
}

describe("POST /api/chat — scope (Contract I, P1, P2)", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    resetChatBudgetStateForTests();
    hoisted.db = new Database(":memory:");
    hoisted.db.pragma("foreign_keys = ON");
    runMigrations(hoisted.db);
    hoisted.streamTextMock.mockReset();
    hoisted.summaryMock.mockClear();
    hoisted.ibkrMock.mockReset();
    hoisted.executeToolMock.mockClear();
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("the summary receives the scope's id list", async () => {
    const two = addAccount("IBKR Two");
    const opts = await capture("ibkr");
    expect(hoisted.summaryMock).toHaveBeenCalledTimes(1);
    expect(hoisted.summaryMock.mock.calls[0][1]).toEqual({ accountIds: [3, two], label: "IBKR" });
    expect(opts.system[1].content).toContain("SUMMARY-MARKER");
  });

  it("the all scope reads every account; macro reads no summary", async () => {
    await capture("all");
    expect(hoisted.summaryMock.mock.calls[0][1]).toBeUndefined();
    hoisted.summaryMock.mockClear();
    await capture("macro");
    expect(hoisted.summaryMock).not.toHaveBeenCalled();
  });

  it("an unresolvable scope hands the summary an empty list, never the whole book", async () => {
    hoisted.db.prepare("DELETE FROM accounts WHERE name = 'IBKR'").run();
    await capture("ibkr");
    expect(hoisted.summaryMock.mock.calls[0][1]).toEqual({ accountIds: [], label: "IBKR" });
    expect(hoisted.ibkrMock).not.toHaveBeenCalled();
  });

  it("a one-account IBKR scope builds the dashboard for that account", async () => {
    hoisted.ibkrMock.mockReturnValue(undefined);
    await capture("ibkr");
    expect(hoisted.ibkrMock).toHaveBeenCalledWith(expect.anything(), 3, "IBKR");
  });

  it("a two-account IBKR scope leaves the dashboard out with a note", async () => {
    addAccount("IBKR Two");
    const opts = await capture("ibkr");
    expect(hoisted.ibkrMock).not.toHaveBeenCalled();
    expect(opts.system[1].content).toContain(
      "The IBKR scope covers 2 accounts; the trading dashboard covers one account and is left out.",
    );
  });

  it("tool calls are clamped to the scope and receive the scope's ids and the abort signal (Contract H)", async () => {
    const two = addAccount("IBKR Two");
    const opts = await capture("ibkr");
    const signal = new AbortController().signal;
    const ctx = { abortSignal: signal, toolCallId: "t", messages: [] as [] };

    await opts.tools.query_holdings.execute({ account_name: "Vanguard Taxable" }, ctx);
    const [, name, input, toolOpts] = hoisted.executeToolMock.mock.calls.at(-1)!;
    expect(name).toBe("query_holdings");
    expect((input as Record<string, unknown>).account_name).toBe("ibkr");
    expect(toolOpts).toEqual({ abortSignal: signal, scopeAccountIds: [3, two] });

    await opts.tools.query_holdings.execute({ account_name: "IBKR Two" }, ctx);
    const [, , narrower] = hoisted.executeToolMock.mock.calls.at(-1)!;
    expect((narrower as Record<string, unknown>).account_name).toBe("IBKR Two");
  });

  it("the all scope passes no scope ids to tools", async () => {
    const opts = await capture("all");
    const signal = new AbortController().signal;
    await opts.tools.query_holdings.execute({ account_name: "IBKR" }, { abortSignal: signal, toolCallId: "t", messages: [] });
    const [, , input, toolOpts] = hoisted.executeToolMock.mock.calls.at(-1)!;
    expect((input as Record<string, unknown>).account_name).toBe("IBKR");
    expect(toolOpts).toEqual({ abortSignal: signal, scopeAccountIds: undefined });
  });
});
