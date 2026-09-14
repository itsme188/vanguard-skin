import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("Custom scenario result is invalidated on scope switch and Hide", () => {
  const src = () =>
    readFileSync("app/dashboard/components/ScenarioModeling.tsx", "utf8");

  it("the [scope] effect drops the stale custom result", () => {
    const text = src();
    const effectMatch = text.match(
      /useEffect\(\(\) => \{([\s\S]*?)\}, \[scope\]\);/
    );
    expect(effectMatch).not.toBeNull();
    const effectBody = effectMatch![1];
    // Switching scope must clear the previous custom result — otherwise a
    // card computed for the OLD scope keeps showing next to presets for the
    // NEW scope.
    expect(effectBody).toContain("setCustomResult(null)");
  });

  it("hiding the custom scenario builder clears the result, but opening it does not", () => {
    const text = src();
    const labelIdx = text.indexOf('Custom Scenario{" "}');
    expect(labelIdx).toBeGreaterThan(-1);
    const beforeLabel = text.slice(0, labelIdx);
    const btnStart = beforeLabel.lastIndexOf("<button");
    expect(btnStart).toBeGreaterThan(-1);
    const buttonBlock = text.slice(btnStart, labelIdx);

    // The card must disappear when the builder collapses — otherwise a
    // dismissed result has no way to leave the screen.
    expect(buttonBlock).toContain("setCustomResult(null)");
    // ...but only on the transition that HIDES the builder, not on open.
    expect(buttonBlock).toMatch(/if\s*\(showBuilder\)/);
  });

  it("still declares customResult and customError state", () => {
    const text = src();
    expect(text).toMatch(/const \[customResult, setCustomResult\]/);
    expect(text).toMatch(/const \[customError, setCustomError\]/);
  });
});
