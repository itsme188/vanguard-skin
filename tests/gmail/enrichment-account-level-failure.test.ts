/**
 * An account-level AI failure must not burn an article's retry cap, and one
 * failing article must not block the queue behind it.
 *
 * Finding: research-feeds--billing-outage-burned-enrich-retry-cap-no-retry-when-credit-returns
 * Owner ruling: billing, rate-limit and outage failures do not count toward
 * MAX_ENRICH_ATTEMPTS and leave processed_at NULL; article-level failures
 * count as before; Unfilter and Retry re-queue.
 *
 * These tests run the whole real path: processUnprocessedArticles -> the
 * repo's AI gateway (generateObjectForFeature) -> the AI SDK -> the Anthropic
 * provider. ONLY the network is replaced (global fetch), with Anthropic's
 * error envelopes from tests/helpers/ai-sdk-real-errors.ts, so the error the
 * failure handler sees is the one production sees.
 *
 * Network isolation: the API key is forced to a dummy value; the default
 * fetch stub THROWS and records the call, and afterEach fails the test if any
 * request arrived that the test did not install a responder for; every pass
 * first checks that global fetch is still the stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { processUnprocessedArticles, type ProcessArticlesResult } from "@/lib/gmail/process";
import {
  COUNTED_AGAINST_ARTICLE_MARKER,
  MAX_ENRICH_ATTEMPTS,
  classifyStoredFailureReason,
} from "@/lib/gmail/enrichment-failure";
import { retryArticleEnrichment, unfilterArticle } from "@/lib/mutations/research-articles";
import {
  ANTHROPIC_FAILURES,
  CREDIT_BALANCE_MESSAGE,
  anthropicMessage,
  fetchFailed,
  type AnthropicFailureName,
} from "../helpers/ai-sdk-real-errors";

const GOOD_ANALYSIS = {
  summary: "ZZAA guided revenue higher and the desk sees room for estimates to move up.",
  key_themes: ["guidance"],
  sentiment: "bullish",
  sentiment_score: 0.5,
  mentioned_symbols: [],
  portfolio_relevance: "Relevant to your ZZAA position.",
  is_portfolio_relevant: true,
};
const ok = () => anthropicMessage(JSON.stringify(GOOD_ANALYSIS));

/** A responder sees the subject of the article the request is about. */
type Responder = (subject: string) => Response | Promise<Response>;
let responder: Responder | null;
let unstubbedRequests: string[];
let fetchStub: ReturnType<typeof vi.fn>;
let errorLog: MockInstance<typeof console.error>;
let warnLog: MockInstance<typeof console.warn>;
let savedKey: string | undefined;

function subjectOf(init: RequestInit | undefined): string {
  const body = typeof init?.body === "string" ? init.body : "";
  return /Subject: (ZZ letter \d+)/.exec(body)?.[1] ?? "(no subject in request)";
}

beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  responder = null;
  unstubbedRequests = [];
  fetchStub = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (!responder) {
      unstubbedRequests.push(String(input));
      throw new Error(`TEST BUG: a request reached fetch with no responder installed (${String(input)})`);
    }
    return responder(subjectOf(init));
  });
  vi.stubGlobal("fetch", fetchStub);
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  const leaked = unstubbedRequests;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  errorLog.mockRestore();
  warnLog.mockRestore();
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  expect(leaked, "a request was made that no test responder was installed for").toEqual([]);
});

/** One enrichment pass, refusing to run if the network stub is not in place. */
async function runPass(db: Database.Database): Promise<ProcessArticlesResult> {
  if (globalThis.fetch !== fetchStub) throw new Error("TEST BUG: global fetch is not the test stub");
  return processUnprocessedArticles(db);
}

/** Every request gets the same answer. */
function respondAll(r: () => Response | Promise<Response>): void {
  responder = () => r();
}
/** Answer by article subject; anything not listed succeeds. */
function respondBySubject(map: Record<string, () => Response | Promise<Response>>): void {
  responder = (subject) => (map[subject] ?? ok)();
}

function makeDb(): { db: Database.Database; sourceId: number } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const sourceId = db.prepare(`INSERT INTO research_sources (name) VALUES ('ZZ Test Letter')`).run()
    .lastInsertRowid as number;
  return { db, sourceId };
}

/**
 * Queue articles newest-first: the first one inserted is the head of the
 * queue. Returns ids and subjects in queue order.
 */
let seq = 0;
function queue(
  db: Database.Database,
  sourceId: number,
  count: number,
  opts: { attempts?: number[] } = {},
): Array<{ id: number; subject: string }> {
  const out: Array<{ id: number; subject: string }> = [];
  for (let i = 0; i < count; i++) {
    seq += 1;
    const subject = `ZZ letter ${seq}`;
    // Later position in the queue = older received_at (the queue is newest first).
    const receivedAt = `2026-01-05 ${String(23 - Math.floor(i / 60)).padStart(2, "0")}:${String(59 - (i % 60)).padStart(2, "0")}:00`;
    const id = db
      .prepare(
        `INSERT INTO research_articles
           (source_id, gmail_message_id, subject, sender, raw_text, received_at, enrich_attempts)
         VALUES (?, ?, ?, 'letters@example.test', 'ZZAA raised its outlook for the year.', ?, ?)`,
      )
      .run(sourceId, `g3-msg-${seq}`, subject, receivedAt, opts.attempts?.[i] ?? 0).lastInsertRowid as number;
    out.push({ id, subject });
  }
  return out;
}

/** New mail: one article newer than everything queued so far (so it is attempted first). */
let arrivals = 0;
function newMail(db: Database.Database, sourceId: number): { id: number; subject: string } {
  seq += 1;
  arrivals += 1;
  const subject = `ZZ letter ${seq}`;
  const receivedAt = `2026-03-01 ${String(Math.floor(arrivals / 60)).padStart(2, "0")}:${String(arrivals % 60).padStart(2, "0")}:00`;
  const id = db
    .prepare(
      `INSERT INTO research_articles
         (source_id, gmail_message_id, subject, sender, raw_text, received_at)
       VALUES (?, ?, ?, 'letters@example.test', 'ZZAA raised its outlook for the year.', ?)`,
    )
    .run(sourceId, `g3-msg-${seq}`, subject, receivedAt).lastInsertRowid as number;
  return { id, subject };
}

interface Row {
  enrich_attempts: number;
  processed_at: string | null;
  is_relevant: number;
  excluded_category: string | null;
  excluded_reason: string | null;
  summary: string | null;
}
function row(db: Database.Database, id: number): Row {
  return db
    .prepare(
      `SELECT enrich_attempts, processed_at, is_relevant, excluded_category, excluded_reason, summary
         FROM research_articles WHERE id = ?`,
    )
    .get(id) as Row;
}

/** Queued and never charged an attempt. */
const UNTOUCHED: Partial<Row> = {
  enrich_attempts: 0,
  processed_at: null,
  is_relevant: 1,
  excluded_category: null,
  excluded_reason: null,
};
/** Queued, with `n` attempts charged. */
const queuedWith = (n: number): Partial<Row> => ({ ...UNTOUCHED, enrich_attempts: n });
function expectEnriched(db: Database.Database, id: number): void {
  const r = row(db, id);
  expect(r.processed_at).not.toBeNull();
  expect(r.summary).toBe(GOOD_ANALYSIS.summary);
  expect(r.is_relevant).toBe(1);
}

describe("an outage (every article fails account-level) never uses an attempt", () => {
  const accountLevel: Array<[AnthropicFailureName, number]> = [
    // [failure, HTTP calls the SDK makes for one enrichment call]
    ["billing400", 1],
    ["billing402", 1],
    ["auth401", 1],
    ["permission403", 1],
    ["rateLimit429", 3],
    ["bare429", 3],
    ["overloaded529", 3],
    ["apiError500", 3],
    ["gatewayHtml502", 3],
  ];

  it.each(accountLevel)(
    "%s with one fresh article queued, well past the cap: still queued, nothing counted",
    async (name, callsPerAttempt) => {
      const { db, sourceId } = makeDb();
      const [a] = queue(db, sourceId, 1);
      respondAll(ANTHROPIC_FAILURES[name]);

      const passes = MAX_ENRICH_ATTEMPTS + 2;
      for (let i = 0; i < passes; i++) {
        expect(await runPass(db)).toEqual({ processed: 0, failed: 1, deferred: 1 });
      }

      expect(row(db, a.id)).toMatchObject(UNTOUCHED);
      expect(fetchStub).toHaveBeenCalledTimes(passes * callsPerAttempt);
    },
  );

  it.each(accountLevel)(
    "%s with several fresh articles queued, ten passes: nothing counted, two calls per pass",
    async (name, callsPerAttempt) => {
      const { db, sourceId } = makeDb();
      const articles = queue(db, sourceId, 4);
      respondAll(ANTHROPIC_FAILURES[name]);

      for (let i = 0; i < 10; i++) {
        expect(await runPass(db)).toEqual({ processed: 0, failed: 2, deferred: 2 });
      }

      for (const a of articles) expect(row(db, a.id)).toMatchObject(UNTOUCHED);
      expect(fetchStub).toHaveBeenCalledTimes(10 * 2 * callsPerAttempt);
    },
  );

  it("no network at all (the SDK retries with its real back-off): still queued", async () => {
    const { db, sourceId } = makeDb();
    const [a] = queue(db, sourceId, 1);
    respondAll(() => {
      throw fetchFailed();
    });
    // A failed connection has no retry-after header, so the SDK waits its
    // real 2s then 4s between tries. Only setTimeout is faked.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    for (let i = 0; i < MAX_ENRICH_ATTEMPTS + 1; i++) {
      const pass = runPass(db);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pass).toEqual({ processed: 0, failed: 1, deferred: 1 });
    }

    expect(row(db, a.id)).toMatchObject(UNTOUCHED);
    expect(fetchStub).toHaveBeenCalledTimes((MAX_ENRICH_ATTEMPTS + 1) * 3);
  });

  it.each([
    ["a bare fetch failure with no cause", () => new TypeError("fetch failed")],
    ["an aborted request", () => new DOMException("This operation was aborted", "AbortError")],
    ["a timed-out request", () => new DOMException("The operation timed out", "TimeoutError")],
  ])("%s (the SDK passes it through unwrapped): still queued", async (_label, make) => {
    const { db, sourceId } = makeDb();
    const [a] = queue(db, sourceId, 1);
    respondAll(() => {
      throw make();
    });

    for (let i = 0; i < MAX_ENRICH_ATTEMPTS + 2; i++) {
      expect(await runPass(db)).toEqual({ processed: 0, failed: 1, deferred: 1 });
    }

    expect(row(db, a.id)).toMatchObject(UNTOUCHED);
    expect(warnLog.mock.calls.map((c) => c.join(" ")).join("\n")).not.toMatch(/unrecognised enrichment error/);
  });

  it("everything is enriched on the first pass after the provider comes back", async () => {
    const { db, sourceId } = makeDb();
    const articles = queue(db, sourceId, 3);

    respondAll(ANTHROPIC_FAILURES.billing400);
    for (let i = 0; i < MAX_ENRICH_ATTEMPTS + 1; i++) await runPass(db);
    for (const a of articles) expect(row(db, a.id)).toMatchObject(UNTOUCHED);

    respondAll(ok);
    expect(await runPass(db)).toEqual({ processed: 3, failed: 0, deferred: 0 });
    for (const a of articles) {
      expectEnriched(db, a.id);
      expect(row(db, a.id).enrich_attempts).toBe(0);
    }
  });

  it.each(accountLevel)(
    "%s on a queue whose articles already used attempts [1, 2], ten passes: nothing changes",
    async (name) => {
      const { db, sourceId } = makeDb();
      const [a, b] = queue(db, sourceId, 2, { attempts: [1, 2] });
      respondAll(ANTHROPIC_FAILURES[name]);

      for (let i = 0; i < 10; i++) {
        expect(await runPass(db)).toEqual({ processed: 0, failed: 2, deferred: 2 });
      }

      expect(row(db, a.id)).toMatchObject(queuedWith(1));
      expect(row(db, b.id)).toMatchObject(queuedWith(2));
    },
  );

  it.each(accountLevel)(
    "%s with ONE queued article that already used two attempts, ten passes: never counted, never excluded",
    async (name) => {
      const { db, sourceId } = makeDb();
      const [a] = queue(db, sourceId, 1, { attempts: [MAX_ENRICH_ATTEMPTS - 1] });
      respondAll(ANTHROPIC_FAILURES[name]);

      for (let i = 0; i < 10; i++) {
        expect(await runPass(db)).toEqual({ processed: 0, failed: 1, deferred: 1 });
      }

      expect(row(db, a.id)).toMatchObject(queuedWith(MAX_ENRICH_ATTEMPTS - 1));
    },
  );

  it("the log names the class and status but not the provider's message", async () => {
    const { db, sourceId } = makeDb();
    queue(db, sourceId, 1);
    respondAll(ANTHROPIC_FAILURES.billing400);

    await runPass(db);

    const logged = errorLog.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toMatch(/account-level/);
    expect(logged).toMatch(/billing, HTTP 400, invalid_request_error/);
    expect(logged).toMatch(/not counted/);
    expect(logged).not.toContain("credit balance");
  });
});

describe("who is charged: orderings within one pass", () => {
  it("[account, ok]: the provider answered the next article, so the failure is charged to its article", async () => {
    const { db, sourceId } = makeDb();
    const [a, b] = queue(db, sourceId, 2);
    respondBySubject({ [a.subject]: ANTHROPIC_FAILURES.apiError500 });

    expect(await runPass(db)).toEqual({ processed: 1, failed: 1, deferred: 0 });

    expect(row(db, a.id)).toMatchObject(queuedWith(1));
    expectEnriched(db, b.id);
  });

  it("[account, account, x, x]: stop; neither is counted and the rest are not attempted", async () => {
    const { db, sourceId } = makeDb();
    const [a, b, c, d] = queue(db, sourceId, 4);
    respondBySubject({ [a.subject]: ANTHROPIC_FAILURES.billing400, [b.subject]: ANTHROPIC_FAILURES.billing400 });

    expect(await runPass(db)).toEqual({ processed: 0, failed: 2, deferred: 2 });

    expect(fetchStub).toHaveBeenCalledTimes(2);
    for (const x of [a, b, c, d]) expect(row(db, x.id)).toMatchObject(UNTOUCHED);
  });

  it("[account, article-level]: a refusal is the provider answering, so both are charged", async () => {
    const { db, sourceId } = makeDb();
    const [a, b] = queue(db, sourceId, 2);
    respondBySubject({ [a.subject]: ANTHROPIC_FAILURES.apiError500, [b.subject]: ANTHROPIC_FAILURES.refusal });

    expect(await runPass(db)).toEqual({ processed: 0, failed: 2, deferred: 0 });

    expect(row(db, a.id)).toMatchObject(queuedWith(1));
    expect(row(db, b.id)).toMatchObject(queuedWith(1));
  });

  it("[ok, account, ok]: charged", async () => {
    const { db, sourceId } = makeDb();
    const [a, b, c] = queue(db, sourceId, 3);
    respondBySubject({ [b.subject]: ANTHROPIC_FAILURES.permission403 });

    expect(await runPass(db)).toEqual({ processed: 2, failed: 1, deferred: 0 });

    expectEnriched(db, a.id);
    expect(row(db, b.id)).toMatchObject(queuedWith(1));
    expectEnriched(db, c.id);
  });

  it("[ok, account] with the failure LAST: charged, because the provider answered earlier in the pass", async () => {
    const { db, sourceId } = makeDb();
    const [a, b] = queue(db, sourceId, 2);
    respondBySubject({ [b.subject]: ANTHROPIC_FAILURES.apiError500 });

    expect(await runPass(db)).toEqual({ processed: 1, failed: 1, deferred: 0 });

    expectEnriched(db, a.id);
    expect(row(db, b.id)).toMatchObject(queuedWith(1));
  });

  it("[ok, account, account, x]: an outage that starts mid-pass stops it; neither failure is charged", async () => {
    const { db, sourceId } = makeDb();
    const [a, b, c, d] = queue(db, sourceId, 4);
    respondBySubject({ [b.subject]: ANTHROPIC_FAILURES.billing400, [c.subject]: ANTHROPIC_FAILURES.billing400 });

    expect(await runPass(db)).toEqual({ processed: 1, failed: 2, deferred: 2 });

    expect(fetchStub).toHaveBeenCalledTimes(3);
    expectEnriched(db, a.id);
    for (const x of [b, c, d]) expect(row(db, x.id)).toMatchObject(UNTOUCHED);
  });

  it("[account] alone, fresh article: not charged (nothing to compare it with)", async () => {
    const { db, sourceId } = makeDb();
    const [a] = queue(db, sourceId, 1);
    respondAll(ANTHROPIC_FAILURES.apiError500);

    expect(await runPass(db)).toEqual({ processed: 0, failed: 1, deferred: 1 });
    expect(row(db, a.id)).toMatchObject(UNTOUCHED);
  });

  it("[account] alone, article that already has a counted attempt: still not counted", async () => {
    const { db, sourceId } = makeDb();
    const [a] = queue(db, sourceId, 1, { attempts: [1] });
    respondAll(ANTHROPIC_FAILURES.apiError500);

    expect(await runPass(db)).toEqual({ processed: 0, failed: 1, deferred: 1 });
    expect(row(db, a.id)).toMatchObject(queuedWith(1));
  });

  it("[ok, 429, ok]: a rate limit followed by an answer for a LATER article is counted once", async () => {
    const { db, sourceId } = makeDb();
    const [a, b, c] = queue(db, sourceId, 3);
    respondBySubject({ [b.subject]: ANTHROPIC_FAILURES.rateLimit429 });

    expect(await runPass(db)).toEqual({ processed: 2, failed: 1, deferred: 0 });

    expectEnriched(db, a.id);
    expect(row(db, b.id)).toMatchObject(queuedWith(1));
    expectEnriched(db, c.id);
  });

  it.each(["rateLimit429", "bare429"] as AnthropicFailureName[])(
    "[ok, %s] with the rate limit LAST: not counted (the earlier call may be what used up the limit)",
    async (name) => {
      const { db, sourceId } = makeDb();
      const [a, b] = queue(db, sourceId, 2);
      respondBySubject({ [b.subject]: ANTHROPIC_FAILURES[name] });

      expect(await runPass(db)).toEqual({ processed: 1, failed: 1, deferred: 1 });

      expectEnriched(db, a.id);
      expect(row(db, b.id)).toMatchObject(UNTOUCHED);
    },
  );

  it("[account, unknown-with-no-status]: an error that proves nothing leaves the account failure uncharged", async () => {
    const { db, sourceId } = makeDb();
    const [a, b] = queue(db, sourceId, 2);
    respondBySubject({
      [a.subject]: ANTHROPIC_FAILURES.apiError500,
      [b.subject]: () => {
        throw new Error("a failure nobody has seen before");
      },
    });

    expect(await runPass(db)).toEqual({ processed: 0, failed: 2, deferred: 1 });

    expect(row(db, a.id)).toMatchObject(UNTOUCHED);
    expect(row(db, b.id)).toMatchObject(queuedWith(1));
  });

  it("a pass cut off by its batch size: the failure in the last slot is judged by the answers before it", async () => {
    const { db, sourceId } = makeDb();
    const articles = queue(db, sourceId, 21);
    const last = articles[19]; // 20th: the last article this pass takes
    const beyond = articles[20]; // 21st: not in this pass
    respondBySubject({ [last.subject]: ANTHROPIC_FAILURES.billing400 });

    expect(await runPass(db)).toEqual({ processed: 19, failed: 1, deferred: 0 });

    expect(fetchStub).toHaveBeenCalledTimes(20);
    expect(row(db, last.id)).toMatchObject(queuedWith(1));
    expect(row(db, beyond.id)).toMatchObject(UNTOUCHED);
  });

  it("a full batch during an outage: two calls, not twenty", async () => {
    const { db, sourceId } = makeDb();
    const articles = queue(db, sourceId, 25);
    respondAll(ANTHROPIC_FAILURES.billing400);

    expect(await runPass(db)).toEqual({ processed: 0, failed: 2, deferred: 2 });

    expect(fetchStub).toHaveBeenCalledTimes(2);
    for (const a of articles) expect(row(db, a.id)).toMatchObject(UNTOUCHED);
  });
});

describe("one article that always fails does not block the queue", () => {
  const poisons: Array<[string, () => Response, RegExp]> = [
    ["a 500 for its own content", ANTHROPIC_FAILURES.apiError500, /Internal server error/],
    ["a 403", ANTHROPIC_FAILURES.permission403, /does not have permission/],
    [
      "a 400 whose message contains the billing phrase",
      ANTHROPIC_FAILURES.billing400,
      /credit balance is too low/,
    ],
  ];

  it.each(poisons)(
    "reviewer probe [newer, bad, older, older], %s: the others are enriched in pass 1; the bad one is capped by pass 3 as mail keeps arriving",
    async (_label, poison, text) => {
      const { db, sourceId } = makeDb();
      const [newer, bad, older1, older2] = queue(db, sourceId, 4);
      respondBySubject({ [bad.subject]: poison });

      // Pass 1: everything else is enriched; the bad article is counted once.
      expect(await runPass(db)).toEqual({ processed: 3, failed: 1, deferred: 0 });
      for (const a of [newer, older1, older2]) expectEnriched(db, a.id);
      expect(row(db, bad.id)).toMatchObject(queuedWith(1));

      // Passes 2 and 3: new mail is enriched ahead of it, so it is counted again.
      const m2 = newMail(db, sourceId);
      expect(await runPass(db)).toEqual({ processed: 1, failed: 1, deferred: 0 });
      expectEnriched(db, m2.id);
      expect(row(db, bad.id)).toMatchObject(queuedWith(2));
      const m3 = newMail(db, sourceId);
      expect(await runPass(db)).toEqual({ processed: 1, failed: 1, deferred: 0 });
      expectEnriched(db, m3.id);

      const capped = row(db, bad.id);
      expect(capped.enrich_attempts).toBe(MAX_ENRICH_ATTEMPTS);
      expect(capped.excluded_category).toBe("enrichment_failed");
      expect(capped.is_relevant).toBe(0);
      expect(capped.processed_at).not.toBeNull();
      // The reason still says what the provider returned, and why it was counted.
      expect(capped.excluded_reason).toMatch(/^Enrichment failed 3 times — last failure: /);
      expect(capped.excluded_reason).toMatch(text);
      expect(capped.excluded_reason).toContain(COUNTED_AGAINST_ARTICLE_MARKER);
      // ...so the repair script does not take it for an outage casualty.
      expect(classifyStoredFailureReason(capped.excluded_reason)).toBeNull();

      // Out of the queue: later passes make no call at all.
      fetchStub.mockClear();
      for (let i = 0; i < 7; i++) {
        expect(await runPass(db)).toEqual({ processed: 0, failed: 0, deferred: 0 });
      }
      expect(fetchStub).not.toHaveBeenCalled();
    },
  );

  it("the same probe with NO new mail: the others are enriched, the bad one waits at one attempt, one call per pass", async () => {
    const { db, sourceId } = makeDb();
    const [newer, bad, older1, older2] = queue(db, sourceId, 4);
    respondBySubject({ [bad.subject]: ANTHROPIC_FAILURES.billing400 });

    expect(await runPass(db)).toEqual({ processed: 3, failed: 1, deferred: 0 });
    for (const a of [newer, older1, older2]) expectEnriched(db, a.id);

    fetchStub.mockClear();
    for (let i = 0; i < 10; i++) {
      expect(await runPass(db)).toEqual({ processed: 0, failed: 1, deferred: 1 });
    }
    expect(fetchStub).toHaveBeenCalledTimes(10);
    expect(row(db, bad.id)).toMatchObject(queuedWith(1));
  });

  it("a fresh bad article alone in the queue, ten passes: attempts stay 0, one call per pass", async () => {
    const { db, sourceId } = makeDb();
    const [bad] = queue(db, sourceId, 1);
    respondAll(ANTHROPIC_FAILURES.billing400);

    for (let i = 0; i < 10; i++) {
      expect(await runPass(db)).toEqual({ processed: 0, failed: 1, deferred: 1 });
    }

    expect(fetchStub).toHaveBeenCalledTimes(10);
    expect(row(db, bad.id)).toMatchObject(UNTOUCHED);
  });

  it("the stored message is the provider's own text followed by why it was counted", async () => {
    const { db, sourceId } = makeDb();
    const [, bad] = queue(db, sourceId, 2);
    respondBySubject({ [bad.subject]: ANTHROPIC_FAILURES.billing400 });
    await runPass(db);
    for (let i = 1; i < MAX_ENRICH_ATTEMPTS; i++) {
      newMail(db, sourceId);
      await runPass(db);
    }

    expect(row(db, bad.id).excluded_reason).toBe(
      `Enrichment failed 3 times — last failure: ${CREDIT_BALANCE_MESSAGE.slice(0, 200)} ` +
        `[counted against this article: the provider answered another article in the same pass]`,
    );
  });
});

describe("an outage that starts in the middle of a pass does not exclude a healthy article", () => {
  it.each([
    ["a 500", ANTHROPIC_FAILURES.apiError500, 3],
    ["out of credit (the billing 400)", ANTHROPIC_FAILURES.billing400, 1],
  ] as Array<[string, () => Response, number]>)(
    "reviewer probe: pass 1 is [ok, fail], then the provider stays down with the article alone (%s)",
    async (_label, failure, callsPerAttempt) => {
      const { db, sourceId } = makeDb();
      const [first, healthy] = queue(db, sourceId, 2);

      // Pass 1: the first article is answered, then the provider goes down.
      respondBySubject({ [healthy.subject]: failure });
      expect(await runPass(db)).toEqual({ processed: 1, failed: 1, deferred: 0 });
      expectEnriched(db, first.id);
      expect(row(db, healthy.id)).toMatchObject(queuedWith(1));

      // Three more passes, provider down for everything, the article alone.
      respondAll(failure);
      fetchStub.mockClear();
      for (let i = 0; i < 3; i++) {
        expect(await runPass(db)).toEqual({ processed: 0, failed: 1, deferred: 1 });
      }
      expect(fetchStub).toHaveBeenCalledTimes(3 * callsPerAttempt);
      expect(row(db, healthy.id)).toMatchObject(queuedWith(1));

      // The provider returns: the article is enriched.
      respondAll(ok);
      expect(await runPass(db)).toEqual({ processed: 1, failed: 0, deferred: 0 });
      expectEnriched(db, healthy.id);
      expect(row(db, healthy.id).excluded_category).toBeNull();
    },
  );
});

describe("a rate limit at the tail of a pass is not the tail article's fault", () => {
  it("reviewer probe: [ok x 19, 429] over four passes with new mail before each: the tail article's attempts stay 0", async () => {
    const { db, sourceId } = makeDb();
    const [tail] = queue(db, sourceId, 1);
    respondBySubject({ [tail.subject]: ANTHROPIC_FAILURES.rateLimit429 });

    for (let pass = 0; pass < 4; pass++) {
      const fresh = Array.from({ length: 19 }, () => newMail(db, sourceId));
      fetchStub.mockClear();

      expect(await runPass(db)).toEqual({ processed: 19, failed: 1, deferred: 1 });

      // 19 answered calls, then the tail's call tried three times by the SDK.
      expect(fetchStub).toHaveBeenCalledTimes(19 + 3);
      for (const f of fresh) expectEnriched(db, f.id);
      expect(row(db, tail.id)).toMatchObject(UNTOUCHED);
    }
  });

  it("when the limit lifts, the tail article is enriched", async () => {
    const { db, sourceId } = makeDb();
    const [tail] = queue(db, sourceId, 1);
    respondBySubject({ [tail.subject]: ANTHROPIC_FAILURES.rateLimit429 });
    newMail(db, sourceId);
    await runPass(db);
    expect(row(db, tail.id)).toMatchObject(UNTOUCHED);

    respondAll(ok);
    expect(await runPass(db)).toEqual({ processed: 1, failed: 0, deferred: 0 });
    expectEnriched(db, tail.id);
  });
});

describe("article-level failures still count and still exclude at the cap", () => {
  const articleLevel: Array<[AnthropicFailureName, RegExp]> = [
    ["refusal", /No object generated/],
    ["malformedOutput", /No object generated/],
    ["promptTooLong400", /prompt is too long/],
    ["requestTooLarge413", /maximum allowed/],
  ];

  it.each(articleLevel)("%s three times: excluded as enrichment_failed", async (name, reason) => {
    const { db, sourceId } = makeDb();
    const [a] = queue(db, sourceId, 1);
    respondAll(ANTHROPIC_FAILURES[name]);

    for (let i = 1; i <= MAX_ENRICH_ATTEMPTS; i++) {
      expect(await runPass(db)).toEqual({ processed: 0, failed: 1, deferred: 0 });
      expect(row(db, a.id).enrich_attempts).toBe(i);
      if (i < MAX_ENRICH_ATTEMPTS) expect(row(db, a.id)).toMatchObject({ processed_at: null, is_relevant: 1 });
    }

    const after = row(db, a.id);
    expect(after.is_relevant).toBe(0);
    expect(after.excluded_category).toBe("enrichment_failed");
    expect(after.processed_at).not.toBeNull();
    expect(after.excluded_reason).toMatch(/^Enrichment failed 3 times — last failure: /);
    expect(after.excluded_reason).toMatch(reason);
    expect(after.excluded_reason).not.toContain(COUNTED_AGAINST_ARTICLE_MARKER);

    // And it is out of the queue: a fourth pass makes no call.
    fetchStub.mockClear();
    expect(await runPass(db)).toEqual({ processed: 0, failed: 0, deferred: 0 });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("an article-level failure does not stop the pass: the next article is still tried", async () => {
    const { db, sourceId } = makeDb();
    const [refused, fine] = queue(db, sourceId, 2);
    respondBySubject({ [refused.subject]: ANTHROPIC_FAILURES.refusal });

    expect(await runPass(db)).toEqual({ processed: 1, failed: 1, deferred: 0 });
    expect(row(db, refused.id).enrich_attempts).toBe(1);
    expectEnriched(db, fine.id);
  });

  it("an UNKNOWN error counts toward the cap, and is logged as unrecognised", async () => {
    const { db, sourceId } = makeDb();
    const [a] = queue(db, sourceId, 1);
    // Not a fetch failure, abort or timeout, so nothing recognises it.
    respondAll(() => {
      throw new Error("a failure nobody has seen before");
    });

    for (let i = 0; i < MAX_ENRICH_ATTEMPTS; i++) {
      expect(await runPass(db)).toEqual({ processed: 0, failed: 1, deferred: 0 });
    }

    const after = row(db, a.id);
    expect(after.enrich_attempts).toBe(MAX_ENRICH_ATTEMPTS);
    expect(after.excluded_category).toBe("enrichment_failed");
    expect(after.processed_at).not.toBeNull();
    const warned = warnLog.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warned).toMatch(/unrecognised enrichment error/);
    expect(warned).toMatch(/counted toward the retry cap/);
  });

  it("an empty enrichment (no summary, no themes) still counts", async () => {
    const { db, sourceId } = makeDb();
    const [a] = queue(db, sourceId, 1);
    respondAll(() =>
      anthropicMessage(JSON.stringify({ ...GOOD_ANALYSIS, summary: "", key_themes: [], portfolio_relevance: "" })),
    );

    for (let i = 0; i < MAX_ENRICH_ATTEMPTS; i++) await runPass(db);

    expect(row(db, a.id)).toMatchObject({ enrich_attempts: MAX_ENRICH_ATTEMPTS, excluded_category: "enrichment_failed" });
  });
});

describe("Retry and Unfilter put an excluded article back through enrichment", () => {
  async function failOut(db: Database.Database, id: number): Promise<void> {
    respondAll(ANTHROPIC_FAILURES.refusal);
    for (let i = 0; i < MAX_ENRICH_ATTEMPTS; i++) await runPass(db);
    expect(row(db, id)).toMatchObject({ excluded_category: "enrichment_failed", is_relevant: 0 });
    respondAll(ok);
    fetchStub.mockClear();
  }

  it("Retry: the next pass enriches it", async () => {
    const { db, sourceId } = makeDb();
    const [a] = queue(db, sourceId, 1);
    await failOut(db, a.id);

    expect(retryArticleEnrichment(db, a.id)).toEqual({ status: "requeued" });
    expect(row(db, a.id)).toMatchObject(UNTOUCHED);

    expect(await runPass(db)).toEqual({ processed: 1, failed: 0, deferred: 0 });
    expectEnriched(db, a.id);
    expect(row(db, a.id).excluded_category).toBeNull();
  });

  it("Unfilter: the next pass enriches it (before the fix it stayed stamped and empty)", async () => {
    const { db, sourceId } = makeDb();
    const [a] = queue(db, sourceId, 1);
    await failOut(db, a.id);

    expect(unfilterArticle(db, a.id)).toEqual({ changed: true, requeued: true });
    expect(row(db, a.id)).toMatchObject(UNTOUCHED);

    expect(await runPass(db)).toEqual({ processed: 1, failed: 0, deferred: 0 });
    expectEnriched(db, a.id);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("a re-queued article gets a fresh set of attempts", async () => {
    const { db, sourceId } = makeDb();
    const [a] = queue(db, sourceId, 1);
    await failOut(db, a.id);
    retryArticleEnrichment(db, a.id);

    respondAll(ANTHROPIC_FAILURES.refusal);
    await runPass(db);
    expect(row(db, a.id)).toMatchObject(queuedWith(1));
  });
});

describe("the network guard itself", () => {
  it("a request with no responder installed throws and is recorded", async () => {
    const { db, sourceId } = makeDb();
    queue(db, sourceId, 1);

    await runPass(db);

    expect(unstubbedRequests).toHaveLength(1);
    expect(unstubbedRequests[0]).toMatch(/\/messages$/);
    unstubbedRequests.length = 0; // expected here; afterEach fails any other test that leaks
  });
});
