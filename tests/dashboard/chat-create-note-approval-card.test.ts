/**
 * B19 client (Contract C): a drafted note waits for the owner. useChat
 * resends automatically once every approval in the last step has an answer;
 * the card's two buttons answer through addToolApprovalResponse with the
 * CURRENT per-call body (scope, conversation id, page), never the transport.
 *
 * The card's states are pinned as a pure function in
 * tests/chat/turn-adoption.test.ts (noteApprovalView).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/components/ChatInterface.tsx", "utf8");

describe("create_note approval card (Contract C)", () => {
  it("useChat resends when every approval has an answer (additive option only)", () => {
    expect(src).toMatch(
      /import \{[^}]*\blastAssistantMessageIsCompleteWithApprovalResponses\b[^}]*\} from "ai"/,
    );
    anchorIndex(src, "useChat({\n    transport,\n    sendAutomaticallyWhen,\n  });");
    const when = sliceBetween(src, "const sendAutomaticallyWhen = (", "return {");
    anchorIndex(
      when,
      "shouldAutoContinue(\n        lastAssistantMessageIsCompleteWithApprovalResponses({ messages }),\n        turn.autoContinuations,\n      );",
    );
    anchorIndex(when, "if (go) turn.autoContinuations += 1;");
    expect(src.match(/useChat\(/g)).toHaveLength(1);
  });

  it("the answer carries the current per-call body and the denial reason", () => {
    const handler = sliceBetween(src, "const answerNoteApproval = useCallback(", "}, [");
    anchorIndex(handler, "addToolApprovalResponse({");
    anchorIndex(handler, "id: approvalId,");
    anchorIndex(handler, "approved,");
    anchorIndex(handler, 'reason: approved ? undefined : "Owner chose not to save",');
    anchorIndex(handler, "options: { body: currentRequestBody() },");
    anchorIndex(handler, "turn.autoContinuations = 0;");
  });

  it("the card is a module-level component reading noteApprovalView", () => {
    const cardAt = anchorIndex(src, "function NoteApprovalCard(");
    expect(cardAt).toBeLessThan(anchorIndex(src, "export function ChatInterface("));
    anchorIndex(src, "noteApprovalView(part as NoteToolPartView, { inLastMessage: opts.inLastMessage })");
  });

  it("shows the draft with its content through PrivateText, and two buttons", () => {
    const card = sliceBetween(src, "function NoteApprovalCard(", "// ─── Message rendering");
    anchorIndex(card, "<PrivateText>{view.content}</PrivateText>");
    anchorIndex(card, "Save note");
    anchorIndex(card, "Don't save");
    anchorIndex(card, "onClick={() => onAnswer(view.approvalId, true)}");
    anchorIndex(card, "onClick={() => onAnswer(view.approvalId, false)}");
    expect(card.match(/disabled=\{disabled\}/g)).toHaveLength(2);
    // R4-6: at least 36 px targets (44 px on touch).
    expect(card.match(/min-h-9 pointer-coarse:min-h-11/g)).toHaveLength(2);
    anchorIndex(card, "Not saved: ${view.reason}");
    anchorIndex(card, "Save not confirmed");
    anchorIndex(card, "Saving…");
    anchorIndex(card, "Saved");
    anchorIndex(card, "Not saved");
  });

  it("the buttons are disabled while a reply is pending", () => {
    anchorIndex(src, "onNoteAnswer: answerNoteApproval,\n");
    anchorIndex(src, "busy: isStreaming,\n");
  });
});
