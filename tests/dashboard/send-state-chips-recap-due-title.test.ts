import { describe, it, expect } from "vitest";
import { stageChips } from "@/app/dashboard/today/hub-live/send-state-chips";
import type { CockpitRowWire } from "@/app/dashboard/today/hub-live/types";

type Stages = CockpitRowWire["stages"];

const row = (actual: Stages["actual"], recap: string): CockpitRowWire =>
  ({
    eventId: 1, symbol: "AAA", securityId: null, title: "AAA Q3", eventDate: "2026-09-10",
    eventTime: "AMC", releaseTime: "16:05", symbolStatus: "armed", consensus: "EPS 1.00", actual: null,
    stages: {
      preview: "sent",
      released: { state: "released", releaseInstant: "2026-09-10T20:05:00.000Z" },
      actual,
      reaction: { state: "pending", source: null, readyAt: null },
      recap,
    },
    netExposure: 0, isTopExposure: false, hasCallNote: false, carryover: false, intel: null,
  }) as unknown as CockpitRowWire;

const recapChip = (r: CockpitRowWire) => stageChips(r).find((c) => c.key === "recap")!;

describe("recap chip tooltip when the recap is waiting", () => {
  it("says due, not sent yet when the figures are captured", () => {
    const c = recapChip(row("captured", "waiting"));
    expect(c.title).toBe("Recap email: due, not sent yet");
    expect(c.title).not.toContain("waiting for the reported figures");
  });
  it("says due, not sent yet when the figures are captured but flagged", () => {
    expect(recapChip(row("implausible", "waiting")).title).toBe("Recap email: due, not sent yet");
  });
  it("still blames missing figures when the actual is pending", () => {
    expect(recapChip(row("pending", "waiting")).title).toContain("waiting for the reported figures");
  });
  it("still blames missing figures when the actual is blocked", () => {
    expect(recapChip(row("blocked", "waiting")).title).toContain("waiting for the reported figures");
  });
  it("leaves a sent recap alone", () => {
    expect(recapChip(row("captured", "sent")).title).toBe("Recap email: sent");
  });
});
