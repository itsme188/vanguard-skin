import { describe, it, expect } from "vitest";
import {
  formatBogeyFields,
  formatBogeyFieldLine,
  BOGEY_FIELD_SEPARATOR,
  type BogeyFieldSource,
} from "@/lib/earnings/format-bogey-fields";

// QA finding today-earningshub-bogeys--stray-leading-separator-no-eps-consensus:
// the EXISTING BOGEYS cards in BogeysEditModal glued the "·" separator onto the
// FRONT of each optional field's own span ("· rev $1.44B"). With eps_consensus
// NULL the card opened with a dangling bullet — "· rev $1.44B · rev whisper
// $1.46B" — and on mobile the Tailwind `space-x-2` margin that supplied the
// only leading space collapsed, rendering "EPS 1.55· whisper".
//
// The fix builds an array of PRESENT fields and joins with " · ", so a
// separator can only ever appear BETWEEN two rendered fields. This repo has no
// React rendering harness (no jsdom / @testing-library/react — see the
// precedent note in tests/dashboard/data-confidence-indicator-privacy.test.ts),
// so the extracted pure helper is what carries the assertions.

const EMPTY = {
  eps_consensus: null,
  eps_whisper: null,
  revenue_consensus_usd: null,
  revenue_whisper_usd: null,
  expected_move_pct: null,
};

describe("formatBogeyFields", () => {
  it("emits no leading separator when eps_consensus is NULL (the QA repro)", () => {
    const line = formatBogeyFieldLine({
      ...EMPTY,
      revenue_consensus_usd: 1_440_000_000,
      revenue_whisper_usd: 1_460_000_000,
    });
    expect(line.startsWith("·")).toBe(false);
    expect(line.trimStart()).toBe(line);
    expect(line).toBe("rev $1.44B · rev whisper $1.46B");
  });

  it("puts real spaces on BOTH sides of every separator (mobile glue repro)", () => {
    const line = formatBogeyFieldLine({
      ...EMPTY,
      eps_consensus: 1.55,
      eps_whisper: 1.62,
    });
    expect(line).toBe("EPS 1.55 · whisper 1.62");
    // No bullet may ever touch a non-space character on either side.
    expect(line).not.toMatch(/\S·/);
    expect(line).not.toMatch(/·\S/);
  });

  it("renders every field, in order, when all are present", () => {
    expect(
      formatBogeyFields({
        eps_consensus: 1.55,
        eps_whisper: 1.62,
        revenue_consensus_usd: 1_440_000_000,
        revenue_whisper_usd: 1_460_000_000,
        expected_move_pct: 7.4,
      }),
    ).toEqual([
      "EPS 1.55",
      "whisper 1.62",
      "rev $1.44B",
      "rev whisper $1.46B",
      "move ±7.4%",
    ]);
  });

  it("returns an empty list (and an empty line) when the bogey has no figures", () => {
    expect(formatBogeyFields(EMPTY)).toEqual([]);
    expect(formatBogeyFieldLine(EMPTY)).toBe("");
  });

  it("never produces a leading, trailing, or doubled separator for ANY field combination", () => {
    const values = {
      eps_consensus: 1.55,
      eps_whisper: 1.62,
      revenue_consensus_usd: 1_440_000_000,
      revenue_whisper_usd: 1_460_000_000,
      expected_move_pct: 7.4,
    };
    const keys = Object.keys(values) as (keyof typeof values)[];

    // All 32 present/absent combinations.
    for (let mask = 0; mask < 1 << keys.length; mask++) {
      const bogey: BogeyFieldSource = { ...EMPTY };
      keys.forEach((k, i) => {
        if (mask & (1 << i)) bogey[k] = values[k];
      });
      const line = formatBogeyFieldLine(bogey);

      expect(line).not.toMatch(/^\s*·/); // no leading separator
      expect(line).not.toMatch(/·\s*$/); // no trailing separator
      expect(line).not.toMatch(/·\s*·/); // no doubled separator
      expect(line).toBe(line.trim()); // no stray edge whitespace

      // Bullet count is always exactly one fewer than the fields shown.
      const fields = formatBogeyFields(bogey);
      const bullets = (line.match(/·/g) ?? []).length;
      expect(bullets).toBe(Math.max(0, fields.length - 1));
    }
  });

  it("treats 0 as a present value, not an absent one", () => {
    // A genuine 0.00 EPS consensus must render — only NULL/undefined drop out.
    expect(formatBogeyFields({ ...EMPTY, eps_consensus: 0 })).toEqual(["EPS 0.00"]);
    expect(formatBogeyFields({ ...EMPTY, expected_move_pct: 0 })).toEqual(["move ±0.0%"]);
  });

  it("exports the separator so the render site cannot re-invent a glued one", () => {
    expect(BOGEY_FIELD_SEPARATOR).toBe(" · ");
  });
});
