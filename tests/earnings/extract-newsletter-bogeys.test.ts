import { describe, it, expect, vi, afterEach } from "vitest";
import Database from "better-sqlite3";

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: (...a: unknown[]) => generateTextMock(...a),
  AIRefusalError: class AIRefusalError extends Error {
    constructor(feature: string, modelId: string) {
      super(`AI refused request for feature "${feature}" (model ${modelId})`);
      this.name = "AIRefusalError";
    }
  },
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "claude-test-model" })),
}));

import {
  extractBogeysFromNewArticles,
  buildExtractionPrompt,
  parseExtractionResponse,
  isSymbolMentioned,
} from "@/lib/earnings/extract-newsletter-bogeys";

// Reset in afterEach (not beforeEach) — see tests/securities/classify-option-sectors.test.ts
// for the vitest 4.0.18 tinyspy phantom-rejection rationale.
afterEach(() => generateTextMock.mockReset());

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE securities (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL,
      security_type TEXT,
      underlying_symbol TEXT,
      expiration_date TEXT
    );
    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      security_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      as_of_date TEXT NOT NULL
    );
    CREATE TABLE watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      security_id INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL DEFAULT 'finnhub',
      event_type TEXT NOT NULL,
      event_date TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      symbol TEXT,
      source_key TEXT UNIQUE,
      superseded INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE research_sources (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE research_articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      received_at TEXT NOT NULL,
      raw_text TEXT,
      bogeys_scanned_at TEXT
    );
    CREATE TABLE earnings_bogeys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('pdf_upload', 'manual', 'newsletter')),
      source_label TEXT,
      source_url TEXT,
      raw_pdf_r2_key TEXT,
      research_document_id INTEGER,
      research_article_id INTEGER REFERENCES research_articles(id),
      eps_consensus REAL,
      eps_whisper REAL,
      revenue_consensus_usd REAL,
      revenue_whisper_usd REAL,
      expected_move_pct REAL,
      segment_breakdown_json TEXT,
      guidance_notes TEXT,
      notes TEXT,
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
      ai_extraction_model TEXT,
      UNIQUE(event_id, source, source_label)
    );
    CREATE TABLE earnings_worksheet_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL UNIQUE REFERENCES calendar_events(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      printed_at TEXT
    );
  `);
  db.prepare(`INSERT INTO research_sources (id, name) VALUES (1, 'TMT Breakout')`).run();
  return db;
}

function addEvent(
  db: Database.Database,
  opts: { id: number; symbol: string; daysFromToday: number; superseded?: number }
) {
  const eventDate = new Date();
  eventDate.setDate(eventDate.getDate() + opts.daysFromToday);
  const dateStr = eventDate.toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO calendar_events (id, event_type, event_date, symbol, source_key, superseded)
     VALUES (?, 'earnings', ?, ?, ?, ?)`
  ).run(opts.id, dateStr, opts.symbol, `finnhub:${opts.symbol}:${dateStr}`, opts.superseded ?? 0);
  return dateStr;
}

function addSecurity(db: Database.Database, id: number, symbol: string) {
  db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (?, ?, 'stock')`).run(id, symbol);
}

function holdSecurity(db: Database.Database, securityId: number) {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (1, ?, 100, date('now'))`
  ).run(securityId);
}

function addArticle(
  db: Database.Database,
  opts: { sourceId?: number; subject: string; rawText: string; receivedAt?: string }
): number {
  const result = db
    .prepare(
      `INSERT INTO research_articles (source_id, subject, received_at, raw_text)
       VALUES (?, ?, ?, ?)`
    )
    .run(
      opts.sourceId ?? 1,
      opts.subject,
      opts.receivedAt ?? new Date().toISOString().slice(0, 19).replace("T", " "),
      opts.rawText
    );
  return result.lastInsertRowid as number;
}

// received_at inside the lib's rolling datetime('now','-30 days') scan window;
// hardcoded timestamps rot as the wall clock advances past them (broke 2026-08-19).
function daysAgoTimestamp(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

describe("buildExtractionPrompt", () => {
  it("lists the reporters and caps article text at 30_000 chars", () => {
    const longText = "x".repeat(40_000);
    const prompt = buildExtractionPrompt(
      {
        id: 1,
        source_name: "TMT Breakout",
        subject: "Weekly preview",
        received_at: "2026-07-20 08:00:00",
        raw_text: longText,
      },
      [{ symbol: "TSM", event_id: 5, event_date: "2026-07-24" }]
    );
    expect(prompt).toContain("TSM");
    expect(prompt).toContain("2026-07-24");
    expect(prompt.length).toBeLessThan(35_000);
    expect(prompt).toContain("[truncated]");
  });

  it("documents guidance_notes in the response schema", () => {
    const prompt = buildExtractionPrompt(
      {
        id: 1,
        source_name: "TMT Breakout",
        subject: "Buyside Bogeys",
        received_at: "2026-08-26 08:00:00",
        raw_text: "NVDA reports Wednesday.",
      },
      [{ symbol: "NVDA", event_id: 5, event_date: "2026-08-27" }]
    );
    expect(prompt).toContain("guidance_notes");
  });

  it("teaches the TMTB 'Buyside Bogeys' layout in a KNOWN FORMATS block", () => {
    const prompt = buildExtractionPrompt(
      {
        id: 1,
        source_name: "TMT Breakout",
        subject: "Buyside Bogeys",
        received_at: "2026-08-26 08:00:00",
        raw_text: "NVDA reports Wednesday.",
      },
      [{ symbol: "NVDA", event_id: 5, event_date: "2026-08-27" }]
    );
    expect(prompt).toContain("KNOWN FORMATS");
    // The leading figure is the buyside/whisper number...
    expect(prompt).toMatch(/leading figure/i);
    // ..."Street @" is the sell-side consensus...
    expect(prompt).toMatch(/Street @/);
    // ..."guide of" is company guidance, never a bogey number...
    expect(prompt).toMatch(/guide of/);
    // ...ARR/cRPO/margins are commentary, not revenue_*/eps_*...
    expect(prompt).toMatch(/ARR/);
    expect(prompt).toMatch(/cRPO/);
    // ...and the "4:15p / 5:00p" header is print time / call time.
    expect(prompt).toMatch(/print time/i);
    expect(prompt).toMatch(/call time/i);
  });
});

describe("parseExtractionResponse", () => {
  it("parses a clean JSON array", () => {
    const raw = JSON.stringify([
      {
        symbol: "TSM",
        eps_consensus: 3.8,
        eps_whisper: 4.0,
        revenue_consensus: 40_200_000_000,
        revenue_whisper: null,
        notes: "street leaning higher",
      },
    ]);
    const out = parseExtractionResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      symbol: "TSM",
      eps_consensus: 3.8,
      eps_whisper: 4.0,
      revenue_consensus: 40_200_000_000,
      revenue_whisper: null,
      expected_move_pct: null,
      guidance_notes: null,
      notes: "street leaning higher",
    });
  });

  it("parses an author-stated expected move, tolerating percent strings (feedback #5)", () => {
    const raw = JSON.stringify([
      { symbol: "TSM", expected_move_pct: "±6.5%" },
      { symbol: "AMD", expected_move_pct: 4 },
    ]);
    const out = parseExtractionResponse(raw);
    expect(out.map((b) => b.expected_move_pct)).toEqual([6.5, 4]);
  });

  it("parses through preamble prose (extractJsonArray)", () => {
    const raw = `Let me look at this newsletter for upcoming reporters.\n\n[{"symbol": "TSM", "eps_consensus": 3.8}]\n\nHope that helps!`;
    const out = parseExtractionResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe("TSM");
  });

  it("returns [] on non-JSON input", () => {
    expect(parseExtractionResponse("not json at all")).toEqual([]);
  });

  it("coerces abbreviated revenue strings via parseLargeUSD", () => {
    const raw = JSON.stringify([{ symbol: "TSM", revenue_consensus: "$40.2B" }]);
    const out = parseExtractionResponse(raw);
    expect(out[0].revenue_consensus).toBe(40_200_000_000);
  });

  it("parses a TMTB 'Buyside Bogeys' NVDA block: whisper, consensus and guidance_notes", () => {
    // Shaped like the model's output for:
    //   NVDA - 4:15p / 5:00p
    //   FQ2 Revenue: ~$95B vs. guide of $91B and Street @ $92.4B
    //   FQ3 Revenue Guide: $108.5B+ vs. Street @ $105B
    const raw = JSON.stringify([
      {
        symbol: "NVDA",
        eps_consensus: null,
        eps_whisper: null,
        revenue_consensus: 92_400_000_000,
        revenue_whisper: 95_000_000_000,
        expected_move_pct: null,
        guidance_notes: "FQ2 company guide $91B; buyside FQ3 revenue guide bogey $108.5B+ vs Street $105B",
        notes: "buyside positioned above the guide",
      },
    ]);
    const out = parseExtractionResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0].revenue_whisper).toBe(95_000_000_000);
    expect(out[0].revenue_consensus).toBe(92_400_000_000);
    expect(out[0].guidance_notes).toContain("108.5B");
    expect(out[0].notes).toBe("buyside positioned above the guide");
  });

  it("defaults guidance_notes to null when the model omits it", () => {
    const out = parseExtractionResponse(JSON.stringify([{ symbol: "NVDA", eps_consensus: 1.02 }]));
    expect(out[0].guidance_notes).toBeNull();
  });

  it("ignores a non-string guidance_notes", () => {
    const out = parseExtractionResponse(JSON.stringify([{ symbol: "NVDA", guidance_notes: 42 }]));
    expect(out[0].guidance_notes).toBeNull();
  });

  it("[Codex finding] a whitespace-only notes/guidance_notes normalizes to null, not a blank string", () => {
    const out = parseExtractionResponse(
      JSON.stringify([{ symbol: "NVDA", notes: "   ", guidance_notes: "\t\n" }]),
    );
    expect(out[0].notes).toBeNull();
    expect(out[0].guidance_notes).toBeNull();
  });

  it("trims a string with meaningful content and surrounding whitespace", () => {
    const out = parseExtractionResponse(
      JSON.stringify([{ symbol: "NVDA", notes: "  buyside above the guide  " }]),
    );
    expect(out[0].notes).toBe("buyside above the guide");
  });
});

describe("isSymbolMentioned (short-ticker collision guard)", () => {
  it("does not match a common-English-word ticker's bare occurrence in prose", () => {
    expect(isSymbolMentioned("This will help it a lot going forward.", "IT")).toBe(false);
    expect(isSymbolMentioned("All in all, it was a rally.", "ALL")).toBe(false);
    expect(isSymbolMentioned("The Fed is on hold for now.", "ON")).toBe(false);
    expect(isSymbolMentioned("Buy now, ask questions later.", "NOW")).toBe(false);
    expect(isSymbolMentioned("So, what happens next?", "SO")).toBe(false);
    expect(isSymbolMentioned("That's the key takeaway.", "KEY")).toBe(false);
  });

  it("matches a $cashtag for a short ticker", () => {
    expect(isSymbolMentioned("Watching $IT closely into the print.", "IT")).toBe(true);
  });

  it("matches a short ticker immediately followed by a finance-context cue", () => {
    expect(isSymbolMentioned("IT earnings are due Thursday.", "IT")).toBe(true);
    expect(isSymbolMentioned("IT reports next week.", "IT")).toBe(true);
    expect(isSymbolMentioned("IT prints Wednesday morning.", "IT")).toBe(true);
    expect(isSymbolMentioned("IT EPS should beat.", "IT")).toBe(true);
    expect(isSymbolMentioned("IT Q2 numbers land soon.", "IT")).toBe(true);
  });

  it("is case-insensitive on both the symbol and the surrounding text", () => {
    expect(isSymbolMentioned("it earnings are due thursday.", "IT")).toBe(true);
    expect(isSymbolMentioned("this will help it a lot.", "it")).toBe(false);
  });

  it("uses a plain word-boundary test for symbols of length >= 4 (no cue required)", () => {
    expect(isSymbolMentioned("Watching NFLX ahead of the print.", "NFLX")).toBe(true);
    expect(isSymbolMentioned("NFLXY is unrelated.", "NFLX")).toBe(false);
  });
});

describe("isSymbolMentioned (gates on the ambiguous-word stoplist, not symbol length)", () => {
  it("[regression #11 A2] the pre-fix length<=3 gate would have rejected plain TSM prose — RED then GREEN", () => {
    // Reconstruction of the PRE-FIX predicate (length-gated at <= 3 chars)
    // for documentation purposes only — this is NOT the code under test.
    // It shows the old guard silently blocked real 3-char tickers (TSM,
    // AMD, GS, IBM, CAT, ...) from ever matching in ordinary prose, because
    // they were never a $cashtag or immediately followed by a finance cue.
    const preFixLengthGated = (text: string, symbol: string): boolean => {
      const escaped = symbol.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const upperText = text.toUpperCase();
      if (symbol.length > 3) return new RegExp(`\\b${escaped}\\b`).test(upperText);
      const cashtagRe = new RegExp(`\\$${escaped}\\b`);
      const contextRe = new RegExp(
        `\\b${escaped}(?=\\s*(?:EARNINGS|REPORTS?|PRINTS?|EPS|Q[1-4])\\b)`
      );
      return cashtagRe.test(upperText) || contextRe.test(upperText);
    };

    const prose = "TSM beat on both lines";
    // RED: the pre-fix length-based guard misses plain prose entirely.
    expect(preFixLengthGated(prose, "TSM")).toBe(false);
    // GREEN: the stoplist-based guard catches it — TSM isn't an ambiguous
    // English word, so it gets the plain word-boundary test regardless of
    // its 3-char length.
    expect(isSymbolMentioned(prose, "TSM")).toBe(true);
  });

  it("matches a real 3-char ticker in plain prose with no cashtag or finance cue", () => {
    expect(isSymbolMentioned("TSM beat on both lines", "TSM")).toBe(true);
  });

  it("matches multiple real 3-char tickers listed in plain prose", () => {
    const text = "This week's prints: TSM, AMD, GS";
    expect(isSymbolMentioned(text, "TSM")).toBe(true);
    expect(isSymbolMentioned(text, "AMD")).toBe(true);
    expect(isSymbolMentioned(text, "GS")).toBe(true);
  });

  it("matches a possessive mention (apostrophe is a word boundary)", () => {
    expect(isSymbolMentioned("AMD's guidance disappointed", "AMD")).toBe(true);
  });

  it("still gates true stoplist collisions (IT/ALL) on prose-only mentions — unchanged", () => {
    expect(isSymbolMentioned("This will help it a lot going forward.", "IT")).toBe(false);
    expect(isSymbolMentioned("All in all, it was a rally.", "ALL")).toBe(false);
  });

  it("still matches stoplist symbols via cashtag or finance-cue — unchanged", () => {
    expect(isSymbolMentioned("Watching $IT closely into the print.", "IT")).toBe(true);
    expect(isSymbolMentioned("IT earnings are due Thursday.", "IT")).toBe(true);
  });
});

describe("extractBogeysFromNewArticles", () => {
  it("1. article mentioning no upcoming reporter is marked scanned with zero AI calls", async () => {
    const db = makeDb();
    addSecurity(db, 1, "TSM");
    holdSecurity(db, 1);
    addEvent(db, { id: 1, symbol: "TSM", daysFromToday: 5 });
    const articleId = addArticle(db, {
      subject: "Macro update",
      rawText: "The Fed held rates steady this week. " + "filler ".repeat(50),
    });

    const result = await extractBogeysFromNewArticles(db, { batchSize: 10 });

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(result.articlesScanned).toBe(1);
    expect(result.bogeysStored).toBe(0);
    const row = db
      .prepare("SELECT bogeys_scanned_at FROM research_articles WHERE id = ?")
      .get(articleId) as { bogeys_scanned_at: string | null };
    expect(row.bogeys_scanned_at).not.toBeNull();
  });

  it("2. a held reporter mention triggers an AI call and stores one bogey row", async () => {
    const db = makeDb();
    addSecurity(db, 1, "TSM");
    holdSecurity(db, 1);
    addEvent(db, { id: 1, symbol: "TSM", daysFromToday: 5 });
    addArticle(db, {
      subject: "Semis weekly",
      rawText: "TSM reports next week — street watching foundry ASP trends. " + "filler ".repeat(50),
    });

    generateTextMock.mockResolvedValue({
      text: JSON.stringify([
        {
          symbol: "TSM",
          eps_consensus: 3.8,
          eps_whisper: 4.0,
          revenue_consensus: 40_200_000_000,
          revenue_whisper: null,
          notes: "street leaning higher",
        },
      ]),
    });

    const result = await extractBogeysFromNewArticles(db);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(result.bogeysStored).toBe(1);
    expect(result.eventsMatched).toBe(1);

    const rows = db.prepare("SELECT * FROM earnings_bogeys").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe(1);
    expect(rows[0].source).toBe("newsletter");
    expect(rows[0].source_label).toBe("TMT Breakout");
    expect(rows[0].eps_consensus).toBe(3.8);
    expect(rows[0].eps_whisper).toBe(4.0);
    expect(rows[0].revenue_consensus_usd).toBe(40_200_000_000);
    expect(rows[0].revenue_whisper_usd).toBeNull();
  });

  it("3. family fan-out: extraction says GOOGL, calendar row is GOOG — matched", async () => {
    const db = makeDb();
    addSecurity(db, 1, "GOOG");
    holdSecurity(db, 1);
    addEvent(db, { id: 1, symbol: "GOOG", daysFromToday: 4 });
    addArticle(db, {
      subject: "Mega-cap preview",
      rawText: "GOOGL is a name to watch this earnings season. " + "filler ".repeat(50),
    });

    generateTextMock.mockResolvedValue({
      text: JSON.stringify([{ symbol: "GOOGL", eps_consensus: 2.1 }]),
    });

    const result = await extractBogeysFromNewArticles(db);

    expect(result.bogeysStored).toBe(1);
    const rows = db.prepare("SELECT * FROM earnings_bogeys").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe(1);
  });

  it("4. model preamble prose around the array still parses", async () => {
    const db = makeDb();
    addSecurity(db, 1, "TSM");
    holdSecurity(db, 1);
    addEvent(db, { id: 1, symbol: "TSM", daysFromToday: 5 });
    addArticle(db, {
      subject: "Semis weekly",
      rawText: "TSM reports next week. " + "filler ".repeat(50),
    });

    generateTextMock.mockResolvedValue({
      text: `Sure, let me scan this newsletter for the listed reporters.\n\n[{"symbol": "TSM", "eps_consensus": 3.8}]\n\nLet me know if you need anything else!`,
    });

    const result = await extractBogeysFromNewArticles(db);

    expect(result.bogeysStored).toBe(1);
    const rows = db.prepare("SELECT * FROM earnings_bogeys").all() as Array<Record<string, unknown>>;
    expect(rows[0].eps_consensus).toBe(3.8);
  });

  it("5. AI failure leaves the article unscanned for retry, with no partial rows", async () => {
    const db = makeDb();
    addSecurity(db, 1, "TSM");
    holdSecurity(db, 1);
    addEvent(db, { id: 1, symbol: "TSM", daysFromToday: 5 });
    const articleId = addArticle(db, {
      subject: "Semis weekly",
      rawText: "TSM reports next week. " + "filler ".repeat(50),
    });

    generateTextMock.mockRejectedValue(new Error("upstream 529"));

    const result = await extractBogeysFromNewArticles(db);

    expect(result.bogeysStored).toBe(0);
    const row = db
      .prepare("SELECT bogeys_scanned_at FROM research_articles WHERE id = ?")
      .get(articleId) as { bogeys_scanned_at: string | null };
    expect(row.bogeys_scanned_at).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM earnings_bogeys").get()).toEqual({ n: 0 });
  });

  it("6a. re-running over an already-scanned article makes no additional AI calls or rows", async () => {
    const db = makeDb();
    addSecurity(db, 1, "TSM");
    holdSecurity(db, 1);
    addEvent(db, { id: 1, symbol: "TSM", daysFromToday: 5 });
    addArticle(db, {
      subject: "Semis weekly",
      rawText: "TSM reports next week. " + "filler ".repeat(50),
    });

    generateTextMock.mockResolvedValue({
      text: JSON.stringify([{ symbol: "TSM", eps_consensus: 3.8 }]),
    });

    const first = await extractBogeysFromNewArticles(db);
    expect(first.articlesScanned).toBe(1);
    expect(first.bogeysStored).toBe(1);

    const second = await extractBogeysFromNewArticles(db);
    expect(second.articlesScanned).toBe(0);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM earnings_bogeys").get()).toEqual({ n: 1 });
  });

  it("6b. a re-mention from the same source on a NEW article upserts in place, not a duplicate row", async () => {
    const db = makeDb();
    addSecurity(db, 1, "TSM");
    holdSecurity(db, 1);
    addEvent(db, { id: 1, symbol: "TSM", daysFromToday: 5 });
    addArticle(db, {
      subject: "Semis weekly #1",
      rawText: "TSM reports next week. " + "filler ".repeat(50),
      receivedAt: daysAgoTimestamp(2),
    });
    addArticle(db, {
      subject: "Semis weekly #2",
      rawText: "TSM print coming up — updated numbers inside. " + "filler ".repeat(50),
      receivedAt: daysAgoTimestamp(1),
    });

    generateTextMock
      .mockResolvedValueOnce({ text: JSON.stringify([{ symbol: "TSM", eps_consensus: 3.8 }]) })
      .mockResolvedValueOnce({ text: JSON.stringify([{ symbol: "TSM", eps_consensus: 4.1 }]) });

    const result = await extractBogeysFromNewArticles(db, { batchSize: 10 });

    expect(result.articlesScanned).toBe(2);
    expect(generateTextMock).toHaveBeenCalledTimes(2);

    const rows = db.prepare("SELECT * FROM earnings_bogeys").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1); // upsert-in-place, not a duplicate
    expect(rows[0].eps_consensus).toBe(4.1); // latest write wins
  });

  it("6c. [regression 2026-08-26 NVDA/CRWD] a later numberless issue from the same source does NOT erase the earlier numbers", async () => {
    const db = makeDb();
    addSecurity(db, 1, "NVDA");
    holdSecurity(db, 1);
    addEvent(db, { id: 1, symbol: "NVDA", daysFromToday: 3 });
    addArticle(db, {
      subject: "Buyside Bogeys #1",
      rawText: "NVDA reports Wednesday, numbers inside. " + "filler ".repeat(50),
      receivedAt: daysAgoTimestamp(2),
    });

    generateTextMock.mockResolvedValueOnce({
      text: JSON.stringify([
        {
          symbol: "NVDA",
          eps_consensus: 1.02,
          revenue_consensus: 92_400_000_000,
          revenue_whisper: 95_000_000_000,
          guidance_notes: "FQ3 revenue guide $108.5B+ vs Street $105B",
          notes: "buyside above the guide",
        },
      ]),
    });
    await extractBogeysFromNewArticles(db, { batchSize: 10 });

    // A second issue mentions NVDA but carries no numbers for it.
    addArticle(db, {
      subject: "Buyside Bogeys #2",
      rawText: "NVDA still the whole market's tell this week. " + "filler ".repeat(50),
      receivedAt: daysAgoTimestamp(1),
    });
    generateTextMock.mockResolvedValueOnce({
      text: JSON.stringify([{ symbol: "NVDA", notes: "no fresh numbers, just positioning chatter" }]),
    });
    await extractBogeysFromNewArticles(db, { batchSize: 10 });

    const rows = db.prepare("SELECT * FROM earnings_bogeys").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].eps_consensus).toBe(1.02);
    expect(rows[0].revenue_consensus_usd).toBe(92_400_000_000);
    expect(rows[0].revenue_whisper_usd).toBe(95_000_000_000);
    expect(rows[0].guidance_notes).toBe("FQ3 revenue guide $108.5B+ vs Street $105B");
    expect(rows[0].notes).toBe("no fresh numbers, just positioning chatter");
  });

  it("6d. [regression 2026-08-26] an extraction with nothing at all for the symbol leaves the stored row untouched", async () => {
    const db = makeDb();
    addSecurity(db, 1, "NVDA");
    holdSecurity(db, 1);
    addEvent(db, { id: 1, symbol: "NVDA", daysFromToday: 3 });
    addArticle(db, {
      subject: "Buyside Bogeys #1",
      rawText: "NVDA reports Wednesday, numbers inside. " + "filler ".repeat(50),
      receivedAt: daysAgoTimestamp(2),
    });
    generateTextMock.mockResolvedValueOnce({
      text: JSON.stringify([{ symbol: "NVDA", eps_consensus: 1.02, notes: "buyside above the guide" }]),
    });
    await extractBogeysFromNewArticles(db, { batchSize: 10 });
    db.prepare("UPDATE earnings_bogeys SET uploaded_at = '2026-01-01 00:00:00'").run();
    const before = db.prepare("SELECT * FROM earnings_bogeys").all();

    addArticle(db, {
      subject: "Buyside Bogeys #2",
      rawText: "NVDA still the whole market's tell this week. " + "filler ".repeat(50),
      receivedAt: daysAgoTimestamp(1),
    });
    generateTextMock.mockResolvedValueOnce({ text: JSON.stringify([{ symbol: "NVDA" }]) });
    await extractBogeysFromNewArticles(db, { batchSize: 10 });

    expect(db.prepare("SELECT * FROM earnings_bogeys").all()).toEqual(before);
  });

  it("7. a non-held reporter mention never triggers an AI call for that symbol set", async () => {
    const db = makeDb();
    // TSM is held; ZZZ has an earnings event but is neither held nor watchlisted.
    addSecurity(db, 1, "TSM");
    holdSecurity(db, 1);
    addEvent(db, { id: 1, symbol: "TSM", daysFromToday: 5 });
    addEvent(db, { id: 2, symbol: "ZZZ", daysFromToday: 6 });

    addArticle(db, {
      subject: "Semis weekly",
      rawText: "TSM reports next week. " + "filler ".repeat(50),
      receivedAt: daysAgoTimestamp(2),
    });
    addArticle(db, {
      subject: "Small-cap corner",
      rawText: "ZZZ is an obscure name reporting soon. " + "filler ".repeat(50),
      receivedAt: daysAgoTimestamp(1),
    });

    generateTextMock.mockResolvedValue({
      text: JSON.stringify([{ symbol: "TSM", eps_consensus: 3.8 }]),
    });

    const result = await extractBogeysFromNewArticles(db, { batchSize: 10 });

    // Only the TSM article should have triggered a call.
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(result.articlesScanned).toBe(2);
    expect(result.bogeysStored).toBe(1);

    const rows = db.prepare("SELECT * FROM earnings_bogeys").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe(1);

    // The ZZZ-only article should still be marked scanned (nothing to retry).
    const zzzArticle = db
      .prepare("SELECT bogeys_scanned_at FROM research_articles WHERE subject = 'Small-cap corner'")
      .get() as { bogeys_scanned_at: string | null };
    expect(zzzArticle.bogeys_scanned_at).not.toBeNull();
  });

  it("returns zero counts and does not fetch articles when there are no upcoming held/watchlist reporters", async () => {
    const db = makeDb();
    addArticle(db, { subject: "Whatever", rawText: "no relevant content here. " + "filler ".repeat(50) });

    const result = await extractBogeysFromNewArticles(db);

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(result).toEqual({ articlesScanned: 0, bogeysStored: 0, eventsMatched: 0 });
  });

  it("excludes superseded calendar events from the reporter window", async () => {
    const db = makeDb();
    addSecurity(db, 1, "TSM");
    holdSecurity(db, 1);
    addEvent(db, { id: 1, symbol: "TSM", daysFromToday: 5, superseded: 1 });
    addArticle(db, {
      subject: "Semis weekly",
      rawText: "TSM reports next week. " + "filler ".repeat(50),
    });

    const result = await extractBogeysFromNewArticles(db);

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(result.articlesScanned).toBe(0);
  });

  it("excludes reporters outside the 14-day window", async () => {
    const db = makeDb();
    addSecurity(db, 1, "TSM");
    holdSecurity(db, 1);
    addEvent(db, { id: 1, symbol: "TSM", daysFromToday: 20 });
    addArticle(db, {
      subject: "Semis weekly",
      rawText: "TSM reports next week. " + "filler ".repeat(50),
    });

    const result = await extractBogeysFromNewArticles(db);

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(result.articlesScanned).toBe(0);
  });

  it("8. a common-English-word ticker (IT) mentioned only as prose never triggers an AI call", async () => {
    const db = makeDb();
    addSecurity(db, 1, "IT");
    holdSecurity(db, 1);
    addEvent(db, { id: 1, symbol: "IT", daysFromToday: 5 });
    const articleId = addArticle(db, {
      subject: "Macro roundup",
      rawText:
        "This will help it a lot going forward, and it is a broadly positive setup. " +
        "filler ".repeat(50),
    });

    const result = await extractBogeysFromNewArticles(db, { batchSize: 10 });

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(result.articlesScanned).toBe(1);
    expect(result.bogeysStored).toBe(0);
    const row = db
      .prepare("SELECT bogeys_scanned_at FROM research_articles WHERE id = ?")
      .get(articleId) as { bogeys_scanned_at: string | null };
    expect(row.bogeys_scanned_at).not.toBeNull();
  });

  it("9. a real mention of a common-English-word ticker (IT) with finance context DOES trigger an AI call", async () => {
    const db = makeDb();
    addSecurity(db, 1, "IT");
    holdSecurity(db, 1);
    addEvent(db, { id: 1, symbol: "IT", daysFromToday: 5 });
    addArticle(db, {
      subject: "Enterprise software preview",
      rawText: "IT earnings are due Thursday morning, street watching license growth. " + "filler ".repeat(50),
    });

    generateTextMock.mockResolvedValue({
      text: JSON.stringify([{ symbol: "IT", eps_consensus: 2.7 }]),
    });

    const result = await extractBogeysFromNewArticles(db);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(result.bogeysStored).toBe(1);
  });

  it("10. stores ai_extraction_model resolved from resolveFeatureModel(\"newsletterBogeyExtraction\")", async () => {
    const db = makeDb();
    addSecurity(db, 1, "TSM");
    holdSecurity(db, 1);
    addEvent(db, { id: 1, symbol: "TSM", daysFromToday: 5 });
    addArticle(db, {
      subject: "Semis weekly",
      rawText: "TSM reports next week. " + "filler ".repeat(50),
    });

    generateTextMock.mockResolvedValue({
      text: JSON.stringify([{ symbol: "TSM", eps_consensus: 3.8 }]),
    });

    await extractBogeysFromNewArticles(db);

    const rows = db.prepare("SELECT * FROM earnings_bogeys").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].ai_extraction_model).toBe("claude-test-model");
  });
});
