import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorIndex } from "../helpers/source-anchor";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const HOOK = read("app/dashboard/components/settings/usePreferences.ts");
const PRINTING = read("app/dashboard/components/settings/PrintingPreferences.tsx");
const CAPS = read("app/dashboard/components/settings/ConstructionCapsPreferences.tsx");

describe("Settings preference saves confirm success", () => {
  it("the hook exposes a separate success signal", () => {
    expect(HOOK).toMatch(/saved: boolean;/);
    expect(HOOK).toMatch(/return \{[^}]*\bsaved\b[^}]*\}/);
  });

  it("clears it at the start of save, never sets it on failure, sets it after the early return", () => {
    const start = anchorIndex(HOOK, "async (updates: PreferencesPatch");
    const clear = anchorIndex(HOOK, "setSaved(false)", start);
    const call = anchorIndex(HOOK, "await patchPreferences", start);
    const guard = anchorIndex(HOOK, "if (!result.ok)", start);
    const set = anchorIndex(HOOK, "setSaved(true)", start);
    expect(clear).toBeLessThan(call);
    expect(set).toBeGreaterThan(guard);
    // the failure branch (between the guard and its return) must not set it
    const failureEnd = anchorIndex(HOOK, "return false;", guard);
    expect(set).toBeGreaterThan(failureEnd);
    // success is never written into the error message
    expect(HOOK.match(/setSaved\(true\)/g)).toHaveLength(1);
  });

  for (const [name, src] of [
    ["PrintingPreferences", PRINTING],
    ["ConstructionCapsPreferences", CAPS],
  ] as const) {
    it(`${name} reads the signal and renders a Saved status`, () => {
      expect(src).toMatch(/const \{[^}]*\bsaved\b[^}]*\} = usePreferences\(\)/);
      const at = anchorIndex(src, "{saved &&");
      const block = src.slice(at, at + 300);
      expect(block).toContain('role="status"');
      expect(block).toContain("text-[12px] text-up");
      expect(block).toContain("Saved");
    });
  }
});
