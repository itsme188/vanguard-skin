/**
 * Pure chip helpers moved out of EarningsHub.tsx (a server component that
 * imports the db singleton at module load, so its helpers can't be unit
 * tested directly — [C-17], live print v2 slice A Task 5).
 */
import { describe, it, expect } from "vitest";
import { statusChipClass, statusChipLabel } from "@/app/dashboard/today/status-chip";

describe("statusChipClass", () => {
  it("held", () => {
    expect(statusChipClass("held")).toBe("text-up bg-up/15 border border-up/30");
  });
  it("watchlist", () => {
    expect(statusChipClass("watchlist")).toBe("text-gold-ink bg-gold/15 border border-gold/30");
  });
  it("armed — the existing muted-chip pair (text-ink-dim on bg-raised), not a new tone", () => {
    expect(statusChipClass("armed")).toContain("border-edge-strong");
    expect(statusChipClass("armed")).toContain("text-ink-dim");
    expect(statusChipClass("armed")).toContain("bg-raised");
  });
  it("neither — unchanged from today's string", () => {
    expect(statusChipClass("neither")).toBe("text-ink-faint bg-raised border border-edge");
  });
});

describe("statusChipLabel", () => {
  it("held", () => {
    expect(statusChipLabel("held")).toBe("HELD");
  });
  it("watchlist", () => {
    expect(statusChipLabel("watchlist")).toBe("WATCH");
  });
  it("armed", () => {
    expect(statusChipLabel("armed")).toBe("ARMED");
  });
  it("neither — unchanged from today's string", () => {
    expect(statusChipLabel("neither")).toBe("—");
  });
});
