import { describe, it, expect } from "vitest";
import {
  decideTurnAdoption,
  noteApprovalView,
  isNearBottom,
  nextFollowBottom,
  AUTO_SCROLL_THRESHOLD_PX,
  stoppedNotice,
  STOPPED_SENTENCE,
  toolIndicatorState,
  showThinking,
  shouldIgnoreStopClick,
  STOP_CLICK_GUARD_MS,
  shouldAutoContinue,
  MAX_AUTO_CONTINUATIONS,
  SUPERSEDED_NOTE_REASON,
  settledAssistantView,
} from "@/lib/chat/turn-adoption";
import { turnOutcomeNotice, CUT_OFF_SENTENCE } from "@/lib/chat/turn-outcome";

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

describe("noteApprovalView in an older message (R4-2)", () => {
  const input = { note_type: "journal", content: "Synthetic" };
  it("a pending draft that is not in the last message shows no buttons", () => {
    expect(
      noteApprovalView(
        { type: "tool-create_note", state: "approval-requested", input, approval: { id: "a" } },
        { inLastMessage: false },
      ),
    ).toEqual({ kind: "not-saved", reason: SUPERSEDED_NOTE_REASON });
    expect(SUPERSEDED_NOTE_REASON).toBe("superseded by a later message");
  });
  it("an approved answer whose continuation never landed is not left Saving forever", () => {
    expect(
      noteApprovalView(
        { type: "tool-create_note", state: "approval-responded", input, approval: { id: "a", approved: true } },
        { inLastMessage: false },
      ),
    ).toEqual({ kind: "unconfirmed" });
  });
  it("finished states read the same in any message", () => {
    expect(
      noteApprovalView(
        { type: "tool-create_note", state: "output-available", input, output: { data: { saved: true } } },
        { inLastMessage: false },
      ),
    ).toEqual({ kind: "saved" });
  });
  it("the last message still asks", () => {
    expect(
      noteApprovalView(
        { type: "tool-create_note", state: "approval-requested", input, approval: { id: "a" } },
        { inLastMessage: true },
      )?.kind,
    ).toBe("ask");
  });
});

describe("a stopped reply settles (R4-3)", () => {
  it("reasoning shows Thinking only while its message is live and streaming", () => {
    expect(showThinking("streaming", true)).toBe(true);
    expect(showThinking("streaming", false)).toBe(false);
    expect(showThinking("done", true)).toBe(false);
  });
  it("a tool stopped mid-call stops pulsing once the message is not live", () => {
    expect(toolIndicatorState("input-streaming", true)).toBe("active");
    expect(toolIndicatorState("input-available", true)).toBe("active");
    expect(toolIndicatorState("input-streaming", false)).toBeNull();
    expect(toolIndicatorState("input-available", false)).toBeNull();
    expect(toolIndicatorState("output-available", true)).toBeNull();
    expect(toolIndicatorState("output-error", false)).toBe("error");
    expect(toolIndicatorState("output-error", true)).toBe("error");
  });
  it("an empty stopped message reads Stopped.", () => {
    expect(STOPPED_SENTENCE).toBe("Stopped.");
    expect(stoppedNotice({ parts: [] })).toBe("Stopped.");
    expect(stoppedNotice({ parts: [{ type: "step-start" }] })).toBe("Stopped.");
    expect(
      stoppedNotice({ parts: [{ type: "step-start" }, { type: "reasoning", text: "hmm", state: "streaming" }] }),
    ).toBe("Stopped.");
    expect(
      stoppedNotice({ parts: [{ type: "tool-query_holdings", state: "input-available" }] }),
    ).toBe("Stopped.");
  });
  it("a message with something to show is not called stopped", () => {
    expect(stoppedNotice({ parts: [{ type: "text", text: "partial answer" }] })).toBeNull();
    expect(stoppedNotice({ parts: [{ type: "tool-query_holdings", state: "output-error" }] })).toBeNull();
    expect(stoppedNotice({ parts: [{ type: "tool-create_note", state: "approval-requested" }] })).toBeNull();
  });
  it("a turn that finished (the server sent a finish reason) is never called stopped", () => {
    expect(stoppedNotice({ parts: [], metadata: { finishReason: "stop" } })).toBeNull();
  });
});

describe("Stop guard after a send (R4-4)", () => {
  it("ignores a Stop click within 400 ms of the send starting", () => {
    expect(STOP_CLICK_GUARD_MS).toBe(400);
    expect(shouldIgnoreStopClick(1000, 1000)).toBe(true);
    expect(shouldIgnoreStopClick(1000, 1399)).toBe(true);
    expect(shouldIgnoreStopClick(1000, 1400)).toBe(false);
  });
  it("never ignores when no send time is recorded", () => {
    expect(shouldIgnoreStopClick(null, 5)).toBe(false);
  });
});

describe("automatic continuation cap (R4-10)", () => {
  it("continues while the SDK says complete and the cap is not reached", () => {
    expect(MAX_AUTO_CONTINUATIONS).toBe(3);
    expect(shouldAutoContinue(true, 0)).toBe(true);
    expect(shouldAutoContinue(true, 2)).toBe(true);
  });
  it("stops at the cap, and never continues when the SDK says not complete", () => {
    expect(shouldAutoContinue(true, 3)).toBe(false);
    expect(shouldAutoContinue(false, 0)).toBe(false);
  });
});

describe("settledAssistantView: a stopped turn versus an errored one", () => {
  const view = (message: { parts: { type: string; text?: string; state?: string }[]; metadata?: unknown }, endedInError: boolean) =>
    settledAssistantView(message, { endedInError, outcomeNotice: turnOutcomeNotice(message) });

  it("owner stop with no content reads Stopped.", () => {
    expect(view({ parts: [{ type: "step-start" }] }, false)).toEqual({ kind: "notice", text: "Stopped." });
  });
  it("an error with no content shows no Stopped. line and no bubble", () => {
    expect(view({ parts: [{ type: "step-start" }] }, true)).toEqual({ kind: "hidden" });
    expect(view({ parts: [] }, true)).toEqual({ kind: "hidden" });
    expect(stoppedNotice({ parts: [] }, { endedInError: true })).toBeNull();
  });
  it("an error after some content shows the content (the error bubble follows it)", () => {
    expect(view({ parts: [{ type: "text", text: "partial" }] }, true)).toEqual({ kind: "parts" });
  });
  it("a cut-off turn shows the cut-off sentence as before", () => {
    expect(view({ parts: [], metadata: { finishReason: "tool-calls" } }, false)).toEqual({
      kind: "notice",
      text: CUT_OFF_SENTENCE,
    });
  });
  it("a turn with content and no error shows its parts", () => {
    expect(view({ parts: [{ type: "text", text: "answer" }], metadata: { finishReason: "stop" } }, false)).toEqual({
      kind: "parts",
    });
  });
});

describe("settledAssistantView: a cut-off notice under written text (RF-7)", () => {
  // The notice is stubbed per the contract: turnOutcomeNotice returns the
  // sentence for a cap finish reason whether or not text exists.
  const cap = { finishReason: "tool-calls" };
  const half = { type: "text", text: "Let me check your lots." };

  it("text + cap: the text, then the notice below it", () => {
    expect(
      settledAssistantView({ parts: [half], metadata: cap }, { endedInError: false, outcomeNotice: CUT_OFF_SENTENCE }),
    ).toEqual({ kind: "parts", trailingNotice: CUT_OFF_SENTENCE });
  });
  it("no text + cap: the notice alone, as before", () => {
    expect(
      settledAssistantView({ parts: [], metadata: cap }, { endedInError: false, outcomeNotice: CUT_OFF_SENTENCE }),
    ).toEqual({ kind: "notice", text: CUT_OFF_SENTENCE });
  });
  it("text + normal finish: parts only", () => {
    expect(
      settledAssistantView({ parts: [half], metadata: { finishReason: "stop" } }, { endedInError: false, outcomeNotice: null }),
    ).toEqual({ kind: "parts" });
  });
  it("text + pending approval: no notice even if one is passed", () => {
    expect(
      settledAssistantView(
        { parts: [half, { type: "tool-create_note", state: "approval-requested" }], metadata: cap },
        { endedInError: false, outcomeNotice: CUT_OFF_SENTENCE },
      ),
    ).toEqual({ kind: "parts" });
  });
  it("a reloaded row whose text already ends with the sentence gets no second line", () => {
    const saved = { type: "text", text: `Let me check your lots.\n\n${CUT_OFF_SENTENCE}` };
    expect(
      settledAssistantView({ parts: [saved] }, { endedInError: false, outcomeNotice: CUT_OFF_SENTENCE }),
    ).toEqual({ kind: "parts" });
    expect(settledAssistantView({ parts: [saved] }, { endedInError: false, outcomeNotice: null })).toEqual({
      kind: "parts",
    });
  });
  it("an errored turn never shows the notice", () => {
    expect(
      settledAssistantView({ parts: [half], metadata: cap }, { endedInError: true, outcomeNotice: CUT_OFF_SENTENCE }),
    ).toEqual({ kind: "parts" });
    expect(
      settledAssistantView({ parts: [], metadata: cap }, { endedInError: true, outcomeNotice: CUT_OFF_SENTENCE }),
    ).toEqual({ kind: "hidden" });
  });
  it("an owner-stopped turn keeps the Stopped. rules", () => {
    expect(settledAssistantView({ parts: [] }, { endedInError: false, outcomeNotice: null })).toEqual({
      kind: "notice",
      text: "Stopped.",
    });
    expect(settledAssistantView({ parts: [half] }, { endedInError: false, outcomeNotice: null })).toEqual({
      kind: "parts",
    });
  });
});
