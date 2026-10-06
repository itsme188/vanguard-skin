/**
 * Source pin: a turn adopts a conversation only when the server said, on that
 * turn's own response, which conversation it created. A first-turn failure
 * before the server creates a row carries no id, so nothing is adopted and
 * Retry posts into a fresh conversation. The id never comes from the
 * conversation list (sorted by last update, shared across devices) or from a
 * clock comparison between the browser and the server.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

const root = join(__dirname, "../..");
const src = readFileSync(join(root, "app/dashboard/components/ChatInterface.tsx"), "utf8");
const route = readFileSync(join(root, "app/api/chat/route.ts"), "utf8");

describe("chat failed-turn conversation adoption", () => {
  it("every chat-route response after the conversation exists names it", () => {
    const created = anchorIndex(
      route,
      'conversationHeaders = { "X-Conversation-Id": String(conversationId) };',
    );
    expect(created).toBeGreaterThan(anchorIndex(route, "createConversation(db, scope)"));
    // Exits after that point: missing key, slot busy, the stream, the catch.
    const after = route.slice(created);
    const exits = after.match(/Response\.json\(|toUIMessageStreamResponse\(/g) ?? [];
    const named = after.match(/headers: conversationHeaders/g) ?? [];
    expect(exits.length).toBe(4);
    expect(named.length).toBe(exits.length);
  });

  it("the transport fetch clears the turn id, then records the response header", () => {
    const wrapper = sliceBetween(src, "const chatFetch", "new DefaultChatTransport(");
    const clear = anchorIndex(wrapper, "turn.conversationId = null");
    const call = anchorIndex(wrapper, "await apiFetch(input, init)");
    const read = anchorIndex(wrapper, 'res.headers.get("X-Conversation-Id")');
    expect(clear).toBeLessThan(call);
    expect(call).toBeLessThan(read);
    anchorIndex(src, 'new DefaultChatTransport({ api: "/api/chat", fetch: chatFetch })');
    // The box and the transport come out of ONE memo, so they cannot drift.
    anchorIndex(src, "const { transport, turn } = useMemo(");
  });

  it("adoption reads only the turn id — never the list head, never a clock", () => {
    const effect = sliceBetween(
      src,
      "const prevStatusRef = useRef(status)",
      "// Auto-scroll on new content",
    );
    anchorIndex(effect, "setConversationId(turn.conversationId)");
    expect(effect).not.toContain("convs[0]");
    expect(src).not.toContain("setConversationId(convs[0].id)");
    expect(src).not.toContain("sendStartedAtRef");
    expect(effect).not.toContain("Date.now()");
  });
});
