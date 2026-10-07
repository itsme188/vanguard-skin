import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  upsertTranscript,
  filingDateMatchesPrint,
  transcriptQuarterMismatchReason,
  PRINT_FILING_WINDOW_DAYS,
  TranscriptQuarterMismatchError,
} from "@/lib/mutations/transcripts";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function params(overrides: Partial<Parameters<typeof upsertTranscript>[1]> = {}) {
  return {
    ticker: "ZZM",
    year: 2026,
    quarter: 3,
    call_date: null,
    source: "alpha_vantage" as const,
    transcript: "Operator: Welcome to ZZM's third quarter 2026 earnings call.",
    summary: null,
    guidance: null,
    risk_factors: null,
    sentiment_score: null,
    sentiment_label: null,
    participants: null,
    source_key: "alpha_vantage:ZZM:2026:3",
    ...overrides,
  };
}

describe("upsertTranscript fiscal self-consistency", () => {
  it("rejects and caches nothing when the transcript states a quarter that contradicts the key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() =>
      upsertTranscript(
        db,
        params({
          quarter: 4,
          source_key: "alpha_vantage:ZZM:2026:4",
          transcript: "Operator: Welcome to ZZM's fiscal second quarter 2026 earnings call.",
        }),
      ),
    ).toThrow(TranscriptQuarterMismatchError);

    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM earnings_transcripts").get() as { c: number }).c,
    ).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("rejected"));
    warn.mockRestore();
  });

  it("allows transcripts with no stated quarter and updates call_date on conflict when supplied", () => {
    const first = upsertTranscript(
      db,
      params({
        transcript: "Jane Doe (CEO): Operating remarks without a quarter phrase.",
        call_date: null,
        source: "api_ninjas",
        source_key: "api_ninjas:ZZM:2026:3",
      }),
    );
    expect(first.call_date).toBeNull();

    const second = upsertTranscript(
      db,
      params({
        transcript: "Jane Doe (CEO): Operating remarks without a quarter phrase.",
        call_date: "2026-10-20",
        source: "api_ninjas",
        source_key: "api_ninjas:ZZM:2026:3",
      }),
    );

    expect(second.id).toBe(first.id);
    expect(second.call_date).toBe("2026-10-20");
  });
});

describe("upsertTranscript — the key rule at the single insert", () => {
  const count = () =>
    (db.prepare("SELECT COUNT(*) AS c FROM earnings_transcripts").get() as { c: number }).c;

  it("a CALL is rejected when its text names the right quarter of another year", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      upsertTranscript(
        db,
        params({ transcript: "Operator: Welcome to ZZM's third quarter 2025 earnings call." }),
      ),
    ).toThrow(TranscriptQuarterMismatchError);
    expect(count()).toBe(0);
    warn.mockRestore();
  });

  it("require_stated_quarter: a call that states nothing, or only mentions the quarter in passing, is rejected", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      upsertTranscript(
        db,
        params({
          transcript: "Jane Doe (CEO): Operating remarks without a quarter phrase.",
          require_stated_quarter: true,
        }),
      ),
    ).toThrow(/states no fiscal quarter/);
    expect(() =>
      upsertTranscript(
        db,
        params({
          transcript: "Jane Doe (CEO): In the third quarter we shipped more units.",
          require_stated_quarter: true,
        }),
      ),
    ).toThrow(/only mentions Q3 in passing/);
    expect(count()).toBe(0);

    // A self-identifying statement of the key's quarter is what admits it.
    upsertTranscript(db, params({ require_stated_quarter: true }));
    expect(count()).toBe(1);
    warn.mockRestore();
  });

  it("a FILING without a print date is held to the same rule as a call", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      upsertTranscript(
        db,
        params({
          source: "edgar_8k",
          source_key: "edgar_8k:acc-1",
          call_date: "2026-10-20",
          transcript: "ZZM reports fiscal fourth quarter 2026 results.",
        }),
      ),
    ).toThrow(TranscriptQuarterMismatchError);
    expect(count()).toBe(0);
    warn.mockRestore();
  });

  it("a FILING whose filing date sits in the print's window is stored under the print's key, with the difference logged", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const row = upsertTranscript(
      db,
      params({
        source: "edgar_8k",
        source_key: "edgar_8k:acc-1",
        call_date: "2026-10-21",
        print_event_date: "2026-10-20",
        transcript: "ZZM reports fiscal fourth quarter 2026 results.",
      }),
    );
    expect(row).toMatchObject({ year: 2026, quarter: 3, source: "edgar_8k" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("by filing date 2026-10-21"));
    log.mockRestore();
  });

  it("a print date does NOT excuse a filing dated outside the window, or one with no filing date", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const call_date of ["2026-07-21", "2026-10-25", null]) {
      expect(() =>
        upsertTranscript(
          db,
          params({
            source: "edgar_8k",
            source_key: `edgar_8k:acc-${call_date}`,
            call_date,
            print_event_date: "2026-10-20",
            transcript: "ZZM reports fiscal fourth quarter 2026 results.",
          }),
        ),
      ).toThrow(TranscriptQuarterMismatchError);
    }
    expect(count()).toBe(0);
    warn.mockRestore();
  });

  it("a print date NEVER excuses a call: only a filing has a filing date", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      upsertTranscript(
        db,
        params({
          call_date: "2026-10-20",
          print_event_date: "2026-10-20",
          transcript: "Operator: Welcome to ZZM's fiscal second quarter 2026 earnings call.",
        }),
      ),
    ).toThrow(TranscriptQuarterMismatchError);
    expect(count()).toBe(0);
    warn.mockRestore();
  });

  it("re-writing a stored row (the desk note over the summary) is not a new keying decision", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const stored = upsertTranscript(
      db,
      params({
        source: "edgar_8k",
        source_key: "edgar_8k:acc-1",
        call_date: "2026-10-20",
        print_event_date: "2026-10-20",
        transcript: "ZZM reports fiscal fourth quarter 2026 results.",
        summary: "extractive",
      }),
    );
    // summarizeTranscript echoes the row back with a new summary and no print date.
    const rewritten = upsertTranscript(db, {
      ticker: stored.ticker,
      year: stored.year,
      quarter: stored.quarter,
      call_date: stored.call_date,
      source: stored.source,
      transcript: stored.transcript,
      summary: "**Guidance**\n- desk note",
      source_key: stored.source_key,
    });
    expect(rewritten.id).toBe(stored.id);
    expect(rewritten.summary).toBe("**Guidance**\n- desk note");

    // Changing the text under the same source_key IS a new decision.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      upsertTranscript(db, {
        ticker: stored.ticker,
        year: stored.year,
        quarter: stored.quarter,
        source: stored.source,
        transcript: "ZZM reports fiscal first quarter 2027 results.",
        source_key: stored.source_key,
      }),
    ).toThrow(TranscriptQuarterMismatchError);
    warn.mockRestore();
    log.mockRestore();
  });

  it("the filing window is a named constant and symmetric around the print", () => {
    expect(PRINT_FILING_WINDOW_DAYS).toBe(4);
    expect(filingDateMatchesPrint("2026-10-20", "2026-10-20")).toBe(true);
    expect(filingDateMatchesPrint("2026-10-24", "2026-10-20")).toBe(true);
    expect(filingDateMatchesPrint("2026-10-16", "2026-10-20")).toBe(true);
    expect(filingDateMatchesPrint("2026-10-25", "2026-10-20")).toBe(false);
    expect(filingDateMatchesPrint(null, "2026-10-20")).toBe(false);
    expect(filingDateMatchesPrint("2026-10-20", undefined)).toBe(false);
    expect(filingDateMatchesPrint("garbage", "2026-10-20")).toBe(false);
  });

  it("transcriptQuarterMismatchReason names the expected and the stated quarter", () => {
    expect(
      transcriptQuarterMismatchReason({
        ticker: "ZZM",
        year: 2026,
        quarter: 4,
        source: "alpha_vantage",
        transcript: "Operator: Welcome to the fiscal second quarter 2026 earnings call.",
      }),
    ).toBe("stated Q2 2026 but key is Q4 2026");
  });
});
