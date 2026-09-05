/**
 * HTTP-boundary tests for `POST /api/print-watch/send-recap` (live print v2
 * slice E, Task 6b) — the desk's "send recap now" button.
 *
 * THE CONTRACT THIS FILE PINS. The response DTO is a cross-slice contract
 * (docs/superpowers/plans/2026-09-04-live-print-v2-outputs-contract.md §3):
 * slice F renders `data.outcome` and `data.reason` VERBATIM, so every
 * coordination outcome — a gate refusal, a claim already held, an email that
 * already went out, a delivery nobody can confirm, a compose failure — is a
 * 200 with a readable answer. Only three things are HTTP errors: a malformed
 * body (400), an unknown print (404) and an unexpected exception (500). A
 * refusal is an ANSWER, not an error, and this file fails if that ever slips.
 *
 * The route also PROJECTS the send service's outcome down to the DTO
 * (session finding E-S7): `status`, `symbol` and `modelOutputChars` are
 * service-internal and never reach F; the optional `note` on
 * `delivery_unknown` (which says WHY it is unknown) is kept and passed through.
 *
 * Harness per tests/api/print-watch-go.test.ts: a hoisted in-memory migrated
 * database behind `vi.mock("@/lib/db")`, handlers driven directly with a
 * `NextRequest`, the route module dynamically imported. `sendEarningsCandidate`
 * is mocked at the module boundary so nothing composes, calls a model or opens
 * a socket — the GATE stays real, so a refused press is refused for the real
 * reason.
 *
 * The last describe block pins the trust boundary: the route is `human` by the
 * proxy's DEFAULT classification (no lib/auth/route-policy.ts entry), asserted
 * through `decideRequest` — the proxy's own decision function — never a
 * re-implementation of it.
 *
 * Every date fixture is seeded relative to `todayET()`; a literal would go
 * stale tomorrow. Identifiers are synthetic (`XMPL`, example.com).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { todayET } from "@/lib/calendar/date-utils";
import { upsertPrint, upsertLines } from "@/lib/print-watch/store";
import { mergeFinnhubActual } from "@/lib/format/finnhub-figure";
import { GATE_NOT_ACCEPTED, GATE_NOT_PROMOTED } from "@/lib/earnings/recap-nudge-gate";
import { classifyRoute } from "@/lib/auth/route-policy";
import { decideRequest, type RequestCtx } from "@/lib/auth/verify-request";
import { createSession } from "@/lib/mutations/sessions";
import { SESSION_COOKIE, CSRF_COOKIE } from "@/lib/auth/cookies";
import type { PrintWatchLine } from "@/lib/print-watch/types";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

/** The one seam that would compose an email and reach the provider. */
const sendCandidate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/earnings/send-service", () => ({ sendEarningsCandidate: sendCandidate }));

const TODAY = todayET();
let eventId: number;
let printId: number;
let sourceKeySeq = 0;

/** A sheet line the promote path would accept: revenue in dollars, EPS per share. */
function line(metricId: string, over: Partial<PrintWatchLine> = {}): PrintWatchLine {
  return {
    metric_id: metricId,
    contract: {
      metric_id: metricId,
      label: metricId,
      definition: "d",
      basis: "na",
      period: "Q",
      currency: "USD",
      unit: metricId === "revenue_q" ? "usd" : "per_share",
      kind: "point",
      segment: null,
    },
    expected: { value: 1, value_high: null, whisper: null, source_label: "VK" },
    state: "accepted",
    value: metricId === "revenue_q" ? 100_000_000 : 2,
    value_high: null,
    snippet: null,
    source_doc_id: null,
    candidates_json: "[]",
    ...over,
  };
}

function insertEvent(): number {
  sourceKeySeq += 1;
  return Number(
    hoisted.db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key)
         VALUES ('manual','earnings',?,'XMPL earnings','XMPL',?)`,
      )
      .run(TODAY, `k${sourceKeySeq}`).lastInsertRowid,
  );
}

/** A print with a sheet, but nothing promoted — the gate refuses. */
function seedPrintWithLines(lines: PrintWatchLine[]): void {
  eventId = insertEvent();
  printId = upsertPrint(hoisted.db, eventId, "xmpl", TODAY, "16:05");
  upsertLines(hoisted.db, printId, lines);
}

/** Exactly what POST /api/print-watch/accept { promoteHeadline: true } leaves
 *  behind: the accepted pair on the sheet, and `saveManualActuals`'
 *  `mergeFinnhubActual` string plus the stamp on the event. The gate passes. */
function seedPromotedPrint(): void {
  seedPrintWithLines([line("eps_adj_q"), line("revenue_q")]);
  hoisted.db
    .prepare(
      `UPDATE calendar_events SET actual_value = ?, manual_actuals_at = datetime('now') WHERE id = ?`,
    )
    .run(mergeFinnhubActual(null, { eps: 2, revenue: 100_000_000 }), eventId);
}

function json(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/print-watch/send-recap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  sendCandidate.mockReset();
  sourceKeySeq = 0;
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

afterEach(() => {
  hoisted.db.close();
});

describe("POST /api/print-watch/send-recap", () => {
  it("400s a malformed body and 404s an unknown print, without ever reaching the service", async () => {
    const { POST } = await import("@/app/api/print-watch/send-recap/route");

    for (const body of [{ nope: 1 }, { printId: "3" }, { printId: 1.5 }, null]) {
      const res = await POST(json(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      const parsed = (await res.json()) as { success: boolean; error: string };
      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/printId/);
    }

    // A body that is not JSON at all is the same malformed-body answer, never a 500.
    const notJson = await POST(
      new NextRequest("http://localhost/api/print-watch/send-recap", {
        method: "POST",
        body: "{not json",
      }),
    );
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as { success: boolean }).success).toBe(false);

    const r404 = await POST(json({ printId: 999999 }));
    expect(r404.status).toBe(404);
    expect((await r404.json()).success).toBe(false);

    expect(sendCandidate).not.toHaveBeenCalled();
  });

  it("200s a gate refusal with the copy verbatim and never calls the service", async () => {
    seedPrintWithLines([line("eps_adj_q")]); // no revenue_q — the pair is incomplete
    const { POST } = await import("@/app/api/print-watch/send-recap/route");

    const res = await POST(json({ printId }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { outcome: "refused", reason: GATE_NOT_ACCEPTED },
    });
    expect(sendCandidate).not.toHaveBeenCalled();
  });

  it("200s the not-promoted refusal too — an accepted pair alone is not enough", async () => {
    seedPrintWithLines([line("eps_adj_q"), line("revenue_q")]);
    const { POST } = await import("@/app/api/print-watch/send-recap/route");

    expect(await (await POST(json({ printId }))).json()).toEqual({
      success: true,
      data: { outcome: "refused", reason: GATE_NOT_PROMOTED },
    });
    expect(sendCandidate).not.toHaveBeenCalled();
  });

  it("calls the service in nudge mode with the full recap candidate (never reporterRecap)", async () => {
    seedPromotedPrint();
    sendCandidate.mockResolvedValueOnce({
      outcome: "sent",
      sentTo: "me@example.com",
      providerMessageId: "<m@d>",
      title: "XMPL Earnings Recap",
      modelOutputChars: 42,
      symbol: "XMPL",
    });
    const { POST } = await import("@/app/api/print-watch/send-recap/route");

    const res = await POST(json({ printId }));
    expect(res.status).toBe(200);
    expect(sendCandidate).toHaveBeenCalledWith(
      expect.anything(),
      { eventId, symbol: "XMPL", phase: "recap" },
      { mode: "nudge" },
    );
    // The symbol is UPPERCASED by the gate even though the print row is not.
    expect(await res.json()).toEqual({
      success: true,
      data: {
        outcome: "sent",
        sentTo: "me@example.com",
        providerMessageId: "<m@d>",
        title: "XMPL Earnings Recap",
      },
    });
  });

  it.each([
    [{ outcome: "in_progress" }, { outcome: "in_progress" }],
    [
      { outcome: "already_sent", sentAt: "2026-09-10 20:30:00", sentBy: "local" },
      { outcome: "already_sent", sentAt: "2026-09-10 20:30:00", sentBy: "local" },
    ],
    [
      { outcome: "already_sent", sentAt: "2026-09-10 20:30:00", sentBy: "cloud" },
      { outcome: "already_sent", sentAt: "2026-09-10 20:30:00", sentBy: "cloud" },
    ],
    [
      { outcome: "delivery_unknown", providerMessageId: "<m@d>", since: "2026-09-10 20:30:00" },
      { outcome: "delivery_unknown", providerMessageId: "<m@d>", since: "2026-09-10 20:30:00" },
    ],
    [
      {
        outcome: "delivery_unknown",
        providerMessageId: null,
        since: "",
        note: "the provider call exceeded 60000ms and was never answered",
      },
      {
        outcome: "delivery_unknown",
        providerMessageId: null,
        since: "",
        note: "the provider call exceeded 60000ms and was never answered",
      },
    ],
    [
      { outcome: "refused", reason: "no recipient", status: 400 },
      { outcome: "refused", reason: "no recipient" },
    ],
    [
      { outcome: "failed", reason: "Send failed: boom", status: 500 },
      { outcome: "failed", reason: "Send failed: boom" },
    ],
  ])(
    "answers 200 for every coordination outcome and drops the service-only fields (%#)",
    async (given, expected) => {
      seedPromotedPrint();
      sendCandidate.mockResolvedValueOnce(given as never);
      const { POST } = await import("@/app/api/print-watch/send-recap/route");

      const res = await POST(json({ printId }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, data: expected });
    },
  );

  it("500s only an unexpected exception", async () => {
    seedPromotedPrint();
    sendCandidate.mockRejectedValueOnce(new Error("kaboom"));
    const { POST } = await import("@/app/api/print-watch/send-recap/route");

    const res = await POST(json({ printId }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: "kaboom" });
  });
});

// ---------------------------------------------------------------------------
// Proxy classification — the same three negative rows as the go/extend routes
// ---------------------------------------------------------------------------

const T0 = Date.now();
const PATHNAME = "/api/print-watch/send-recap";
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

describe("the send-recap route sits behind the human trust boundary", () => {
  it("classifies as 'human' by the proxy's default — no route-policy carve-out", () => {
    expect(classifyRoute("POST", PATHNAME)).toBe("human");
  });

  it("deny401 a press with no session at all", () => {
    expect(decideRequest(hoisted.db, ctx({ method: "POST", pathname: PATHNAME }), T0).action).toBe(
      "deny401",
    );
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
