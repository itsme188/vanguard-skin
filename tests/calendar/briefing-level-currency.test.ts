import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

// A level price is native currency: labelled, never converted (ruling
// 2026-10-07). The weekly briefing prompt printed a hardcoded dollar sign in
// its two level sections. The real generateWeeklyBriefing runs here with the
// AI call mocked, and the prompt it built is read back. Synthetic symbols and
// invented round prices only.

vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn(),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/vital-knowledge", () => ({
  fetchVitalKnowledge: vi.fn(async () => ""),
}));

import { runMigrations } from "@/lib/db/migrate";
import { generateTextForFeature } from "@/lib/ai/generate";
import { generateWeeklyBriefing } from "@/lib/calendar/briefing";
import { upsertCalendarEvents } from "@/lib/mutations/calendar";
import { upsertLevel, triggerLevel } from "@/lib/mutations/security-levels";

const WEEK = "2026-11-02";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.mocked(generateTextForFeature).mockReset();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(generateTextForFeature).mockResolvedValue({ text: "# Briefing" } as any);
  // The briefing needs at least one event in the week to build a prompt.
  // A Finnhub earnings row in the shape lib/calendar/finnhub.ts assembles.
  upsertCalendarEvents(db, [
    {
      source: "finnhub",
      event_type: "earnings",
      event_date: "2026-11-05",
      event_time: null,
      title: "ZZQ earnings",
      description: "Q3 2026 report.",
      symbol: "ZZQ",
      consensus_estimate: "EPS 1.00 \u00b7 Rev 2B",
      raw_json: JSON.stringify({
        entry: { symbol: "ZZQ", date: "2026-11-05", epsEstimate: 1, revenueEstimate: 2_000_000_000, quarter: 3, year: 2026, epsActual: null },
        history: [],
        finnhub_symbol: "ZZQ",
      }),
      source_key: "finnhub:ZZQ:2026-11-05",
      week_of: WEEK,
    },
  ]);
});

function seedSecurity(symbol: string, currency: string): number {
  const id = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
  db.prepare("UPDATE securities SET currency = ? WHERE id = ?").run(currency, id);
  return id;
}

function setPrice(secId: number, close: number) {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-10-30', ?, 'manual')"
  ).run(secId, close);
}

async function promptText(): Promise<string> {
  await generateWeeklyBriefing(db, WEEK);
  const call = vi.mocked(generateTextForFeature).mock.calls[0];
  expect(call).toBeDefined();
  return JSON.stringify(call);
}

function lineFor(prompt: string, symbol: string, marker: string): string {
  // The prompt is read out of the JSON-encoded call arguments, so a line break
  // is the two characters backslash + n.
  const line = prompt.split("\\n").find((l) => l.includes(`**${symbol}**`) && l.includes(marker));
  expect(line, `no ${marker} line for ${symbol}`).toBeDefined();
  return line!;
}

describe("weekly briefing prompt: level prices carry their own currency", () => {
  it("levels hit in the past week: dollars read as before, yen is labelled in yen", async () => {
    const usd = seedSecurity("ZZA", "USD");
    const usdLevel = upsertLevel(db, { security_id: usd, level_type: "support", price: 1180 });
    triggerLevel(db, { levelId: usdLevel, securityId: usd, triggeredPrice: 1179.5 });

    const jpy = seedSecurity("ZZJ", "JPY");
    const jpyLevel = upsertLevel(db, { security_id: jpy, level_type: "support", price: 976000 });
    triggerLevel(db, { levelId: jpyLevel, securityId: jpy, triggeredPrice: 975500 });

    const prompt = await promptText();
    expect(prompt).toContain("## Price Levels Hit in the Past Week");

    const usdLine = lineFor(prompt, "ZZA", "hit on");
    expect(usdLine).toContain("**ZZA** support at $1180.00 hit on ");
    expect(usdLine).toContain("(price: $1179.50).");

    const jpyLine = lineFor(prompt, "ZZJ", "hit on");
    expect(jpyLine).toContain("**ZZJ** support at \u00a5976,000 hit on ");
    expect(jpyLine).toContain("(price: \u00a5975,500).");
    expect(jpyLine).not.toContain("$");
  });

  it("levels near the current price: dollars read as before, pounds are labelled in pounds", async () => {
    const usd = seedSecurity("ZZB", "USD");
    upsertLevel(db, { security_id: usd, level_type: "resistance", price: 1200 });
    setPrice(usd, 1180);

    const gbp = seedSecurity("ZZG", "GBP");
    upsertLevel(db, { security_id: gbp, level_type: "resistance", price: 50 });
    setPrice(gbp, 49);

    const prompt = await promptText();
    expect(prompt).toContain("## Active Levels Within 5% of Current Price");

    expect(lineFor(prompt, "ZZB", "currently")).toContain(
      "**ZZB** resistance at $1200.00 \u2014 currently $1180.00 ("
    );
    const gbpLine = lineFor(prompt, "ZZG", "currently");
    expect(gbpLine).toContain("**ZZG** resistance at \u00a350.00 \u2014 currently \u00a349.00 (");
    expect(gbpLine).not.toContain("$");
  });
});
