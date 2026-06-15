import { describe, it, expect } from "vitest";
import {
  chatPanelWidthPx,
  RAIL_WIDTH_PX,
  EXPANDED_WIDTH_PX,
} from "@/lib/chat/rail-layout";

describe("chatPanelWidthPx", () => {
  it("returns the normal rail width when not expanded", () => {
    expect(chatPanelWidthPx(false)).toBe(RAIL_WIDTH_PX);
    expect(chatPanelWidthPx(false)).toBe(480);
  });

  it("returns the wide width when expanded", () => {
    expect(chatPanelWidthPx(true)).toBe(EXPANDED_WIDTH_PX);
    expect(chatPanelWidthPx(true)).toBe(720);
  });

  it("expanded is wider than normal (the whole point of U2b)", () => {
    expect(EXPANDED_WIDTH_PX).toBeGreaterThan(RAIL_WIDTH_PX);
  });
});
