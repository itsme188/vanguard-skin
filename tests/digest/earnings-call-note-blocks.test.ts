import { describe, it, expect } from "vitest";
import {
  renderCallNoteBlock,
  renderPriorCallNoteBlock,
} from "@/lib/digest/send-earnings-email";
import type { EarningsCallNote } from "@/lib/queries/earnings-call-notes";

const NOTE: EarningsCallNote = {
  id: 1,
  event_id: 10,
  security_id: null,
  symbol: "NVDA",
  guidance: "lowered",
  tone: "defensive on China questions",
  surprises: "Gross margin guide below every bogey",
  follow_ups: "Recheck hyperscaler capex commentary next week",
  created_at: "2026-07-08 21:30:00",
  updated_at: "2026-07-08 21:30:00",
};

describe("call note prompt blocks", () => {
  it("recap block states guidance explicitly and includes every filled field", () => {
    const block = renderCallNoteBlock(NOTE);
    expect(block).toContain("## Your call notes");
    expect(block).toContain("guidance: **LOWERED**");
    expect(block).toContain("defensive on China questions");
    expect(block).toContain("Gross margin guide below every bogey");
    expect(block).toContain("Recheck hyperscaler capex commentary");
  });

  it("returns empty string for null note or all-empty note", () => {
    expect(renderCallNoteBlock(null)).toBe("");
    expect(
      renderCallNoteBlock({ ...NOTE, guidance: null, tone: null, surprises: null, follow_ups: null })
    ).toBe("");
  });

  it("preview block uses the prior-quarter framing", () => {
    const block = renderPriorCallNoteBlock(NOTE);
    expect(block).toContain("## Last quarter's call, in your words");
    expect(block).toContain("**LOWERED**");
  });
});
