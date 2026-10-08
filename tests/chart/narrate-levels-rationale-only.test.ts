import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import type { SuggestedLevel } from "@/lib/chart/suggested-levels";
import type { OhlcBar } from "@/lib/chart/indicators";

// TODO (f8): the prompt asks the model for the rationale only. The facts
// (side, touch count, touch dates) are the templated sentence the card writes
// from the level row itself; the price and the distance are the card's chip.
vi.mock("ai", () => ({
  jsonSchema: (s: unknown) => s,
}));
vi.mock("@/lib/ai/generate", () => ({
  generateObjectForFeature: vi.fn(async () => ({ object: { narrative: "mocked sentence." } })),
}));

import { getOrGenerateNarrative, NARRATIVE_SCHEMA } from "@/lib/chart/narrate-levels";
import { generateObjectForFeature } from "@/lib/ai/generate";
import { buildFactSentence, composeLevelNarrative } from "@/lib/levels/narrative-guard";

const LEVEL: SuggestedLevel = {
  price: 150,
  type: "support",
  touches: 4,
  lastTouchDate: "2026-04-10",
  firstTouchDate: "2025-12-05",
  confidence: "high",
  distancePct: -14.3,
};
const BARS: OhlcBar[] = Array.from({ length: 20 }, (_, i) => ({
  date: `2026-04-${String(i + 1).padStart(2, "0")}`,
  open: 150 + i,
  high: 152 + i,
  low: 148 + i,
  close: 151 + i,
}));
const CURRENT = 175;

type Call = [string, { prompt: string; maxOutputTokens?: number; schema: unknown }];
function lastCall(): Call {
  const { calls } = (generateObjectForFeature as unknown as { mock: { calls: Call[] } }).mock;
  return calls[calls.length - 1];
}

describe("narrate-levels asks for the rationale only", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (1, 'AAA', 'stock')`).run();
    vi.clearAllMocks();
  });

  const run = (level: SuggestedLevel = LEVEL) =>
    getOrGenerateNarrative(db, {
      securityId: 1,
      symbol: "AAA",
      currentPrice: CURRENT,
      level,
      recentBars: BARS,
    });

  it("the instruction asks for the rationale and forbids restating the card's facts", async () => {
    await run();
    const { prompt } = lastCall()[1];
    // The instruction is the text after the data block.
    const instruction = prompt.slice(prompt.lastIndexOf("Write exactly one sentence"));
    expect(instruction).toContain("rationale only");
    expect(instruction).toMatch(/do not restate/i);
    for (const fact of ["price", "support or resistance", "distance", "touch count", "dates"]) {
      expect(instruction).toContain(fact);
    }
    // The old ask, which invited a full restatement of the level.
    expect(prompt).not.toContain("explains why this level is worth watching");
  });

  it("the schema describes a rationale and its example restates no figure", () => {
    const schema = NARRATIVE_SCHEMA as unknown as {
      properties: { narrative: { description: string } };
    };
    const description = schema.properties.narrative.description;
    expect(description).toContain("rationale");
    expect(description).not.toContain("4 times");
    expect(description).not.toMatch(/\d+\s*(?:times|%)/);
    expect(description).not.toMatch(/\$\s*\d/);
  });

  it("still passes an explicit output cap and adds no second AI call", async () => {
    await run();
    expect(generateObjectForFeature).toHaveBeenCalledTimes(1);
    expect(lastCall()[0]).toBe("suggestedLevelNarrative");
    expect(lastCall()[1].maxOutputTokens).toBeGreaterThan(0);
  });

  it("a reply that states a different price cannot change the displayed fact", async () => {
    vi.mocked(generateObjectForFeature).mockResolvedValueOnce({
      object: {
        narrative: "Resistance at $999.00, touched 9 times, sits 80% above the current price of $555.",
      },
    } as never);
    const stored = await run();

    const shown = composeLevelNarrative({ ...LEVEL, narrative: stored }, CURRENT);
    const fact = buildFactSentence(LEVEL);
    expect(fact).toBe("Support touched 4 times between 2025-12-05 and 2026-04-10.");
    expect(shown.startsWith(fact)).toBe(true);
    // The fact sentence is written from the level row; the reply adds nothing.
    expect(shown).toBe(fact);
    for (const wrong of ["999", "555", "80%", "9 times", "Resistance"]) {
      expect(shown).not.toContain(wrong);
    }
  });

  it("a clean rationale is shown after the fact sentence, never in place of it", async () => {
    const rationale = "Buyers stepped in on each retest and the latest bounce held a higher low.";
    vi.mocked(generateObjectForFeature).mockResolvedValueOnce({
      object: { narrative: rationale },
    } as never);
    const stored = await run();
    expect(stored).toBe(rationale);
    expect(composeLevelNarrative({ ...LEVEL, narrative: stored }, CURRENT)).toBe(
      `${buildFactSentence(LEVEL)} ${rationale}`,
    );
  });
});
