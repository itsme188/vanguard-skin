/**
 * Same-day transcript orchestrator (#12 B1).
 * Spec: .superpowers/sdd/task-3-brief.md
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  fetchSameDayTranscripts,
  isValidDeskNote,
  looksLikeDeskNoteRefusal,
  vendorRequestDue,
  MIN_TRANSCRIPT_CHARS_FOR_AI,
  VENDOR_RETRY_INTERVAL_MS,
} from "@/lib/transcripts/same-day";
import { fetchTranscript } from "@/lib/transcripts/fetch";
import { upsertTranscript } from "@/lib/mutations/transcripts";
import { generateTextForFeature } from "@/lib/ai/generate";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { todayET, nowET, addDays } from "@/lib/calendar/date-utils";
import type { EarningsTranscript } from "@/lib/types";

vi.mock("@/lib/transcripts/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transcripts/fetch")>()),
  fetchTranscript: vi.fn(),
}));

vi.mock("@/lib/ai/generate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/generate")>()),
  generateTextForFeature: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchTranscript);
const mockedGenerate = vi.mocked(generateTextForFeature);

let db: Database.Database;

// 2026-07-17T02:00:00Z = 2026-07-16 22:00 ET (EDT, UTC-4 in July).
const NOW = new Date("2026-07-17T02:00:00Z");

/** Convert a UTC instant into its ET wall-clock {date, time} strings, fixed
 * at the EDT (UTC-4) offset in effect for every date used in this suite. */
function etParts(utc: Date): { date: string; time: string } {
  const et = new Date(utc.getTime() - 4 * 60 * 60 * 1000);
  return { date: et.toISOString().slice(0, 10), time: et.toISOString().slice(11, 16) };
}

function hoursAgoEt(hours: number): { date: string; time: string } {
  return etParts(new Date(NOW.getTime() - hours * 60 * 60 * 1000));
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  mockedFetch.mockReset();
  mockedGenerate.mockReset();
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

let eventCounter = 0;

function seedEvent(opts: {
  symbol: string;
  date: string;
  releaseTime: string;
  actual?: string | null;
  transcriptAttemptedAt?: string | null;
  superseded?: number;
  source?: string;
  rawJson?: string | null;
}): number {
  eventCounter += 1;
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events
          (source, event_type, event_date, release_time, title, symbol,
           actual_value, transcript_attempted_at, source_key, week_of, superseded, raw_json)
         VALUES (?, 'earnings', ?, ?, ?, ?, ?, ?, ?, '2026-07-13', ?, ?)`,
      )
      .run(
        opts.source ?? "finnhub",
        opts.date,
        opts.releaseTime,
        `${opts.symbol} earnings`,
        opts.symbol,
        opts.actual === undefined ? "EPS 1.00" : opts.actual,
        opts.transcriptAttemptedAt ?? null,
        `finnhub:${opts.symbol}:${opts.date}:${eventCounter}`,
        opts.superseded ?? 0,
        opts.rawJson ?? null,
      ).lastInsertRowid,
  );
}

/** Seed a cached transcript row for 2026 Q2 (what July event dates derive to). */
function seedCachedTranscript(
  securityId: number | null,
  ticker: string,
  source: "edgar_8k" | "alpha_vantage" | "api_ninjas",
  transcript = "cached body",
  opts: { callDate?: string | null; year?: number; quarter?: number } = {},
): void {
  upsertTranscript(db, {
    security_id: securityId,
    ticker,
    year: opts.year ?? 2026,
    quarter: opts.quarter ?? 2,
    call_date: opts.callDate ?? null,
    source,
    transcript,
    summary: null,
    guidance: null,
    risk_factors: null,
    sentiment_score: null,
    sentiment_label: null,
    participants: null,
    source_key: `${source}:${ticker}:${opts.year ?? 2026}:${opts.quarter ?? 2}`,
  });
}

/** The Finnhub calendar entry that makes a July print's fiscal quarter known. */
const FINNHUB_Q2_2026 = JSON.stringify({ entry: { quarter: 2, year: 2026 } });

function getAttemptedAt(eventId: number): string | null {
  const row = db
    .prepare(`SELECT transcript_attempted_at FROM calendar_events WHERE id = ?`)
    .get(eventId) as { transcript_attempted_at: string | null };
  return row.transcript_attempted_at;
}

function fakeFetchResult() {
  return { transcript: {} as never, fromCache: false };
}

// A transcript long enough to clear MIN_TRANSCRIPT_CHARS_FOR_AI, so the AI
// desk-note tests actually reach the AI call rather than being skipped by
// the store-time length gate (lib/transcripts/same-day.ts).
const LONG_TRANSCRIPT = "Full call transcript text here. ".repeat(200);

function fakeTranscript(overrides: Partial<EarningsTranscript> = {}): EarningsTranscript {
  return {
    id: 1,
    security_id: null,
    ticker: "JJJ",
    year: 2026,
    quarter: 2,
    // Real vendor rows carry no call date: the vendor's response has none.
    call_date: null,
    source: "alpha_vantage",
    transcript: "Full call transcript text here.",
    summary: "extractive summary from fetchTranscript",
    guidance: "guidance paragraph, untouched by summarize",
    risk_factors: "risk paragraph, untouched by summarize",
    sentiment_score: 0.3,
    sentiment_label: "bullish",
    participants: null,
    accession_number: null,
    filing_url: null,
    source_key: "alpha_vantage:JJJ:2026:2",
    fetched_at: "2026-07-16 12:00:00",
    created_at: "2026-07-16 12:00:00",
    ...overrides,
  };
}

function getTranscriptRow(sourceKey: string) {
  return db
    .prepare(`SELECT * FROM earnings_transcripts WHERE source_key = ?`)
    .get(sourceKey) as
    | { summary: string | null; guidance: string | null; transcript: string | null }
    | undefined;
}

/**
 * Pre-seed a transcript row exactly as the real (mocked-out in these tests)
 * fetchTranscript would already have written it before summarizeTranscript
 * runs — needed to assert "the extractive summary survives" against a real
 * DB row, since summarizeTranscript is the only writer left once
 * fetchTranscript is mocked.
 */
function seedExtractiveRow(fetched: EarningsTranscript): void {
  upsertTranscript(db, {
    security_id: fetched.security_id,
    ticker: fetched.ticker,
    year: fetched.year,
    quarter: fetched.quarter,
    call_date: fetched.call_date,
    source: fetched.source,
    transcript: fetched.transcript,
    summary: fetched.summary,
    guidance: fetched.guidance,
    risk_factors: fetched.risk_factors,
    sentiment_score: fetched.sentiment_score,
    sentiment_label: fetched.sentiment_label,
    participants: fetched.participants,
    accession_number: fetched.accession_number,
    filing_url: fetched.filing_url,
    source_key: fetched.source_key,
  });
}

describe("fetchSameDayTranscripts", () => {
  it("fetches a held reporter released 3h ago with actuals and no cached transcript", async () => {
    seedHeld("AAA");
    const rel = hoursAgoEt(3);
    const eventId = seedEvent({ symbol: "AAA", date: rel.date, releaseTime: rel.time });
    mockedFetch.mockResolvedValue(fakeFetchResult());

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 1, fetched: 1 });
    expect(mockedFetch).toHaveBeenCalledWith(db, "AAA", expect.any(Number), expect.any(Number), {
      eventDate: rel.date,
      skipAlphaVantage: true,
    });
    expect(getAttemptedAt(eventId)).not.toBeNull();
  });

  it("uses the Finnhub fiscal quarter for same-day Alpha Vantage requests", async () => {
    seedHeld("FQ4");
    const rel = hoursAgoEt(3);
    seedEvent({
      symbol: "FQ4",
      date: rel.date,
      releaseTime: rel.time,
      rawJson: JSON.stringify({ entry: { quarter: 4, year: 2026 } }),
    });
    mockedFetch.mockResolvedValue(fakeFetchResult());

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 1, fetched: 1 });
    expect(mockedFetch).toHaveBeenCalledWith(db, "FQ4", 2026, 4, {
      eventDate: rel.date,
      expectedFiscalQuarter: { year: 2026, quarter: 4 },
    });
  });

  it("uses a superseded nearby Finnhub twin to resolve the live row's fiscal quarter", async () => {
    seedHeld("TWN");
    const rel = hoursAgoEt(3);
    seedEvent({
      symbol: "TWN",
      date: rel.date,
      releaseTime: rel.time,
      source: "manual",
    });
    seedEvent({
      symbol: "TWN",
      date: addDays(rel.date, -1),
      releaseTime: rel.time,
      superseded: 1,
      rawJson: JSON.stringify({ entry: { quarter: 4, year: 2026 } }),
    });
    mockedFetch.mockResolvedValue(fakeFetchResult());

    await fetchSameDayTranscripts(db, { now: NOW });

    expect(mockedFetch).toHaveBeenCalledWith(db, "TWN", 2026, 4, {
      eventDate: rel.date,
      expectedFiscalQuarter: { year: 2026, quarter: 4 },
    });
  });

  it("skips Alpha Vantage for prints with no Finnhub fiscal quarter and falls through via fetchTranscript", async () => {
    seedHeld("NOF");
    const rel = hoursAgoEt(3);
    seedEvent({ symbol: "NOF", date: rel.date, releaseTime: rel.time });
    mockedFetch.mockResolvedValue(fakeFetchResult());

    await fetchSameDayTranscripts(db, { now: NOW });

    expect(mockedFetch).toHaveBeenCalledWith(db, "NOF", 2026, 2, {
      eventDate: rel.date,
      skipAlphaVantage: true,
    });
  });

  // fetchSameDayTranscripts' getSymbolStatus call takes no `today` override
  // (real wall-clock, spec §4.1) — so unlike this file's other cases, the
  // symbol-level armed signal has to be seeded relative to REAL today, not
  // the fixture NOW. The release event itself can stay anchored to NOW
  // (only the armed FLAG's own event needs to sit inside the real horizon);
  // seeding both from real "now" keeps every date self-consistent regardless
  // of when the suite runs (same fix as 1736248).
  it("attempts an armed-only (unheld, unwatched) symbol with actuals inside the fresh window", async () => {
    const nowReal = new Date();
    const releaseAt = new Date(nowReal.getTime() - 3 * 60 * 60 * 1000);
    const eventId = seedEvent({
      symbol: "ARM1",
      date: todayET(releaseAt),
      releaseTime: nowET(releaseAt),
    });
    // A second, unrelated earnings event for the same symbol inside the real
    // 14-day armed horizon — getArmedSymbolsInHorizon is symbol-level, not
    // tied to the specific event under test.
    const today = todayET(nowReal);
    const armedFlagEventId = seedEvent({
      symbol: "ARM1",
      date: addDays(today, 1),
      releaseTime: "16:00",
    });
    armWorksheet(db, armedFlagEventId);
    mockedFetch.mockResolvedValue(fakeFetchResult());

    const result = await fetchSameDayTranscripts(db, { now: nowReal });

    expect(result.attempted).toBe(1);
    expect(getAttemptedAt(eventId)).not.toBeNull();
  });

  it("skips an event attempted 10 minutes ago (pacing >= 30 min)", async () => {
    seedHeld("BBB");
    const rel = hoursAgoEt(3);
    const attemptedAt = new Date(NOW.getTime() - 10 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    seedEvent({
      symbol: "BBB",
      date: rel.date,
      releaseTime: rel.time,
      transcriptAttemptedAt: attemptedAt,
    });

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 0, fetched: 0 });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("skips an event released 40h ago (past the 36h deadline)", async () => {
    seedHeld("CCC");
    const rel = hoursAgoEt(40);
    seedEvent({ symbol: "CCC", date: rel.date, releaseTime: rel.time });

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 0, fetched: 0 });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("skips an event with no actual value yet", async () => {
    seedHeld("DDD");
    const rel = hoursAgoEt(3);
    seedEvent({ symbol: "DDD", date: rel.date, releaseTime: rel.time, actual: null });

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 0, fetched: 0 });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("skips a print whose FISCAL key already has a cached call", async () => {
    const secId = seedHeld("EEE");
    const rel = hoursAgoEt(3);
    seedEvent({ symbol: "EEE", date: rel.date, releaseTime: rel.time, rawJson: FINNHUB_Q2_2026 });

    // A real (alpha_vantage) call under the print's fiscal key is terminal.
    seedCachedTranscript(secId, "EEE", "alpha_vantage");

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 0, fetched: 0 });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("checks the cache under the fiscal key, not the calendar key", async () => {
    // July print, Finnhub says fiscal Q4 2026. A call cached under the
    // calendar key (2026, 2) is an OLDER fiscal quarter's call and must not
    // satisfy the check (the original finding).
    const secId = seedHeld("FKY");
    const rel = hoursAgoEt(3);
    seedEvent({
      symbol: "FKY",
      date: rel.date,
      releaseTime: rel.time,
      rawJson: JSON.stringify({ entry: { quarter: 4, year: 2026 } }),
    });
    seedCachedTranscript(secId, "FKY", "alpha_vantage");
    mockedFetch.mockResolvedValue(null);

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result.attempted).toBe(1);
    expect(mockedFetch).toHaveBeenCalledWith(db, "FKY", 2026, 4, {
      eventDate: rel.date,
      expectedFiscalQuarter: { year: 2026, quarter: 4 },
    });
  });

  it("fiscal quarter unknown: a call cached under the calendar key does not stand in for the print", async () => {
    const secId = seedHeld("UNK");
    const rel = hoursAgoEt(3);
    seedEvent({ symbol: "UNK", date: rel.date, releaseTime: rel.time });
    seedCachedTranscript(secId, "UNK", "alpha_vantage");
    mockedFetch.mockResolvedValue(null);

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result.attempted).toBe(1);
    expect(mockedFetch).toHaveBeenCalledWith(db, "UNK", 2026, 2, {
      eventDate: rel.date,
      skipAlphaVantage: true,
    });
  });

  it("fiscal quarter unknown: the print is done once its filing is cached (found by filing date, under any key)", async () => {
    const secId = seedHeld("UNF");
    const rel = hoursAgoEt(3);
    seedEvent({ symbol: "UNF", date: rel.date, releaseTime: rel.time });
    // Keyed by the release's own stated fiscal quarter, not the calendar key.
    seedCachedTranscript(secId, "UNF", "edgar_8k", "cached body", {
      callDate: rel.date,
      year: 2026,
      quarter: 4,
    });

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 0, fetched: 0 });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("asks the vendor once per retry slot while nothing is cached: an attempt 31 minutes later is filing-only", async () => {
    seedHeld("SLT");
    const rel = hoursAgoEt(3);
    const attemptedAt = new Date(NOW.getTime() - 31 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    seedEvent({
      symbol: "SLT",
      date: rel.date,
      releaseTime: rel.time,
      rawJson: FINNHUB_Q2_2026,
      transcriptAttemptedAt: attemptedAt,
    });
    mockedFetch.mockResolvedValue(null);

    await fetchSameDayTranscripts(db, { now: NOW });

    expect(mockedFetch).toHaveBeenCalledWith(db, "SLT", 2026, 2, {
      eventDate: rel.date,
      expectedFiscalQuarter: { year: 2026, quarter: 2 },
      skipAlphaVantage: true,
    });
  });

  it("asks the vendor again on the first attempt after the next retry mark", async () => {
    seedHeld("SLU");
    // Released 12h10m ago; last attempt 31 minutes ago (age 11h39m then).
    const rel = hoursAgoEt(12 + 10 / 60);
    const attemptedAt = new Date(NOW.getTime() - 31 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    seedEvent({
      symbol: "SLU",
      date: rel.date,
      releaseTime: rel.time,
      rawJson: FINNHUB_Q2_2026,
      transcriptAttemptedAt: attemptedAt,
    });
    mockedFetch.mockResolvedValue(null);

    await fetchSameDayTranscripts(db, { now: NOW });

    expect(mockedFetch).toHaveBeenCalledWith(db, "SLU", 2026, 2, {
      eventDate: rel.date,
      expectedFiscalQuarter: { year: 2026, quarter: 2 },
    });
  });

  it("stamps the attempt with the sweep's own clock", async () => {
    seedHeld("STM");
    const rel = hoursAgoEt(3);
    const eventId = seedEvent({ symbol: "STM", date: rel.date, releaseTime: rel.time });
    mockedFetch.mockResolvedValue(null);

    await fetchSameDayTranscripts(db, { now: NOW });

    expect(getAttemptedAt(eventId)).toBe("2026-07-17 02:00:00");
  });

  it("caps at maxAttempts when more candidates are eligible", async () => {
    seedHeld("FFF");
    seedHeld("GGG");
    seedHeld("HHH");
    const rel3 = hoursAgoEt(3);
    const rel5 = hoursAgoEt(5);
    const rel7 = hoursAgoEt(7);
    seedEvent({ symbol: "FFF", date: rel3.date, releaseTime: rel3.time });
    seedEvent({ symbol: "GGG", date: rel5.date, releaseTime: rel5.time });
    seedEvent({ symbol: "HHH", date: rel7.date, releaseTime: rel7.time });
    mockedFetch.mockResolvedValue(fakeFetchResult());

    const result = await fetchSameDayTranscripts(db, { now: NOW, maxAttempts: 2 });

    expect(result.attempted).toBe(2);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("never throws when fetchTranscript rejects, and still stamps transcript_attempted_at", async () => {
    seedHeld("III");
    const rel = hoursAgoEt(3);
    const eventId = seedEvent({ symbol: "III", date: rel.date, releaseTime: rel.time });
    mockedFetch.mockRejectedValue(new Error("network down"));

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 1, fetched: 0 });
    expect(getAttemptedAt(eventId)).not.toBeNull();
  });

  // ─── B1 Minor hardening (reviewer-suggested) ───────────────────

  it("skips an event whose release instant is in the future (negative age)", async () => {
    seedHeld("MMM");
    const rel = hoursAgoEt(-3); // release is 3 hours from now
    seedEvent({ symbol: "MMM", date: rel.date, releaseTime: rel.time });

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 0, fetched: 0 });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("increments attempted but not fetched when fetchTranscript resolves null without throwing", async () => {
    seedHeld("NNN");
    const rel = hoursAgoEt(3);
    const eventId = seedEvent({ symbol: "NNN", date: rel.date, releaseTime: rel.time });
    mockedFetch.mockResolvedValue(null);

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 1, fetched: 0 });
    expect(getAttemptedAt(eventId)).not.toBeNull();
    expect(mockedGenerate).not.toHaveBeenCalled();
  });
});

describe("fetchSameDayTranscripts — cached-EDGAR upgrade candidates (thin-8-K fix)", () => {
  function hoursAgoUtcStamp(hours: number): string {
    return new Date(NOW.getTime() - hours * 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
  }

  it("attempts an upgrade fetch when the cached transcript is edgar_8k (never attempted)", async () => {
    const secId = seedHeld("UPA");
    const rel = hoursAgoEt(3);
    const eventId = seedEvent({ symbol: "UPA", date: rel.date, releaseTime: rel.time, rawJson: FINNHUB_Q2_2026 });
    seedCachedTranscript(secId, "UPA", "edgar_8k");
    mockedFetch.mockResolvedValue({
      transcript: fakeTranscript({ ticker: "UPA", source_key: "alpha_vantage:UPA:2026:2" }),
      fromCache: false,
    });
    mockedGenerate.mockResolvedValue({ text: "## Desk note\n- upgraded" } as never);

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 1, fetched: 1 });
    expect(mockedFetch).toHaveBeenCalledWith(db, "UPA", 2026, 2, {
      eventDate: rel.date,
      expectedFiscalQuarter: { year: 2026, quarter: 2 },
    });
    expect(getAttemptedAt(eventId)).not.toBeNull();
  });

  it("counts a failed upgrade (fromCache=true edgar echo) as attempted but not fetched, and never re-summarizes", async () => {
    const secId = seedHeld("UPB");
    const rel = hoursAgoEt(3);
    seedEvent({ symbol: "UPB", date: rel.date, releaseTime: rel.time, rawJson: FINNHUB_Q2_2026 });
    seedCachedTranscript(secId, "UPB", "edgar_8k");
    // fetchTranscript's internal AV upgrade found nothing → echoes the cached
    // edgar row back with fromCache: true.
    mockedFetch.mockResolvedValue({
      transcript: fakeTranscript({
        ticker: "UPB",
        source: "edgar_8k",
        source_key: "edgar_8k:UPB:2026:2",
      }),
      fromCache: true,
    });

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 1, fetched: 0 });
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("upgrade candidates stay eligible past the 36h fresh deadline (5 days out)", async () => {
    const secId = seedHeld("UPC");
    const rel = hoursAgoEt(5 * 24);
    seedEvent({ symbol: "UPC", date: rel.date, releaseTime: rel.time, rawJson: FINNHUB_Q2_2026 });
    seedCachedTranscript(secId, "UPC", "edgar_8k");
    mockedFetch.mockResolvedValue({
      transcript: fakeTranscript({ ticker: "UPC", source_key: "alpha_vantage:UPC:2026:2" }),
      fromCache: false,
    });
    mockedGenerate.mockResolvedValue({ text: "## Desk note\n- upgraded" } as never);

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 1, fetched: 1 });
  });

  it("upgrade candidates expire at the 10-day upgrade deadline", async () => {
    const secId = seedHeld("UPD");
    const rel = hoursAgoEt(11 * 24);
    seedEvent({ symbol: "UPD", date: rel.date, releaseTime: rel.time, rawJson: FINNHUB_Q2_2026 });
    seedCachedTranscript(secId, "UPD", "edgar_8k");

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 0, fetched: 0 });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("upgrade attempts pace at 24h, not the fresh 30-min pacing", async () => {
    const secId = seedHeld("UPE");
    const rel = hoursAgoEt(30);
    seedEvent({
      symbol: "UPE",
      date: rel.date,
      releaseTime: rel.time,
      rawJson: FINNHUB_Q2_2026,
      transcriptAttemptedAt: hoursAgoUtcStamp(2), // 2h ago: past 30-min, inside 24h
    });
    seedCachedTranscript(secId, "UPE", "edgar_8k");

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 0, fetched: 0 });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("upgrade attempts re-arm once the last attempt is >= 24h old", async () => {
    const secId = seedHeld("UPF");
    const rel = hoursAgoEt(30);
    seedEvent({
      symbol: "UPF",
      date: rel.date,
      releaseTime: rel.time,
      rawJson: FINNHUB_Q2_2026,
      transcriptAttemptedAt: hoursAgoUtcStamp(25),
    });
    seedCachedTranscript(secId, "UPF", "edgar_8k");
    mockedFetch.mockResolvedValue({
      transcript: fakeTranscript({ ticker: "UPF", source_key: "alpha_vantage:UPF:2026:2" }),
      fromCache: false,
    });
    mockedGenerate.mockResolvedValue({ text: "## Desk note\n- upgraded" } as never);

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 1, fetched: 1 });
  });

  it("a filing cached for the print under ANOTHER key (stored before the Finnhub entry arrived) is an upgrade candidate, not a fresh one", async () => {
    const secId = seedHeld("UPK");
    const rel = hoursAgoEt(5 * 24);
    seedEvent({
      symbol: "UPK",
      date: rel.date,
      releaseTime: rel.time,
      rawJson: JSON.stringify({ entry: { quarter: 4, year: 2026 } }),
    });
    // Keyed by the calendar (2026, 2); found by its filing date.
    seedCachedTranscript(secId, "UPK", "edgar_8k", "cached body", { callDate: rel.date });
    mockedFetch.mockResolvedValue({
      transcript: fakeTranscript({ ticker: "UPK", source: "edgar_8k", source_key: "edgar_8k:UPK:2026:2" }),
      fromCache: true,
    });

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    // Five days out: a fresh candidate would have expired at 36h.
    expect(result).toEqual({ attempted: 1, fetched: 0 });
    expect(mockedFetch).toHaveBeenCalledWith(db, "UPK", 2026, 4, {
      eventDate: rel.date,
      expectedFiscalQuarter: { year: 2026, quarter: 4 },
    });
  });

  it("a cached filing with NO known fiscal quarter is not retried: no call could be verified", async () => {
    const secId = seedHeld("UPN");
    const rel = hoursAgoEt(30);
    seedEvent({ symbol: "UPN", date: rel.date, releaseTime: rel.time });
    seedCachedTranscript(secId, "UPN", "edgar_8k", "cached body", { callDate: rel.date });

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 0, fetched: 0 });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("fresh candidates win the attempt budget over upgrade candidates", async () => {
    seedHeld("FRE");
    const upSec = seedHeld("UPG");
    // Upgrade candidate released MORE recently so the SQL recency order would
    // place it first — the fresh-first priority sort must still win.
    const relFresh = hoursAgoEt(3);
    const relUp = hoursAgoEt(2);
    seedEvent({ symbol: "FRE", date: relFresh.date, releaseTime: relFresh.time });
    seedEvent({ symbol: "UPG", date: relUp.date, releaseTime: relUp.time, rawJson: FINNHUB_Q2_2026 });
    seedCachedTranscript(upSec, "UPG", "edgar_8k");
    mockedFetch.mockResolvedValue(fakeFetchResult());

    const result = await fetchSameDayTranscripts(db, { now: NOW, maxAttempts: 1 });

    expect(result.attempted).toBe(1);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledWith(db, "FRE", 2026, 2, {
      eventDate: relFresh.date,
      skipAlphaVantage: true,
    });
  });
});

describe("fetchSameDayTranscripts: the attempt budget goes to the print waited on longest", () => {
  it("a print never tried goes before a newer print tried 31 minutes ago", async () => {
    seedHeld("NEWA");
    seedHeld("OLDA");
    const relNew = hoursAgoEt(3);
    const relOld = hoursAgoEt(7);
    const triedAt = new Date(NOW.getTime() - 31 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
    seedEvent({ symbol: "NEWA", date: relNew.date, releaseTime: relNew.time, transcriptAttemptedAt: triedAt });
    seedEvent({ symbol: "OLDA", date: relOld.date, releaseTime: relOld.time });
    mockedFetch.mockResolvedValue(null);

    const result = await fetchSameDayTranscripts(db, { now: NOW, maxAttempts: 1 });

    expect(result.attempted).toBe(1);
    expect(mockedFetch.mock.calls.map((c) => c[1])).toEqual(["OLDA"]);
  });

  it("among prints already tried, the oldest attempt goes first", async () => {
    seedHeld("NEWB");
    seedHeld("MIDB");
    seedHeld("OLDB");
    const stamp = (minutesAgo: number) =>
      new Date(NOW.getTime() - minutesAgo * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
    const relNew = hoursAgoEt(3);
    const relMid = hoursAgoEt(5);
    const relOld = hoursAgoEt(7);
    seedEvent({ symbol: "NEWB", date: relNew.date, releaseTime: relNew.time, transcriptAttemptedAt: stamp(40) });
    seedEvent({ symbol: "MIDB", date: relMid.date, releaseTime: relMid.time, transcriptAttemptedAt: stamp(90) });
    seedEvent({ symbol: "OLDB", date: relOld.date, releaseTime: relOld.time, transcriptAttemptedAt: stamp(60) });
    mockedFetch.mockResolvedValue(null);

    await fetchSameDayTranscripts(db, { now: NOW, maxAttempts: 2 });

    expect(mockedFetch.mock.calls.map((c) => c[1])).toEqual(["MIDB", "OLDB"]);
  });

  it("five prints with nothing filed all get a turn across ticks (the newest four no longer share every slot)", async () => {
    const symbols = ["P1C", "P2C", "P3C", "P4C", "P5C"];
    symbols.forEach((symbol, i) => {
      seedHeld(symbol);
      const rel = hoursAgoEt(3 + i);
      seedEvent({ symbol, date: rel.date, releaseTime: rel.time });
    });
    mockedFetch.mockResolvedValue(null);

    const tried: string[] = [];
    // Five ticks, 15 minutes apart, two attempts each: ten attempts in all.
    for (let tick = 0; tick < 5; tick += 1) {
      mockedFetch.mockClear();
      await fetchSameDayTranscripts(db, {
        now: new Date(NOW.getTime() + tick * 15 * 60 * 1000),
        maxAttempts: 2,
      });
      tried.push(...mockedFetch.mock.calls.map((c) => c[1] as string));
    }

    // The oldest print used to get no attempt at all. Now every print is
    // tried once before any print is tried twice.
    expect([...tried.slice(0, 5)].sort()).toEqual([...symbols].sort());
    expect(tried).toHaveLength(10);
    expect(tried.filter((t) => t === "P5C").length).toBeGreaterThanOrEqual(1);
  });

  it("with equal waits the newest print still goes first", async () => {
    seedHeld("NEWD");
    seedHeld("OLDD");
    const relNew = hoursAgoEt(3);
    const relOld = hoursAgoEt(7);
    seedEvent({ symbol: "OLDD", date: relOld.date, releaseTime: relOld.time });
    seedEvent({ symbol: "NEWD", date: relNew.date, releaseTime: relNew.time });
    mockedFetch.mockResolvedValue(null);

    await fetchSameDayTranscripts(db, { now: NOW, maxAttempts: 1 });

    expect(mockedFetch.mock.calls.map((c) => c[1])).toEqual(["NEWD"]);
  });
});

describe("fetchSameDayTranscripts — AI desk-note summary (#12 B2)", () => {
  it("calls the AI once and stores the desk-note summary over the cached row when the fetched transcript has text", async () => {
    seedHeld("JJJ");
    const rel = hoursAgoEt(3);
    seedEvent({ symbol: "JJJ", date: rel.date, releaseTime: rel.time });
    mockedFetch.mockResolvedValue({
      transcript: fakeTranscript({ transcript: LONG_TRANSCRIPT }),
      fromCache: false,
    });
    mockedGenerate.mockResolvedValue({
      text: "**Guidance**\n- Raised full-year outlook",
    } as never);

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 1, fetched: 1 });
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    expect(mockedGenerate).toHaveBeenCalledWith(
      "transcriptSummary",
      expect.objectContaining({ prompt: expect.any(String) }),
    );

    const row = getTranscriptRow("alpha_vantage:JJJ:2026:2");
    expect(row?.summary).toBe("**Guidance**\n- Raised full-year outlook");
    // Everything else on the cached row is echoed back unchanged.
    expect(row?.guidance).toBe("guidance paragraph, untouched by summarize");
    expect(row?.transcript).toBe(LONG_TRANSCRIPT);
  });

  it("strips a chatty AI preamble before storing the desk-note summary (carry-over fix, B3)", async () => {
    seedHeld("PPP");
    const rel = hoursAgoEt(3);
    seedEvent({ symbol: "PPP", date: rel.date, releaseTime: rel.time });
    mockedFetch.mockResolvedValue({
      transcript: fakeTranscript({
        ticker: "PPP",
        transcript: LONG_TRANSCRIPT,
        source_key: "alpha_vantage:PPP:2026:2",
      }),
      fromCache: false,
    });
    mockedGenerate.mockResolvedValue({
      text: "Good, now I have enough to write the desk note.\n\n**Guidance**\n- Raised full-year outlook",
    } as never);

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 1, fetched: 1 });
    const row = getTranscriptRow("alpha_vantage:PPP:2026:2");
    expect(row?.summary).toBe("**Guidance**\n- Raised full-year outlook");
    expect(row?.summary).not.toMatch(/^Good, now I have enough/);
  });

  it("keeps the extractive summary when the AI summary call throws (no error surfaces)", async () => {
    seedHeld("KKK");
    const rel = hoursAgoEt(3);
    seedEvent({ symbol: "KKK", date: rel.date, releaseTime: rel.time });
    mockedFetch.mockResolvedValue({
      transcript: fakeTranscript({
        ticker: "KKK",
        transcript: LONG_TRANSCRIPT,
        source_key: "alpha_vantage:KKK:2026:2",
      }),
      fromCache: false,
    });
    mockedGenerate.mockRejectedValue(new Error("model unavailable"));

    await expect(fetchSameDayTranscripts(db, { now: NOW })).resolves.toEqual({
      attempted: 1,
      fetched: 1,
    });

    // The AI call actually ran (long-enough transcript clears the length
    // gate) and threw — summarizeTranscript's upsert never ran as a result.
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    // summarizeTranscript's upsert never ran — no row was written by B2 code
    // (fetchTranscript is mocked, so the real extractive-summary upsert from
    // B1's pipeline also never ran here; the assertion that matters is that
    // no *new* summary write happened as a side effect of the AI failure).
    expect(getTranscriptRow("alpha_vantage:KKK:2026:2")).toBeUndefined();
  });

  it("does not call the AI when the fetched transcript has no text (metadata-only)", async () => {
    seedHeld("LLL");
    const rel = hoursAgoEt(3);
    seedEvent({ symbol: "LLL", date: rel.date, releaseTime: rel.time });
    mockedFetch.mockResolvedValue({
      transcript: fakeTranscript({
        ticker: "LLL",
        source: "edgar_8k",
        transcript: null,
        source_key: "edgar_8k:LLL:2026:2",
      }),
      fromCache: false,
    });

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 1, fetched: 1 });
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("stores a valid structured desk note (has **Guidance** section) unchanged", async () => {
    const good =
      '**Guidance**\n- Raised FY guide\n\n**Tone**\n- Confident\n\n**Surprises**\n- None\n\n**Key quotes**\n- "We can\'t predict rates."';
    seedHeld("GGG");
    const rel = hoursAgoEt(3);
    seedEvent({ symbol: "GGG", date: rel.date, releaseTime: rel.time });
    mockedFetch.mockResolvedValue({
      transcript: fakeTranscript({
        ticker: "GGG",
        transcript: LONG_TRANSCRIPT,
        source_key: "alpha_vantage:GGG:2026:2",
      }),
      fromCache: false,
    });
    mockedGenerate.mockResolvedValue({ text: good } as never);

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 1, fetched: 1 });
    const row = getTranscriptRow("alpha_vantage:GGG:2026:2");
    expect(row?.summary).toBe(good);
  });

  it("rejects a soft-refusal AI output and keeps the extractive summary", async () => {
    // Exact shape of the 2026-07-22 CSX poison: bulleted request-for-input.
    const refusal = [
      "- Exhibit 99.1 (press release with results)",
      "- Exhibit 99.2 (Quarterly Financial Report)",
      "- And/or the earnings call transcript itself (Q&A and prepared remarks)",
      "",
      "**Please provide the transcript text or the press release/financial report content**, and I'll produce the structured desk note as specified.",
    ].join("\n");

    seedHeld("CSX");
    const rel = hoursAgoEt(3);
    seedEvent({ symbol: "CSX", date: rel.date, releaseTime: rel.time });
    const fetched = fakeTranscript({
      ticker: "CSX",
      source: "edgar_8k",
      transcript: LONG_TRANSCRIPT,
      summary: "Extractive summary text",
      source_key: "edgar_8k:CSX:2026:2",
    });
    // Seed the row the way the real (mocked-here) fetchTranscript would have
    // already written it, so we can assert it survives the rejected AI call.
    seedExtractiveRow(fetched);
    mockedFetch.mockResolvedValue({ transcript: fetched, fromCache: false });
    mockedGenerate.mockResolvedValue({ text: refusal } as never);

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 1, fetched: 1 });
    expect(mockedGenerate).toHaveBeenCalledTimes(1);

    const row = getTranscriptRow("edgar_8k:CSX:2026:2");
    expect(row?.summary).toBe("Extractive summary text");
  });

  it("skips the AI call entirely for transcripts under MIN_TRANSCRIPT_CHARS_FOR_AI", async () => {
    // 3,774 chars — the actual CSX thin-8-K cover-page length observed 2026-07-22.
    const thin = "x".repeat(3_774);
    expect(thin.length).toBeLessThan(MIN_TRANSCRIPT_CHARS_FOR_AI);

    seedHeld("THN");
    const rel = hoursAgoEt(3);
    seedEvent({ symbol: "THN", date: rel.date, releaseTime: rel.time });
    const fetched = fakeTranscript({
      ticker: "THN",
      source: "edgar_8k",
      transcript: thin,
      summary: "Extractive summary text",
      source_key: "edgar_8k:THN:2026:2",
    });
    seedExtractiveRow(fetched);
    mockedFetch.mockResolvedValue({ transcript: fetched, fromCache: false });

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 1, fetched: 1 });
    expect(mockedGenerate).not.toHaveBeenCalled();

    const row = getTranscriptRow("edgar_8k:THN:2026:2");
    expect(row?.summary).toBe("Extractive summary text");
  });
});

describe("isValidDeskNote / looksLikeDeskNoteRefusal (pure)", () => {
  it("CSX refusal shape: not valid, is refusal", () => {
    const refusal = [
      "- Exhibit 99.1 (press release with results)",
      "- Exhibit 99.2 (Quarterly Financial Report)",
      "- And/or the earnings call transcript itself (Q&A and prepared remarks)",
      "",
      "**Please provide the transcript text or the press release/financial report content**, and I'll produce the structured desk note as specified.",
    ].join("\n");

    expect(isValidDeskNote(refusal)).toBe(false);
    expect(looksLikeDeskNoteRefusal(refusal)).toBe(true);
  });

  it("structured desk note: valid, not refusal", () => {
    const good =
      '**Guidance**\n- Raised FY guide\n\n**Tone**\n- Confident\n\n**Surprises**\n- None\n\n**Key quotes**\n- "We can\'t predict rates."';

    expect(isValidDeskNote(good)).toBe(true);
    expect(looksLikeDeskNoteRefusal(good)).toBe(false);
  });

  it("plain extractive prose (no bold labels): NOT valid, NOT refusal", () => {
    const extractive =
      "CSX reported second quarter results. Revenue was flat year over year and management discussed network performance.";
    expect(isValidDeskNote(extractive)).toBe(false);
    expect(looksLikeDeskNoteRefusal(extractive)).toBe(false);
  });
});

describe("vendorRequestDue (pure)", () => {
  const H = 60 * 60 * 1000;
  const now = Date.parse("2026-07-17T02:00:00Z");

  it("is due on the first attempt", () => {
    expect(vendorRequestDue(3 * H, null, now)).toBe(true);
  });

  it("is not due again inside the same retry slot", () => {
    expect(vendorRequestDue(3 * H, now - 31 * 60 * 1000, now)).toBe(false);
    expect(vendorRequestDue(VENDOR_RETRY_INTERVAL_MS - 1, now - 11 * H, now)).toBe(false);
  });

  it("is due on the first attempt after a retry mark, and only that one", () => {
    expect(vendorRequestDue(VENDOR_RETRY_INTERVAL_MS + 60_000, now - 31 * 60 * 1000, now)).toBe(true);
    expect(vendorRequestDue(VENDOR_RETRY_INTERVAL_MS + 32 * 60 * 1000, now - 31 * 60 * 1000, now)).toBe(false);
  });

  it("treats a stamp from before the release as no attempt at all", () => {
    expect(vendorRequestDue(1 * H, now - 5 * H, now)).toBe(true);
  });
});
