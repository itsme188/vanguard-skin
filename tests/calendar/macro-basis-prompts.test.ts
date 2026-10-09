/**
 * Basis in the prompts (owner ruling 2026-10-08: "the lookup must return the
 * actual on the consensus basis").
 *
 *   - The sync-time prompt is told, per tracked release, the basis the FRED
 *     actual will be formatted in, so consensus and previous come back on it.
 *   - The non-FRED actual lookup is given the row's consensus and previous
 *     and told to answer on that basis.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockGenerate = vi.fn();
vi.mock("@/lib/ai/generate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/generate")>();
  return { ...actual, generateTextForFeature: (...args: unknown[]) => mockGenerate(...args) };
});

import { fetchMacroEvents, releaseBasisNote } from "@/lib/calendar/macro-events";
import {
  buildNonFredActualPrompt,
  fredBasisDescription,
  RELEASE_ID_TO_SERIES,
} from "@/lib/calendar/enrich-actuals";

describe("fredBasisDescription", () => {
  it("names the basis of every format the FRED actual can take", () => {
    expect(fredBasisDescription("pct_yoy")).toMatch(/year-over-year percent/);
    expect(fredBasisDescription("pct_mom")).toMatch(/month-over-month percent/);
    expect(fredBasisDescription("qoq_saar")).toMatch(/quarter-over-quarter/);
    expect(fredBasisDescription("delta_k")).toMatch(/change/);
    expect(fredBasisDescription("level_count")).toMatch(/level/);
    expect(fredBasisDescription("usd_millions")).toMatch(/level/);
    expect(fredBasisDescription("pct")).toMatch(/level/);
  });

  it("every mapped release has a basis note that names its series", () => {
    for (const [releaseId, cfg] of Object.entries(RELEASE_ID_TO_SERIES)) {
      const note = releaseBasisNote(Number(releaseId));
      expect(note).toContain(cfg.seriesId);
      expect(note).toContain(fredBasisDescription(cfg.formatAs));
    }
    expect(releaseBasisNote(999_999)).toBeNull();
  });
});

describe("the sync-time prompt carries each release's basis", () => {
  const savedFred = process.env.FRED_API_KEY;
  const savedAi = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.FRED_API_KEY = "test-key";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    mockGenerate.mockReset();
    mockGenerate.mockResolvedValue({ text: "[]" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          release_dates: [
            { release_id: 46, release_name: "Producer Price Index", date: "2026-09-15" },
            { release_id: 9, release_name: "Advance Monthly Sales for Retail and Food Services", date: "2026-09-16" },
            { release_id: 180, release_name: "Unemployment Insurance Weekly Claims Report", date: "2026-09-17" },
          ],
        }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedFred === undefined) delete process.env.FRED_API_KEY;
    else process.env.FRED_API_KEY = savedFred;
    if (savedAi === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAi;
  });

  it("each listed release line states its basis, and the instructions bind consensus and previous to it", async () => {
    // 2026-09-14..20 holds no non-FRED indicator, so the only AI call is this one.
    await fetchMacroEvents("2026-09-14", "2026-09-20", "2026-09-14");

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    const prompt = String((mockGenerate.mock.calls[0][1] as { prompt: string }).prompt);
    const lineFor = (name: string) => prompt.split("\n").find((l) => l.includes(name)) ?? "";

    expect(lineFor("Producer Price Index")).toMatch(/year-over-year percent/);
    expect(lineFor("Producer Price Index")).toContain("PPIFIS");
    expect(lineFor("Retail Sales")).toMatch(/month-over-month percent/);
    expect(lineFor("Initial Jobless Claims")).toMatch(/level/);

    // The two fields are no longer basis-free.
    const consensusLine = prompt.split("\n").find((l) => l.startsWith("- consensus_estimate")) ?? "";
    const previousLine = prompt.split("\n").find((l) => l.startsWith("- previous_value")) ?? "";
    expect(consensusLine).toMatch(/basis/i);
    expect(previousLine).toMatch(/basis/i);
  });
});

describe("buildNonFredActualPrompt", () => {
  it("gives the lookup the row's consensus and previous and asks for the same basis", () => {
    const prompt = buildNonFredActualPrompt("ISM Manufacturing", "2026-09-01", "52.1", "51.8");
    expect(prompt).toContain("ISM Manufacturing");
    expect(prompt).toContain("2026-09-01");
    expect(prompt).toContain("52.1");
    expect(prompt).toContain("51.8");
    expect(prompt).toMatch(/same basis/i);
  });

  it("names only the figure the row has", () => {
    const onlyConsensus = buildNonFredActualPrompt("ISM Services", "2026-09-03", "53.0", null);
    expect(onlyConsensus).toContain("53.0");
    expect(onlyConsensus).toMatch(/same basis/i);
    expect(onlyConsensus).not.toMatch(/previous reading/i);
  });

  it("adds no basis instruction when the row has neither figure", () => {
    const bare = buildNonFredActualPrompt("ISM Services", "2026-09-03", null, null);
    expect(bare).toContain("ISM Services");
    expect(bare).not.toMatch(/same basis/i);
  });
});
