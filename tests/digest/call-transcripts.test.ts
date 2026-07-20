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
  source?: string;
  callDate?: string | null;
  securityId?: number | null;
}): void {
  const source = opts.source ?? "alpha_vantage";
  db.prepare(
    `INSERT INTO earnings_transcripts
       (ticker, year, quarter, source, summary, guidance, call_date, security_id, source_key, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.ticker,
    opts.year ?? 2026,
    opts.quarter ?? 2,
    source,
    opts.summary ?? "Extractive summary body.",
    opts.guidance ?? null,
    opts.callDate ?? null,
    opts.securityId ?? null,
    `${source}:${opts.ticker}:${opts.year ?? 2026}:${opts.quarter ?? 2}`,
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
    // The raw `guidance` column (keyword-extracted from the transcript) is
    // never rendered — the desk note supersedes it, and for extractive-only
    // rows it's usually safe-harbor boilerplate.
    expect(block).not.toContain("Guidance: Raised full-year revenue guidance by 3%.");
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
    // on a word boundary, never mid-word. (The block's last paragraph is now
    // the app pointer line, so find the truncated paragraph by its ellipsis.)
    const truncated = block!.trim().split("\n\n").find((p) => p.endsWith("…"))!;
    expect(truncated).toBeDefined();
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
    const truncated = block.trim().split("\n\n").find((p) => p.endsWith("…"))!;
    expect(truncated).toBeDefined();
    // Every ** must be paired — an odd count renders a dangling literal **.
    const markers = (truncated.match(/\*\*/g) ?? []).length;
    expect(markers % 2).toBe(0);
  });

  it("never renders the raw guidance column, even when populated", () => {
    // extractGuidance keyword-matches transcript paragraphs — on real calls it
    // captures the safe-harbor boilerplate + opening Q&A (the 7/20 NFLX
    // digest rendered exactly that). The desk note's own Guidance section is
    // the only guidance surface.
    seedHeld("GGG");
    insertTranscript({
      ticker: "GGG",
      guidance: "I am the VP of finance. We will now take questions from analysts.",
      fetchedAt: hoursAgo(1),
    });

    const block = composeCallTranscriptsBlock(db, { now: NOW });

    expect(block).not.toBeNull();
    expect(block).not.toContain("Guidance:");
    expect(block).not.toContain("We will now take questions");
  });

  it("dedupes edgar + alpha_vantage rows for the same (ticker, quarter) to one best-source section", () => {
    // The upgrade path (thin-8-K fix) creates exactly this shape: the sweep
    // caches an edgar_8k excerpt, then the AV upgrade lands within the same
    // 24h digest window as a SECOND row for the same call.
    seedHeld("DUP");
    insertTranscript({
      ticker: "DUP",
      source: "edgar_8k",
      summary: "Thin 8-K cover page text.",
      fetchedAt: hoursAgo(5),
    });
    insertTranscript({
      ticker: "DUP",
      source: "alpha_vantage",
      summary: "Real desk note from the upgraded transcript.",
      fetchedAt: hoursAgo(1),
    });

    const block = composeCallTranscriptsBlock(db, { now: NOW })!;

    const sections = block.match(/### DUP — Q2 2026 call/g) ?? [];
    expect(sections).toHaveLength(1);
    expect(block).toContain("Real desk note from the upgraded transcript.");
    expect(block).not.toContain("Thin 8-K cover page text.");
  });

  it("demotes embedded desk-note headings: leading title dropped, section headings become bold", () => {
    seedHeld("NFLX");
    insertTranscript({
      ticker: "NFLX",
      summary:
        "# Netflix (NFLX) – Q2 2026 Desk Note\n\n## Guidance\n- Raised full-year revenue outlook\n\n## Tone\nConfident throughout the Q&A.",
      fetchedAt: hoursAgo(2),
    });

    const block = composeCallTranscriptsBlock(db, { now: NOW })!;

    // The AI's own H1 title duplicates the block's section header — dropped.
    expect(block).not.toContain("# Netflix (NFLX)");
    // H2s must not compete with the digest's own heading scale.
    expect(block).not.toContain("## Guidance");
    expect(block).not.toContain("## Tone");
    expect(block).toContain("**Guidance**");
    // A demoted desk note enters compact mode: Tone renders as a prose line.
    expect(block).toContain("Tone: Confident throughout the Q&A.");
    // Body content survives untouched.
    expect(block).toContain("- Raised full-year revenue outlook");
    // The block's own structure is intact.
    expect(block).toContain("## Call transcripts");
    expect(block).toContain("### NFLX — Q2 2026 call");
  });

  it("desk-note summaries render compact: Guidance + Tone only, with a deep link", () => {
    const sec = seedHeld("NOTE");
    insertTranscript({
      ticker: "NOTE",
      securityId: sec,
      callDate: "2026-07-16",
      summary: [
        "# NOTE Q2'26 Earnings — Desk Note",
        "",
        "**Guidance**",
        "- Reaffirmed, not raised. Q3 +12% reported.",
        "- FY26 13–14% reiterated.",
        "",
        "**Tone**",
        "Confident, controlled, on-message throughout the call.",
        "",
        "**Surprises**",
        "- Record buyback in the quarter.",
        "",
        "**Key Quotes**",
        '- "We manage to the full year."',
      ].join("\n"),
      fetchedAt: hoursAgo(1),
    });

    const block = composeCallTranscriptsBlock(db, {
      now: NOW,
      linkBase: "http://100.96.0.1:3099",
    })!;

    expect(block).toContain("### NOTE — Q2 2026 call (Thu 7/16)");
    expect(block).toContain("**Guidance**");
    expect(block).toContain("- Reaffirmed, not raised. Q3 +12% reported.");
    expect(block).toContain("Tone: Confident, controlled, on-message throughout the call.");
    // Compact means compact: the back half stays in-app.
    expect(block).not.toContain("Surprises");
    expect(block).not.toContain("Record buyback");
    expect(block).not.toContain("Key Quotes");
    expect(block).toContain(
      `Full transcript + desk note → [NOTE in Portfolio Desk](http://100.96.0.1:3099/dashboard/security/${sec})`,
    );
  });

  it("caps a runaway Guidance section at a word boundary with an ellipsis", () => {
    seedHeld("LONGG");
    const bullets = Array.from(
      { length: 30 },
      (_, i) => `- Guidance detail number ${i} with several trailing words attached`,
    ).join("\n");
    insertTranscript({
      ticker: "LONGG",
      summary: `**Guidance**\n${bullets}\n\n**Tone**\nCalm.`,
      fetchedAt: hoursAgo(1),
    });

    const block = composeCallTranscriptsBlock(db, { now: NOW })!;

    const guidancePara = block.trim().split("\n\n").find((p) => p.includes("**Guidance**"))!;
    expect(guidancePara.endsWith("…")).toBe(true);
    expect(guidancePara.length).toBeLessThan(1100);
  });

  it("coalesces the call date from a superseded edgar row when the AV upgrade lacks it", () => {
    // Alpha Vantage never supplies call_date; the same-day 8-K row always
    // does. The dedupe keeps AV's content but must not lose the 8-K's date —
    // exactly the NFLX 7/20 shape.
    seedHeld("COAL");
    insertTranscript({
      ticker: "COAL",
      source: "edgar_8k",
      callDate: "2026-07-16",
      summary: "Thin 8-K text.",
      fetchedAt: hoursAgo(6),
    });
    insertTranscript({
      ticker: "COAL",
      source: "alpha_vantage",
      callDate: null,
      summary: "Real desk note body.",
      fetchedAt: hoursAgo(1),
    });

    const block = composeCallTranscriptsBlock(db, { now: NOW })!;

    expect(block).toContain("### COAL — Q2 2026 call (Thu 7/16)");
    expect(block).toContain("Real desk note body.");
    expect(block).not.toContain("Thin 8-K text.");
  });

  it("coalesces the call date from an OLDER out-of-window row for the same call", () => {
    // The real Monday-upgrade shape: the 8-K row (with call_date) was fetched
    // Thursday night — far outside the digest's 24h window — and only the AV
    // upgrade row (call_date NULL) is in-window. The date must still surface.
    seedHeld("XWIN");
    insertTranscript({
      ticker: "XWIN",
      source: "edgar_8k",
      callDate: "2026-07-16",
      summary: "Thin 8-K text.",
      fetchedAt: hoursAgo(73),
    });
    insertTranscript({
      ticker: "XWIN",
      source: "alpha_vantage",
      callDate: null,
      summary: "Real desk note body.",
      fetchedAt: hoursAgo(1),
    });

    const block = composeCallTranscriptsBlock(db, { now: NOW })!;

    expect(block).toContain("### XWIN — Q2 2026 call (Thu 7/16)");
    expect(block).not.toContain("Thin 8-K text.");
  });

  it("renders a plain pointer without a markdown link when no linkBase is configured", () => {
    seedHeld("PLAIN");
    insertTranscript({ ticker: "PLAIN", fetchedAt: hoursAgo(1) });

    const block = composeCallTranscriptsBlock(db, { now: NOW, linkBase: null })!;

    expect(block).toContain("Full transcript in Portfolio Desk");
    expect(block).not.toContain("](");
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
