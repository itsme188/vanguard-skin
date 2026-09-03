import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertBogey, deleteBogey } from "@/lib/mutations/earnings-bogeys";
import {
  getBogeysForEvent,
  getPrimaryBogeyForEvent,
} from "@/lib/queries/earnings-bogeys";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // Seed a calendar_events row to satisfy the FK.
  db.prepare(
    `INSERT INTO calendar_events
       (id, source, event_type, event_date, title, source_key, fetched_at, week_of)
     VALUES
       (1, 'manual', 'earnings', '2026-04-28', 'GLW Earnings', 'manual:GLW:2026-04-28:earnings', datetime('now'), '2026-04-27')`,
  ).run();
  // Two newsletter issues from one source — the FK targets for
  // research_article_id in the preserve-mode tests below.
  db.prepare(
    `INSERT OR IGNORE INTO research_sources (id, name) VALUES (1, 'TMT Breakout')`,
  ).run();
  const article = db.prepare(
    `INSERT INTO research_articles
       (id, source_id, received_at, subject, sender, raw_text)
     VALUES (?, 1, ?, ?, 'author@example.com', 'body')`,
  );
  article.run(1, '2026-04-26 08:00:00', 'Buyside Bogeys #1');
  article.run(2, '2026-04-27 08:00:00', 'Buyside Bogeys #2');
  return db;
}

describe("upsertBogey", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("creates a new manual bogey", () => {
    const r = upsertBogey(db, {
      event_id: 1,
      source: "manual",
      eps_consensus: 0.46,
      eps_whisper: 0.5,
      revenue_consensus_usd: 3_850_000_000,
    });
    expect(r.created).toBe(true);
    expect(r.id).toBeGreaterThan(0);

    const all = getBogeysForEvent(db, 1);
    expect(all).toHaveLength(1);
    expect(all[0].eps_consensus).toBe(0.46);
    expect(all[0].eps_whisper).toBe(0.5);
    expect(all[0].revenue_consensus_usd).toBe(3_850_000_000);
  });

  it("updates in place on (event_id, source, source_label) conflict", () => {
    const a = upsertBogey(db, {
      event_id: 1,
      source: "pdf_upload",
      source_label: "TMT Breakout 2026-04-28",
      eps_consensus: 0.46,
    });
    const b = upsertBogey(db, {
      event_id: 1,
      source: "pdf_upload",
      source_label: "TMT Breakout 2026-04-28",
      eps_consensus: 0.48, // updated
      eps_whisper: 0.5, // newly populated
    });

    expect(b.id).toBe(a.id);
    expect(b.created).toBe(false);

    const all = getBogeysForEvent(db, 1);
    expect(all).toHaveLength(1);
    expect(all[0].eps_consensus).toBe(0.48);
    expect(all[0].eps_whisper).toBe(0.5);
  });

  it("allows different sources to coexist on the same event", () => {
    upsertBogey(db, {
      event_id: 1,
      source: "pdf_upload",
      source_label: "TMT Breakout",
      eps_consensus: 0.46,
    });
    upsertBogey(db, {
      event_id: 1,
      source: "manual",
      source_label: "user note",
      eps_whisper: 0.5,
    });

    const all = getBogeysForEvent(db, 1);
    expect(all).toHaveLength(2);
  });

  it("returns most-recently-uploaded as primary", () => {
    const first = upsertBogey(db, {
      event_id: 1,
      source: "pdf_upload",
      source_label: "old",
      eps_consensus: 0.4,
    });
    // Sleep to advance datetime('now') tick.
    db.prepare("UPDATE earnings_bogeys SET uploaded_at = '2026-04-27 10:00:00' WHERE id = ?").run(first.id);

    upsertBogey(db, {
      event_id: 1,
      source: "manual",
      source_label: "fresh",
      eps_consensus: 0.5,
    });

    const primary = getPrimaryBogeyForEvent(db, 1);
    expect(primary?.source_label).toBe("fresh");
  });

  it("supports delete", () => {
    const r = upsertBogey(db, {
      event_id: 1,
      source: "manual",
      eps_consensus: 0.46,
    });
    expect(getBogeysForEvent(db, 1)).toHaveLength(1);
    const ok = deleteBogey(db, r.id);
    expect(ok).toBe(true);
    expect(getBogeysForEvent(db, 1)).toHaveLength(0);
  });

  it("stores a finnhub row with the vendor EPS apart from eps_consensus", () => {
    upsertBogey(db, { event_id: 1, source: "finnhub", source_label: "Sell-side consensus (Finnhub)", eps_consensus: null, eps_consensus_vendor: 0.50, revenue_consensus_usd: 1_234_000_000 });
    const row = db.prepare(`SELECT source, eps_consensus, eps_consensus_vendor, revenue_consensus_usd FROM earnings_bogeys WHERE event_id = ?`).get(1);
    expect(row).toEqual({ source: "finnhub", eps_consensus: null, eps_consensus_vendor: 0.50, revenue_consensus_usd: 1_234_000_000 });

    // Production read paths must carry the vendor EPS too — not just raw SQL.
    const all = getBogeysForEvent(db, 1);
    expect(all[0].eps_consensus_vendor).toBe(0.50);
    const primary = getPrimaryBogeyForEvent(db, 1);
    expect(primary?.eps_consensus_vendor).toBe(0.50);
  });
});

/**
 * Regression suite for the 2026-08-26 live loss (NVDA + CRWD bogeys erased):
 * a later issue of the same newsletter that mentioned the ticker WITHOUT
 * numbers overwrote the earlier issue's extracted consensus with nulls,
 * because the conflict clause copies `excluded.*` unconditionally.
 */
describe("upsertBogey preserveExisting (newsletter re-scan)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("preserve mode: a null-numbered re-scan keeps the existing numbers, updates notes + provenance", () => {
    const first = upsertBogey(db, {
      event_id: 1,
      source: "newsletter",
      source_label: "TMT Breakout",
      research_article_id: 1,
      eps_consensus: 1.02,
      revenue_consensus_usd: 46_000_000_000,
      notes: "buyside leaning above the guide",
      ai_extraction_model: "claude-old",
    });
    db.prepare(
      "UPDATE earnings_bogeys SET uploaded_at = '2026-01-01 00:00:00' WHERE id = ?",
    ).run(first.id);

    const second = upsertBogey(db, {
      event_id: 1,
      source: "newsletter",
      source_label: "TMT Breakout",
      research_article_id: 2,
      eps_consensus: null,
      eps_whisper: null,
      revenue_consensus_usd: null,
      revenue_whisper_usd: null,
      expected_move_pct: null,
      notes: "mentioned again, no numbers this issue",
      ai_extraction_model: "claude-new",
      preserveExisting: true,
    });

    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
    expect(second.skipped).toBeFalsy();

    const rows = getBogeysForEvent(db, 1);
    expect(rows).toHaveLength(1);
    // Content: nulls never overwrite, non-nulls do.
    expect(rows[0].eps_consensus).toBe(1.02);
    expect(rows[0].revenue_consensus_usd).toBe(46_000_000_000);
    expect(rows[0].notes).toBe("mentioned again, no numbers this issue");
    // Provenance: always takes the incoming values.
    expect(rows[0].research_article_id).toBe(2);
    expect(rows[0].ai_extraction_model).toBe("claude-new");
    expect(rows[0].uploaded_at).not.toBe("2026-01-01 00:00:00");
  });

  it("preserve mode: a re-scan with no content at all writes nothing (skipped), so provenance can't go stale-fresh", () => {
    const first = upsertBogey(db, {
      event_id: 1,
      source: "newsletter",
      source_label: "TMT Breakout",
      research_article_id: 1,
      eps_consensus: 1.02,
      revenue_consensus_usd: 46_000_000_000,
      notes: "buyside leaning above the guide",
      ai_extraction_model: "claude-old",
    });
    db.prepare(
      "UPDATE earnings_bogeys SET uploaded_at = '2026-01-01 00:00:00' WHERE id = ?",
    ).run(first.id);
    const before = db
      .prepare("SELECT * FROM earnings_bogeys WHERE id = ?")
      .get(first.id) as Record<string, unknown>;

    const second = upsertBogey(db, {
      event_id: 1,
      source: "newsletter",
      source_label: "TMT Breakout",
      research_article_id: 2,
      eps_consensus: null,
      eps_whisper: null,
      revenue_consensus_usd: null,
      revenue_whisper_usd: null,
      expected_move_pct: null,
      segment_breakdown_json: null,
      guidance_notes: null,
      notes: null,
      ai_extraction_model: "claude-new",
      preserveExisting: true,
    });

    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
    expect(second.skipped).toBe(true);

    const after = db
      .prepare("SELECT * FROM earnings_bogeys WHERE id = ?")
      .get(first.id) as Record<string, unknown>;
    expect(after).toEqual(before);
    expect(after.uploaded_at).toBe("2026-01-01 00:00:00");
    expect(after.research_article_id).toBe(1);
    expect(after.ai_extraction_model).toBe("claude-old");
    expect(db.prepare("SELECT COUNT(*) AS n FROM earnings_bogeys").get()).toEqual({ n: 1 });
  });

  it("overwrite mode (the default) still CLEARS fields with nulls — manual + PDF corrections depend on it", () => {
    const first = upsertBogey(db, {
      event_id: 1,
      source: "manual",
      source_label: "user note",
      eps_consensus: 0.46,
      eps_whisper: 0.5,
      revenue_consensus_usd: 3_850_000_000,
      guidance_notes: "FY26 guide $19.5-20.0B",
      notes: "typed in a hurry",
    });

    const second = upsertBogey(db, {
      event_id: 1,
      source: "manual",
      source_label: "user note",
      eps_consensus: 0.48,
    });

    expect(second.id).toBe(first.id);
    expect(second.skipped).toBeFalsy();

    const rows = getBogeysForEvent(db, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].eps_consensus).toBe(0.48);
    expect(rows[0].eps_whisper).toBeNull();
    expect(rows[0].revenue_consensus_usd).toBeNull();
    expect(rows[0].guidance_notes).toBeNull();
    expect(rows[0].notes).toBeNull();
  });

  it("preserve mode with no existing row inserts normally", () => {
    const r = upsertBogey(db, {
      event_id: 1,
      source: "newsletter",
      source_label: "TMT Breakout",
      research_article_id: 1,
      eps_consensus: 1.02,
      guidance_notes: "FQ3 revenue guide $108.5B+ vs street $105B",
      preserveExisting: true,
    });

    expect(r.created).toBe(true);
    expect(r.skipped).toBeFalsy();

    const rows = getBogeysForEvent(db, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].eps_consensus).toBe(1.02);
    expect(rows[0].guidance_notes).toBe("FQ3 revenue guide $108.5B+ vs street $105B");
  });

  it("[Codex finding] preserve mode: a blank-string notes on an all-null re-scan is treated as no content — skipped, notes + uploaded_at unchanged", () => {
    const first = upsertBogey(db, {
      event_id: 1,
      source: "newsletter",
      source_label: "TMT Breakout",
      research_article_id: 1,
      eps_consensus: 1.02,
      revenue_consensus_usd: 46_000_000_000,
      notes: "buyside leaning above the guide",
      ai_extraction_model: "claude-old",
    });
    db.prepare(
      "UPDATE earnings_bogeys SET uploaded_at = '2026-01-01 00:00:00' WHERE id = ?",
    ).run(first.id);
    const before = db
      .prepare("SELECT * FROM earnings_bogeys WHERE id = ?")
      .get(first.id) as Record<string, unknown>;

    const second = upsertBogey(db, {
      event_id: 1,
      source: "newsletter",
      source_label: "TMT Breakout",
      research_article_id: 2,
      eps_consensus: null,
      eps_whisper: null,
      revenue_consensus_usd: null,
      revenue_whisper_usd: null,
      expected_move_pct: null,
      segment_breakdown_json: null,
      guidance_notes: null,
      // Blank string, not null — must still count as "no content".
      notes: "",
      ai_extraction_model: "claude-new",
      preserveExisting: true,
    });

    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
    expect(second.skipped).toBe(true);

    const after = db
      .prepare("SELECT * FROM earnings_bogeys WHERE id = ?")
      .get(first.id) as Record<string, unknown>;
    expect(after).toEqual(before);
    expect(after.notes).toBe("buyside leaning above the guide");
    expect(after.uploaded_at).toBe("2026-01-01 00:00:00");
  });

  it("preserve mode with no existing row and no content at all still inserts (nothing to protect)", () => {
    const r = upsertBogey(db, {
      event_id: 1,
      source: "newsletter",
      source_label: "TMT Breakout",
      research_article_id: 1,
      preserveExisting: true,
    });

    expect(r.created).toBe(true);
    expect(r.skipped).toBeFalsy();
    expect(getBogeysForEvent(db, 1)).toHaveLength(1);
  });
});
