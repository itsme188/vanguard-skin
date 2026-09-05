/**
 * HTTP-boundary tests for POST /api/print-watch/print-sheet (live print v2
 * slice E, Task 10) — the button that puts the whole print on paper.
 *
 * Harness per tests/api/print-watch-go.test.ts and
 * tests/api/print-watch-outputs.test.ts: vi.mock the db singleton with an
 * in-memory migrated getter, drive the exported handler directly with a
 * NextRequest, dynamic-import the route module.
 *
 * `printPostPrintSheetNow` is mocked at the module boundary, so NOTHING in this
 * file starts Chrome, spawns `lp` or opens a socket. `evaluatePrintOutputs`
 * stays REAL — the 409 body is a cross-slice contract string and a stub would
 * prove nothing about it.
 *
 * The route is `human` by the proxy's DEFAULT classification (session cookie +
 * double-submit CSRF + trusted Origin on unsafe methods) — deliberately NO
 * lib/auth/route-policy.ts entry, and none is needed. The last describe block
 * pins that through `decideRequest`, the proxy's own decision function, never a
 * re-implementation of it.
 *
 * Every date fixture is seeded relative to `todayET()`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { upsertPrint, upsertLines } from "@/lib/print-watch/store";
import { PRINT_SHEET_DISABLED } from "@/lib/earnings/print-outputs";
import { todayET } from "@/lib/calendar/date-utils";
import { classifyRoute } from "@/lib/auth/route-policy";
import { decideRequest, type RequestCtx } from "@/lib/auth/verify-request";
import { createSession } from "@/lib/mutations/sessions";
import { SESSION_COOKIE, CSRF_COOKIE } from "@/lib/auth/cookies";
import type { PrintWatchLine, LineStateKind } from "@/lib/print-watch/types";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

const printNow = vi.hoisted(() => vi.fn());
vi.mock("@/lib/earnings/post-print-sheet", () => ({ printPostPrintSheetNow: printNow }));

const TODAY = todayET();
const PATHNAME = "/api/print-watch/print-sheet";

let eventId: number;
let printId: number;

function line(metricId: string, o: { state: LineStateKind; value: number | null }): PrintWatchLine {
  return {
    metric_id: metricId,
    contract: {
      metric_id: metricId,
      label: metricId,
      definition: "d",
      basis: "na",
      period: "Q",
      currency: "USD",
      unit: "usd",
      kind: "point",
      segment: null,
    },
    expected: null,
    state: o.state,
    value: o.value,
    value_high: null,
    snippet: null,
    source_doc_id: null,
    candidates_json: "[]",
  };
}

function seedPrintWithLines(lines: PrintWatchLine[]): void {
  upsertLines(hoisted.db, printId, lines);
}

function json(body: unknown): NextRequest {
  return new NextRequest(`http://localhost${PATHNAME}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  printNow.mockReset();
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);

  eventId = Number(
    hoisted.db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, event_time, title, symbol, source_key)
         VALUES ('manual','earnings',?,'AMC','XMPL earnings','XMPL',?)`,
      )
      .run(TODAY, `manual:XMPL:${TODAY}`).lastInsertRowid,
  );
  printId = upsertPrint(hoisted.db, eventId, "XMPL", TODAY, "16:05");
});

afterEach(() => {
  hoisted.db.close();
});

describe("POST /api/print-watch/print-sheet", () => {
  it("400s a malformed body and 404s an unknown print", async () => {
    const { POST } = await import("@/app/api/print-watch/print-sheet/route");
    expect((await POST(json({}))).status).toBe(400);
    expect((await POST(json({ printId: "7" }))).status).toBe(400);
    expect((await POST(json({ printId: 999999 }))).status).toBe(404);
    expect(printNow).not.toHaveBeenCalled();
  });

  it("400s a body that is not JSON at all", async () => {
    const { POST } = await import("@/app/api/print-watch/print-sheet/route");
    const req = new NextRequest(`http://localhost${PATHNAME}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect((await POST(req)).status).toBe(400);
    expect(printNow).not.toHaveBeenCalled();
  });

  // Controller hardening after the Task 6b review of the sibling send-recap
  // route: a literal `null` body satisfies `typeof body === "object"`, so a
  // guard that only checks the type reaches `body.printId` on null and throws —
  // surfacing a malformed request as an unexpected 500. Every malformed shape
  // must be a 400 with the envelope.
  it("400s every malformed body shape rather than 500ing on it", async () => {
    const { POST } = await import("@/app/api/print-watch/print-sheet/route");
    for (const raw of ["null", "[]", "[1,2]", '"XMPL"', "7", "true"]) {
      const req = new NextRequest(`http://localhost${PATHNAME}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      const res = await POST(req);
      expect(res.status, `body ${raw}`).toBe(400);
      const body = await res.json();
      expect(body.success, `body ${raw}`).toBe(false);
      expect(typeof body.error, `body ${raw}`).toBe("string");
    }
    expect(printNow).not.toHaveBeenCalled();
  });

  it("404s (not 400s) a well-formed but impossible printId", async () => {
    const { POST } = await import("@/app/api/print-watch/print-sheet/route");
    for (const id of [-5, 0, Number.MAX_SAFE_INTEGER]) {
      const res = await POST(json({ printId: id }));
      expect(res.status, `printId ${id}`).toBe(404);
    }
    // ...while a non-integer number is malformed, not merely absent.
    expect((await POST(json({ printId: 1.5 }))).status).toBe(400);
    expect((await POST(json({ printId: -0.5 }))).status).toBe(400);
    expect(printNow).not.toHaveBeenCalled();
  });

  it("409s with the outputs reason, verbatim, when no line has a value", async () => {
    seedPrintWithLines([line("revenue_q", { state: "pending", value: null })]);
    const { POST } = await import("@/app/api/print-watch/print-sheet/route");
    const res = await POST(json({ printId }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: PRINT_SHEET_DISABLED });
    expect(printNow).not.toHaveBeenCalled();
  });

  it("409s for a print whose only figure sits on a RETIRED line", async () => {
    seedPrintWithLines([line("x_old_Q", { state: "retired", value: 1e8 })]);
    const { POST } = await import("@/app/api/print-watch/print-sheet/route");
    const res = await POST(json({ printId }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: PRINT_SHEET_DISABLED });
    expect(printNow).not.toHaveBeenCalled();
  });

  it("200s with the road, the page count and the symbol", async () => {
    seedPrintWithLines([line("revenue_q", { state: "agreed", value: 1e8 })]);
    printNow.mockResolvedValueOnce({ road: "pdf", pages: 1, symbol: "XMPL" });
    const { POST } = await import("@/app/api/print-watch/print-sheet/route");
    const res = await POST(json({ printId }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { road: "pdf", pages: 1, symbol: "XMPL" } });
    expect(printNow).toHaveBeenCalledWith(expect.anything(), printId);
  });

  it("reports the monospace downgrade honestly rather than claiming a PDF", async () => {
    seedPrintWithLines([line("revenue_q", { state: "agreed", value: 1e8 })]);
    printNow.mockResolvedValueOnce({ road: "monospace", pages: null, symbol: "XMPL" });
    const { POST } = await import("@/app/api/print-watch/print-sheet/route");
    const res = await POST(json({ printId }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { road: "monospace", pages: null, symbol: "XMPL" },
    });
  });

  it("500s when both roads fail, naming the printer failure", async () => {
    seedPrintWithLines([line("revenue_q", { state: "agreed", value: 1e8 })]);
    printNow.mockRejectedValueOnce(new Error("lp exited 1: cupsd wedged"));
    const { POST } = await import("@/app/api/print-watch/print-sheet/route");
    const res = await POST(json({ printId }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("cupsd wedged");
  });

  it("writes nothing to the database — a refused press leaves no trace", async () => {
    seedPrintWithLines([line("revenue_q", { state: "pending", value: null })]);
    const tables = (
      hoisted.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all() as Array<{ name: string }>
    ).map((t) => t.name);
    const snapshot = () =>
      tables.map(
        (t) => `${t}:${(hoisted.db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n}`,
      );
    const before = snapshot();
    const { POST } = await import("@/app/api/print-watch/print-sheet/route");
    expect((await POST(json({ printId }))).status).toBe(409);
    expect(snapshot()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// The trust boundary. `decideRequest` is the proxy's own decision function;
// nothing here re-implements it.
// ---------------------------------------------------------------------------

const T0 = Date.now();
const GOOD_ORIGIN = "http://localhost:3099";
const HOSTS = new Set(["localhost:3099", "127.0.0.1:3099", "app.myportfoliodesk.com"]);
const ORIGINS = new Set([
  "http://localhost:3099",
  "http://127.0.0.1:3099",
  "https://app.myportfoliodesk.com",
]);

function ctx(partial: Partial<RequestCtx> & Pick<RequestCtx, "method" | "pathname">): RequestCtx {
  return {
    host: "localhost:3099",
    cookies: {},
    headers: {},
    hosts: HOSTS,
    origins: ORIGINS,
    cronSecret: "cron-secret-value",
    electronCred: "electron-cred-value",
    ...partial,
  };
}

describe("the print-sheet route sits behind the human trust boundary", () => {
  it("classifies as 'human' by the proxy's default — no route-policy carve-out", () => {
    expect(classifyRoute("POST", PATHNAME)).toBe("human");
  });

  it("deny401 a press with no session at all", () => {
    expect(decideRequest(hoisted.db, ctx({ method: "POST", pathname: PATHNAME }), T0).action).toBe("deny401");
  });

  it("deny401 a press with a valid session but no CSRF header", () => {
    const { rawToken, csrfToken } = createSession(hoisted.db, { label: "desk" }, T0);
    const d = decideRequest(
      hoisted.db,
      ctx({
        method: "POST",
        pathname: PATHNAME,
        cookies: { [SESSION_COOKIE]: rawToken, [CSRF_COOKIE]: csrfToken },
        headers: { origin: GOOD_ORIGIN }, // no x-csrf-token
      }),
      T0,
    );
    expect(d.action).toBe("deny401");
  });

  it("deny401 a press from an untrusted Origin even with a valid session + CSRF", () => {
    const { rawToken, csrfToken } = createSession(hoisted.db, { label: "desk" }, T0);
    const d = decideRequest(
      hoisted.db,
      ctx({
        method: "POST",
        pathname: PATHNAME,
        cookies: { [SESSION_COOKIE]: rawToken, [CSRF_COOKIE]: csrfToken },
        headers: { origin: "https://evil.example", "x-csrf-token": csrfToken },
      }),
      T0,
    );
    expect(d.action).toBe("deny401");
  });

  it("allows the press with session + trusted Origin + matching CSRF", () => {
    const { rawToken, csrfToken } = createSession(hoisted.db, { label: "desk" }, T0);
    const d = decideRequest(
      hoisted.db,
      ctx({
        method: "POST",
        pathname: PATHNAME,
        cookies: { [SESSION_COOKIE]: rawToken, [CSRF_COOKIE]: csrfToken },
        headers: { origin: GOOD_ORIGIN, "x-csrf-token": csrfToken },
      }),
      T0,
    );
    expect(d.action).toBe("allow");
  });
});
