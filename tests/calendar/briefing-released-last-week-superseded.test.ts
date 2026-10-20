import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn(),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/vital-knowledge", () => ({ fetchVitalKnowledge: vi.fn(async () => "") }));

import { runMigrations } from "@/lib/db/migrate";
import { generateTextForFeature } from "@/lib/ai/generate";
import { generateWeeklyBriefing } from "@/lib/calendar/briefing";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.mocked(generateTextForFeature).mockReset();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(generateTextForFeature).mockResolvedValue({ text: "# Briefing" } as any);
});

function add(key: string, title: string, date: string, week: string, superseded: number, released: boolean) {
  db.prepare(
    `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, week_of,
       actual_value, enriched_at, superseded)
     VALUES ('manual', 'macro', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(date, title, key, week, released ? "3.1%" : null, released ? "2026-10-27 20:00:00" : null, superseded);
}

describe("Released last week skips superseded twins", () => {
  it("lists the kept row once and omits its hidden duplicate", async () => {
    add("a", "ZZK kept print", "2026-10-27", "2026-10-26", 0, true);
    add("b", "ZZH hidden twin", "2026-10-27", "2026-10-26", 1, true);
    add("c", "This week event", "2026-11-03", "2026-11-02", 0, false);

    await generateWeeklyBriefing(db, "2026-11-02");

    const prompt = vi.mocked(generateTextForFeature).mock.calls[0][1].prompt as string;
    expect(prompt).toContain("Released Last Week");
    expect(prompt).toContain("ZZK kept print");
    expect(prompt).not.toContain("ZZH hidden twin");
  });
});
