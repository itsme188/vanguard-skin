import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { fetchTranscript, ALPHA_VANTAGE_DAILY_REQUEST_LIMIT } from "@/lib/transcripts/fetch";
import { getEarningsTranscript as getAlphaVantageTranscript } from "@/lib/transcripts/alpha-vantage";
import { getEarnings8KFilings } from "@/lib/apis/edgar";
import { todayET } from "@/lib/calendar/date-utils";

vi.mock("@/lib/calendar/date-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/calendar/date-utils")>();
  return { ...actual, todayET: vi.fn(() => "2026-10-07") };
});

vi.mock("@/lib/transcripts/alpha-vantage", () => ({
  isAlphaVantageConfigured: vi.fn(() => true),
  getEarningsTranscript: vi.fn(async () => null),
}));

vi.mock("@/lib/apis/api-ninjas", () => ({
  isApiNinjasConfigured: vi.fn(() => false),
  getEarningsTranscript: vi.fn(async () => null),
}));

vi.mock("@/lib/apis/edgar", () => ({
  getEarnings8KFilings: vi.fn(async () => []),
}));

function count(db: Database.Database, day: string): number {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(`transcript_vendor_requests:alpha_vantage:${day}`) as { value: string } | undefined;
  return Number(row?.value ?? "0");
}

describe("fetchTranscript Alpha Vantage quota", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    vi.mocked(todayET).mockReturnValue("2026-10-07");
    vi.mocked(getAlphaVantageTranscript).mockResolvedValue(null);
    vi.mocked(getEarnings8KFilings).mockResolvedValue([]);
  });

  it("does not call the vendor once the Eastern-day limit is already spent", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "transcript_vendor_requests:alpha_vantage:2026-10-07",
      String(ALPHA_VANTAGE_DAILY_REQUEST_LIMIT),
    );
    await fetchTranscript(db, "ZZAA", 2026, 3);
    expect(getAlphaVantageTranscript).not.toHaveBeenCalled();
    expect(count(db, "2026-10-07")).toBe(ALPHA_VANTAGE_DAILY_REQUEST_LIMIT);
  });

  it("counts a failed/null vendor call and starts the next Eastern day at zero", async () => {
    await fetchTranscript(db, "ZZAA", 2026, 3);
    expect(getAlphaVantageTranscript).toHaveBeenCalledTimes(1);
    expect(count(db, "2026-10-07")).toBe(1);

    vi.mocked(getAlphaVantageTranscript).mockClear();
    vi.mocked(todayET).mockReturnValue("2026-10-08");
    await fetchTranscript(db, "ZZAA", 2026, 3);
    expect(getAlphaVantageTranscript).toHaveBeenCalledTimes(1);
    expect(count(db, "2026-10-08")).toBe(1);
  });
});
