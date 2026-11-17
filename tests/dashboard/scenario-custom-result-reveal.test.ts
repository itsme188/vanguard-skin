import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

// Source-pin test (no DOM harness in this repo). QA finding: at phone width
// the custom scenario result card renders above the builder form, wholly
// off-screen, so Compute looked dead. A successful Compute must bring the new
// card into view; nothing else may trigger the scroll.
const src = readFileSync("app/dashboard/components/ScenarioModeling.tsx", "utf8");

describe("custom scenario result is brought into view", () => {
  it("a successful Compute arms the reveal before the result is set", () => {
    const success = sliceBetween(src, "if (result.ok) {", "} else {");
    const arm = anchorIndex(success, "revealCustomResultRef.current = true;");
    const set = anchorIndex(success, "setCustomResult(result.data.data);");
    expect(arm).toBeLessThan(set);
  });

  it("only the success branch arms the reveal", () => {
    expect(src.split("revealCustomResultRef.current = true;").length - 1).toBe(1);
  });

  it("the effect scrolls only when armed, disarms itself, and only when the card top is off-screen", () => {
    const start = anchorIndex(src, "if (!revealCustomResultRef.current) return;");
    const effect = src.slice(start, anchorIndex(src, "}, [customResult]);", start));
    expect(effect).toContain("revealCustomResultRef.current = false;");
    expect(effect).toContain("getBoundingClientRect().top");
    expect(effect).toMatch(/top < 0 \|\| top > window\.innerHeight/);
    expect(effect).toContain('scrollIntoView({ block: "start" })');
  });

  it("the ref sits on the custom card only, and the card clears the sticky header", () => {
    const card = sliceBetween(src, "key={result.scenario.id}", "{/* Card header */}");
    expect(card).toContain('ref={result.scenario.id === "custom" ? customCardRef : undefined}');
    expect(card).toContain("scroll-mt-20");
  });
});
