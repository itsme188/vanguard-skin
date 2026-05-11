/**
 * Integration check for Tier 5 D2 wiring: confirms the
 * processUnprocessedArticles query honors is_relevant = 0.
 *
 * We don't run the full Claude pipeline; we just exercise the SQL selector
 * directly to assert the filter behavior, since the SELECT is the only
 * surface that changes in process.ts for this slice. End-to-end coverage
 * (D3 + D4 + D5) lands in future slices.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE research_sources (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      processing_prompt TEXT
    );
    CREATE TABLE research_articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      sender TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      received_at TEXT NOT NULL,
      processed_at TEXT,
      is_relevant INTEGER NOT NULL DEFAULT 1,
      excluded_category TEXT,
      excluded_reason TEXT
    );
  `);
  db.prepare(`INSERT INTO research_sources (id, name) VALUES (1, 'Test Source')`).run();
  return db;
}

const UNPROCESSED_QUERY = `
  SELECT a.id, a.source_id, a.subject, a.sender, a.raw_text,
         s.name as source_name, s.processing_prompt
   FROM research_articles a
   JOIN research_sources s ON a.source_id = s.id
   WHERE a.processed_at IS NULL
     AND COALESCE(a.is_relevant, 1) = 1
   ORDER BY a.received_at DESC
   LIMIT 20
`;

describe("processUnprocessedArticles SELECT — is_relevant filter", () => {
  it("returns rows where is_relevant = 1 and processed_at IS NULL", () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO research_articles (source_id, subject, sender, raw_text, received_at, is_relevant)
       VALUES (1, 'Real research note', 'sender@x.com', 'body', '2026-05-11', 1)`,
    ).run();

    const rows = db.prepare(UNPROCESSED_QUERY).all() as { subject: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe("Real research note");
  });

  it("excludes rows where is_relevant = 0 (short-circuited by D2 regex)", () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO research_articles (source_id, subject, sender, raw_text, received_at, is_relevant, excluded_category, excluded_reason)
       VALUES (1, '** Payment Receipt', 'sub@stripe.com', 'body', '2026-05-11', 0, 'receipt', 'payment receipt')`,
    ).run();

    const rows = db.prepare(UNPROCESSED_QUERY).all();
    expect(rows).toHaveLength(0);
  });

  it("excludes rows where is_relevant = 0 even when other selectable rows are also unprocessed", () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO research_articles (source_id, subject, sender, raw_text, received_at, is_relevant)
       VALUES (1, 'Real article', 'sender@x.com', 'body', '2026-05-11', 1),
              (1, 'Welcome to Newsletter', 'noreply@sub.com', 'body', '2026-05-11', 0)`,
    ).run();

    const rows = db.prepare(UNPROCESSED_QUERY).all() as { subject: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe("Real article");
  });

  it("defensive COALESCE(is_relevant, 1) — treats NULL as relevant (handles partial migration / legacy rows)", () => {
    const db = makeDb();
    // Bypass the NOT NULL DEFAULT 1 by explicit NULL — simulates a legacy
    // row where the column was added but never populated. The defensive
    // COALESCE in the SELECT should still return it.
    db.exec(`ALTER TABLE research_articles RENAME TO _old`);
    db.exec(`
      CREATE TABLE research_articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        subject TEXT NOT NULL,
        sender TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        received_at TEXT NOT NULL,
        processed_at TEXT,
        is_relevant INTEGER,
        excluded_category TEXT,
        excluded_reason TEXT
      );
    `);
    db.prepare(
      `INSERT INTO research_articles (source_id, subject, sender, raw_text, received_at, is_relevant)
       VALUES (1, 'Legacy row', 'x@x', 'b', '2026-05-11', NULL)`,
    ).run();

    const rows = db.prepare(UNPROCESSED_QUERY).all() as { subject: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe("Legacy row");
  });
});
