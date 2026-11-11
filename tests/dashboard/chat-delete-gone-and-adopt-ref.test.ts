/**
 * R4-9: a delete answered 404 removes the stale row and says the
 * conversation no longer exists.
 * R4-12: a follow-up sent in the frame between a turn's finish and the
 * adoption effect still carries the conversation id: the id is held in a
 * ref written where the response header is read, and the body reads it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/components/ChatInterface.tsx", "utf8");

describe("delete answered 404 (R4-9)", () => {
  const handler = sliceBetween(src, "const confirmDeleteConversation = useCallback(", "const answerNoteApproval");
  it("treats 404 as already gone: drops the row and says so", () => {
    const gone = anchorIndex(handler, "const alreadyGone = !result.ok && result.status === 404;");
    const fail = anchorIndex(handler, "if (!result.ok && !alreadyGone) {");
    expect(gone).toBeLessThan(fail);
    anchorIndex(handler, 'if (alreadyGone) toast("That conversation no longer exists.", "info");');
    anchorIndex(handler, "setConversations((list) => list.filter((c) => c.id !== conv.id));");
  });
});

describe("adopted id in a ref (R4-12)", () => {
  it("the transport fetch writes the adopted id where it reads the header", () => {
    const wrapper = sliceBetween(src, "const chatFetch", "new DefaultChatTransport(");
    const header = anchorIndex(wrapper, 'res.headers.get("X-Conversation-Id")');
    const adopt = anchorIndex(wrapper, "if (adopt !== null) conversationIdRef.current = adopt;");
    expect(header).toBeLessThan(adopt);
    anchorIndex(wrapper, "openConversationId: conversationIdRef.current,");
  });
  it("every change to the open conversation goes through one setter that writes the ref", () => {
    const setter = sliceBetween(src, "const openConversation = useCallback(", "}, []);");
    anchorIndex(setter, "conversationIdRef.current = id;");
    anchorIndex(setter, "setConversationId(id);");
    // No other writer of the state.
    expect(src.match(/setConversationId\(/g)).toHaveLength(1);
  });
});
