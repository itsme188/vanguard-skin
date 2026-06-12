/**
 * Tests for workers/cron/src/enrich-actuals.ts::formatFredValue — the
 * Worker mirror of lib/calendar/enrich-actuals.ts. Cases are identical to
 * tests/calendar/enrich-actuals.test.ts (Mac side) so the two formatters
 * can never drift: same observation in, same rendered string out.
 *
 * Values are REAL FRED observations (verified live 2026-06-11). The
 * 2026-06-11 deep-QA sweep caught the old `level_k` formatter appending
 * "K" to raw-count series and rendering deltas for level-quoted series.
 */

import { describe, it, expect } from "vitest";
import { formatFredValue, RELEASE_ID_TO_SERIES } from "../src/enrich-actuals";

const obs = (value: number, priorValue: number | null = null) => ({
  value,
  date: "2026-06-06",
  priorValue,
  priorYearValue: null as number | null,
});

describe("formatFredValue — count/level semantics (Worker mirror)", () => {
  it("renders Initial Claims as the LEVEL in K (raw-count series)", () => {
    expect(formatFredValue(obs(229000, 225000), { formatAs: "level_count", unitScale: 1 }))
      .toBe("229K");
  });

  it("renders Existing Home Sales as the level in M (raw-count series)", () => {
    expect(formatFredValue(obs(4170000, 4040000), { formatAs: "level_count", unitScale: 1 }))
      .toBe("4.17M");
  });

  it("scales thousands-denominated levels to M (Housing Starts)", () => {
    expect(formatFredValue(obs(1465, 1507), { formatAs: "level_count", unitScale: 1000 }))
      .toBe("1.47M");
  });

  it("keeps sub-million thousands-denominated levels in K (New Home Sales)", () => {
    expect(formatFredValue(obs(622, 663), { formatAs: "level_count", unitScale: 1000 }))
      .toBe("622K");
  });

  it("renders JOLTS openings as the level in M", () => {
    expect(formatFredValue(obs(7618, 6887), { formatAs: "level_count", unitScale: 1000 }))
      .toBe("7.62M");
  });

  it("renders payrolls as a signed monthly delta in K (delta convention)", () => {
    expect(formatFredValue(obs(159001, 158829), { formatAs: "delta_k", unitScale: 1000 }))
      .toBe("+172K");
  });

  it("renders negative payroll deltas with a minus sign", () => {
    expect(formatFredValue(obs(158650, 158829), { formatAs: "delta_k", unitScale: 1000 }))
      .toBe("-179K");
  });

  it("renders raw-persons delta series in K (monthly ADP)", () => {
    expect(formatFredValue(obs(134500000, 134458000), { formatAs: "delta_k", unitScale: 1 }))
      .toBe("+42K");
  });

  it("returns null for delta_k with no prior observation (never a bare level)", () => {
    expect(formatFredValue(obs(159001, null), { formatAs: "delta_k", unitScale: 1000 }))
      .toBeNull();
  });

  it("renders trade balance in signed $B (millions-of-dollars series)", () => {
    expect(formatFredValue(obs(-55881, -56585), { formatAs: "usd_millions" }))
      .toBe("-$55.9B");
  });
});

describe("RELEASE_ID_TO_SERIES — units-verified config (Worker mirror)", () => {
  it("pins ICSA as a level-quoted raw-count series", () => {
    expect(RELEASE_ID_TO_SERIES[180]).toEqual({
      seriesId: "ICSA", formatAs: "level_count", unitScale: 1,
    });
  });

  it("uses the MONTHLY ADP series (weekly raw series can't produce the headline)", () => {
    expect(RELEASE_ID_TO_SERIES[194].seriesId).toBe("ADPMNUSNERSA");
    expect(RELEASE_ID_TO_SERIES[194].formatAs).toBe("delta_k");
  });

  it("pins trade balance as millions-of-USD", () => {
    expect(RELEASE_ID_TO_SERIES[51].formatAs).toBe("usd_millions");
  });
});
