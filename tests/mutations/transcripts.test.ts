import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  upsertTranscript,
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
