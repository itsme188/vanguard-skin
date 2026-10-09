/**
 * QA ledger: mobile-chat--new-conversation-and-picker-scrolled-out-of-reach
 * (owner-ruled 2026-09-02, option 1).
 *
 * The scope pill, the conversation picker and "New Conversation" used to live
 * inside the auto-scrolling transcript, so after a long answer they sat
 * thousands of pixels above the window on a phone. The ruling moves them into
 * the drawer's fixed (non-scrolling) header at phone width, LAYOUT ONLY: the
 * `useChat` wiring is a protected area and must not change by a byte.
 *
 * No DOM harness in this repo, so both halves are source pins:
 *   (a) the chat wiring is byte-identical to the commit this fix was built on;
 *   (b) the controls render before, and outside, the transcript scroller.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const src = readFileSync(
  path.join(process.cwd(), "app/dashboard/components/ChatInterface.tsx"),
  "utf8",
);
const drawer = readFileSync(
  path.join(process.cwd(), "app/dashboard/components/ChatDrawer.tsx"),
  "utf8",
);

// Copied verbatim from `git show HEAD:app/dashboard/components/ChatInterface.tsx`
// (commit 91f9a646) — the transport memo, the destructure and the useChat call.
const USE_CHAT_BLOCK_AT_HEAD = `const { transport, turn } = useMemo(() => {
    // Plain mutable box, written only inside the fetch call (never in render).
    const turn: { conversationId: number | null } = { conversationId: null };
    const chatFetch: ApiFetch = async (input, init) => {
      turn.conversationId = null;
      const res = await apiFetch(input, init);
      const id = Number(res.headers.get("X-Conversation-Id"));
      turn.conversationId = Number.isInteger(id) && id > 0 ? id : null;
      return res;
    };
    return {
      transport: new DefaultChatTransport({ api: "/api/chat", fetch: chatFetch }),
      turn,
    };
  }, []);

  const {
    messages,
    status,
    error,
    sendMessage,
    regenerate,
    setMessages,
    clearError,
    stop,
  } = useChat({ transport });`;

// Re-pinned 2026-10-09 for the owner-approved skip-link fix: the only lines inside
// this region that moved are the new `messagesScrollRef` declaration and the
// body of the auto-scroll effect (container scrollTo instead of scrollIntoView).
// sha256 of everything from `export function ChatInterface(` up to the
// component's `return (` at that same commit: every hook, effect, handler and
// state declaration of the component that owns useChat.
const COMPONENT_LOGIC_SHA256_AT_HEAD =
  "082a23d976b76f449e968f0107d68daadaf526da44a61cd881ba3ebe5e80c81b";

const RETURN_ANCHOR = '\n  return (\n    <div className="flex flex-col';

describe("chat wiring is untouched by the header move", () => {
  it("the transport memo and the useChat call are byte-identical to HEAD", () => {
    const start = anchorIndex(src, "const { transport, turn } = useMemo(() => {");
    const endNeedle = "} = useChat({ transport });";
    const end = anchorIndex(src, endNeedle, start) + endNeedle.length;
    expect(src.slice(start, end)).toBe(USE_CHAT_BLOCK_AT_HEAD);
  });

  it("there is exactly one useChat call and one transport", () => {
    expect(src.match(/useChat\(/g)).toHaveLength(1);
    expect(src.match(/new DefaultChatTransport\(/g)).toHaveLength(1);
  });

  it("every hook, effect and handler of the component is byte-identical to HEAD", () => {
    const start = anchorIndex(src, "export function ChatInterface(");
    const end = anchorIndex(src, RETURN_ANCHOR, start);
    const digest = createHash("sha256").update(src.slice(start, end)).digest("hex");
    expect(digest).toBe(COMPONENT_LOGIC_SHA256_AT_HEAD);
  });

  it("send and retry still pass the per-call body, and submit still goes through handleSubmit", () => {
    expect(src.match(/sendMessage\(\{ text \}, \{ body: requestBody \}\)/g)).toHaveLength(1);
    expect(src.match(/regenerate\(\{ body: requestBody \}\)/g)).toHaveLength(1);
    expect(src.match(/onSubmit=\{handleSubmit\}/g)).toHaveLength(1);
  });

  it("the drawer still mounts ChatInterface once, unconditionally and without a key", () => {
    expect(drawer.match(/<ChatInterface\b/g)).toHaveLength(1);
    expect(drawer).toContain("<ChatInterface pathname={pathname} />");
    const mount = sliceBetween(
      drawer,
      "{/* Chat content — always mounted to preserve conversation */}",
      "<ChatInterface pathname={pathname} />",
    );
    // Nothing between the comment and the mount but one plain wrapper div:
    // no `&&`, no ternary around the element, no key.
    expect(mount).not.toMatch(/&&|key=/);
    expect(mount.match(/<div\b/g)).toHaveLength(1);
  });
});

describe("conversation controls sit in the fixed header at phone width", () => {
  const body = src.slice(anchorIndex(src, RETURN_ANCHOR));
  // The scroller's opening tag starts right after this comment; its
  // aria-label proves the comment still marks the transcript.
  const scroller = anchorIndex(body, "{/* Messages area */}");
  const fixedRow = anchorIndex(body, "{/* Fixed conversation header (phone width)");

  it("the phone-width controls render before the transcript scroller, not inside it", () => {
    expect(fixedRow).toBeLessThan(scroller);
    const row = body.slice(fixedRow, scroller);
    expect(row).toContain("<ConversationControls");
    // Phone only, and it never shrinks or scrolls with the transcript.
    expect(row).toMatch(/className="[^"]*\bmd:hidden\b[^"]*"/);
    expect(row).toMatch(/className="[^"]*\bshrink-0\b[^"]*"/);
    // The scroller is the only overflow-y container, and it opens after the row.
    expect(row).not.toContain("overflow-y-auto");
    const opening = body.slice(scroller, anchorIndex(body, ">", scroller) + 1);
    expect(opening).toContain("overflow-y-auto");
    expect(opening).toContain('aria-label="Chat messages"');
    expect(body.match(/overflow-y-auto/g)).toHaveLength(2); // + the Recent Conversations list
  });

  it("the copy inside the transcript is desktop-only", () => {
    const inScroller = body.slice(scroller, anchorIndex(body, "{/* Empty state */}"));
    expect(inScroller).toContain("<ConversationControls");
    expect(inScroller).toMatch(/className="[^"]*\bhidden md:flex\b[^"]*"/);
    expect(inScroller).not.toMatch(/\bmd:hidden\b/);
  });

  it("the shared controls are the scope pill, the picker and New Conversation", () => {
    const controls = sliceBetween(src, "function ConversationControls(", "// ─── Main component");
    expect(controls).toContain("{scopeLabel}");
    expect(controls).toContain("<ConversationHistory");
    expect(controls).toContain("New Conversation");
    // Both copies are fed by the same props, so they cannot drift apart.
    expect(body.match(/<ConversationControls\b/g)).toHaveLength(2);
    expect(body.match(/onNew=\{handleNewConversation\}/g)).toHaveLength(2);
    expect(body.match(/onSelect=\{loadConversation\}/g)).toHaveLength(2);
    expect(body.match(/onDelete=\{handleDeleteConversation\}/g)).toHaveLength(2);
  });

  it("the controls component is module-level, never defined inside ChatInterface", () => {
    // A component defined in another's body remounts on every render.
    expect(anchorIndex(src, "function ConversationControls(")).toBeLessThan(
      anchorIndex(src, "export function ChatInterface("),
    );
  });
});
