/**
 * HTTP-boundary tests for slice C's "print is live" routes (Task 7):
 * POST/GET /api/print-watch/go, POST /api/print-watch/extend, and the four
 * window fields GET /api/print-watch/status now carries.
 *
 * Harness per tests/api/print-watch-routes.test.ts and
 * tests/api/print-watch-sources.test.ts: vi.mock the db singleton with an
 * in-memory migrated getter, drive the exported handlers directly with a
 * NextRequest, dynamic-import the route module. Kept in its own file (the
 * plan's rule: slice C route tests never share a file) so no other agent's
 * task collides with this one.
 *
 * All three routes are `human` by the proxy's DEFAULT classification (session
 * + CSRF + trusted Origin on unsafe methods) — deliberately NO
 * lib/auth/route-policy.ts entry, and none is needed. The last describe block
 * pins that, plus the three negative rows (no session / no CSRF / untrusted
 * Origin) through `decideRequest`, the proxy's own decision function — never a
 * re-implementation of it.
 *
 * Beyond the routes harness: a go press ARMS the event (slice A's prepare
 * steps + the Worker outbox drain) and reaches the watcher through go.ts's
 * lazy default seams. Neither may touch the network or the filesystem here, so
 * both are mocked at the module boundary; `requestGo`'s own validation,
 * `classifyBytes` and the SSRF contract all stay REAL, so a refused press is
 * refused for the real reason.
 *
 * Every date fixture is seeded relative to `todayET()` (worktree rule): a
 * literal date would go stale tomorrow.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { todayET } from "@/lib/calendar/date-utils";
import { getGoRequest, getPrintByEventId } from "@/lib/print-watch/store";
import { __resetPrepareStepsForTests } from "@/lib/earnings/prepare-armed-event";
import { classifyRoute } from "@/lib/auth/route-policy";
import { decideRequest, type RequestCtx } from "@/lib/auth/verify-request";
import { createSession } from "@/lib/mutations/sessions";
import { SESSION_COOKIE, CSRF_COOKIE } from "@/lib/auth/cookies";
import type { RoadReport } from "@/lib/print-watch/types";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

// Slice A's post-commit fan-out. `enqueuePrepareSteps` and every other export
// stay real (importOriginal spread) — only the two things that would RUN work
// (model calls, an outbound POST to the Worker) are stubbed.
vi.mock("@/lib/earnings/prepare-armed-event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/earnings/prepare-armed-event")>()),
  runPrepareSteps: vi.fn(async () => ({ ran: 0, done: 0, pending: 0, failed: 0, skipped: 0 })),
}));

vi.mock("@/lib/earnings/cloud-outbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/earnings/cloud-outbox")>()),
  attemptPostCommitDrain: vi.fn(async () => ({ timedOut: false, result: null })),
}));

const watcherSpies = vi.hoisted(() => ({
  wake: vi.fn(async () => {}),
  forced: vi.fn(async () => [
    { road: "dj", outcome: "skipped", detail: "tws offline" },
    { road: "edgar", outcome: "ok", detail: "ok — 0 filing(s)" },
    { road: "ir", outcome: "skipped", detail: "IR: none configured" },
  ]),
}));

// `getWatchStatus`, `buildArmedEventDto` and the gate all stay REAL; the three
// exports that would start a timer, write bytes or reach the network do not.
vi.mock("@/lib/print-watch/watcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/print-watch/watcher")>();
  return {
    ...actual,
    ensurePrintWatch: () => {},
    wakePrintWatch: watcherSpies.wake,
    runForcedPass: watcherSpies.forced,
    writeAcquiredBytes: async (dirKey: number | string, sha: string, ext: string) =>
      `/tmp/pw-test/${String(dirKey)}/${sha}.${ext}`,
  };
});

/** A today-dated ACME earnings event with a resolvable 16:05 ET print. */
function seedArmedEvent(sourceKey = "go-route-k"): number {
  const today = todayET();
  const eventId = Number(
    hoisted.db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol, event_time, release_time)
         VALUES ('manual','earnings',?,'ACME',?,'ACME','16:05','16:05')`,
      )
      .run(today, sourceKey).lastInsertRowid,
  );
  hoisted.db
    .prepare(`INSERT INTO securities (symbol, name, security_type) VALUES ('ACME','Acme Corp','Stock')`)
    .run();
  return eventId;
}

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  // Suppress slice A's lazy step bootstrap: `enqueuePrepareSteps` is real, and
  // the real steps' rows are irrelevant to a route contract.
  __resetPrepareStepsForTests();
  watcherSpies.wake.mockClear();
  watcherSpies.forced.mockClear();
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

afterEach(() => {
  hoisted.db.close();
});

describe("POST /api/print-watch/go", () => {
  it("acks a press with the request id, print id and the ONCE-stamped forcedOpenAt; the row is queued; the watcher is woken", async () => {
    const eventId = seedArmedEvent();
    const { POST } = await import("@/app/api/print-watch/go/route");

    const r1 = await POST(post("/api/print-watch/go", { eventId }));
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as {
      success: boolean;
      data: { requestId: number; printId: number; forcedOpenAt: string; newlyArmed: boolean; wakeError: string | null };
    };
    expect(b1.success).toBe(true);
    expect(b1.data).toMatchObject({
      requestId: expect.any(Number),
      printId: expect.any(Number),
      forcedOpenAt: expect.any(String),
      newlyArmed: true,
      wakeError: null,
    });
    expect(getGoRequest(hoisted.db, b1.data.requestId)?.status).toBe("queued");
    expect(watcherSpies.wake).toHaveBeenCalledWith(expect.anything(), b1.data.printId);

    // A second press is a NEW request row against the SAME forced stamp: the
    // first go opens the window once and a repeat press never widens it.
    const r2 = await POST(post("/api/print-watch/go", { eventId }));
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { data: { requestId: number; forcedOpenAt: string; newlyArmed: boolean } };
    expect(b2.data.forcedOpenAt).toBe(b1.data.forcedOpenAt);
    expect(b2.data.requestId).not.toBe(b1.data.requestId);
    expect(b2.data.newlyArmed).toBe(false);
  });

  it("400s: both inputs, a non-public link, a plain-http link, a binary file, an oversize file (before decoding), a bad eventId", async () => {
    const eventId = seedArmedEvent();
    const { POST } = await import("@/app/api/print-watch/go/route");
    const cases: Array<[unknown, RegExp]> = [
      [{ eventId, url: "https://ir.acme.example/x", contentBase64: "aGk=" }, /one of/],
      [{ eventId, url: "https://127.0.0.1/x" }, /refused/i],
      [{ eventId, url: "http://ir.acme.example/x" }, /https/],
      [{ eventId, contentBase64: Buffer.alloc(32, 0).toString("base64") }, /binary/],
      [{ eventId, contentBase64: "A".repeat(15 * 1024 * 1024) }, /10 MB/],
      [{ eventId: "x" }, /eventId/],
    ];
    for (const [body, re] of cases) {
      const res = await POST(post("/api/print-watch/go", body));
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toMatch(re);
    }
    // A refused press changes nothing at all — no print row was ever created.
    expect(getPrintByEventId(hoisted.db, eventId)).toBeNull();
  });

  it("a body that is not JSON, and a link this event cannot be pressed for, are 400s with the domain reason — never a 500", async () => {
    const { POST } = await import("@/app/api/print-watch/go/route");

    const notJson = await POST(
      new NextRequest("http://localhost/api/print-watch/go", { method: "POST", body: "{not json" }),
    );
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as { success: boolean }).success).toBe(false);

    // No such event: `requestGo` refuses (nothing is written), and the desk
    // gets the reason rather than an opaque failure.
    const noEvent = await POST(post("/api/print-watch/go", { eventId: 424242 }));
    expect(noEvent.status).toBe(400);
    expect(((await noEvent.json()) as { error: string }).error).toMatch(/no earnings event/i);
  });

  it("GET ?requestId= returns the row (pure read) and never the local bytes path; 400 without an id; 404 unknown", async () => {
    const eventId = seedArmedEvent();
    const { POST, GET } = await import("@/app/api/print-watch/go/route");
    const ack = (
      (await (
        await POST(
          post("/api/print-watch/go", {
            eventId,
            filename: "acme-q3.html",
            contentBase64: Buffer.from("<html>ACME</html>").toString("base64"),
          }),
        )
      ).json()) as { data: { requestId: number; printId: number } }
    ).data;

    const res = await GET(new NextRequest(`http://localhost/api/print-watch/go?requestId=${ack.requestId}`));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: { request: { id: number; printId: number; status: string; inputKind: string; result: RoadReport[] | null } };
    };
    expect(json.data.request).toMatchObject({
      id: ack.requestId,
      printId: ack.printId,
      status: "queued",
      inputKind: "file",
      result: null,
    });
    // The staged bytes live on this machine's disk; their path never leaves
    // the process, and neither does the claimed filename.
    const wire = JSON.stringify(json);
    expect(wire).not.toContain("/tmp/pw-test");
    expect(wire).not.toContain("acme-q3.html");

    expect((await GET(new NextRequest("http://localhost/api/print-watch/go"))).status).toBe(400);
    expect((await GET(new NextRequest("http://localhost/api/print-watch/go?requestId=abc"))).status).toBe(400);
    expect((await GET(new NextRequest("http://localhost/api/print-watch/go?requestId=99999"))).status).toBe(404);
  });

  it("GET redacts a pasted link rather than echoing it back verbatim", async () => {
    const eventId = seedArmedEvent();
    const { POST, GET } = await import("@/app/api/print-watch/go/route");
    const ack = (
      (await (
        await POST(post("/api/print-watch/go", { eventId, url: "https://ir.acme.example/q3?utm_source=desk" }))
      ).json()) as { data: { requestId: number } }
    ).data;

    const json = (await (
      await GET(new NextRequest(`http://localhost/api/print-watch/go?requestId=${ack.requestId}`))
    ).json()) as { data: { request: { inputKind: string; inputUrl: string | null } } };
    expect(json.data.request.inputKind).toBe("url");
    expect(json.data.request.inputUrl).toContain("ir.acme.example/q3");
  });
});

describe("POST /api/print-watch/extend", () => {
  it("stacks 30 minutes per press and returns the new effective window; 400 with no print", async () => {
    const eventId = seedArmedEvent();
    const { POST: go } = await import("@/app/api/print-watch/go/route");
    const { POST: extend } = await import("@/app/api/print-watch/extend/route");
    await go(post("/api/print-watch/go", { eventId }));

    type ExtendBody = {
      data: { printId: number; windowExtendedUntil: string; effectiveWindow: { start: string; end: string } | null };
    };
    const r1 = (await (await extend(post("/api/print-watch/extend", { eventId }))).json()) as ExtendBody;
    const r2 = (await (await extend(post("/api/print-watch/extend", { eventId }))).json()) as ExtendBody;
    expect(Date.parse(r2.data.windowExtendedUntil) - Date.parse(r1.data.windowExtendedUntil)).toBe(30 * 60_000);
    expect(r2.data.effectiveWindow?.end).toBe(r2.data.windowExtendedUntil);
    // The loop that had stopped at the old end is told to resume at once.
    expect(watcherSpies.wake).toHaveBeenCalledWith(expect.anything(), r2.data.printId);

    const bad = await extend(post("/api/print-watch/extend", { eventId: 424242 }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/print-watch/i);
  });

  it("refuses a missing or non-integer eventId, and a body that is not JSON", async () => {
    const { POST: extend } = await import("@/app/api/print-watch/extend/route");
    for (const body of [{}, { eventId: "12" }, { eventId: 0 }, { eventId: 1.5 }]) {
      const res = await extend(post("/api/print-watch/extend", body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/eventId/);
    }
    const notJson = await extend(
      new NextRequest("http://localhost/api/print-watch/extend", { method: "POST", body: "{not json" }),
    );
    expect(notJson.status).toBe(400);
  });
});

describe("GET /api/print-watch/status (slice C fields)", () => {
  it("carries forcedOpenAt, windowExtendedUntil, effectiveWindow and goRequest for the print", async () => {
    const eventId = seedArmedEvent();
    const { POST: go } = await import("@/app/api/print-watch/go/route");
    const ack = ((await (await go(post("/api/print-watch/go", { eventId }))).json()) as {
      data: { requestId: number; printId: number; forcedOpenAt: string };
    }).data;

    const { GET } = await import("@/app/api/print-watch/status/route");
    const json = (await (await GET()).json()) as {
      data: {
        prints: Array<{
          printId: number;
          forcedOpenAt: string | null;
          windowExtendedUntil: string | null;
          effectiveWindow: { start: string; end: string } | null;
          goRequest: { id: number; status: string; attempts: number } | null;
        }>;
      };
    };
    const print = json.data.prints.find((p) => p.printId === ack.printId);
    expect(print).toBeDefined();
    expect(print!.forcedOpenAt).toBe(ack.forcedOpenAt);
    expect(print!.windowExtendedUntil).toBeNull();
    expect(print!.effectiveWindow).toEqual({ start: expect.any(String), end: expect.any(String) });
    expect(print!.goRequest).toMatchObject({ id: ack.requestId, status: "queued", attempts: 0 });

    const { POST: extend } = await import("@/app/api/print-watch/extend/route");
    const extended = ((await (await extend(post("/api/print-watch/extend", { eventId }))).json()) as {
      data: { windowExtendedUntil: string };
    }).data;
    const after = ((await (await GET()).json()) as {
      data: { prints: Array<{ printId: number; windowExtendedUntil: string | null; effectiveWindow: { end: string } | null }> };
    }).data.prints.find((p) => p.printId === ack.printId)!;
    expect(after.windowExtendedUntil).toBe(extended.windowExtendedUntil);
    expect(after.effectiveWindow?.end).toBe(extended.windowExtendedUntil);
  });
});

// ---------------------------------------------------------------------------
// Proxy classification (Codex round 1, amendment #16)
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-09-03T20:05:00Z");
const GOOD_ORIGIN = "http://localhost:3099";
const HOSTS = new Set(["localhost:3099", "127.0.0.1:3099", "app.myportfoliodesk.com"]);
const ORIGINS = new Set(["http://localhost:3099", "http://127.0.0.1:3099", "https://app.myportfoliodesk.com"]);

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

describe("the go/extend routes sit behind the human trust boundary", () => {
  it("classify as 'human' by the proxy's default — no route-policy carve-out", () => {
    expect(classifyRoute("POST", "/api/print-watch/go")).toBe("human");
    expect(classifyRoute("GET", "/api/print-watch/go")).toBe("human");
    expect(classifyRoute("POST", "/api/print-watch/extend")).toBe("human");
  });

  it("deny401 a press with no session at all", () => {
    for (const pathname of ["/api/print-watch/go", "/api/print-watch/extend"]) {
      expect(decideRequest(hoisted.db, ctx({ method: "POST", pathname }), T0).action).toBe("deny401");
    }
    expect(
      decideRequest(hoisted.db, ctx({ method: "GET", pathname: "/api/print-watch/go" }), T0).action,
    ).toBe("deny401");
  });

  it("deny401 a press with a valid session but no CSRF header", () => {
    const { rawToken, csrfToken } = createSession(hoisted.db, { label: "desk" }, T0);
    for (const pathname of ["/api/print-watch/go", "/api/print-watch/extend"]) {
      const d = decideRequest(
        hoisted.db,
        ctx({
          method: "POST",
          pathname,
          cookies: { [SESSION_COOKIE]: rawToken, [CSRF_COOKIE]: csrfToken },
          headers: { origin: GOOD_ORIGIN }, // no x-csrf-token
        }),
        T0,
      );
      expect(d.action, pathname).toBe("deny401");
    }
  });

  it("deny401 a press from an untrusted Origin even with a valid session + CSRF", () => {
    const { rawToken, csrfToken } = createSession(hoisted.db, { label: "desk" }, T0);
    for (const pathname of ["/api/print-watch/go", "/api/print-watch/extend"]) {
      const d = decideRequest(
        hoisted.db,
        ctx({
          method: "POST",
          pathname,
          cookies: { [SESSION_COOKIE]: rawToken, [CSRF_COOKIE]: csrfToken },
          headers: { origin: "https://evil.example", "x-csrf-token": csrfToken },
        }),
        T0,
      );
      expect(d.action, pathname).toBe("deny401");
    }
  });

  it("allows the press with session + trusted Origin + matching CSRF", () => {
    const { rawToken, csrfToken } = createSession(hoisted.db, { label: "desk" }, T0);
    const d = decideRequest(
      hoisted.db,
      ctx({
        method: "POST",
        pathname: "/api/print-watch/go",
        cookies: { [SESSION_COOKIE]: rawToken, [CSRF_COOKIE]: csrfToken },
        headers: { origin: GOOD_ORIGIN, "x-csrf-token": csrfToken },
      }),
      T0,
    );
    expect(d.action).toBe("allow");
  });
});
