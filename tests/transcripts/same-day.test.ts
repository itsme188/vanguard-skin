/**
 * Same-day transcript orchestrator (#12 B1).
 * Spec: .superpowers/sdd/task-3-brief.md
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { fetchSameDayTranscripts } from "@/lib/transcripts/same-day";
import { fetchTranscript } from "@/lib/transcripts/fetch";
import { upsertTranscript } from "@/lib/mutations/transcripts";

vi.mock("@/lib/transcripts/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transcripts/fetch")>()),
  fetchTranscript: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchTranscript);

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
}): number {
  eventCounter += 1;
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events
          (source, event_type, event_date, release_time, title, symbol,
           actual_value, transcript_attempted_at, source_key, week_of, superseded)
         VALUES (?, 'earnings', ?, ?, ?, ?, ?, ?, ?, '2026-07-13', ?)`,
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
      ).lastInsertRowid,
  );
}

function getAttemptedAt(eventId: number): string | null {
  const row = db
    .prepare(`SELECT transcript_attempted_at FROM calendar_events WHERE id = ?`)
    .get(eventId) as { transcript_attempted_at: string | null };
  return row.transcript_attempted_at;
}

function fakeFetchResult() {
  return { transcript: {} as never, fromCache: false };
}

describe("fetchSameDayTranscripts", () => {
  it("fetches a held reporter released 3h ago with actuals and no cached transcript", async () => {
    seedHeld("AAA");
    const rel = hoursAgoEt(3);
    const eventId = seedEvent({ symbol: "AAA", date: rel.date, releaseTime: rel.time });
    mockedFetch.mockResolvedValue(fakeFetchResult());

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 1, fetched: 1 });
    expect(mockedFetch).toHaveBeenCalledWith(db, "AAA", expect.any(Number), expect.any(Number));
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

  it("skips an event whose (ticker, year, quarter) already has a cached transcript", async () => {
    const secId = seedHeld("EEE");
    const rel = hoursAgoEt(3);
    seedEvent({ symbol: "EEE", date: rel.date, releaseTime: rel.time });

    // deriveFilingReportingQuarter("2026-07-xx") -> { year: 2026, quarter: 2 }
    upsertTranscript(db, {
      security_id: secId,
      ticker: "EEE",
      year: 2026,
      quarter: 2,
      call_date: null,
      source: "edgar_8k",
      transcript: "cached body",
      summary: null,
      guidance: null,
      risk_factors: null,
      sentiment_score: null,
      sentiment_label: null,
      participants: null,
      source_key: "edgar_8k:EEE:2026:2",
    });

    const result = await fetchSameDayTranscripts(db, { now: NOW });

    expect(result).toEqual({ attempted: 0, fetched: 0 });
    expect(mockedFetch).not.toHaveBeenCalled();
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
});
