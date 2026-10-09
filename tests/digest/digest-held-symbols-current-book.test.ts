/**
 * The daily digest tells the editorial pass which names are held. That list
 * must be the CURRENT book: a position that was sold (its newest row is the
 * closed-position reconciler's zero-quantity tombstone) is not held, while a
 * statement-only position whose newest row is old still is.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/digest/synthesize", () => ({
  synthesize: vi.fn(),
  SynthesisEmptyError: class SynthesisEmptyError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "SynthesisEmptyError";
    }
  },
}));

vi.mock("@/lib/digest/anomalies", () => ({
  computeAnomalies: vi.fn(() => []),
  formatVanguardAnomaliesBlock: vi.fn(() => ""),
}));

import { generateDigestSinceAdaptive } from "@/lib/digest/daily-digest";
import { synthesize } from "@/lib/digest/synthesize";

let db: Database.Database;
let acctId: number;

beforeEach(() => {
  vi.clearAllMocks();
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run("Vanguard Taxable");
  acctId = (db.prepare("SELECT id FROM accounts WHERE name = ?").get("Vanguard Taxable") as { id: number }).id;

  // Five processed articles: enough for the digest to reach the editorial pass.
  const src = db
    .prepare("INSERT INTO research_sources (name, sender_email, is_active) VALUES ('Vital Knowledge', 'vk@example.com', 1)")
    .run().lastInsertRowid as number;
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  for (let i = 0; i < 5; i++) {
    db.prepare(
      `INSERT INTO research_articles
         (source_id, subject, sender, received_at, raw_text, summary, sentiment, processed_at,
          source_url, mentioned_symbols)
       VALUES (?, ?, 'vk@example.com', ?, 'Body', ?, 'neutral', datetime('now'), ?, '["AAPL"]')`,
    ).run(src, `Article ${i + 1}`, now, `Summary for article ${i + 1}`, `https://example.com/article-${i + 1}`);
  }
  (synthesize as ReturnType<typeof vi.fn>).mockResolvedValue("## Overnight & Setup\n\nMacro.");
});

function seedSecurity(symbol: string, type = "stock"): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, ?, 'equity', 1)")
    .run(symbol, `${symbol} Corp`, type).lastInsertRowid as number;
}

function seedHolding(securityId: number, quantity: number, date: string, account = acctId): void {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, ?, ?)",
  ).run(account, securityId, quantity, date, `test:${account}:${securityId}:${date}`);
}

async function heldSymbolsSentToEditor(): Promise<string[]> {
  await generateDigestSinceAdaptive(db, "2020-01-01");
  const input = (synthesize as ReturnType<typeof vi.fn>).mock.calls[0][0] as { heldSymbols: string[] };
  return [...input.heldSymbols].sort();
}

describe("daily digest: held symbols are the current book", () => {
  it("a sold name (newest row is a zero-quantity tombstone) is not held", async () => {
    const sold = seedSecurity("ZZA");
    seedHolding(sold, 100, "2026-04-30");
    seedHolding(sold, 0, "2026-05-31");
    seedHolding(seedSecurity("ZZB"), 100, "2026-05-31");

    expect(await heldSymbolsSentToEditor()).toEqual(["ZZB"]);
  });

  it("a statement-only name with an older newest row is still held", async () => {
    seedHolding(seedSecurity("ZZA"), 100, "2026-03-31");
    seedHolding(seedSecurity("ZZB"), 100, "2026-05-31");

    expect(await heldSymbolsSentToEditor()).toEqual(["ZZA", "ZZB"]);
  });

  it("sold in one account, still held in another: held, listed once", async () => {
    db.prepare("INSERT INTO accounts (name) VALUES ('Second Account')").run();
    const other = (db.prepare("SELECT id FROM accounts WHERE name = 'Second Account'").get() as { id: number }).id;
    const sec = seedSecurity("ZZA");
    seedHolding(sec, 100, "2026-04-30");
    seedHolding(sec, 0, "2026-05-31");
    seedHolding(sec, 50, "2026-04-30", other);

    expect(await heldSymbolsSentToEditor()).toEqual(["ZZA"]);
  });

  it("a short position counts as exposure; an option row is still not a held symbol", async () => {
    seedHolding(seedSecurity("ZZS"), -100, "2026-05-31");
    seedHolding(seedSecurity("ZZO 260619C00100000", "option"), 1, "2026-05-31");

    expect(await heldSymbolsSentToEditor()).toEqual(["ZZS"]);
  });
});
