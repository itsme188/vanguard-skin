import { describe, it, expect } from "vitest";
import { notesListIsFiltered } from "@/app/dashboard/components/NotesView";

describe("notesListIsFiltered (empty-state copy selector)", () => {
  it("a bare tab selection (?type=) is navigation, not a user filter", () => {
    expect(notesListIsFiltered({ search: null, symbol: null, type: "trade_thesis" })).toBe(
      false,
    );
  });

  it("search counts as a user filter", () => {
    expect(notesListIsFiltered({ search: "NVDA", symbol: null, type: null })).toBe(true);
  });

  it("symbol counts as a user filter, including combined with a tab", () => {
    expect(notesListIsFiltered({ search: null, symbol: "AAPL", type: "journal" })).toBe(
      true,
    );
  });

  it("nothing set → not filtered", () => {
    expect(notesListIsFiltered({ search: null, symbol: null, type: null })).toBe(false);
  });
});
