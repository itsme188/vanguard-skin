import { describe, it, expect } from "vitest";
import {
  turnOutcomeNotice,
  CUT_OFF_SENTENCE,
  OUTPUT_LIMIT_SENTENCE,
  CONTENT_FILTER_SENTENCE,
  assistantRowText,
} from "@/lib/chat/turn-outcome";

// Contract B: the sentence shown (and saved) for a turn with no written reply.

const toolDone = { type: "tool-query_holdings", state: "output-available" };

describe("turnOutcomeNotice", () => {
  it("a turn cut off at the step limit gets the cut-off sentence", () => {
    expect(turnOutcomeNotice({ parts: [toolDone], metadata: { finishReason: "tool-calls", stepCount: 8 } })).toBe(
      CUT_OFF_SENTENCE,
    );
  });

  it("the output limit and a refusal each get their own sentence", () => {
    expect(turnOutcomeNotice({ parts: [], metadata: { finishReason: "length" } })).toBe(OUTPUT_LIMIT_SENTENCE);
    expect(turnOutcomeNotice({ parts: [], metadata: { finishReason: "content-filter" } })).toBe(
      CONTENT_FILTER_SENTENCE,
    );
  });

  // RF-7: interim narration before a tool call is the usual shape of a
  // cut-off turn; the notice is shown below the text, not instead of it.
  it("text then a tool call at the step limit still yields the notice (live message)", () => {
    expect(
      turnOutcomeNotice({
        parts: [{ type: "text", text: "Let me check your lots." }, toolDone],
        metadata: { finishReason: "tool-calls", stepCount: 8 },
      }),
    ).toBe(CUT_OFF_SENTENCE);
    expect(
      turnOutcomeNotice({ parts: [{ type: "text", text: "Partial." }], metadata: { finishReason: "length" } }),
    ).toBe(OUTPUT_LIMIT_SENTENCE);
  });

  it("a reloaded text-only message has no metadata, so no second notice", () => {
    expect(
      turnOutcomeNotice({ parts: [{ type: "text", text: `Let me check your lots.\n\n${CUT_OFF_SENTENCE}` }] }),
    ).toBeNull();
  });

  it("a normal multi-step answer yields no notice", () => {
    expect(
      turnOutcomeNotice({
        parts: [{ type: "text", text: "Checking." }, toolDone, { type: "text", text: "Here is the answer." }],
        metadata: { finishReason: "stop", stepCount: 2 },
      }),
    ).toBeNull();
  });

  it("a pending approval card with text yields no notice", () => {
    expect(
      turnOutcomeNotice({
        parts: [{ type: "text", text: "Here is the draft." }, { type: "tool-create_note", state: "approval-requested" }],
        metadata: { finishReason: "tool-calls" },
      }),
    ).toBeNull();
  });

  it("whitespace-only text still counts as empty", () => {
    expect(turnOutcomeNotice({ parts: [{ type: "text", text: "  \n" }], metadata: { finishReason: "length" } })).toBe(
      OUTPUT_LIMIT_SENTENCE,
    );
  });

  it("a pending approval card means no notice", () => {
    expect(
      turnOutcomeNotice({
        parts: [{ type: "tool-create_note", state: "approval-requested" }],
        metadata: { finishReason: "tool-calls" },
      }),
    ).toBeNull();
    expect(
      turnOutcomeNotice({
        parts: [{ type: "dynamic-tool", state: "approval-requested" }],
        metadata: { finishReason: "tool-calls" },
      }),
    ).toBeNull();
  });

  it("a normal stop, unknown reason, or no metadata means no notice", () => {
    expect(turnOutcomeNotice({ parts: [], metadata: { finishReason: "stop" } })).toBeNull();
    expect(turnOutcomeNotice({ parts: [], metadata: { finishReason: "other" } })).toBeNull();
    expect(turnOutcomeNotice({ parts: [] })).toBeNull();
    expect(turnOutcomeNotice({ parts: [], metadata: null })).toBeNull();
    expect(turnOutcomeNotice({ parts: [], metadata: "tool-calls" })).toBeNull();
  });
});


describe("assistantRowText (the saved assistant row, B11)", () => {
  const step = (text: string, content: { type: string }[] = []) => ({ text, content });

  it("text then a tool call at the step limit saves the text and the cut-off sentence (RF-7)", () => {
    expect(
      assistantRowText([step("Let me check your lots.", [{ type: "tool-call" }]), step("", [{ type: "tool-call" }])], "tool-calls"),
    ).toBe(`Let me check your lots.\n\n${CUT_OFF_SENTENCE}`);
    expect(assistantRowText([step("Partial answer")], "length")).toBe(`Partial answer\n\n${OUTPUT_LIMIT_SENTENCE}`);
    expect(assistantRowText([step("Partial")], "content-filter")).toBe(`Partial\n\n${CONTENT_FILTER_SENTENCE}`);
  });

  it("a normal multi-step answer gets no appended sentence", () => {
    expect(assistantRowText([step("Checking.", [{ type: "tool-call" }]), step("Done.")], "stop")).toBe("Checking.\n\nDone.");
  });

  it("joins every step's non-empty text with a blank line", () => {
    expect(assistantRowText([step("Before."), step(""), step("After.")], "stop")).toBe("Before.\n\nAfter.");
  });

  it("an empty turn that ended on tool calls saves the cut-off sentence", () => {
    expect(assistantRowText([step(""), step("  ")], "tool-calls")).toBe(CUT_OFF_SENTENCE);
    expect(assistantRowText([step("")], "length")).toBe(OUTPUT_LIMIT_SENTENCE);
    expect(assistantRowText([step("")], "content-filter")).toBe(CONTENT_FILTER_SENTENCE);
  });

  it("an empty turn waiting for approval saves nothing", () => {
    expect(assistantRowText([step("", [{ type: "tool-call" }, { type: "tool-approval-request" }])], "tool-calls")).toBeNull();
  });

  it("text written before an approval request is still saved", () => {
    expect(assistantRowText([step("Here is the draft.", [{ type: "tool-approval-request" }])], "tool-calls")).toBe(
      "Here is the draft.",
    );
  });

  it("an empty normal stop saves nothing", () => {
    expect(assistantRowText([], "stop")).toBeNull();
  });
});
