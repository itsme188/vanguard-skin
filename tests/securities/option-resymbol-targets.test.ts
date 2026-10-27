import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  OPTION_RESYMBOL_TARGETS,
  resymbolTargetsFrom,
} from "@/lib/securities/option-resymbol-targets";
import { OPTION_RESYMBOL_TARGETS as FROM_SCRIPT } from "@/scripts/repair-mistyped-option-legs";

// SHA-256 of JSON.stringify(OPTION_RESYMBOL_TARGETS) recorded at HEAD before the move.
const RECORDED_HASH = "1fbbe027f6ffc1f47e464c5c69a224ad183fa9d393487a3e8528a2d792fc49d9";

describe("option re-symbol targets", () => {
  it("the moved list is byte-identical", () => {
    const hash = crypto.createHash("sha256").update(JSON.stringify(OPTION_RESYMBOL_TARGETS)).digest("hex");
    expect(hash).toBe(RECORDED_HASH);
  });

  it("the script re-exports the same object", () => {
    expect(FROM_SCRIPT).toBe(OPTION_RESYMBOL_TARGETS);
  });

  it("resymbolTargetsFrom returns exactly the entries with that stored symbol", () => {
    for (const entry of OPTION_RESYMBOL_TARGETS) {
      const expected = OPTION_RESYMBOL_TARGETS.filter((t) => t.fromSymbol === entry.fromSymbol);
      expect(resymbolTargetsFrom(entry.fromSymbol)).toEqual(expected);
      expect(resymbolTargetsFrom(entry.fromSymbol).length).toBeGreaterThan(0);
    }
  });

  it("matches the exact stored symbol only (no trimming, no case change)", () => {
    const from = OPTION_RESYMBOL_TARGETS[0].fromSymbol;
    expect(resymbolTargetsFrom(` ${from}`)).toEqual([]);
    expect(resymbolTargetsFrom(from.toLowerCase())).toEqual([]);
    expect(resymbolTargetsFrom("")).toEqual([]);
  });
});
