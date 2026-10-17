/**
 * The digest synthesis prompt dates itself.
 *
 * A Monday digest copied a Friday newsletter's "next week's CPI" and a Friday
 * digest copied Thursday's "IBKR reports after the close"; both told the
 * reader an event was ahead when it was that week, or already past. The
 * prompt now carries the send date, its trading week and the rule that a
 * source's relative words are relative to the source's date. Both composers
 * (Mac synthesize, Worker fallback evening) include the block.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { anchorIndex } from "../helpers/source-anchor";
import { digestDatingRules } from "@/lib/digest/synthesis-dating";
import { digestDatingRules as workerRules } from "../../workers/cron/src/synthesis-dating";

vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn(),
  AIRefusalError: class AIRefusalError extends Error {},
}));
import { generateTextForFeature } from "@/lib/ai/generate";
import { synthesize } from "@/lib/digest/synthesize";

describe("digestDatingRules", () => {
  it("a Monday digest names its own Monday-to-Friday week as this week", () => {
    const block = digestDatingRules("2026-10-12");
    expect(block).toContain("DATING (HARD)");
    expect(block).toContain("This digest is dated Monday, October 12, 2026.");
    expect(block).toContain("Its trading week runs Monday, October 12 to Friday, October 16.");
    expect(block).toContain('is "this week", named by its weekday');
  });

  it("a Friday digest says an event dated before it has already happened", () => {
    const block = digestDatingRules("2026-10-16");
    expect(block).toContain("dated Friday, October 16, 2026");
    expect(block).toContain("Its trading week runs Monday, October 12 to Friday, October 16.");
    expect(block).toContain("has already happened");
    expect(block).toContain("reports after the close");
  });

  it("a Saturday looks back at the week just ended and a Sunday ahead to the coming one", () => {
    expect(digestDatingRules("2026-10-17")).toContain(
      "The trading week just ended ran Monday, October 12 to Friday, October 16.",
    );
    expect(digestDatingRules("2026-10-18")).toContain(
      "The coming trading week runs Monday, October 19 to Friday, October 23.",
    );
  });

  it("crosses a month and a year boundary by the calendar", () => {
    expect(digestDatingRules("2026-12-30")).toContain("Monday, December 28 to Friday, January 1.");
  });

  it("returns nothing for a malformed or impossible date", () => {
    expect(digestDatingRules("")).toBe("");
    expect(digestDatingRules("2026-10-17T03:00:00Z")).toBe("");
    expect(digestDatingRules("2026-02-30")).toBe("");
  });

  it("is mirrored byte for byte in the Worker", () => {
    const body = (path: string) => {
      const src = readFileSync(path, "utf8");
      return src.slice(anchorIndex(src, "// Dating rules mirrored", 0, path));
    };
    expect(body("workers/cron/src/synthesis-dating.ts")).toBe(body("lib/digest/synthesis-dating.ts"));
    expect(workerRules("2026-10-12")).toBe(digestDatingRules("2026-10-12"));
  });

  it("the Worker's evening synthesis prompt includes the block", () => {
    const src = readFileSync("workers/cron/src/fallback-evening.ts", "utf8");
    anchorIndex(src, "digestDatingRules(dateStr)", 0, "workers/cron/src/fallback-evening.ts");
  });
});

describe("synthesize — system prompt dating", () => {
  const mocked = vi.mocked(generateTextForFeature);
  beforeEach(() => {
    mocked.mockReset();
    mocked.mockResolvedValue({
      text: `# Headline\n\n## The Session\n\n${"Substantive sentence. ".repeat(20)}`,
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    } as unknown as Awaited<ReturnType<typeof generateTextForFeature>>);
  });

  const input = { buckets: [], heldSymbols: [], watchlist: [], anomalies: [] };

  it("carries the send date and its week when one is given", async () => {
    await synthesize({ ...input, sendDate: "2026-10-12" });
    const system = String(mocked.mock.calls[0][1].system);
    expect(system).toContain("DATING (HARD)");
    expect(system).toContain("Monday, October 12, 2026");
  });

  it("omits the block, rather than inventing a date, when none is given", async () => {
    await synthesize(input);
    expect(String(mocked.mock.calls[0][1].system)).not.toContain("DATING (HARD)");
  });
});
