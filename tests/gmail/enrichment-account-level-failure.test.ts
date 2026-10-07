/**
 * An account-level AI failure must not burn an article's retry cap.
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
 * failure handler sees is the one production sees. The API key is forced to a
 * dummy value and every test asserts the stub was what answered.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { processUnprocessedArticles } from "@/lib/gmail/process";
import { MAX_ENRICH_ATTEMPTS } from "@/lib/gmail/enrichment-failure";
import { retryArticleEnrichment, unfilterArticle } from "@/lib/mutations/research-articles";
import {
  ANTHROPIC_FAILURES,
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

type Responder = () => Response | Promise<Response>;
let respond: Responder;
let fetchStub: ReturnType<typeof vi.fn>;
let errorLog: MockInstance<typeof console.error>;
let warnLog: MockInstance<typeof console.warn>;
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  respond = () => anthropicMessage(JSON.stringify(GOOD_ANALYSIS));
  fetchStub = vi.fn(async () => respond());
  vi.stubGlobal("fetch", fetchStub);
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  errorLog.mockRestore();
  warnLog.mockRestore();
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

function makeDb(): { db: Database.Database; sourceId: number } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const sourceId = db.prepare(`INSERT INTO research_sources (name) VALUES ('ZZ Test Letter')`).run()
    .lastInsertRowid as number;
  return { db, sourceId };
}

let seq = 0;
function insertQueued(
  db: Database.Database,
  sourceId: number,
  opts: { receivedAt?: string; attempts?: number } = {},
): number {
  seq += 1;
  return db
    .prepare(
      `INSERT INTO research_articles
         (source_id, gmail_message_id, subject, sender, raw_text, received_at, enrich_attempts)
       VALUES (?, ?, ?, 'letters@example.test', 'ZZAA raised its outlook for the year.', ?, ?)`,
    )
    .run(sourceId, `g3-msg-${seq}`, `ZZ letter ${seq}`, opts.receivedAt ?? "2026-01-05 12:00:00", opts.attempts ?? 0)
    .lastInsertRowid as number;
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

const STILL_QUEUED: Partial<Row> = {
  enrich_attempts: 0,
  processed_at: null,
  is_relevant: 1,
  excluded_category: null,
  excluded_reason: null,
};

describe("account-level failures leave the article queued and uncounted", () => {
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
    "%s on every pass, well past the cap: still queued, attempt count untouched",
    async (name, callsPerAttempt) => {
      const { db, sourceId } = makeDb();
      const id = insertQueued(db, sourceId);
      respond = ANTHROPIC_FAILURES[name];

      const passes = MAX_ENRICH_ATTEMPTS + 2;
      for (let i = 0; i < passes; i++) {
        const result = await processUnprocessedArticles(db);
        expect(result).toEqual({ processed: 0, failed: 1, deferred: 1 });
      }

      expect(row(db, id)).toMatchObject(STILL_QUEUED);
      expect(fetchStub).toHaveBeenCalledTimes(passes * callsPerAttempt);
    },
  );

  it("no network at all: still queued", async () => {
    const { db, sourceId } = makeDb();
    const id = insertQueued(db, sourceId);
    respond = () => {
      throw fetchFailed();
    };
    // A failed connection has no retry-after header, so the SDK waits its
    // real 2s then 4s between tries. Only setTimeout is faked.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    for (let i = 0; i < MAX_ENRICH_ATTEMPTS + 1; i++) {
      const pass = processUnprocessedArticles(db);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pass).toEqual({ processed: 0, failed: 1, deferred: 1 });
    }

    expect(row(db, id)).toMatchObject(STILL_QUEUED);
    expect(fetchStub).toHaveBeenCalledTimes((MAX_ENRICH_ATTEMPTS + 1) * 3);
  });

  it("the article is enriched on the first pass after the provider comes back", async () => {
    const { db, sourceId } = makeDb();
    const id = insertQueued(db, sourceId);

    respond = ANTHROPIC_FAILURES.billing400;
    for (let i = 0; i < MAX_ENRICH_ATTEMPTS + 1; i++) await processUnprocessedArticles(db);
    expect(row(db, id)).toMatchObject(STILL_QUEUED);

    respond = () => anthropicMessage(JSON.stringify(GOOD_ANALYSIS));
    const result = await processUnprocessedArticles(db);

    expect(result).toEqual({ processed: 1, failed: 0, deferred: 0 });
    const after = row(db, id);
    expect(after.processed_at).not.toBeNull();
    expect(after.summary).toBe(GOOD_ANALYSIS.summary);
    expect(after.is_relevant).toBe(1);
    expect(after.enrich_attempts).toBe(0);
  });

  it("an account-level failure does not erase attempts the article already used", async () => {
    const { db, sourceId } = makeDb();
    const id = insertQueued(db, sourceId, { attempts: MAX_ENRICH_ATTEMPTS - 1 });
    respond = ANTHROPIC_FAILURES.overloaded529;

    await processUnprocessedArticles(db);
    await processUnprocessedArticles(db);

    expect(row(db, id)).toMatchObject({ ...STILL_QUEUED, enrich_attempts: MAX_ENRICH_ATTEMPTS - 1 });
  });

  it("the log names the class and status but not the provider's message", async () => {
    const { db, sourceId } = makeDb();
    insertQueued(db, sourceId);
    respond = ANTHROPIC_FAILURES.billing400;

    await processUnprocessedArticles(db);

    const logged = errorLog.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toMatch(/account-level/);
    expect(logged).toMatch(/billing, HTTP 400, invalid_request_error/);
    expect(logged).toMatch(/not counted/);
  });
});

describe("a long outage does not hammer the provider", () => {
  it("the pass stops at the first account-level failure: one enrichment call however many are queued", async () => {
    const { db, sourceId } = makeDb();
    const ids = [
      insertQueued(db, sourceId, { receivedAt: "2026-01-05 12:00:00" }),
      insertQueued(db, sourceId, { receivedAt: "2026-01-05 11:00:00" }),
      insertQueued(db, sourceId, { receivedAt: "2026-01-05 10:00:00" }),
      insertQueued(db, sourceId, { receivedAt: "2026-01-05 09:00:00" }),
    ];
    respond = ANTHROPIC_FAILURES.billing400;

    const result = await processUnprocessedArticles(db);

    expect(result).toEqual({ processed: 0, failed: 1, deferred: 1 });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    for (const id of ids) expect(row(db, id)).toMatchObject(STILL_QUEUED);
  });

  it("articles enriched before the failure keep their result; the rest wait for the next pass", async () => {
    const { db, sourceId } = makeDb();
    const first = insertQueued(db, sourceId, { receivedAt: "2026-01-05 12:00:00" });
    const second = insertQueued(db, sourceId, { receivedAt: "2026-01-05 11:00:00" });
    const third = insertQueued(db, sourceId, { receivedAt: "2026-01-05 10:00:00" });
    let call = 0;
    respond = () => {
      call += 1;
      return call === 1 ? anthropicMessage(JSON.stringify(GOOD_ANALYSIS)) : ANTHROPIC_FAILURES.billing400();
    };

    const result = await processUnprocessedArticles(db);

    expect(result).toEqual({ processed: 1, failed: 1, deferred: 1 });
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(row(db, first).processed_at).not.toBeNull();
    expect(row(db, second)).toMatchObject(STILL_QUEUED);
    expect(row(db, third)).toMatchObject(STILL_QUEUED);
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
    const id = insertQueued(db, sourceId);
    respond = ANTHROPIC_FAILURES[name];

    for (let i = 1; i <= MAX_ENRICH_ATTEMPTS; i++) {
      const result = await processUnprocessedArticles(db);
      expect(result).toEqual({ processed: 0, failed: 1, deferred: 0 });
      expect(row(db, id).enrich_attempts).toBe(i);
      if (i < MAX_ENRICH_ATTEMPTS) expect(row(db, id)).toMatchObject({ processed_at: null, is_relevant: 1 });
    }

    const after = row(db, id);
    expect(after.is_relevant).toBe(0);
    expect(after.excluded_category).toBe("enrichment_failed");
    expect(after.processed_at).not.toBeNull();
    expect(after.excluded_reason).toMatch(/^Enrichment failed 3 times — last failure: /);
    expect(after.excluded_reason).toMatch(reason);

    // And it is out of the queue: a fourth pass makes no call.
    fetchStub.mockClear();
    expect(await processUnprocessedArticles(db)).toEqual({ processed: 0, failed: 0, deferred: 0 });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("an article-level failure does not stop the pass: the next article is still tried", async () => {
    const { db, sourceId } = makeDb();
    const refused = insertQueued(db, sourceId, { receivedAt: "2026-01-05 12:00:00" });
    const fine = insertQueued(db, sourceId, { receivedAt: "2026-01-05 11:00:00" });
    let call = 0;
    respond = () => {
      call += 1;
      return call === 1 ? ANTHROPIC_FAILURES.refusal() : anthropicMessage(JSON.stringify(GOOD_ANALYSIS));
    };

    expect(await processUnprocessedArticles(db)).toEqual({ processed: 1, failed: 1, deferred: 0 });
    expect(row(db, refused).enrich_attempts).toBe(1);
    expect(row(db, fine).processed_at).not.toBeNull();
  });

  it("an UNKNOWN error counts toward the cap, and is logged as unrecognised", async () => {
    const { db, sourceId } = makeDb();
    const id = insertQueued(db, sourceId);
    // Not a TypeError("fetch failed"), so the SDK passes it through unwrapped.
    respond = () => {
      throw new Error("a failure nobody has seen before");
    };

    for (let i = 0; i < MAX_ENRICH_ATTEMPTS; i++) {
      expect(await processUnprocessedArticles(db)).toEqual({ processed: 0, failed: 1, deferred: 0 });
    }

    const after = row(db, id);
    expect(after.enrich_attempts).toBe(MAX_ENRICH_ATTEMPTS);
    expect(after.excluded_category).toBe("enrichment_failed");
    expect(after.processed_at).not.toBeNull();
    const warned = warnLog.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warned).toMatch(/unrecognised enrichment error/);
    expect(warned).toMatch(/counted toward the retry cap/);
  });

  it("an empty enrichment (no summary, no themes) still counts", async () => {
    const { db, sourceId } = makeDb();
    const id = insertQueued(db, sourceId);
    respond = () =>
      anthropicMessage(JSON.stringify({ ...GOOD_ANALYSIS, summary: "", key_themes: [], portfolio_relevance: "" }));

    for (let i = 0; i < MAX_ENRICH_ATTEMPTS; i++) await processUnprocessedArticles(db);

    expect(row(db, id)).toMatchObject({ enrich_attempts: MAX_ENRICH_ATTEMPTS, excluded_category: "enrichment_failed" });
  });
});

describe("Retry and Unfilter put an excluded article back through enrichment", () => {
  async function failOut(db: Database.Database, id: number): Promise<void> {
    respond = ANTHROPIC_FAILURES.refusal;
    for (let i = 0; i < MAX_ENRICH_ATTEMPTS; i++) await processUnprocessedArticles(db);
    expect(row(db, id)).toMatchObject({ excluded_category: "enrichment_failed", is_relevant: 0 });
    respond = () => anthropicMessage(JSON.stringify(GOOD_ANALYSIS));
    fetchStub.mockClear();
  }

  it("Retry: the next pass enriches it", async () => {
    const { db, sourceId } = makeDb();
    const id = insertQueued(db, sourceId);
    await failOut(db, id);

    expect(retryArticleEnrichment(db, id)).toEqual({ status: "requeued" });
    expect(row(db, id)).toMatchObject(STILL_QUEUED);

    expect(await processUnprocessedArticles(db)).toEqual({ processed: 1, failed: 0, deferred: 0 });
    expect(row(db, id)).toMatchObject({ summary: GOOD_ANALYSIS.summary, is_relevant: 1, excluded_category: null });
    expect(row(db, id).processed_at).not.toBeNull();
  });

  it("Unfilter: the next pass enriches it (before the fix it stayed stamped and empty)", async () => {
    const { db, sourceId } = makeDb();
    const id = insertQueued(db, sourceId);
    await failOut(db, id);

    expect(unfilterArticle(db, id)).toEqual({ changed: true, requeued: true });
    expect(row(db, id)).toMatchObject(STILL_QUEUED);

    expect(await processUnprocessedArticles(db)).toEqual({ processed: 1, failed: 0, deferred: 0 });
    expect(row(db, id).summary).toBe(GOOD_ANALYSIS.summary);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("a re-queued article gets a fresh set of attempts", async () => {
    const { db, sourceId } = makeDb();
    const id = insertQueued(db, sourceId);
    await failOut(db, id);
    retryArticleEnrichment(db, id);

    respond = ANTHROPIC_FAILURES.refusal;
    await processUnprocessedArticles(db);
    expect(row(db, id)).toMatchObject({ enrich_attempts: 1, processed_at: null, is_relevant: 1 });
  });
});
