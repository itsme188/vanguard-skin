/**
 * Wiring pin: generateDigestSinceAdaptive includes the Overnight block for
 * the MORNING edition only, positioned before the article body, and stays
 * whole when the block composer returns null (Yahoo outage / total failure).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const composeOvernight = vi.fn(
  async (..._args: unknown[]) => null as string | null,
);
vi.mock("@/lib/digest/overnight", () => ({
  composeOvernightBlock: (...a: unknown[]) => composeOvernight(...a),
}));

import { generateDigestSinceAdaptive } from "@/lib/digest/daily-digest";

function seedOneArticle(db: Database.Database) {
  const sourceId = db
    .prepare(
      `INSERT INTO research_sources (name, sender_email, is_active)
       VALUES ('Some Letter', 'x@example.com', 1) RETURNING id`,
    )
    .get()!["id" as never] as number;
  db.prepare(
    `INSERT INTO research_articles
       (source_id, subject, sender, received_at, raw_text, summary, sentiment, processed_at)
     VALUES (?, 'Note', 'x@example.com', datetime('now'), 'body', 'Summary text', 'neutral', datetime('now'))`,
  ).run(sourceId);
}

describe("overnight block wiring in generateDigestSinceAdaptive", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seedOneArticle(db);
    composeOvernight.mockClear();
    composeOvernight.mockResolvedValue(null);
  });

  it("morning edition includes the block above the article body", async () => {
    composeOvernight.mockResolvedValue("## Overnight\n\nKOSPI +1.0%");

    const digest = await generateDigestSinceAdaptive(db, "2026-01-01", {
      edition: "morning",
    });

    expect(digest).toContain("## Overnight");
    expect(digest!.indexOf("## Overnight")).toBeLessThan(digest!.indexOf("Some Letter"));
  });

  it("evening edition never calls the overnight composer", async () => {
    await generateDigestSinceAdaptive(db, "2026-01-01", { edition: "evening" });
    expect(composeOvernight).not.toHaveBeenCalled();
  });

  it("a null block leaves the morning digest intact with no Overnight section", async () => {
    const digest = await generateDigestSinceAdaptive(db, "2026-01-01", {
      edition: "morning",
    });

    expect(composeOvernight).toHaveBeenCalledTimes(1);
    expect(digest).not.toContain("## Overnight");
    // The article body still renders (unknown sources land in Research Desk).
    expect(digest).toContain("## Research Desk");
  });
});
