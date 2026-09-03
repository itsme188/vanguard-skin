/**
 * HTTP-boundary tests for PUT /api/print-watch/sources (slice B, Task 12).
 *
 * Same harness as tests/api/print-watch-routes.test.ts: vi.mock the db
 * singleton with an in-memory migrated getter, NextRequest, dynamic import.
 * Kept in its own file (controller ruling R-B3) so this task never touches a
 * file another slice-B agent is editing.
 *
 * The route is a `human` route by the proxy's DEFAULT classification (session
 * + CSRF + trusted Origin on unsafe methods) — there is deliberately no
 * lib/auth/route-policy.ts entry, and none is needed: classifyRoute() returns
 * "human" for anything not carved out. These tests drive the handler directly,
 * exactly as the sibling print-watch route tests do.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { getPrintWatchSource, upsertPrintWatchSource } from "@/lib/print-watch/store";
import { classifyRoute } from "@/lib/auth/route-policy";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

function putReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/print-watch/sources", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

afterEach(() => {
  hoisted.db.close();
});

describe("PUT /api/print-watch/sources", () => {
  it("upserts a stored IR page after validating the URL, and clears it on an empty url", async () => {
    const { PUT } = await import("@/app/api/print-watch/sources/route");

    const ok = await PUT(
      putReq({
        symbol: "acme",
        irPageUrl: "https://ir.acme.example/news",
        linkMustContain: "Results",
      }),
    );
    expect(ok.status).toBe(200);
    expect(
      ((await ok.json()) as { data: { symbol: string; ir_page_url: string; link_must_contain: string } }).data,
    ).toMatchObject({
      symbol: "ACME",
      ir_page_url: "https://ir.acme.example/news",
      link_must_contain: "Results",
    });

    const bad = await PUT(putReq({ symbol: "ACME", irPageUrl: "http://ir.acme.example/news" }));
    expect(bad.status).toBe(400);
    // The stored row is untouched by a refused update.
    expect(getPrintWatchSource(hoisted.db, "ACME")?.ir_page_url).toBe("https://ir.acme.example/news");

    const cleared = await PUT(putReq({ symbol: "ACME", irPageUrl: "" }));
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { data: { cleared: boolean } }).data.cleared).toBe(true);
    expect(getPrintWatchSource(hoisted.db, "ACME")).toBeNull();
  });

  it("clearing a symbol that has no stored page is an honest no-op, not a lie", async () => {
    const { PUT } = await import("@/app/api/print-watch/sources/route");
    const res = await PUT(putReq({ symbol: "NONE", irPageUrl: "  " }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { cleared: boolean } };
    expect(body.success).toBe(true);
    expect(body.data.cleared).toBe(false);
  });

  it("refuses a missing/blank symbol and a non-string irPageUrl with the error envelope", async () => {
    const { PUT } = await import("@/app/api/print-watch/sources/route");

    for (const body of [{}, { symbol: "   ", irPageUrl: "https://ir.acme.example/news" }]) {
      const res = await PUT(putReq(body));
      expect(res.status).toBe(400);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/symbol/i);
    }

    const noUrl = await PUT(putReq({ symbol: "ACME" }));
    expect(noUrl.status).toBe(400);
    expect(((await noUrl.json()) as { error: string }).error).toMatch(/irPageUrl/);
  });

  // Task 12 minor, ruled in. `symbol` is the PRIMARY KEY of
  // print_watch_sources and the key every lane re-reads the row by, so junk
  // stored here is a row nothing will ever look up again — refuse it at the
  // boundary instead of persisting an unreachable configuration.
  it("refuses a symbol that is not ticker-shaped, and accepts the shapes that are", async () => {
    const { PUT } = await import("@/app/api/print-watch/sources/route");
    for (const symbol of ["AC ME", "ACME!", "ABCDEFGHIJKLM", "acme@x", "a/b"]) {
      const res = await PUT(putReq({ symbol, irPageUrl: "https://ir.acme.example/news" }));
      expect(res.status, symbol).toBe(400);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/symbol/i);
    }
    expect(getPrintWatchSource(hoisted.db, "ACME")).toBeNull();

    for (const symbol of [" brk.b ", "ACME", "rds-a", "ABCDEFGHIJKL"]) {
      const res = await PUT(putReq({ symbol, irPageUrl: "https://ir.acme.example/news" }));
      expect(res.status, symbol).toBe(200);
    }
    expect(getPrintWatchSource(hoisted.db, "BRK.B")?.ir_page_url).toBe("https://ir.acme.example/news");
  });

  // The same shape gate on the CLEAR direction: an empty irPageUrl must not be
  // a back door that runs a DELETE for an impossible symbol.
  it("refuses a malformed symbol on the clear path too", async () => {
    const { PUT } = await import("@/app/api/print-watch/sources/route");
    const res = await PUT(putReq({ symbol: "AC ME", irPageUrl: "" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/symbol/i);
  });

  it("refuses an SSRF-unsafe IR page (loopback, credentials, non-443 port)", async () => {
    const { PUT } = await import("@/app/api/print-watch/sources/route");
    for (const irPageUrl of [
      "https://localhost/news",
      "https://user:pw@ir.acme.example/news",
      "https://ir.acme.example:8443/news",
      "https://127.0.0.1/news",
      "not a url",
    ]) {
      const res = await PUT(putReq({ symbol: "ACME", irPageUrl }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/IR page:/);
    }
    expect(getPrintWatchSource(hoisted.db, "ACME")).toBeNull();
  });

  it("a blank linkMustContain stores NULL (no filter), not an empty string", async () => {
    const { PUT } = await import("@/app/api/print-watch/sources/route");
    upsertPrintWatchSource(hoisted.db, {
      symbol: "ACME",
      irPageUrl: "https://ir.acme.example/old",
      linkMustContain: "Results",
    });
    const res = await PUT(
      putReq({ symbol: "ACME", irPageUrl: "https://ir.acme.example/news", linkMustContain: "   " }),
    );
    expect(res.status).toBe(200);
    expect(getPrintWatchSource(hoisted.db, "ACME")).toMatchObject({
      ir_page_url: "https://ir.acme.example/news",
      link_must_contain: null,
    });
  });

  it("a malformed body is a 400, never a 500", async () => {
    const { PUT } = await import("@/app/api/print-watch/sources/route");
    const res = await PUT(
      new NextRequest("http://localhost/api/print-watch/sources", { method: "PUT", body: "{not json" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { success: boolean }).success).toBe(false);
  });

  it("is a human route by the proxy's default classification (no policy carve-out)", () => {
    expect(classifyRoute("PUT", "/api/print-watch/sources")).toBe("human");
  });
});
