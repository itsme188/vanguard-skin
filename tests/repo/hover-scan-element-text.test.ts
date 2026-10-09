/**
 * The hover scan (tests/helpers/small-text-scan.ts) used to skip a class
 * string that has a hover FILL but no text colour of its own: its text is
 * coloured "somewhere else". In a `className` template literal that somewhere
 * else is usually the template's own static text, a few characters away:
 *
 *   className={`text-xs text-gold-ink ${active ? "bg-gold/15" : "hover:bg-gold/10"}`}
 *
 * The scan now reads the text colour from the template's always-applied
 * parts, and says so (`textFrom: "element"`). It never borrows a colour from
 * the other arm of a condition: that class is not on the element at the same
 * time.
 */
import { describe, it, expect } from "vitest";
import { hoverFailures, scanHoverChanges } from "@/tests/helpers/small-text-scan";
import { worstRatio } from "@/tests/helpers/tint-pair-scan";

const FLOOR = 4.5;

describe("hover scan: text colour read from the same element", () => {
  it("a nested hover fill takes the text colour of the template's static part", () => {
    const src =
      'const x = <a className={`text-xs text-gold-ink ${on ? "bg-gold/15" : "hover:bg-gold/10"}`} />;';
    const changes = scanHoverChanges(src);
    expect(changes.map((c) => c.hover)).toEqual(["hover:bg-gold/10"]);
    expect(changes[0].textFrom).toBe("element");
    expect(changes[0].hovered.light).toBeCloseTo(worstRatio("light", "bg-gold/10", "text-gold-ink"), 6);
    // 4.34:1 in the light theme: the pair the repo test already calls a failure.
    expect(hoverFailures(src, FLOOR).map((c) => c.hover)).toEqual(["hover:bg-gold/10"]);
  });

  it("a hover fill after an interpolation takes the text colour written before it", () => {
    const src = "const x = <a className={`text-ink-dim ${pad} hover:bg-raised`} />;";
    const [change] = scanHoverChanges(src);
    expect(change.hover).toBe("hover:bg-raised");
    expect(change.textFrom).toBe("element");
    expect(change.hovered.light).toBeCloseTo(worstRatio("light", "bg-raised", "text-ink-dim"), 6);
    expect(change.resting.light).not.toBeNull();
  });

  it("the theme-specific text colour of the element is used per theme", () => {
    const src =
      "const x = <a className={`text-ink [[data-theme=dark]_&]:text-ink-dim ${pad} hover:bg-raised`} />;";
    const [change] = scanHoverChanges(src);
    expect(change.hovered.light).toBeCloseTo(worstRatio("light", "bg-raised", "text-ink"), 6);
    expect(change.hovered.dark).toBeCloseTo(worstRatio("dark", "bg-raised", "text-ink-dim"), 6);
  });

  it("a string with its own text colour is read as before", () => {
    const src = 'const x = <a className={`text-ink ${on ? "text-gold-ink hover:bg-gold/10" : ""}`} />;';
    const [change] = scanHoverChanges(src);
    expect(change.textFrom).toBe("own");
    expect(change.hovered.light).toBeCloseTo(worstRatio("light", "bg-gold/10", "text-gold-ink"), 6);
  });

  it("never borrows from the other arm of a condition", () => {
    const src = 'const x = <a className={on ? "bg-gold text-canvas" : "hover:bg-raised"} />;';
    expect(scanHoverChanges(src)).toEqual([]);
    const nested = 'const y = <a className={`px-2 ${on ? "text-canvas bg-gold" : "hover:bg-raised"}`} />;';
    expect(scanHoverChanges(nested)).toEqual([]);
  });

  it("still skips what it cannot read: a plain string, a constant, a hover state colour", () => {
    expect(scanHoverChanges('const a = "hover:bg-gold/10";')).toEqual([]);
    expect(scanHoverChanges("const b = <a className={`${TONE} hover:bg-gold/10`} />;")).toEqual([]);
    // A colour that only applies while disabled is not the resting text colour.
    expect(
      scanHoverChanges("const c = <a className={`disabled:text-ink-faint ${p} hover:bg-raised`} />;"),
    ).toEqual([]);
  });

  it("a template that is not a className is not an element", () => {
    expect(scanHoverChanges("const d = `text-ink ${p} hover:bg-raised`;")).toEqual([]);
  });

  it("line numbers survive a multi-line template", () => {
    const src = ["<a", "  className={`text-ink-dim", "    ${pad}", "    hover:bg-raised`}", "/>"].join("\n");
    const [change] = scanHoverChanges(src);
    expect(change.line).toBe(4);
  });
});
