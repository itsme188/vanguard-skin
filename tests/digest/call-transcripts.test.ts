/**
 * Morning-digest "Call transcripts" block (#12 B3).
 * Spec: .superpowers/sdd/task-5-brief.md
 *
 * Surfaces earnings-call transcripts fetched in the last 24h (via
 * fetchSameDayTranscripts, #12 B1/B2) for held or watchlist tickers, so the
 * user sees today's desk-note summary without opening chat. Deterministic,
 * `null` self-quiet, never blocks the digest (Overnight/reporters-block
 * precedent).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { composeCallTranscriptsBlock } from "@/lib/digest/call-transcripts";

let db: Database.Database;

// 2026-07-17T02:00:00Z = 2026-07-16 22:00 ET (EDT).
const NOW = new Date("2026-07-17T02:00:00Z");

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedHeld(symbol: string): number {
  const sec = Number(
    db
      .prepare(`INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')`)
      .run(symbol, symbol).lastInsertRowid,
  );
  const acct = Number(
    db.prepare(`INSERT INTO accounts (name) VALUES (?)`).run(`a-${symbol}`).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, 100, '2026-07-15', ?)`,
  ).run(acct, sec, `t:${symbol}`);
  return sec;
}

function seedWatchlist(symbol: string): number {
  const sec = Number(
    db
      .prepare(`INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')`)
      .run(symbol, symbol).lastInsertRowid,
  );
  db.prepare(`INSERT INTO watchlist (security_id, is_active) VALUES (?, 1)`).run(sec);
  return sec;
}

function insertTranscript(opts: {
  ticker: string;
  year?: number;
  quarter?: number;
  summary?: string | null;
  guidance?: string | null;
  fetchedAt?: string; // SQLite datetime() literal, space-separated
}): void {
  db.prepare(
    `INSERT INTO earnings_transcripts
       (ticker, year, quarter, source, summary, guidance, source_key, fetched_at)
     VALUES (?, ?, ?, 'alpha_vantage', ?, ?, ?, ?)`,
  ).run(
    opts.ticker,
    opts.year ?? 2026,
    opts.quarter ?? 2,
    opts.summary ?? "Extractive summary body.",
    opts.guidance ?? null,
    `alpha_vantage:${opts.ticker}:${opts.year ?? 2026}:${opts.quarter ?? 2}`,
    opts.fetchedAt ?? NOW.toISOString().replace("T", " ").slice(0, 19),
  );
}

/** hoursAgo relative to NOW, formatted as a SQLite datetime() literal. */
function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

describe("composeCallTranscriptsBlock", () => {
  it("renders a block for a held ticker's transcript cached in the last 24h", () => {
    seedHeld("AAA");
    insertTranscript({
      ticker: "AAA",
      year: 2026,
      quarter: 2,
      summary: "Management struck a confident tone on margin trajectory.",
      guidance: "Raised full-year revenue guidance by 3%.",
      fetchedAt: hoursAgo(3),
    });

    const block = composeCallTranscriptsBlock(db, { now: NOW });

    expect(block).not.toBeNull();
    expect(block).toContain("## Call transcripts");
    expect(block).toContain("### AAA — Q2 2026 call");
    expect(block).toContain("Management struck a confident tone on margin trajectory.");
    expect(block).toContain("Guidance: Raised full-year revenue guidance by 3%.");
  });

  it("returns null when nothing was fetched in the last 24h", () => {
    seedHeld("BBB");
    insertTranscript({ ticker: "BBB", fetchedAt: hoursAgo(30) });

    const block = composeCallTranscriptsBlock(db, { now: NOW });

    expect(block).toBeNull();
  });

  it("excludes a non-held, non-watchlist ticker's transcript", () => {
    // BBB is not held and not on the watchlist.
    insertTranscript({ ticker: "ZZZ", fetchedAt: hoursAgo(3) });

    const block = composeCallTranscriptsBlock(db, { now: NOW });

    expect(block).toBeNull();
  });

  it("includes a watchlist ticker alongside a held one, excludes an uncovered third", () => {
    seedHeld("CCC");
    seedWatchlist("DDD");
    insertTranscript({ ticker: "CCC", fetchedAt: hoursAgo(2) });
    insertTranscript({ ticker: "DDD", fetchedAt: hoursAgo(4) });
    insertTranscript({ ticker: "EEE", fetchedAt: hoursAgo(1) }); // uncovered

    const block = composeCallTranscriptsBlock(db, { now: NOW });

    expect(block).not.toBeNull();
    expect(block).toContain("### CCC — Q2 2026 call");
    expect(block).toContain("### DDD — Q2 2026 call");
    expect(block).not.toContain("EEE");
  });

  it("caps the rendered summary to roughly 4 lines, cutting at a word boundary", () => {
    seedHeld("FFF");
    const longSummary = Array.from({ length: 40 }, (_, i) => `sentence number ${i}`).join(". ");
    insertTranscript({ ticker: "FFF", summary: longSummary, fetchedAt: hoursAgo(1) });

    const block = composeCallTranscriptsBlock(db, { now: NOW });

    expect(block).not.toBeNull();
    // Rendered summary should be meaningfully shorter than the raw ~470-char
    // input and end with an ellipsis. The truncated text (ellipsis removed)
    // must be an exact prefix of the original AND the original's next
    // character at that cut point must be whitespace — i.e. the cut landed
    // on a word boundary, never mid-word.
    const truncated = block!.trim().split("\n\n").pop()!;
    expect(truncated.length).toBeLessThan(longSummary.length);
    expect(truncated.endsWith("…")).toBe(true);
    const withoutEllipsis = truncated.slice(0, -1);
    expect(longSummary.startsWith(withoutEllipsis)).toBe(true);
    expect(longSummary[withoutEllipsis.length]).toBe(" ");
  });

  it("a cut landing inside a **bold** span closes the span (no literal ** in the email)", () => {
    // The transcriptSummary prompt asks for **bold** section labels;
    // briefingToHtml's inline regex needs the closing ** on the same line.
    seedHeld("BBOLD");
    // 24 × 23 = 552 chars of prose puts the 600-char cap ~48 chars INTO the
    // bold span — the cut genuinely lands mid-span (pre-fix: dangling **).
    const boldTail = `**Guidance raised materially on data-center demand and gross margin trajectory through fiscal 2027 and beyond**`;
    const longSummary = `${"Solid quarter overall. ".repeat(24)}${boldTail}`;
    insertTranscript({ ticker: "BBOLD", summary: longSummary, fetchedAt: hoursAgo(1) });

    const block = composeCallTranscriptsBlock(db, { now: NOW })!;
    const truncated = block.trim().split("\n\n").pop()!;
    expect(truncated.endsWith("…")).toBe(true);
    // Every ** must be paired — an odd count renders a dangling literal **.
    const markers = (truncated.match(/\*\*/g) ?? []).length;
    expect(markers % 2).toBe(0);
  });

  it("omits the Guidance line when guidance is null", () => {
    seedHeld("GGG");
    insertTranscript({ ticker: "GGG", guidance: null, fetchedAt: hoursAgo(1) });

    const block = composeCallTranscriptsBlock(db, { now: NOW });

    expect(block).not.toBeNull();
    expect(block).not.toContain("Guidance:");
  });

  it("never throws — a DB error (dropped table) yields null", () => {
    seedHeld("HHH");
    insertTranscript({ ticker: "HHH", fetchedAt: hoursAgo(1) });
    db.exec("DROP TABLE earnings_transcripts");

    expect(() => composeCallTranscriptsBlock(db, { now: NOW })).not.toThrow();
    expect(composeCallTranscriptsBlock(db, { now: NOW })).toBeNull();
  });
});

// ─── Wiring: morning-only, positioned after Overnight ──────────────────────

const composeOvernight = vi.fn(async (..._args: unknown[]) => null as string | null);
vi.mock("@/lib/digest/overnight", () => ({
  composeOvernightBlock: (...a: unknown[]) => composeOvernight(...a),
}));

describe("call-transcripts block wiring in generateDigestSinceAdaptive", () => {
  let wiringDb: Database.Database;

  beforeEach(async () => {
    wiringDb = new Database(":memory:");
    wiringDb.pragma("foreign_keys = ON");
    runMigrations(wiringDb);
    composeOvernight.mockClear();
    composeOvernight.mockResolvedValue(null);

    const sourceId = wiringDb
      .prepare(
        `INSERT INTO research_sources (name, sender_email, is_active)
         VALUES ('Some Letter', 'x@example.com', 1) RETURNING id`,
      )
      .get()!["id" as never] as number;
    wiringDb
      .prepare(
        `INSERT INTO research_articles
           (source_id, subject, sender, received_at, raw_text, summary, sentiment, processed_at)
         VALUES (?, 'Note', 'x@example.com', datetime('now'), 'body', 'Summary text', 'neutral', datetime('now'))`,
      )
      .run(sourceId);

    seedHeldOn(wiringDb, "WWW");
    wiringDb
      .prepare(
        `INSERT INTO earnings_transcripts
           (ticker, year, quarter, source, summary, source_key, fetched_at)
         VALUES ('WWW', 2026, 2, 'alpha_vantage', 'Desk note body.', 'alpha_vantage:WWW:2026:2', datetime('now'))`,
      )
      .run();
  });

  function seedHeldOn(database: Database.Database, symbol: string) {
    const sec = Number(
      database
        .prepare(`INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')`)
        .run(symbol, symbol).lastInsertRowid,
    );
    const acct = Number(
      database.prepare(`INSERT INTO accounts (name) VALUES (?)`).run(`a-${symbol}`).lastInsertRowid,
    );
    database
      .prepare(
        `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
         VALUES (?, ?, 100, '2026-07-15', ?)`,
      )
      .run(acct, sec, `t:${symbol}`);
  }

  it("morning edition includes the block after Overnight, above the article body", async () => {
    const { generateDigestSinceAdaptive } = await import("@/lib/digest/daily-digest");
    composeOvernight.mockResolvedValue("## Overnight\n\nKOSPI +1.0%");

    const digest = await generateDigestSinceAdaptive(wiringDb, "2026-01-01", {
      edition: "morning",
    });

    expect(digest).toContain("## Call transcripts");
    expect(digest!.indexOf("## Overnight")).toBeLessThan(digest!.indexOf("## Call transcripts"));
    expect(digest!.indexOf("## Call transcripts")).toBeLessThan(digest!.indexOf("Some Letter"));
  });

  it("evening edition never renders the block", async () => {
    const { generateDigestSinceAdaptive } = await import("@/lib/digest/daily-digest");

    const digest = await generateDigestSinceAdaptive(wiringDb, "2026-01-01", {
      edition: "evening",
    });

    expect(digest).not.toContain("## Call transcripts");
  });
});
