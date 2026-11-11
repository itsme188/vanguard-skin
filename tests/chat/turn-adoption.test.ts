import { describe, it, expect } from "vitest";
import {
  decideTurnAdoption,
  noteApprovalView,
  isNearBottom,
  nextFollowBottom,
  AUTO_SCROLL_THRESHOLD_PX,
} from "@/lib/chat/turn-adoption";

describe("decideTurnAdoption (B17)", () => {
  it("adopts the server's id for a first turn in the same generation", () => {
    expect(
      decideTurnAdoption({
        openConversationId: null,
        turnConversationId: 41,
        turnGeneration: 3,
        currentGeneration: 3,
      }),
    ).toBe(41);
  });

  it("a late header after New Conversation is not adopted", () => {
    // The turn was sent in generation 3; New Conversation bumped it to 4.
    expect(
      decideTurnAdoption({
        openConversationId: null,
        turnConversationId: 41,
        turnGeneration: 3,
        currentGeneration: 4,
      }),
    ).toBeNull();
  });

  it("failure without a header adopts nothing", () => {
    expect(
      decideTurnAdoption({
        openConversationId: null,
        turnConversationId: null,
        turnGeneration: 2,
        currentGeneration: 2,
      }),
    ).toBeNull();
  });

  it("a turn that never sent (no generation recorded) adopts nothing", () => {
    expect(
      decideTurnAdoption({
        openConversationId: null,
        turnConversationId: 9,
        turnGeneration: null,
        currentGeneration: 0,
      }),
    ).toBeNull();
  });

  it("the open id is kept when the server named the same one", () => {
    expect(
      decideTurnAdoption({
        openConversationId: 7,
        turnConversationId: 7,
        turnGeneration: 1,
        currentGeneration: 1,
      }),
    ).toBeNull();
  });

  it("a replacement id from the server (the open one was deleted) is adopted", () => {
    expect(
      decideTurnAdoption({
        openConversationId: 7,
        turnConversationId: 12,
        turnGeneration: 1,
        currentGeneration: 1,
      }),
    ).toBe(12);
  });
});

describe("noteApprovalView (B19, Contract C)", () => {
  const input = {
    note_type: "journal",
    content: "Synthetic thesis text",
    symbol: "ZZZT",
    event_date: "2026-01-02",
  };

  it("a pending approval asks with the drafted note", () => {
    const v = noteApprovalView({
      type: "tool-create_note",
      state: "approval-requested",
      input,
      approval: { id: "ap-1" },
    });
    expect(v).toEqual({
      kind: "ask",
      approvalId: "ap-1",
      noteType: "journal",
      content: "Synthetic thesis text",
      symbol: "ZZZT",
      eventDate: "2026-01-02",
    });
  });

  it("an approved response waiting for the server reads Saving", () => {
    expect(
      noteApprovalView({
        type: "tool-create_note",
        state: "approval-responded",
        input,
        approval: { id: "ap-1", approved: true },
      }),
    ).toEqual({ kind: "saving" });
  });

  it("a denied response reads Not saved", () => {
    expect(
      noteApprovalView({
        type: "tool-create_note",
        state: "approval-responded",
        input,
        approval: { id: "ap-1", approved: false },
      }),
    ).toEqual({ kind: "not-saved" });
    expect(
      noteApprovalView({
        type: "tool-create_note",
        state: "output-denied",
        input,
        approval: { id: "ap-1", approved: false },
      }),
    ).toEqual({ kind: "not-saved" });
  });

  it("Saved only when the output says data.saved === true", () => {
    expect(
      noteApprovalView({
        type: "tool-create_note",
        state: "output-available",
        input,
        output: { data: { saved: true, note: { id: 1 } } },
      }),
    ).toEqual({ kind: "saved" });
    expect(
      noteApprovalView({
        type: "tool-create_note",
        state: "output-available",
        input,
        output: { data: { saved: true, note: { id: 1 }, duplicate_of_existing: true } },
      }),
    ).toEqual({ kind: "saved" });
  });

  it("an error output reads Not saved with the error", () => {
    expect(
      noteApprovalView({
        type: "tool-create_note",
        state: "output-available",
        input,
        output: { error: "Unknown note type. Nothing was saved." },
      }),
    ).toEqual({ kind: "not-saved", reason: "Unknown note type. Nothing was saved." });
    expect(
      noteApprovalView({
        type: "tool-create_note",
        state: "output-error",
        input,
        errorText: "Tool execution failed",
      }),
    ).toEqual({ kind: "not-saved", reason: "Tool execution failed" });
  });

  it("an output with neither saved nor error is never called Saved", () => {
    expect(
      noteApprovalView({
        type: "tool-create_note",
        state: "output-available",
        input,
        output: { data: {} },
      }),
    ).toEqual({ kind: "not-saved" });
  });

  it("other tools and streaming input are not cards", () => {
    expect(
      noteApprovalView({ type: "tool-query_notes", state: "approval-requested", input, approval: { id: "x" } }),
    ).toBeNull();
    expect(noteApprovalView({ type: "tool-create_note", state: "input-streaming", input })).toBeNull();
    expect(noteApprovalView({ type: "tool-create_note", state: "input-available", input })).toBeNull();
  });

  it("a malformed draft still asks, with empty fields rather than a throw", () => {
    const v = noteApprovalView({
      type: "tool-create_note",
      state: "approval-requested",
      input: { content: 42 },
      approval: { id: "ap-2" },
    });
    expect(v).toEqual({
      kind: "ask",
      approvalId: "ap-2",
      noteType: null,
      content: "",
      symbol: null,
      eventDate: null,
    });
  });
});

describe("isNearBottom (B21)", () => {
  it("uses an 80 px threshold", () => {
    expect(AUTO_SCROLL_THRESHOLD_PX).toBe(80);
  });
  it("true at the bottom and within 80 px of it", () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 520, clientHeight: 400 })).toBe(true);
  });
  it("false when the reader has scrolled further up", () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 519, clientHeight: 400 })).toBe(false);
    expect(isNearBottom({ scrollHeight: 3000, scrollTop: 0, clientHeight: 400 })).toBe(false);
  });
});

describe("nextFollowBottom (B21)", () => {
  it("near the bottom always follows", () => {
    expect(nextFollowBottom(false, { scrollHeight: 1000, scrollTop: 560, clientHeight: 400 }, 700)).toBe(true);
  });
  it("a reader scrolling up stops following", () => {
    expect(nextFollowBottom(true, { scrollHeight: 2000, scrollTop: 900, clientHeight: 400 }, 1000)).toBe(false);
  });
  it("a programmatic smooth scroll moving down never stops following", () => {
    // Mid-animation the list is still far from the bottom, but it moved down.
    expect(nextFollowBottom(true, { scrollHeight: 4000, scrollTop: 1200, clientHeight: 400 }, 1000)).toBe(true);
  });
  it("moving down while not following keeps not following until near the bottom", () => {
    expect(nextFollowBottom(false, { scrollHeight: 4000, scrollTop: 1200, clientHeight: 400 }, 1000)).toBe(false);
  });
});
