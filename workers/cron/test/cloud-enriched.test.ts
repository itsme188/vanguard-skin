import { describe, it, expect } from "vitest";
import {
  cloudEnrichedKey,
  isPayloadComplete,
  isEarningsRow,
  COMPLETE_SETTLE_MS,
} from "../src/cloud-enriched";

const RELEASE = new Date("2026-07-15T20:15:00Z"); // 16:15 ET

describe("cloud-enriched contract", () => {
  it("keys payloads by event id", () => {
    expect(cloudEnrichedKey(42)).toBe("cloud-enriched-42");
  });

  it("earnings predicate mirrors the Mac rule (event_type OR finnhub source_key)", () => {
    expect(isEarningsRow("earnings", "manual:AAPL:2026-07-15:earnings")).toBe(true);
    expect(isEarningsRow("other_macro", "finnhub:AAPL:2026-07-15")).toBe(true);
    expect(isEarningsRow("cpi", "fred:10")).toBe(false);
  });

  it("incomplete: no actual", () => {
    expect(
      isPayloadComplete({ actual: null, reaction: { source: "yahoo" } }, RELEASE, RELEASE.getTime() + 60_000),
    ).toBe(false);
  });

  it("incomplete: deferred actual", () => {
    expect(
      isPayloadComplete({ actual: "EPS 1.00", deferred: true, reaction: null }, RELEASE, RELEASE.getTime() + 60_000),
    ).toBe(false);
  });

  it("complete: actual + reaction", () => {
    expect(
      isPayloadComplete({ actual: "EPS 1.00", reaction: { source: "yahoo" } }, RELEASE, RELEASE.getTime() + 60_000),
    ).toBe(true);
  });

  it("incomplete: actual only, before the 150-min settle", () => {
    expect(
      isPayloadComplete({ actual: "EPS 1.00", reaction: null }, RELEASE, RELEASE.getTime() + COMPLETE_SETTLE_MS - 1),
    ).toBe(false);
  });

  it("complete: actual only, at/after the 150-min settle (reaction window closed)", () => {
    expect(
      isPayloadComplete({ actual: "EPS 1.00", reaction: null }, RELEASE, RELEASE.getTime() + COMPLETE_SETTLE_MS),
    ).toBe(true);
  });
});
