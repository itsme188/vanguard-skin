import { describe, it, expect } from "vitest";
import * as worker from "../src/editions";
import * as mac from "../../../lib/digest/editions";

describe("editions parity (Worker mirror of lib/digest/editions.ts)", () => {
  it("SOURCE_KINDS tables are identical", () => {
    expect(worker.SOURCE_KINDS).toEqual(mac.SOURCE_KINDS);
  });

  it("classifyEdition agrees on a representative subject set", () => {
    const cases: Array<[string, string]> = [
      ["Vital Knowledge", "Vital Knowledge: Vital Dawn for Tuesday June 9, 2026"],
      ["Vital Knowledge", "Vital Knowledge: Vital Mid-Day Market Update for Tuesday June 9, 2026"],
      ["Vital Knowledge", "Vital Knowledge: Vital Market Recap for Tuesday June 9, 2026"],
      ["Vital Knowledge", "Vital Knowledge: Vital Talking Points – Recap for the Week ended Friday June 5, 2026"],
      ["Vital Knowledge", "Vital Knowledge: Company-specific news for Tues 6/9 (BMO) - DBI"],
      ["Vital Knowledge", "Vital Knowledge: Company-specific news for Mon 6/8 (AMC) - APLD"],
      ["Vital Knowledge", "Vital Knowledge: Iran & tech: thoughts"],
      ["TMT Breakout", "TMTB Morning Wrap"],
      ["TMT Breakout", "TMTB EOD Wrap; CRDO HPE First Takes"],
      ["TMT Breakout", "TMTB: Conference Key Quotes"],
      ["Stratechery Updates", "An Interview"],
    ];
    for (const [src, subj] of cases) {
      expect(worker.classifyEdition(src, subj)).toEqual(mac.classifyEdition(src, subj));
      expect(worker.editionLabel(src, subj)).toBe(mac.editionLabel(src, subj));
    }
  });
});
