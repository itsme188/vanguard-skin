/**
 * Bogey intake 2026-11-18, Task D (amendment A6): the "not read" list on an
 * armed Hub row and the one-click read behind it.
 *
 * Listed: the article's text names the ticker family, it arrived inside the
 * deep read's window (DEEP_READ_WINDOW_DAYS before the slot floor, cut at the
 * floor and at now), and it has no `earnings_bogey_scans` row for this event
 * with status hit or no_numbers (any extractor version). The scan gate is not
 * an exclusion. Reading follows the rescan step's claim / compare-and-set
 * ledger protocol.
 *
 * The extractor is mocked (no AI call). Synthetic tickers (ACME, BETA),
 * invented text and figures: the repo is public.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { APIError } from "@anthropic-ai/sdk";
import { runMigrations } from "@/lib/db/migrate";
import { DEEP_READ_WINDOW_DAYS } from "@/lib/earnings/deep-read-bogeys";
import {
  NEWSLETTER_EXTRACTOR_VERSION,
  NEWSLETTER_IMAGE_EXTRACTOR_VERSION,
  type ArticleInput,
} from "@/lib/earnings/extract-newsletter-bogeys";
import {
  listUnreadPreviews,
  readArticleForEvent,
  ReadArticleRefusedError,
  UNREAD_PREVIEWS_MAX,
} from "@/lib/earnings/unread-previews";

type ExtractFn = NonNullable<Parameters<typeof readArticleForEvent>[3]>["extract"];

let db: Database.Database;

// ACME reports 2026-11-20 after the close: slot floor 16:00 ET = 21:00 UTC.
const FLOOR_MS = Date.parse("2026-11-20T21:00:00Z");
const NOW_AFTER_FLOOR = Date.parse("2026-11-21T12:00:00Z");
const FILLER =
  " Desk prose that exists only to clear the two-hundred-character floor every newsletter reader enforces on a body.".repeat(
    3,
  );

function sqlUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}
function hoursBeforeFloor(h: number): string {
  return sqlUtc(FLOOR_MS - h * 3_600_000);
}

function seedEvent(over: { symbol?: string; superseded?: number; eventTime?: string } = {}): number {
  const symbol = over.symbol ?? "ACME";
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (event_date, event_time, event_type, title, symbol, source, source_key, superseded)
         VALUES ('2026-11-20', ?, 'earnings', ?, ?, 'manual', ?, ?)`,
      )
      .run(over.eventTime ?? "AMC", `${symbol} Q3`, symbol, `manual:${symbol}:${Math.random()}`, over.superseded ?? 0)
      .lastInsertRowid,
  );
}

function seedSource(id: number, name: string) {
  db.prepare(`INSERT OR IGNORE INTO research_sources (id, name) VALUES (?, ?)`).run(id, name);
}

function seedArticle(opts: {
  text: string;
  receivedAt?: string;
  sourceId?: number;
  subject?: string;
  html?: string | null;
}): number {
  seedSource(9101, "Gated Desk Letter");
  seedSource(9102, "Open Desk Letter");
  return Number(
    db
      .prepare(
        `INSERT INTO research_articles (source_id, subject, sender, received_at, raw_text, raw_html)
         VALUES (?, ?, 'desk@example.test', ?, ?, ?)`,
      )
      .run(
        opts.sourceId ?? 9102,
        opts.subject ?? "Weekly notes",
        opts.receivedAt ?? hoursBeforeFloor(24),
        opts.text + FILLER,
        opts.html ?? null,
      ).lastInsertRowid,
  );
}

function ledger(eventId: number, articleId: number) {
  return db
    .prepare(
      `SELECT extractor_version, status, attempts, claim_token, model_id FROM earnings_bogey_scans
        WHERE event_id = ? AND article_id = ? ORDER BY extractor_version`,
    )
    .all(eventId, articleId) as Array<{
    extractor_version: number;
    status: string;
    attempts: number;
    claim_token: string | null;
    model_id: string | null;
  }>;
}

function bookScan(eventId: number, articleId: number, status: string, updatedAt = "datetime('now')", version = 2) {
  db.prepare(
    `INSERT INTO earnings_bogey_scans (event_id, article_id, extractor_version, status, attempts, claim_token, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ${updatedAt})`,
  ).run(eventId, articleId, version, status, status === "claimed" ? "someone-else" : null);
}

function billingError(): Error {
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
  return new Error("newsletter extraction failed for article 1 / event 1", { cause: sdkErr });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("listUnreadPreviews", () => {
  it("lists_ungated_mentioning_article, with its source, subject and date", () => {
    const eventId = seedEvent();
    const id = seedArticle({ text: "ACME preview: the desk wants 1.10 on EPS.", subject: "ACME into the print" });
    const list = listUnreadPreviews(db, eventId, NOW_AFTER_FLOOR);
    expect(list).toEqual([
      {
        articleId: id,
        sourceName: "Open Desk Letter",
        subject: "ACME into the print",
        receivedAt: hoursBeforeFloor(24),
        state: "not_read",
      },
    ]);
  });

  it("does not exclude a source the scan gate leaves out", () => {
    const eventId = seedEvent();
    // No rules saved and neither source is a default name: both are gated off.
    const id = seedArticle({ text: "ACME preview text.", sourceId: 9101 });
    expect(listUnreadPreviews(db, eventId, NOW_AFTER_FLOOR)?.map((a) => a.articleId)).toEqual([id]);
  });

  it("an article naming only another ticker is not listed", () => {
    const eventId = seedEvent();
    seedArticle({ text: "BETA preview text only." });
    expect(listUnreadPreviews(db, eventId, NOW_AFTER_FLOOR)).toEqual([]);
  });

  it("skips_already_ledgered: hit or no_numbers at any version drops the article", () => {
    const eventId = seedEvent();
    const hit = seedArticle({ text: "ACME one." });
    const none = seedArticle({ text: "ACME two." });
    const kept = seedArticle({ text: "ACME three." });
    bookScan(eventId, hit, "hit", "datetime('now')", 3);
    bookScan(eventId, none, "no_numbers", "datetime('now')", 2);
    expect(listUnreadPreviews(db, eventId, NOW_AFTER_FLOOR)?.map((a) => a.articleId)).toEqual([kept]);
  });

  it("shows read_failed for an error row and reading for a fresh claim", () => {
    const eventId = seedEvent();
    const failed = seedArticle({ text: "ACME failed.", receivedAt: hoursBeforeFloor(30) });
    const reading = seedArticle({ text: "ACME reading.", receivedAt: hoursBeforeFloor(20) });
    const stale = seedArticle({ text: "ACME stale.", receivedAt: hoursBeforeFloor(10) });
    bookScan(eventId, failed, "error");
    bookScan(eventId, reading, "claimed");
    bookScan(eventId, stale, "claimed", "datetime('now', '-30 minutes')");
    const states = Object.fromEntries(
      (listUnreadPreviews(db, eventId, NOW_AFTER_FLOOR) ?? []).map((a) => [a.articleId, a.state]),
    );
    expect(states).toEqual({ [failed]: "read_failed", [reading]: "reading", [stale]: "read_failed" });
  });

  it("skips_after_floor and before the window, and an article not yet received by now", () => {
    const eventId = seedEvent();
    seedArticle({ text: "ACME recap after the print.", receivedAt: hoursBeforeFloor(-1) });
    seedArticle({ text: "ACME far too early.", receivedAt: hoursBeforeFloor(DEEP_READ_WINDOW_DAYS * 24 + 1) });
    const inside = seedArticle({ text: "ACME inside.", receivedAt: hoursBeforeFloor(DEEP_READ_WINDOW_DAYS * 24 - 1) });
    const later = seedArticle({ text: "ACME later.", receivedAt: hoursBeforeFloor(2) });
    expect(listUnreadPreviews(db, eventId, NOW_AFTER_FLOOR)?.map((a) => a.articleId)).toEqual([later, inside]);
    // "Now" between the two: the later article is in the future and not listed.
    expect(listUnreadPreviews(db, eventId, FLOOR_MS - 5 * 3_600_000)?.map((a) => a.articleId)).toEqual([inside]);
  });

  it("skips_name_only_mention: the per-article reader needs the ticker", () => {
    db.prepare(`INSERT INTO securities (symbol, name, security_type) VALUES ('ACME', 'Acmeworks Corporation', 'Stock')`).run();
    const eventId = seedEvent();
    seedArticle({ text: "Acmeworks preview: the desk wants a beat." });
    expect(listUnreadPreviews(db, eventId, NOW_AFTER_FLOOR)).toEqual([]);
  });

  it("newest_first_cap_10", () => {
    const eventId = seedEvent();
    const ids: number[] = [];
    for (let i = 0; i < UNREAD_PREVIEWS_MAX + 3; i++) {
      ids.push(seedArticle({ text: `ACME issue ${i}.`, receivedAt: hoursBeforeFloor(100 - i) }));
    }
    expect(UNREAD_PREVIEWS_MAX).toBe(10);
    const list = listUnreadPreviews(db, eventId, NOW_AFTER_FLOOR)!;
    expect(list.map((a) => a.articleId)).toEqual(ids.slice().reverse().slice(0, 10));
  });

  // Sandbox click-through 2026-11-18: daily wraps that mention the name in
  // passing filled the cap and pushed the real preview off the list.
  it("subject_naming_the_company_ranks_first_before_the_cap", () => {
    const eventId = seedEvent();
    const preview = seedArticle({ text: "ACME FQ3 model.", subject: "Preview|ACME FQ3", receivedAt: hoursBeforeFloor(150) });
    for (let i = 0; i < UNREAD_PREVIEWS_MAX + 2; i++) {
      seedArticle({ text: `Market wrap ${i}; ACME moved.`, subject: `Daily wrap ${i}`, receivedAt: hoursBeforeFloor(100 - i) });
    }
    const list = listUnreadPreviews(db, eventId, NOW_AFTER_FLOOR)!;
    expect(list).toHaveLength(UNREAD_PREVIEWS_MAX);
    expect(list[0].articleId).toBe(preview);
    expect(list.slice(1).every((a) => a.subject.startsWith("Daily wrap"))).toBe(true);
  });

  it("null for an unknown event; empty for a superseded one", () => {
    expect(listUnreadPreviews(db, 424242, NOW_AFTER_FLOOR)).toBeNull();
    const eventId = seedEvent({ superseded: 1 });
    seedArticle({ text: "ACME preview." });
    expect(listUnreadPreviews(db, eventId, NOW_AFTER_FLOOR)).toEqual([]);
  });
});

describe("readArticleForEvent", () => {
  function extractReturning(result: Awaited<ReturnType<NonNullable<ExtractFn>>>) {
    return vi.fn(async () => result) as unknown as NonNullable<ExtractFn> & ReturnType<typeof vi.fn>;
  }

  it("books_hit_and_drops_from_list", async () => {
    const eventId = seedEvent();
    const id = seedArticle({ text: "ACME preview." });
    const extract = extractReturning({ bogeysStored: 1, modelId: "test-model", called: true });
    const r = await readArticleForEvent(db, eventId, id, { extract, nowMs: NOW_AFTER_FLOOR });
    expect(r).toMatchObject({ bogeysStored: 1, status: "hit" });
    expect(extract).toHaveBeenCalledTimes(1);
    const [, article, event] = extract.mock.calls[0] as unknown as [unknown, ArticleInput, unknown];
    expect(article.id).toBe(id);
    expect(event).toEqual({ event_id: eventId, symbol: "ACME", event_date: "2026-11-20" });
    expect(ledger(eventId, id)).toEqual([
      { extractor_version: NEWSLETTER_EXTRACTOR_VERSION, status: "hit", attempts: 1, claim_token: null, model_id: "test-model" },
    ]);
    expect(listUnreadPreviews(db, eventId, NOW_AFTER_FLOOR)).toEqual([]);
  });

  it("books_no_numbers", async () => {
    const eventId = seedEvent();
    const id = seedArticle({ text: "ACME preview." });
    const r = await readArticleForEvent(db, eventId, id, {
      extract: extractReturning({ bogeysStored: 0, modelId: "test-model", called: true }),
      nowMs: NOW_AFTER_FLOOR,
    });
    expect(r).toMatchObject({ bogeysStored: 0, status: "no_numbers" });
    expect(ledger(eventId, id)[0]).toMatchObject({ status: "no_numbers", attempts: 1 });
  });

  it("reads an image-bearing article at the image version", async () => {
    const eventId = seedEvent();
    const id = seedArticle({
      text: "ACME preview.",
      html: '<p>ACME</p><figure><img src="https://substackcdn.com/image/fetch/w_1100/chart.png"></figure>',
    });
    await readArticleForEvent(db, eventId, id, {
      extract: extractReturning({ bogeysStored: 0, modelId: "m", called: true }),
      nowMs: NOW_AFTER_FLOOR,
    });
    expect(ledger(eventId, id).map((r) => r.extractor_version)).toEqual([NEWSLETTER_IMAGE_EXTRACTOR_VERSION]);
  });

  it("retries a read_failed article, counting the attempt", async () => {
    const eventId = seedEvent();
    const id = seedArticle({ text: "ACME preview." });
    bookScan(eventId, id, "error");
    await readArticleForEvent(db, eventId, id, {
      extract: extractReturning({ bogeysStored: 2, modelId: "m", called: true }),
      nowMs: NOW_AFTER_FLOOR,
    });
    expect(ledger(eventId, id)[0]).toMatchObject({ status: "hit", attempts: 2 });
  });

  it("images_incomplete_books_error_and_stays_listed (text figures kept)", async () => {
    const eventId = seedEvent();
    const id = seedArticle({ text: "ACME preview." });
    const r = await readArticleForEvent(db, eventId, id, {
      extract: extractReturning({ bogeysStored: 1, modelId: "m", called: true, imagesIncomplete: true }),
      nowMs: NOW_AFTER_FLOOR,
    });
    expect(r).toMatchObject({ bogeysStored: 1, status: "images_incomplete" });
    expect(ledger(eventId, id)[0]).toMatchObject({ status: "error", attempts: 1, claim_token: null });
    expect(listUnreadPreviews(db, eventId, NOW_AFTER_FLOOR)?.map((a) => [a.articleId, a.state])).toEqual([
      [id, "read_failed"],
    ]);
  });

  it("model failure books error with an attempt and rethrows", async () => {
    const eventId = seedEvent();
    const id = seedArticle({ text: "ACME preview." });
    const extract = vi.fn(async () => {
      throw new Error("newsletter extraction failed", { cause: new Error("bad json") });
    });
    await expect(
      readArticleForEvent(db, eventId, id, { extract: extract as unknown as NonNullable<ExtractFn>, nowMs: NOW_AFTER_FLOOR }),
    ).rejects.toThrow("newsletter extraction failed");
    expect(ledger(eventId, id)[0]).toMatchObject({ status: "error", attempts: 1, claim_token: null });
  });

  it("outage_books_nothing: a fresh pair leaves no row", async () => {
    const eventId = seedEvent();
    const id = seedArticle({ text: "ACME preview." });
    const extract = vi.fn(async () => {
      throw billingError();
    });
    await expect(
      readArticleForEvent(db, eventId, id, { extract: extract as unknown as NonNullable<ExtractFn>, nowMs: NOW_AFTER_FLOOR }),
    ).rejects.toThrow();
    expect(ledger(eventId, id)).toEqual([]);
    expect(listUnreadPreviews(db, eventId, NOW_AFTER_FLOOR)?.map((a) => a.state)).toEqual(["not_read"]);
  });

  it("outage_books_nothing: a prior error row is put back as it was", async () => {
    const eventId = seedEvent();
    const id = seedArticle({ text: "ACME preview." });
    bookScan(eventId, id, "error");
    const before = ledger(eventId, id);
    await expect(
      readArticleForEvent(db, eventId, id, {
        extract: (async () => {
          throw billingError();
        }) as unknown as NonNullable<ExtractFn>,
        nowMs: NOW_AFTER_FLOOR,
      }),
    ).rejects.toThrow();
    expect(ledger(eventId, id)).toEqual(before);
  });

  it("called:false releases the claim and refuses with 409", async () => {
    const eventId = seedEvent();
    const id = seedArticle({ text: "ACME preview." });
    const err = await readArticleForEvent(db, eventId, id, {
      extract: extractReturning({ bogeysStored: 0, modelId: null, called: false }),
      nowMs: NOW_AFTER_FLOOR,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadArticleRefusedError);
    expect((err as ReadArticleRefusedError).code).toBe("ticker_not_found");
    expect(ledger(eventId, id)).toEqual([]);
  });

  it("double_click_second_gets_409_no_second_ai_call", async () => {
    const eventId = seedEvent();
    const id = seedArticle({ text: "ACME preview." });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const extract = vi.fn(async () => {
      await gate;
      return { bogeysStored: 1, modelId: "m", called: true };
    });
    const first = readArticleForEvent(db, eventId, id, { extract, nowMs: NOW_AFTER_FLOOR });
    const second = await readArticleForEvent(db, eventId, id, { extract, nowMs: NOW_AFTER_FLOOR }).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(ReadArticleRefusedError);
    expect((second as ReadArticleRefusedError).code).toBe("already_reading");
    release();
    await first;
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("post_floor_article_refused", async () => {
    const eventId = seedEvent();
    const id = seedArticle({ text: "ACME recap.", receivedAt: hoursBeforeFloor(-2) });
    const extract = extractReturning({ bogeysStored: 1, modelId: "m", called: true });
    const err = await readArticleForEvent(db, eventId, id, { extract, nowMs: NOW_AFTER_FLOOR }).catch((e: unknown) => e);
    expect((err as ReadArticleRefusedError).code).toBe("not_eligible");
    expect(extract).not.toHaveBeenCalled();
    expect(ledger(eventId, id)).toEqual([]);
  });

  it("superseded_event_refused", async () => {
    const eventId = seedEvent({ superseded: 1 });
    const id = seedArticle({ text: "ACME preview." });
    const extract = extractReturning({ bogeysStored: 1, modelId: "m", called: true });
    const err = await readArticleForEvent(db, eventId, id, { extract, nowMs: NOW_AFTER_FLOOR }).catch((e: unknown) => e);
    expect((err as ReadArticleRefusedError).code).toBe("not_eligible");
    expect(extract).not.toHaveBeenCalled();
  });

  it("an already-read article is refused", async () => {
    const eventId = seedEvent();
    const id = seedArticle({ text: "ACME preview." });
    bookScan(eventId, id, "no_numbers");
    const extract = extractReturning({ bogeysStored: 1, modelId: "m", called: true });
    const err = await readArticleForEvent(db, eventId, id, { extract, nowMs: NOW_AFTER_FLOOR }).catch((e: unknown) => e);
    expect((err as ReadArticleRefusedError).code).toBe("not_eligible");
    expect(extract).not.toHaveBeenCalled();
  });

  it("recompile_called_after_hit: a live print's sheet gains the line", async () => {
    const eventId = seedEvent();
    db.prepare(`INSERT INTO print_watch_prints (event_id, symbol, event_date, state) VALUES (?, 'ACME', '2026-11-20', 'scheduled')`).run(
      eventId,
    );
    const id = seedArticle({ text: "ACME preview." });
    const extract = vi.fn(async (d: Database.Database) => {
      d.prepare(
        `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus) VALUES (?, 'newsletter', 'Open Desk Letter 11/19', 1.07)`,
      ).run(eventId);
      return { bogeysStored: 1, modelId: "m", called: true };
    });
    const r = await readArticleForEvent(db, eventId, id, {
      extract: extract as unknown as NonNullable<ExtractFn>,
      nowMs: NOW_AFTER_FLOOR,
    });
    expect(r.recompiled).not.toBeNull();
    expect(r.recompiled!.added).toContain("eps_adj_q");
    const line = db
      .prepare(`SELECT expected_json FROM print_watch_lines WHERE metric_id = 'eps_adj_q'`)
      .get() as { expected_json: string } | undefined;
    expect(JSON.parse(line!.expected_json)).toMatchObject({ value: 1.07 });
  });

  it("no live print: recompiled is null", async () => {
    const eventId = seedEvent();
    const id = seedArticle({ text: "ACME preview." });
    const r = await readArticleForEvent(db, eventId, id, {
      extract: extractReturning({ bogeysStored: 1, modelId: "m", called: true }),
      nowMs: NOW_AFTER_FLOOR,
    });
    expect(r.recompiled).toBeNull();
  });
});

describe("ticker named only in the subject (2026-11-18)", () => {
  it("lists an article whose body never writes the ticker", () => {
    const eventId = seedEvent();
    const id = seedArticle({ text: "Our model forecasts revenue growth for the quarter.", subject: "Preview|ACME FQ3: demand holds" });
    const list = listUnreadPreviews(db, eventId, NOW_AFTER_FLOOR)!;
    expect(list.map((a) => a.articleId)).toContain(id);
  });
});
