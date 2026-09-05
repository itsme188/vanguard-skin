/**
 * `GET /api/print-watch/sources` (slice F task 8, Codex round 1 finding 11).
 *
 * Slice B shipped this route with a PUT only, and its PUT treats an empty
 * `irPageUrl` as CLEAR. A UI built on PUT alone therefore opens with an empty
 * box over a configured row and erases it on the first Save. The read below is
 * what makes `IrPageField` safe: it can show what is stored before it offers
 * to change it.
 *
 * Synthetic ticker only (R-F8).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

let db: Database.Database;
vi.mock("@/lib/db", () => ({
  get db() {
    return db;
  },
}));

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.resetModules();
});

describe("GET /api/print-watch/sources", () => {
  it("returns null for a symbol with nothing stored — not a 404", async () => {
    const { GET } = await import("@/app/api/print-watch/sources/route");
    const res = await GET(new Request("http://localhost/api/print-watch/sources?symbol=XMPL1") as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: null });
  });

  it("returns what the PUT stored, uppercasing the symbol the same way", async () => {
    const { GET, PUT } = await import("@/app/api/print-watch/sources/route");
    await PUT(
      new Request("http://localhost/api/print-watch/sources", {
        method: "PUT",
        body: JSON.stringify({
          symbol: "xmpl1",
          irPageUrl: "https://example.com/ir",
          linkMustContain: "press",
        }),
      }) as never,
    );
    const body = await (
      await GET(new Request("http://localhost/api/print-watch/sources?symbol=xmpl1") as never)
    ).json();
    expect(body).toEqual({
      success: true,
      data: { symbol: "XMPL1", irPageUrl: "https://example.com/ir", linkMustContain: "press" },
    });
  });

  it("refuses a missing or malformed symbol with 400 and says which", async () => {
    const { GET } = await import("@/app/api/print-watch/sources/route");
    expect((await GET(new Request("http://localhost/api/print-watch/sources") as never)).status).toBe(400);
    expect(
      (await GET(new Request("http://localhost/api/print-watch/sources?symbol=AC%20ME") as never)).status,
    ).toBe(400);
  });

  it("reports an absent row as null AFTER a clear, so the field can disable its clear button honestly", async () => {
    const { GET, PUT } = await import("@/app/api/print-watch/sources/route");
    const put = (body: Record<string, unknown>) =>
      PUT(
        new Request("http://localhost/api/print-watch/sources", {
          method: "PUT",
          body: JSON.stringify(body),
        }) as never,
      );
    await put({ symbol: "XMPL2", irPageUrl: "https://example.com/newsroom" });
    await put({ symbol: "XMPL2", irPageUrl: "" });
    const body = await (
      await GET(new Request("http://localhost/api/print-watch/sources?symbol=XMPL2") as never)
    ).json();
    expect(body).toEqual({ success: true, data: null });
  });
});
