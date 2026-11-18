/**
 * Bogey intake 2026-11-18, Task D (amendments A5, A6): the two routes behind
 * the "not read" list.
 *
 *   GET  /api/earnings/bogeys/unread?eventId=   -> { success, data: { articles } }
 *   POST /api/earnings/bogeys/read-article      -> { success, data: { bogeysStored, status, recompiled } }
 *
 * The extractor is mocked (no AI call); the ledger and the bogey rows are
 * asserted in the database. Synthetic tickers and invented text only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { APIError } from "@anthropic-ai/sdk";
import { runMigrations } from "@/lib/db/migrate";
import { aiUnavailableForClick } from "@/lib/earnings/ai-unavailable";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  calls: 0,
  result: { bogeysStored: 0, modelId: "test-model", called: true } as Record<string, unknown>,
  throwErr: null as unknown,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("@/lib/earnings/extract-newsletter-bogeys", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/earnings/extract-newsletter-bogeys")>();
  return {
    ...original,
    extractBogeysFromArticleForEvent: vi.fn(async () => {
      hoisted.calls += 1;
      if (hoisted.throwErr) throw hoisted.throwErr;
      return hoisted.result;
    }),
  };
});

let db: Database.Database;
let eventId: number;
let articleId: number;
const FILLER = " Invented desk prose to clear the two-hundred-character body floor that newsletter readers use.".repeat(3);

beforeEach(() => {
  // Only Date is faked: the window is read off Date.now(), timers stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T15:00:00Z"));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  hoisted.db = db;
  hoisted.calls = 0;
  hoisted.result = { bogeysStored: 0, modelId: "test-model", called: true };
  hoisted.throwErr = null;
  vi.resetModules();
  eventId = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (event_date, event_time, event_type, title, symbol, source, source_key)
         VALUES ('2026-11-20', 'AMC', 'earnings', 'ACME Q3', 'ACME', 'manual', 'manual:ACME:1')`,
      )
      .run().lastInsertRowid,
  );
  db.prepare(`INSERT INTO research_sources (id, name) VALUES (9201, 'Open Desk Letter')`).run();
  articleId = Number(
    db
      .prepare(
        `INSERT INTO research_articles (source_id, subject, sender, received_at, raw_text)
         VALUES (9201, 'ACME into the print', 'desk@example.test', '2026-11-18 13:00:00', ?)`,
      )
      .run("ACME preview: the desk wants 1.10." + FILLER).lastInsertRowid,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

async function getUnread(query: string) {
  const { GET } = await import("@/app/api/earnings/bogeys/unread/route");
  const res = await GET(new Request(`http://localhost/api/earnings/bogeys/unread${query}`));
  return { status: res.status, body: await res.json() };
}

async function postRead(body: unknown) {
  const { POST } = await import("@/app/api/earnings/bogeys/read-article/route");
  const res = await POST(
    new Request("http://localhost/api/earnings/bogeys/read-article", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

const scanRows = () =>
  db.prepare(`SELECT status, attempts FROM earnings_bogey_scans WHERE event_id = ? AND article_id = ?`).all(eventId, articleId);

describe("GET /api/earnings/bogeys/unread", () => {
  it("lists the unread article for the event", async () => {
    const { status, body } = await getUnread(`?eventId=${eventId}`);
    expect(status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        articles: [
          {
            articleId,
            sourceName: "Open Desk Letter",
            subject: "ACME into the print",
            receivedAt: "2026-11-18 13:00:00",
            state: "not_read",
          },
        ],
      },
    });
    expect(hoisted.calls).toBe(0);
  });

  it("400 for a missing or bad eventId; 404 for an unknown event", async () => {
    expect((await getUnread("")).status).toBe(400);
    expect((await getUnread("?eventId=abc")).status).toBe(400);
    const missing = await getUnread("?eventId=999999");
    expect(missing.status).toBe(404);
    expect(missing.body.success).toBe(false);
  });
});

describe("POST /api/earnings/bogeys/read-article", () => {
  it("reads, books the ledger and drops the article from the list", async () => {
    hoisted.result = { bogeysStored: 2, modelId: "test-model", called: true };
    const { status, body } = await postRead({ eventId, articleId });
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, data: { bogeysStored: 2, status: "hit", recompiled: null } });
    expect(scanRows()).toEqual([{ status: "hit", attempts: 1 }]);
    expect((await getUnread(`?eventId=${eventId}`)).body.data.articles).toEqual([]);
  });

  it("400 for a bad body", async () => {
    expect((await postRead("{nope")).status).toBe(400);
    expect((await postRead({ eventId: "x", articleId })).status).toBe(400);
    expect((await postRead({ eventId, articleId: -1 })).status).toBe(400);
    expect(hoisted.calls).toBe(0);
  });

  it("409 for an article that is not waiting to be read for this print", async () => {
    const { status, body } = await postRead({ eventId, articleId: articleId + 50 });
    expect(status).toBe(409);
    expect(body).toEqual({ success: false, error: "This article is not waiting to be read for this print." });
    expect(hoisted.calls).toBe(0);
  });

  it("409 while another read holds a live claim", async () => {
    db.prepare(
      `INSERT INTO earnings_bogey_scans (event_id, article_id, extractor_version, status, claim_token, updated_at)
       VALUES (?, ?, 2, 'claimed', 'other', ?)`,
    ).run(eventId, articleId, new Date().toISOString().slice(0, 19).replace("T", " "));
    const { status, body } = await postRead({ eventId, articleId });
    expect(status).toBe(409);
    expect(body.error).toMatch(/Already reading/);
    expect(hoisted.calls).toBe(0);
  });

  it("409 when the extractor finds no ticker (called:false), nothing booked", async () => {
    hoisted.result = { bogeysStored: 0, modelId: null, called: false };
    const { status } = await postRead({ eventId, articleId });
    expect(status).toBe(409);
    expect(scanRows()).toEqual([]);
  });

  it("an account outage (real-shaped SDK billing error on cause) answers 503 and books nothing", async () => {
    const payload = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      },
      request_id: "req_testBILLING",
    };
    const sdkErr = new APIError(400, payload, `400 ${JSON.stringify(payload)}`, new Headers());
    hoisted.throwErr = new Error(`newsletter extraction failed for article ${articleId}`, { cause: sdkErr });
    const { status, body } = await postRead({ eventId, articleId });
    expect(status).toBe(503);
    expect(body).toEqual({ success: false, error: aiUnavailableForClick("billing") });
    expect(scanRows()).toEqual([]);
  });

  it("another model failure answers 502 and books an error with an attempt", async () => {
    hoisted.throwErr = new Error("newsletter extraction failed", { cause: new Error("unparseable reply") });
    const { status, body } = await postRead({ eventId, articleId });
    expect(status).toBe(502);
    expect(body).toEqual({ success: false, error: "The AI read failed; try again." });
    expect(scanRows()).toEqual([{ status: "error", attempts: 1 }]);
    const list = (await getUnread(`?eventId=${eventId}`)).body.data.articles;
    expect(list.map((a: { state: string }) => a.state)).toEqual(["read_failed"]);
  });
});
