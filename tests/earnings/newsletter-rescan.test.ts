/**
 * Live print v2 slice A, Task 11 — the `newsletter_rescan` prepare step and
 * the per-(article, event) extraction path it drives.
 *
 * Two things are under test:
 *   1. `extractBogeysFromArticleForEvent` — the PURE per-event path. Same
 *      prompt/parser/write as the global scan (one shared private helper),
 *      but scoped to ONE event and NEVER stamping
 *      `research_articles.bogeys_scanned_at` (the global marker belongs to
 *      the global sweep; an event armed after an article was scanned would
 *      otherwise never get its numbers).
 *   2. `makeNewsletterRescanStep` — the step + its `earnings_bogey_scans`
 *      claim ledger, which is what makes the pass resumable and caps a
 *      crash loop at SCAN_MAX_ATTEMPTS model calls per (event, article).
 *
 * Synthetic issuers / newsletter names / figures only [C-19].
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: (...a: unknown[]) => generateTextMock(...a),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "claude-test-model" })),
}));

import {
  extractBogeysFromArticleForEvent,
  newsletterIssueLabel,
  NEWSLETTER_EXTRACTOR_VERSION,
  type ArticleInput,
} from "@/lib/earnings/extract-newsletter-bogeys";
import {
  makeNewsletterRescanStep,
  RESCAN_WINDOW_DAYS,
  SCAN_MAX_ATTEMPTS,
} from "@/lib/earnings/prepare-steps/newsletter-rescan";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});
afterEach(() => generateTextMock.mockReset());

const ctx = { now: () => Date.parse("2026-09-02T18:00:00Z"), signal: new AbortController().signal };

const seedEvent = () =>
  Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-02','ACME','k','ACME')`,
      )
      .run().lastInsertRowid,
  );

// The scan query floors raw_text at 200 chars (parity with the global scan),
// so every fixture body carries filler. No ticker-shaped words in it.
const FILLER =
  " Desk prose that exists only to clear the two-hundred-character floor the scan query enforces on a newsletter body.".repeat(
    3,
  );

/** Relative, never hardcoded: the step's window is `datetime('now','-14 days')`,
 *  and a fixed timestamp rots the moment the wall clock passes it (this repo has
 *  been bitten — see tests/earnings/extract-newsletter-bogeys.test.ts). */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}

function seedArticle(
  text: string,
  receivedAt = daysAgo(8),
  scanned: string | null = daysAgo(7),
): number {
  // runMigrations seeds the real newsletter registry at low ids — take one of our own.
  db.prepare(`INSERT OR IGNORE INTO research_sources (id, name) VALUES (9001, 'Desk Notes')`).run();
  return Number(
    db
      .prepare(
        `INSERT INTO research_articles (source_id, subject, sender, received_at, raw_text, bogeys_scanned_at)
         VALUES (9001, 'Buyside Bogeys', 'desk@example.test', ?, ?, ?)`,
      )
      .run(receivedAt, text + FILLER, scanned).lastInsertRowid,
  );
}

const loadArticle = (id: number): ArticleInput =>
  db
    .prepare(
      `SELECT a.id, rs.name AS source_name, a.subject, a.received_at, a.raw_text
         FROM research_articles a JOIN research_sources rs ON rs.id = a.source_id
        WHERE a.id = ?`,
    )
    .get(id) as ArticleInput;

const RESPONSE = JSON.stringify([
  { symbol: "ACME", eps_consensus: 0.6, revenue_consensus: 1.51e9, guidance_notes: "product rev ~1.49B" },
]);

describe("newsletterIssueLabel ([C-3] issue-dated newsletter labels)", () => {
  it("dates the label from received_at in ET, unpadded, so two issues never collide on UNIQUE(event_id, source, source_label)", () => {
    expect(newsletterIssueLabel({ source_name: "Desk Notes", received_at: "2026-08-25 13:00:00" })).toBe(
      "Desk Notes 8/25",
    );
    // 02:00 UTC is the PREVIOUS ET day — the issue's own date, not the UTC one.
    expect(newsletterIssueLabel({ source_name: "Desk Notes", received_at: "2026-08-26 02:00:00" })).toBe(
      "Desk Notes 8/25",
    );
    expect(newsletterIssueLabel({ source_name: "Desk Notes", received_at: "2026-09-05 13:00:00" })).toBe(
      "Desk Notes 9/5",
    );
  });
  it("falls back to the bare publication name when received_at is unparseable", () => {
    expect(newsletterIssueLabel({ source_name: "Desk Notes", received_at: "not a date" })).toBe("Desk Notes");
  });
});

describe("extractBogeysFromArticleForEvent (spec §4.1 step 1)", () => {
  it("writes a bogey for THIS event only and never stamps bogeys_scanned_at", async () => {
    const ev = seedEvent();
    const art = seedArticle("ACME buyside bogey: product rev 1.49B, EPS 0.60", "2026-08-25 09:00:00", null);
    generateTextMock.mockResolvedValue({ text: RESPONSE });

    const out = await extractBogeysFromArticleForEvent(db, loadArticle(art), {
      event_id: ev,
      symbol: "ACME",
      event_date: "2026-09-02",
    });

    expect(out).toEqual({ bogeysStored: 1, modelId: "claude-test-model", called: true });
    expect(db.prepare(`SELECT bogeys_scanned_at FROM research_articles WHERE id = ?`).get(art)).toEqual({
      bogeys_scanned_at: null,
    });
    expect(
      db
        .prepare(`SELECT source, source_label, eps_consensus, guidance_notes FROM earnings_bogeys WHERE event_id = ?`)
        .get(ev),
    ).toEqual({
      source: "newsletter",
      source_label: "Desk Notes 8/25",
      eps_consensus: 0.6,
      guidance_notes: "product rev ~1.49B",
    });
  });

  it("an article that does not mention the symbol makes no model call", async () => {
    const ev = seedEvent();
    const art = seedArticle("NVDA and CRWD only");
    expect(
      await extractBogeysFromArticleForEvent(db, loadArticle(art), {
        event_id: ev,
        symbol: "ACME",
        event_date: "2026-09-02",
      }),
    ).toEqual({ bogeysStored: 0, modelId: null, called: false });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("a model failure throws so the step's ledger can record error + attempts", async () => {
    const ev = seedEvent();
    const art = seedArticle("ACME EPS 0.60");
    generateTextMock.mockRejectedValue(new Error("overloaded"));
    await expect(
      extractBogeysFromArticleForEvent(db, loadArticle(art), {
        event_id: ev,
        symbol: "ACME",
        event_date: "2026-09-02",
      }),
    ).rejects.toThrow(/newsletter extraction failed/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys`).get()).toEqual({ n: 0 });
  });

  it("a re-scan of the SAME issue that finds nothing never erases the numbers already stored (preserveExisting)", async () => {
    const ev = seedEvent();
    const art = seedArticle("ACME EPS 0.60", "2026-08-25 09:00:00", null);
    generateTextMock.mockResolvedValueOnce({ text: RESPONSE }).mockResolvedValueOnce({ text: "[]" });
    const event = { event_id: ev, symbol: "ACME", event_date: "2026-09-02" };
    await extractBogeysFromArticleForEvent(db, loadArticle(art), event);
    await extractBogeysFromArticleForEvent(db, loadArticle(art), event);
    expect(
      db.prepare(`SELECT eps_consensus, revenue_consensus_usd FROM earnings_bogeys WHERE event_id = ?`).all(ev),
    ).toEqual([{ eps_consensus: 0.6, revenue_consensus_usd: 1.51e9 }]);
  });

  it("[C-3] two issues of one newsletter for the same event are two bogey rows, never one overwritten", async () => {
    const ev = seedEvent();
    const a1 = seedArticle("ACME EPS 0.60", "2026-08-21 09:00:00", null);
    const a2 = seedArticle("ACME EPS 0.62 rev 1.52B", "2026-08-25 09:00:00", null);
    generateTextMock
      .mockResolvedValueOnce({ text: JSON.stringify([{ symbol: "ACME", eps_consensus: 0.6 }]) })
      .mockResolvedValueOnce({
        text: JSON.stringify([{ symbol: "ACME", eps_consensus: 0.62, revenue_consensus: 1.52e9 }]),
      });
    const event = { event_id: ev, symbol: "ACME", event_date: "2026-09-02" };
    await extractBogeysFromArticleForEvent(db, loadArticle(a1), event);
    await extractBogeysFromArticleForEvent(db, loadArticle(a2), event);
    expect(
      db
        .prepare(`SELECT source_label, eps_consensus FROM earnings_bogeys WHERE event_id = ? ORDER BY source_label`)
        .all(ev),
    ).toEqual([
      { source_label: "Desk Notes 8/21", eps_consensus: 0.6 },
      { source_label: "Desk Notes 8/25", eps_consensus: 0.62 },
    ]);
  });
});

describe("newsletter_rescan step + earnings_bogey_scans ledger", () => {
  const ledger = (ev: number) =>
    db
      .prepare(
        `SELECT article_id, status, attempts, model_id FROM earnings_bogey_scans WHERE event_id = ? AND extractor_version = ? ORDER BY article_id`,
      )
      .all(ev, NEWSLETTER_EXTRACTOR_VERSION);

  it("pins the window + attempt cap the spec names", () => {
    expect(RESCAN_WINDOW_DAYS).toBe(14);
    expect(SCAN_MAX_ATTEMPTS).toBe(3);
    expect(NEWSLETTER_EXTRACTOR_VERSION).toBe(1);
  });

  it("claims before the call, finalises hit / no_numbers, skips articles older than the window, and never re-calls a finalised article", async () => {
    const ev = seedEvent();
    const a1 = seedArticle("ACME: EPS 0.60 / rev 1.51B", daysAgo(3)); // hit
    const a2 = seedArticle("ACME mentioned, no numbers", daysAgo(5)); // no_numbers
    const old = seedArticle("ACME numbers from July", daysAgo(RESCAN_WINDOW_DAYS + 30)); // outside window

    const extract = vi.fn(async (_db: Database.Database, article: { id: number }) => ({
      bogeysStored: article.id === a1 ? 1 : 0,
      modelId: "m",
      called: true,
    }));
    const step = makeNewsletterRescanStep({ extract });

    expect(await step.run(db, ev, ctx)).toEqual({ status: "done", note: "2 scanned, 1 hit" });
    expect(ledger(ev)).toEqual([
      { article_id: a1, status: "hit", attempts: 1, model_id: "m" },
      { article_id: a2, status: "no_numbers", attempts: 1, model_id: "m" },
    ]);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(extract.mock.calls.map((c) => (c[1] as { id: number }).id)).not.toContain(old);

    await step.run(db, ev, ctx);
    expect(extract).toHaveBeenCalledTimes(2); // ledger is the guard
  });

  it("an article that mentions nothing releases its claim row instead of banking a scan", async () => {
    const ev = seedEvent();
    seedArticle("no tickers here at all", daysAgo(3));
    const extract = vi.fn(async () => ({ bogeysStored: 0, modelId: null, called: false }));
    expect(await makeNewsletterRescanStep({ extract }).run(db, ev, ctx)).toEqual({
      status: "done",
      note: "0 scanned, 0 hit",
    });
    expect(ledger(ev)).toEqual([]);
  });

  it("a throwing extract records error and retries up to SCAN_MAX_ATTEMPTS; a stale claim is taken over", async () => {
    const ev = seedEvent();
    const a1 = seedArticle("ACME EPS 0.60", daysAgo(3));
    const extract = vi.fn(async () => {
      throw new Error("overloaded");
    });
    const step = makeNewsletterRescanStep({ extract });
    for (let i = 1; i <= SCAN_MAX_ATTEMPTS; i++) {
      expect((await step.run(db, ev, ctx)).status).toBe("failed");
      expect(ledger(ev)).toEqual([{ article_id: a1, status: "error", attempts: i, model_id: null }]);
    }
    expect(await step.run(db, ev, ctx)).toEqual({ status: "done", note: "0 scanned, 0 hit (1 exhausted)" });

    // Stale claim: simulate a crash mid-call.
    db.prepare(
      `UPDATE earnings_bogey_scans SET status = 'claimed', attempts = 0, claim_token = 'dead', updated_at = datetime('now', '-10 minutes') WHERE article_id = ?`,
    ).run(a1);
    const ok = vi.fn(async () => ({ bogeysStored: 1, modelId: "m", called: true }));
    expect(await makeNewsletterRescanStep({ extract: ok }).run(db, ev, ctx)).toEqual({
      status: "done",
      note: "1 scanned, 1 hit",
    });
    // attempts = 1 (the dead claim, counted at takeover) + 1 (this hit) — so a crash loop is capped at SCAN_MAX_ATTEMPTS calls [C-11]
    expect(ledger(ev)).toEqual([{ article_id: a1, status: "hit", attempts: 2, model_id: "m" }]);
  });

  it("[R13] stops between articles when the runner aborts, and the next tick resumes on what is left", async () => {
    const ev = seedEvent();
    const a1 = seedArticle("ACME EPS 0.60", daysAgo(3));
    const a2 = seedArticle("ACME rev 1.51B", daysAgo(5));
    const controller = new AbortController();
    const extract = vi.fn(async () => {
      controller.abort();
      return { bogeysStored: 1, modelId: "m", called: true };
    });

    expect(await makeNewsletterRescanStep({ extract }).run(db, ev, { now: ctx.now, signal: controller.signal })).toEqual(
      { status: "pending", reason: "aborted; resume next tick" },
    );
    expect(extract).toHaveBeenCalledTimes(1);
    expect(ledger(ev)).toEqual([{ article_id: a1, status: "hit", attempts: 1, model_id: "m" }]);

    const resume = vi.fn(async (_db: Database.Database, _article: { id: number }) => ({
      bogeysStored: 0,
      modelId: "m",
      called: true,
    }));
    expect(await makeNewsletterRescanStep({ extract: resume }).run(db, ev, ctx)).toEqual({
      status: "done",
      note: "1 scanned, 0 hit",
    });
    expect(resume.mock.calls.map((c) => (c[1] as { id: number }).id)).toEqual([a2]);
  });

  it("an event with no symbol fails rather than scanning every article", async () => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, source_key) VALUES ('manual','earnings','2026-09-02','FOMC','k2')`,
        )
        .run().lastInsertRowid,
    );
    seedArticle("ACME EPS 0.60", daysAgo(3));
    const extract = vi.fn();
    const out = await makeNewsletterRescanStep({ extract }).run(db, id, ctx);
    expect(out.status).toBe("failed");
    expect(extract).not.toHaveBeenCalled();
  });

  it("fingerprint = hash(eventId, symbol, window, extractor version)", () => {
    const ev = seedEvent();
    const step = makeNewsletterRescanStep({ extract: vi.fn() });
    expect(step.fingerprint(db, ev)).toMatch(/^[0-9a-f]{64}$/);
    const before = step.fingerprint(db, ev);
    expect(step.fingerprint(db, ev)).toBe(before);
    // A date correction that re-symbols the event must drift the row back to runnable.
    db.prepare(`UPDATE calendar_events SET symbol = 'BETA' WHERE id = ?`).run(ev);
    expect(step.fingerprint(db, ev)).not.toBe(before);
  });
});
