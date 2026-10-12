/**
 * Every place that adds a level meets the create arm guard the same way: a
 * 409 refusal becomes an app-dialog question, and a yes resends the SAME body
 * with `force`. The repo has no DOM harness, so the wording is unit-tested and
 * the three entry points are source-pinned.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRefusalPrompt } from "@/lib/levels/create-level-prompt";
import { anchorIndex } from "../helpers/source-anchor";

const fmt = (p: number) => `$${p.toFixed(2)}`;

describe("createRefusalPrompt wording", () => {
  it("would_fire_immediately names both prices", () => {
    const q = createRefusalPrompt(409, { code: "would_fire_immediately", currentPrice: 100, effectivePrice: 90 }, fmt);
    expect(q?.code).toBe("would_fire_immediately");
    expect(q?.message).toContain("$100.00");
    expect(q?.message).toContain("$90.00");
  });

  it("beyond_scan_range names both prices", () => {
    const q = createRefusalPrompt(409, { code: "beyond_scan_range", currentPrice: 100, effectivePrice: 10000 }, fmt);
    expect(q?.code).toBe("beyond_scan_range");
    expect(q?.message).toContain("$100.00");
    expect(q?.message).toContain("$10000.00");
  });

  it("reads as a plain sentence when the refusal carries no numbers", () => {
    for (const code of ["would_fire_immediately", "beyond_scan_range"]) {
      const q = createRefusalPrompt(409, { code }, fmt);
      expect(q).not.toBeNull();
      expect(q?.message).not.toContain("(the new level)");
      expect(q?.message).not.toMatch(/the current price the current price/);
      expect(q?.message.match(/the new level/gi)?.length).toBe(1);
    }
  });

  it("is null for anything that is not a create refusal", () => {
    expect(createRefusalPrompt(500, { code: "beyond_scan_range" }, fmt)).toBeNull();
    expect(createRefusalPrompt(409, { code: "other" }, fmt)).toBeNull();
    expect(createRefusalPrompt(409, null, fmt)).toBeNull();
  });
});

const panel = readFileSync(join(process.cwd(), "app/dashboard/components/LevelsPanel.tsx"), "utf8");
const popover = readFileSync(join(process.cwd(), "app/dashboard/components/AddLevelPopover.tsx"), "utf8");

function region(src: string, start: string, end: string): string {
  const a = anchorIndex(src, start, 0, "start");
  const b = anchorIndex(src, end, a + start.length, "end");
  return src.slice(a, b);
}

describe("all three create entry points ask, then resend with force", () => {
  it("submitAdd", () => {
    const body = region(panel, "async function submitAdd(", "// Edit: the add form");
    expect(body).toContain("createRefusalPrompt(");
    expect(body).toContain("force: confirmed !== null");
    expect(body).toContain("setConfirmPrompt(");
    expect(body).toContain("submitAdd(addBody, question.code)");
  });

  it("accept (suggested level)", () => {
    const body = region(panel, "async function accept(", "if (loading) {");
    expect(body).toContain("createRefusalPrompt(");
    expect(body).toContain("force: confirmed !== null");
    expect(body).toContain("askQuestion(");
    expect(body).toContain("accept(sug, index, question.code)");
    expect(body).toContain("CREATE_DECLINED_MESSAGE");
  });

  it("the suggestions get the panel's dialog opener", () => {
    expect(panel).toContain("askQuestion={setConfirmPrompt}");
  });

  it("chart-click popover", () => {
    expect(popover).toContain("createRefusalPrompt(");
    expect(popover).toContain("force: confirmed !== null");
    expect(popover).toContain("prompt.ask(question)");
    expect(popover).toContain("submit(type, question.code)");
  });

  it("the popover labels the question price with formatLevelPrice", () => {
    const line = region(popover, "createRefusalPrompt(result.status", ");");
    expect(line).toContain("formatLevelPrice(currency, p)");
    expect(line).not.toContain("formatChartPrice");
  });
});
