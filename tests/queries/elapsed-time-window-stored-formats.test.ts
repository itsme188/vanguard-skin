/**
 * Elapsed-time windows against the format each column is REALLY stored in.
 *
 * SQLite's `datetime('now', '-N days')` is the space form
 * (`2026-10-02 15:00:00`). A stored ISO string (`2026-10-02T09:00:00.000Z`)
 * compared with it as bare text sorts AFTER every space-form string of the
 * same day, because `T` (0x54) is greater than a space (0x20). A bare
 * `column >= datetime('now', …)` therefore let in every row stamped earlier
 * on the cutoff's own UTC day: up to 24 hours outside the documented window.
 * Wrapping the stored side in `datetime()` puts both sides in one form.
 *
 * Stored formats, by writer:
 *   - press_releases.published_at: ISO with T and Z
 *     (`new Date(item.datetime * 1000).toISOString()`, lib/apis/press-releases.ts).
 *   - level_alerts.triggered_at: ISO with T and Z
 *     (`new Date().toISOString()` in triggerLevel, lib/mutations/security-levels.ts;
 *     the Worker's fire instant in lib/alerts/reconcile-cloud-fired.ts).
 *   - research_articles.received_at: SQLite's space form
 *     (`toISOString().replace("T", " ").slice(0, 19)` in lib/gmail/fetch.ts and
 *     workers/cron/src/gmail.ts, the only two producers; the cloud reconciler
 *     stores the Worker's string unchanged). For this column the wrap changes
 *     nothing on real rows; the ISO cases below are a guard against a future
 *     writer, and the space-form cases pin that the real rows are untouched.
 *
 * Every timestamp is relative to the wall clock: SQLite's `'now'` cannot be
 * faked. Synthetic tickers and invented prices only.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: (...a: unknown[]) => generateTextMock(...a),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "claude-test-model" })),
}));

import { runMigrations } from "@/lib/db/migrate";
import { upsertPressRelease } from "@/lib/mutations/press-releases";
import { listPressReleases } from "@/lib/queries/press-releases";
import { upsertLevel, triggerLevel } from "@/lib/mutations/security-levels";
import { getLevelsTriggeredInWindow } from "@/lib/queries/briefing-levels";
import { getFullTextForSources, getRecentArticleSummaries } from "@/lib/queries/research";
import { extractLevelsFromNewArticles } from "@/lib/alerts/extract-newsletter-levels";
import { extractBogeysFromNewArticles } from "@/lib/earnings/extract-newsletter-bogeys";
import {
  makeNewsletterRescanStep,
  RESCAN_WINDOW_DAYS,
} from "@/lib/earnings/prepare-steps/newsletter-rescan";
import { todayET } from "@/lib/calendar/date-utils";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** `2026-10-02T09:00:00.000Z`: what `toISOString()` writes. */
const iso = (ms: number): string => new Date(ms).toISOString();
/** `2026-10-02 09:00:00`: what the Gmail fetchers write. */
const spaceForm = (ms: number): string => iso(ms).slice(0, 19).replace("T", " ");

/**
 * The three instants every case seeds, for a window of `amountMs`:
 *   inside:   one hour inside the window. Selected before and after.
 *   sameDay:  00:00:00 UTC on the cutoff's own day. OUTSIDE the window, but
 *             on the cutoff's calendar day: the row the bare text compare let in.
 *   old:      two days before the cutoff. Never selected.
 */
function instants(amountMs: number): { inside: number; sameDay: number; old: number } {
  const cutoff = Date.now() - amountMs;
  return {
    inside: cutoff + HOUR_MS,
    sameDay: Math.floor(cutoff / DAY_MS) * DAY_MS,
    old: cutoff - 2 * DAY_MS,
  };
}

let db: Database.Database;

beforeAll(async () => {
  // `sameDay` is midnight UTC of the cutoff's day. In the first seconds after
  // midnight UTC it would sit on the cutoff itself; step past them.
  const intoDay = Date.now() % DAY_MS;
  if (intoDay < 5_000) await new Promise((r) => setTimeout(r, 5_000 - intoDay));
}, 20_000);

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});
afterEach(() => generateTextMock.mockReset());

const FILLER =
  " Desk prose that exists only to clear the two-hundred-character floor the scan query enforces on a newsletter body.".repeat(
    3,
  );

function seedSource(id: number, name: string): number {
  db.prepare(`INSERT OR IGNORE INTO research_sources (id, name) VALUES (?, ?)`).run(id, name);
  return id;
}

function seedArticle(opts: {
  sourceId: number;
  subject: string;
  receivedAt: string;
  processed?: boolean;
}): number {
  return Number(
    db
      .prepare(
        `INSERT INTO research_articles (source_id, subject, sender, received_at, raw_text, summary, processed_at)
         VALUES (?, ?, 'desk@example.test', ?, ?, 'summary', ?)`,
      )
      .run(
        opts.sourceId,
        opts.subject,
        opts.receivedAt,
        opts.subject + FILLER,
        opts.processed === false ? null : spaceForm(Date.now()),
      ).lastInsertRowid,
  );
}

function seedEquity(symbol: string, price: number): number {
  const id = Number(
    db
      .prepare(
        "INSERT INTO securities (symbol, security_type, asset_class, multiplier) VALUES (?, 'Stock', 'equity', 1)",
      )
      .run(symbol).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'manual')",
  ).run(id, todayET(), price);
  return id;
}

describe("press_releases.published_at (stored ISO with T and Z)", () => {
  it("a release published before the cutoff, on the cutoff's own day, is outside the window", () => {
    const t = instants(7 * DAY_MS);
    const release = (finnhub_id: number, headline: string, ms: number) =>
      upsertPressRelease(db, {
        finnhub_id,
        symbol: "ZZA",
        headline,
        summary: null,
        source: "wire",
        category: "company",
        url: null,
        image_url: null,
        // The exact expression the Finnhub mapper stores.
        published_at: new Date(Math.floor(ms / 1000) * 1000).toISOString(),
        raw_json: null,
      });
    release(1, "inside", t.inside);
    release(2, "same-day-outside", t.sameDay);
    release(3, "old", t.old);

    const got = listPressReleases(db, { symbol: "ZZA", days_back: 7 }).map((r) => r.headline);
    // Before the fix: ["inside", "same-day-outside"].
    expect(got).toEqual(["inside"]);
    // No window asked for: everything, untouched.
    expect(listPressReleases(db, { symbol: "ZZA" })).toHaveLength(3);
  });
});

describe("level_alerts.triggered_at (stored ISO with T and Z)", () => {
  it("an alert fired before the cutoff, on the cutoff's own day, is outside the window", () => {
    const t = instants(7 * DAY_MS);
    const fire = (symbol: string, ms: number) => {
      const securityId = seedEquity(symbol, 50);
      const levelId = upsertLevel(db, {
        security_id: securityId,
        level_type: "support",
        price: 48,
        direction: "below",
      });
      const res = triggerLevel(db, {
        levelId,
        securityId,
        triggeredPrice: 47.5,
        thresholdPrice: 48,
        triggeredAt: iso(ms),
      });
      expect(res.deduped).toBe(false);
    };
    fire("ZZA", t.inside);
    fire("ZZB", t.sameDay);
    fire("ZZC", t.old);

    const got = getLevelsTriggeredInWindow(db, 7).map((r) => r.symbol);
    // Before the fix: ["ZZA", "ZZB"].
    expect(got).toEqual(["ZZA"]);
  });

  it("an alert fired with the default stamp (now) is selected", () => {
    const securityId = seedEquity("ZZD", 50);
    const levelId = upsertLevel(db, {
      security_id: securityId,
      level_type: "support",
      price: 48,
      direction: "below",
    });
    triggerLevel(db, { levelId, securityId, triggeredPrice: 47.5, thresholdPrice: 48 });
    expect(getLevelsTriggeredInWindow(db, 7).map((r) => r.symbol)).toEqual(["ZZD"]);
  });
});

describe("research_articles.received_at (stored in SQLite's space form)", () => {
  /** Rows in the real format, plus the same three instants as ISO strings. */
  function seedBothForms(sourceId: number, amountMs: number, processed = true) {
    const t = instants(amountMs);
    return {
      spaceInside: seedArticle({ sourceId, subject: "space inside", receivedAt: spaceForm(t.inside), processed }),
      spaceSameDay: seedArticle({ sourceId, subject: "space same-day", receivedAt: spaceForm(t.sameDay), processed }),
      spaceOld: seedArticle({ sourceId, subject: "space old", receivedAt: spaceForm(t.old), processed }),
      isoInside: seedArticle({ sourceId, subject: "iso inside", receivedAt: iso(t.inside), processed }),
      isoSameDay: seedArticle({ sourceId, subject: "iso same-day", receivedAt: iso(t.sameDay), processed }),
      isoOld: seedArticle({ sourceId, subject: "iso old", receivedAt: iso(t.old), processed }),
    };
  }

  it("getFullTextForSources (weekly briefing deep read): hours window", () => {
    const src = seedSource(9001, "Desk Notes");
    const ids = seedBothForms(src, 72 * HOUR_MS);
    const got = getFullTextForSources(db, [src], 72).map((r) => r.article_id).sort((a, b) => a - b);
    // Real (space-form) rows: only the inside one, before and after the fix.
    // ISO rows: before the fix the same-day row leaked in as well.
    expect(got).toEqual([ids.spaceInside, ids.isoInside].sort((a, b) => a - b));
  });

  it("getRecentArticleSummaries (digest source window): hours window", () => {
    const src = seedSource(9001, "Desk Notes");
    const ids = seedBothForms(src, 24 * HOUR_MS);
    const got = getRecentArticleSummaries(db, 24, 50).map((r) => r.id).sort((a, b) => a - b);
    expect(got).toEqual([ids.spaceInside, ids.isoInside].sort((a, b) => a - b));
  });

  it("newsletter level scan: days window", async () => {
    const src = seedSource(9001, "Desk Notes");
    const securityId = seedEquity("ZZA", 50);
    db.prepare("INSERT INTO watchlist (security_id) VALUES (?)").run(securityId);
    const ids = seedBothForms(src, 30 * DAY_MS, false);
    generateTextMock.mockResolvedValue({ text: "[]" });

    const out = await extractLevelsFromNewArticles(db, { sinceDays: 30, batchSize: 50 });
    expect(out.articlesScanned).toBe(2);
    const stamped = (
      db
        .prepare("SELECT id FROM research_articles WHERE levels_extracted_at IS NOT NULL ORDER BY id")
        .all() as Array<{ id: number }>
    ).map((r) => r.id);
    expect(stamped).toEqual([ids.spaceInside, ids.isoInside].sort((a, b) => a - b));
  });

  it("newsletter bogey scan: days window", async () => {
    const src = seedSource(9001, "Desk Notes");
    // An armed event inside the look-ahead makes one covered reporter.
    const soon = new Date(Date.parse(`${todayET()}T12:00:00Z`) + 3 * DAY_MS).toISOString().slice(0, 10);
    const eventId = Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
           VALUES ('manual', 'earnings', ?, 'ZZQX', 'k-zzqx', 'ZZQX')`,
        )
        .run(soon).lastInsertRowid,
    );
    db.prepare("INSERT INTO earnings_worksheet_flags (event_id) VALUES (?)").run(eventId);
    const ids = seedBothForms(src, 30 * DAY_MS, false);

    const out = await extractBogeysFromNewArticles(db, { sinceDays: 30, batchSize: 50 });
    // No article names the reporter: nothing reaches the model, but every
    // article the window selected is stamped as scanned.
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(out.articlesScanned).toBe(2);
    const stamped = (
      db
        .prepare("SELECT id FROM research_articles WHERE bogeys_scanned_at IS NOT NULL ORDER BY id")
        .all() as Array<{ id: number }>
    ).map((r) => r.id);
    expect(stamped).toEqual([ids.spaceInside, ids.isoInside].sort((a, b) => a - b));
  });

  it("newsletter rescan step: days window", async () => {
    const src = seedSource(9001, "Desk Notes");
    const eventId = Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
           VALUES ('manual', 'earnings', ?, 'ZZQX', 'k-zzqx', 'ZZQX')`,
        )
        .run(todayET()).lastInsertRowid,
    );
    const ids = seedBothForms(src, RESCAN_WINDOW_DAYS * DAY_MS);
    const offered: number[] = [];
    const extract = vi.fn(async (_db: Database.Database, article: { id: number }) => {
      offered.push(article.id);
      return { bogeysStored: 0, modelId: null, called: false };
    });
    const step = makeNewsletterRescanStep({ extract: extract as never });
    await step.run(db, eventId, { now: () => Date.now(), signal: new AbortController().signal } as never);
    expect(offered.sort((a, b) => a - b)).toEqual([ids.spaceInside, ids.isoInside].sort((a, b) => a - b));
  });
});
