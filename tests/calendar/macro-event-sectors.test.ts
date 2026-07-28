import { describe, it, expect } from "vitest";
import { macroEventToSectors } from "@/lib/calendar/briefing";
import { GICS_SECTORS } from "@/lib/securities/normalize-sector";
import type { CalendarEvent } from "@/lib/types";

/**
 * Vocabulary-assertion pin: `macroEventToSectors` builds the sector
 * whitelist that `querySymbolsBySectors` matches with an exact `s.sector IN
 * (...)`. `securities.sector` is pure GICS-11 post sector-tag-verification
 * (2026-07-28) — a Bloomberg spelling here ("Consumer, Cyclical",
 * "Financial", "Communications", ...) matches zero rows and silently drops
 * that macro cluster from the Sunday briefing §6. This test enumerates every
 * event shape the function branches on and asserts every sector string it
 * can emit is a member of GICS_SECTORS.
 */

function makeEvent(type: string, title: string): CalendarEvent {
  return {
    id: 1,
    source: "claude_macro",
    event_type: type as CalendarEvent["event_type"],
    event_date: "2026-05-01",
    title,
    source_key: `claude_macro:${type}:2026-05-01`,
  } as CalendarEvent;
}

const GICS_SET = new Set<string>(GICS_SECTORS);

describe("macroEventToSectors — GICS-11 vocabulary pin", () => {
  const cases: { label: string; event: CalendarEvent }[] = [
    { label: "ISM Services", event: makeEvent("pmi", "April ISM Services") },
    { label: "ISM Manufacturing", event: makeEvent("pmi", "April ISM Manufacturing") },
    { label: "FOMC", event: makeEvent("fomc", "FOMC Rate Decision") },
    { label: "CPI", event: makeEvent("cpi", "April CPI") },
    { label: "GDP", event: makeEvent("gdp", "Q1 Advance GDP") },
    { label: "Jobs", event: makeEvent("jobs", "Nonfarm Payrolls") },
    { label: "Housing", event: makeEvent("housing", "Housing Starts") },
    { label: "Retail Sales", event: makeEvent("retail_sales", "Retail Sales") },
    {
      label: "Consumer Confidence",
      event: makeEvent("other_macro", "April Consumer Confidence"),
    },
    { label: "UMich Sentiment", event: makeEvent("other_macro", "UMich Sentiment") },
  ];

  it.each(cases)("$label maps to a non-null mapping with valid sectors", ({ event }) => {
    const mapping = macroEventToSectors(event);
    expect(mapping).not.toBeNull();
    for (const sector of mapping!.sectors) {
      expect(GICS_SET.has(sector)).toBe(true);
    }
  });

  it("every sector string across every mappable event type is GICS-11", () => {
    const allSectors = new Set<string>();
    for (const { event } of cases) {
      const mapping = macroEventToSectors(event);
      if (!mapping) continue;
      for (const sector of mapping.sectors) allSectors.add(sector);
    }
    expect(allSectors.size).toBeGreaterThan(0);
    for (const sector of allSectors) {
      expect(GICS_SET.has(sector)).toBe(true);
    }
  });

  it("unmapped event types return null (earnings, unknown other_macro)", () => {
    expect(macroEventToSectors(makeEvent("earnings", "Some earnings"))).toBeNull();
    expect(macroEventToSectors(makeEvent("other_macro", "Something obscure"))).toBeNull();
  });

  it("GDP is the broad case — empty sectors array, not a vocabulary violation", () => {
    const mapping = macroEventToSectors(makeEvent("gdp", "Q1 Advance GDP"));
    expect(mapping!.sectors).toEqual([]);
  });
});
