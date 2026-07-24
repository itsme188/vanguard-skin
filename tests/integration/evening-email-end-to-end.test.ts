/**
 * tests/integration/evening-email-end-to-end.test.ts
 *
 * End-to-end integration test for the evening email composer.
 *
 * Boots a real in-memory SQLite DB, seeds enough data to exercise:
 *   - anomaly detection (GOOG beta-adjusted deviation vs SPY)
 *   - synthesis path (≥5 articles → synthesize() called)
 *   - full send-evening pipeline
 *
 * Mocks only the I/O boundaries: sendEmail, syncPortfolio, gmail auth,
 * and synthesize (which would call Claude API in production).
 *
 * Privacy assertions verify no portfolio-revealing data leaks into the HTML:
 *   - No $ amounts (e.g. "$1,234")
 *   - No share counts (e.g. "100 shares")
 *   - No portfolio % language (e.g. "5% of portfolio")
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertBeta } from "@/lib/mutations/security-betas";

// ── I/O boundary mocks ─────────────────────────────────────────────────────
// These must be hoisted above any imports of the modules under test.

const mockSendEmail = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/email", () => ({
  sendEmail: mockSendEmail,
}));

const mockSyncPortfolio = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/tws/positions", () => ({
  syncPortfolio: mockSyncPortfolio,
}));

vi.mock("@/lib/gmail/auth", () => ({
  isGmailConfigured: () => false,
  getGmailClient: () => null,
}));

vi.mock("@/lib/gmail/fetch", () => ({
  fetchNewArticles: vi.fn().mockResolvedValue({ fetched: 0 }),
  backfillSourceUrls: vi.fn(),
}));

vi.mock("@/lib/gmail/process", () => ({
  processUnprocessedArticles: vi.fn().mockResolvedValue({ processed: 0, failed: 0 }),
  // Lightweight stand-in — research-desk.ts imports the real one for
  // rendering, and this suite doesn't feed poisoned key_themes fixtures.
  sanitizeThemeList: (v: unknown) =>
    Array.isArray(v) ? v.filter((t): t is string => typeof t === "string").slice(0, 5) : [],
}));

// The mock factory is hoisted so module-level variables cannot be referenced
// inside it. Use vi.hoisted() to define the mock function, then configure it
// in beforeEach (or here at module scope via a closure).
const mockSynthesize = vi.hoisted(() =>
  vi.fn().mockResolvedValue(
    "## NVDA\n" +
    "Nvidia had a strong day across multiple sources [Vital Knowledge](https://x/1).\n" +
    "\n" +
    "## TER\n" +
    "Teradyne up sharply [TMT Breakout](https://x/2).\n" +
    "\n" +
    "x".repeat(220) // padding past the SynthesisEmptyError minimum-length guard
  )
);

vi.mock("@/lib/digest/synthesize", () => ({
  synthesize: mockSynthesize,
  SynthesisEmptyError: class SynthesisEmptyError extends Error {
    constructor(reason: string) {
      super(reason);
      this.name = "SynthesisEmptyError";
    }
  },
}));

// ── Deferred imports (after mocks) ────────────────────────────────────────

import { sendEveningEmail } from "@/lib/digest/send-evening";
import { setLastDigestSentAt } from "@/lib/digest/daily-digest";

// ── Seed helpers ─────────────────────────────────────────────────────────

let db: Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  // Ensure a recipient is available
  process.env.BRIEFING_EMAIL_TO = "test@example.com";
});

function seedAccount(name: string): number {
  // Migrations pre-seed some account names — use INSERT OR IGNORE and read back.
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  const row = db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as {
    id: number;
  };
  return row.id;
}

function seedSecurity(symbol: string, name?: string): number {
  const res = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, name ?? `${symbol} Corp`);
  return res.lastInsertRowid as number;
}

function seedPrice(securityId: number, date: string, closePrice: number): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'vanguard')"
  ).run(securityId, date, closePrice);
}

function seedHolding(accountId: number, securityId: number, date = "2026-05-08"): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, 100, ?, ?)`
  ).run(accountId, securityId, date, `test:${accountId}:${securityId}:${date}`);
}

/**
 * Seed N processed articles into a named source.
 * processed_at is set so getRecentArticles(processedOnly:true) picks them up.
 */
function seedArticles(count: number, sourceName = "Vital Knowledge"): void {
  const src = db
    .prepare(
      "INSERT INTO research_sources (name, sender_email, is_active) VALUES (?, ?, 1)"
    )
    .run(sourceName, `${sourceName.toLowerCase().replace(/ /g, "")}@example.com`);

  const sourceId = src.lastInsertRowid as number;
  // received_at in the window (well after the fallback yesterday boundary)
  const receivedAt = new Date(Date.now() - 2 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);

  for (let i = 0; i < count; i++) {
    db.prepare(
      `INSERT INTO research_articles
         (source_id, subject, sender, received_at, raw_text, summary, sentiment,
          processed_at, source_url, mentioned_symbols)
       VALUES (?, ?, ?, ?, ?, ?, 'neutral', datetime('now'), ?, ?)`
    ).run(
      sourceId,
      `Article ${i + 1}`,
      `${sourceName.toLowerCase().replace(/ /g, "")}@example.com`,
      receivedAt,
      "Body text about NVDA and TER performance today.",
      `Summary for article ${i + 1}: market moved on tech headlines.`,
      `https://example.com/article-${i + 1}`,
      JSON.stringify(["NVDA", "TER"])
    );
  }
}

/**
 * Full anomaly seed:
 *   SPY +0.75%  (prior=530, today=533.975)
 *   GOOG -3.4%  beta=1.6  → threshold=2.4% → FLAGGED + direction flipped
 *
 * Account must be "Vanguard Taxable" (or any Vanguard non-Roth) for the
 * anomaly scanner to include it.
 */
function seedAnomalyData(): void {
  // SPY benchmark prices (stored in the 'prices' table via the SPY security)
  const spyId = seedSecurity("SPY", "SPDR S&P 500 ETF");
  seedPrice(spyId, "2026-05-07", 530);
  seedPrice(spyId, "2026-05-08", 530 * 1.0075); // +0.75%

  // Vanguard Taxable account with a GOOG holding
  const acctId = seedAccount("Vanguard Taxable");
  const googId = seedSecurity("GOOG", "Alphabet Inc.");
  seedHolding(acctId, googId);
  seedPrice(googId, "2026-05-07", 170);
  seedPrice(googId, "2026-05-08", 170 * (1 - 0.034)); // -3.4%
  upsertBeta(db, { securityId: googId, lookbackDays: 60, beta: 1.6 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Evening email end-to-end", () => {
  it("composes alerts + anomaly + synthesis sections — all present in HTML", async () => {
    // Set last-sent to yesterday so the since-window covers our articles
    setLastDigestSentAt(db, "2026-05-07T22:00:00.000Z");

    // Anomaly: GOOG -3.4% vs SPY +0.75%, beta 1.6
    seedAnomalyData();

    // 8 articles — well above the SYNTHESIS_MIN_ARTICLES=5 threshold
    seedArticles(8);

    const result = await sendEveningEmail(db);

    // Must have sent (not skipped)
    expect(result.success).toBe(true);
    expect("skipped" in result && result.skipped).toBe(false);

    // sendEmail must have been called exactly once
    expect(mockSendEmail).toHaveBeenCalledOnce();
    const call = mockSendEmail.mock.calls[0][0] as {
      to: string;
      subject: string;
      html: string;
      fromLocalPart: string;
    };

    const html = call.html;

    // 1a. Anomaly section heading should appear
    expect(html).toContain("Significant Moves in Vanguard Holdings");

    // 1b. GOOG symbol present (in the anomaly block)
    expect(html).toContain("GOOG");

    // 1c. Synthesis text from our mock should appear
    expect(html).toContain("Nvidia had a strong day");

    // 1d. Sources section (per-source tail after synthesis)
    expect(html).toContain("Sources");
  });

  it("subject contains 'Evening Recap'", async () => {
    setLastDigestSentAt(db, "2026-05-07T22:00:00.000Z");
    seedArticles(2);

    await sendEveningEmail(db);

    expect(mockSendEmail).toHaveBeenCalledOnce();
    const { subject } = mockSendEmail.mock.calls[0][0] as { subject: string };
    expect(subject).toMatch(/Evening Recap/i);
  });

  it("uses fromLocalPart='evening' in the sendEmail call", async () => {
    setLastDigestSentAt(db, "2026-05-07T22:00:00.000Z");
    seedArticles(2);

    await sendEveningEmail(db);

    expect(mockSendEmail).toHaveBeenCalledOnce();
    const { fromLocalPart } = mockSendEmail.mock.calls[0][0] as {
      fromLocalPart: string;
    };
    expect(fromLocalPart).toBe("evening");
  });

  it("privacy compliance — no dollar amounts in digest body", async () => {
    setLastDigestSentAt(db, "2026-05-07T22:00:00.000Z");
    seedAnomalyData();
    seedArticles(8);

    await sendEveningEmail(db);

    const html = (mockSendEmail.mock.calls[0][0] as { html: string }).html;

    // Extract the digest body — everything between the opening <body> and </body>
    // tags, to avoid false positives from email-template chrome (href URLs, etc.)
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const body = bodyMatch ? bodyMatch[1] : html;

    // No dollar sign followed by a digit — no revealed dollar amounts
    expect(/\$\d/.test(body)).toBe(false);
  });

  it("privacy compliance — no share counts in digest body", async () => {
    setLastDigestSentAt(db, "2026-05-07T22:00:00.000Z");
    seedAnomalyData();
    seedArticles(8);

    await sendEveningEmail(db);

    const html = (mockSendEmail.mock.calls[0][0] as { html: string }).html;
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const body = bodyMatch ? bodyMatch[1] : html;

    // "N shares" pattern must not appear
    expect(/\d+ shares/i.test(body)).toBe(false);
  });

  it("privacy compliance — no portfolio percentage language in digest body", async () => {
    setLastDigestSentAt(db, "2026-05-07T22:00:00.000Z");
    seedAnomalyData();
    seedArticles(8);

    await sendEveningEmail(db);

    const html = (mockSendEmail.mock.calls[0][0] as { html: string }).html;
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const body = bodyMatch ? bodyMatch[1] : html;

    // "N% of portfolio/account" must not appear
    expect(/% of (?:portfolio|account)/i.test(body)).toBe(false);
  });
});
