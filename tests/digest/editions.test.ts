import { describe, it, expect } from "vitest";
import {
  SOURCE_KINDS,
  sourceKind,
  classifyEdition,
  editionLabel,
} from "@/lib/digest/editions";

// Real subject lines sampled from research_articles, 2026-05-10 → 2026-06-09.
describe("classifyEdition — Vital Knowledge", () => {
  const VK = "Vital Knowledge";
  it.each([
    ["Vital Knowledge: Vital Dawn for Tuesday June 9, 2026", "dawn"],
    ["Vital Knowledge: Company-specific news for Tues 6/9 (BMO) - DBI, DKNG, LE, SAIL", "bmo_news"],
    ["Vital Knowledge: Vital Mid-Day Market Update for Tuesday June 9, 2026", "midday"],
    ["Vital Knowledge: Vital Market Recap for Tuesday June 9, 2026", "recap"],
    ["Vital Knowledge: Company-specific news for Mon 6/8 (AMC) - APLD, AVO, MTN, PRGO", "amc_news"],
    ["Vital Knowledge: Vital Weekend (Sun 6/7/2026) - getting ready for the week ahead", "weekend"],
    ["Vital Knowledge: Vital Catalyst Watch (week of Mon 6/8) - US inflation, ECB/BoC", "catalyst_watch"],
    ["Vital Knowledge: Vital Talking Points – Recap for the Week ended Friday June 5, 2026", "talking_points"],
    ["Vital Knowledge: Iran & tech: thoughts on the Tues market price action", "one_off"],
    ["Vital Knowledge: Blackstone's Gray is bullish on the outlook (growth, inflation)", "one_off"],
  ])("%s → %s", (subject, expected) => {
    expect(classifyEdition(VK, subject).edition).toBe(expected);
  });

  it("supersedence chain: recap ⊐ midday ⊐ dawn", () => {
    expect(classifyEdition(VK, "Vital Knowledge: Vital Market Recap for Monday June 8, 2026").supersedes)
      .toEqual(["midday", "dawn"]);
    expect(classifyEdition(VK, "Vital Knowledge: Vital Mid-Day Market Update for Monday June 8, 2026").supersedes)
      .toEqual(["dawn"]);
    expect(classifyEdition(VK, "Vital Knowledge: Vital Dawn for Monday June 8, 2026").supersedes)
      .toEqual([]);
  });

  // "Talking Points – Recap for the Week" contains the word "Recap" — must NOT match recap.
  it("talking_points is checked before recap", () => {
    expect(
      classifyEdition(VK, "Vital Knowledge: Vital Talking Points – Recap for the Week ended Friday June 5, 2026").edition
    ).toBe("talking_points");
  });
});

describe("classifyEdition — TMT Breakout", () => {
  const TMTB = "TMT Breakout";
  it.each([
    ["TMTB Morning Wrap", "morning_wrap"],
    ["TMTB EOD Wrap", "eod_wrap"],
    ["TMTB EOD Wrap; CRDO HPE First Takes", "eod_wrap"],
    ["TMTB: LITE and SNDK CEOs at Mizuho Conference Key Quotes", "note"],
    ["TMTB: SpaceX (SPCX) Roadshow Webinar Key Quotes", "note"],
  ])("%s → %s", (subject, expected) => {
    expect(classifyEdition(TMTB, subject).edition).toBe(expected);
  });
});

describe("classifyEdition — other sources", () => {
  it("returns standalone with no supersedence", () => {
    const r = classifyEdition("Stratechery Updates", "An Interview with Someone");
    expect(r.edition).toBe("standalone");
    expect(r.supersedes).toEqual([]);
  });
});

describe("SOURCE_KINDS / sourceKind", () => {
  it("classifies the known commentary sources", () => {
    for (const name of [
      "Vital Knowledge", "TMT Breakout", "Purple Drink's Market Musings",
      "Helene Meisler", "Torsten Slok", "TBPN", "James Bulltard", "FundaAI", "JRo's Notes",
    ]) {
      expect(sourceKind(name), name).toBe("commentary");
    }
  });
  it("classifies the known essay sources", () => {
    for (const name of [
      "Stratechery Updates", "The Diff", "MBI Deep Dives", "Semi Doped",
      "Eliant Capital", "Paul Kedrosky", "Sam Ro from TKer", "Liberty's Highlights",
      "BEP Research", "Simon Willison", "Irrational Analysis", "Mobile Dev Memo",
      "Bloomberg Odd Lots", "Northbeam - The Media Buyer", "Consumer Ascent",
      "TickerTrends Research", "Sharp Text", "Emerging AI", "Investing With Martin",
    ]) {
      expect(sourceKind(name), name).toBe("essay");
    }
  });
  it("defaults unknown sources to essay (listed individually, never merged)", () => {
    expect(sourceKind("Some Brand-New Newsletter")).toBe("essay");
  });
  it("every SOURCE_KINDS value is a valid kind", () => {
    for (const v of Object.values(SOURCE_KINDS)) {
      expect(["commentary", "essay"]).toContain(v);
    }
  });
});

describe("editionLabel", () => {
  it("renders a bracketed tag for cyclical editions and empty for standalone/one_off", () => {
    expect(editionLabel("Vital Knowledge", "Vital Knowledge: Vital Market Recap for Tuesday June 9, 2026")).toBe(" [recap]");
    expect(editionLabel("TMT Breakout", "TMTB Morning Wrap")).toBe(" [morning_wrap]");
    expect(editionLabel("Vital Knowledge", "Vital Knowledge: Iran & tech: thoughts")).toBe(" [one-off note]");
    expect(editionLabel("Stratechery Updates", "Anything")).toBe("");
  });
});
