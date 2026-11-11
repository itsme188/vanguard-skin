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

/** The text from the "(" at `open` through its matching ")". */
function balancedCall(text: string, open: number): string {
  expect(text[open]).toBe("(");
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced call");
}

describe("chat failed-turn conversation adoption", () => {
  it("every chat-route response after the conversation exists names it", () => {
    const created = anchorIndex(
      route,
      'conversationHeaders = { "X-Conversation-Id": String(convId) };',
    );
    expect(created).toBeGreaterThan(anchorIndex(route, "createConversation(db, scope)"));
    // Exits after that point: missing key, slot busy, the stream, the catch.
    // Each one is checked on its OWN call text (balanced parentheses), so an
    // exit that loses the header fails here even if another exit names it.
    const after = route.slice(created);
    const exits = [...after.matchAll(/Response\.json\(|toUIMessageStreamResponse\(/g)];
    expect(exits.length).toBe(4);
    for (const exit of exits) {
      const call = balancedCall(after, exit.index! + exit[0].length - 1);
      expect(call, `exit at offset ${exit.index}: ${call.slice(0, 80)}`).toMatch(/\bheaders: conversationHeaders\b/);
    }
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
    anchorIndex(src, "const { transport, turn, sendAutomaticallyWhen } = useMemo(");
  });

  it("adoption reads only the turn id — never the list head, never a clock", () => {
    const effect = sliceBetween(
      src,
      "const prevStatusRef = useRef(status)",
      "// Auto-scroll on new content",
    );
    anchorIndex(effect, "turnConversationId: turn.conversationId,");
    anchorIndex(effect, "openConversation(adopt)");
    // openConversation is the one writer of the open id: state and the ref
    // the request body reads, set together.
    const writer = sliceBetween(src, "const openConversation = useCallback(", "}, []);");
    anchorIndex(writer, "conversationIdRef.current = id;");
    anchorIndex(writer, "setConversationId(id);");
    expect(effect).not.toContain("convs[0]");
    expect(src).not.toContain("setConversationId(convs[0].id)");
    expect(src).not.toContain("sendStartedAtRef");
    expect(effect).not.toContain("Date.now()");
  });

  it("adoption is not behind an await (B17): the id is set before the list refresh", () => {
    const effect = sliceBetween(
      src,
      "const prevStatusRef = useRef(status)",
      "// Auto-scroll on new content",
    );
    const decide = anchorIndex(effect, "decideTurnAdoption({");
    const adopt = anchorIndex(effect, "openConversation(adopt)");
    const refresh = anchorIndex(effect, "void fetchConversations()");
    expect(decide).toBeLessThan(adopt);
    expect(adopt).toBeLessThan(refresh);
    expect(effect.slice(0, adopt)).not.toMatch(/\bawait\b/);
    anchorIndex(effect, "turnGeneration: turn.sentGeneration,");
    anchorIndex(effect, "currentGeneration: turn.generation,");
  });

  it("the transport fetch records the generation its request was sent in", () => {
    const wrapper = sliceBetween(src, "const chatFetch", "new DefaultChatTransport(");
    expect(anchorIndex(wrapper, "turn.sentGeneration = turn.generation;")).toBeLessThan(
      anchorIndex(wrapper, "await apiFetch(input, init)"),
    );
  });

  it("New Conversation, loading one and deleting the open one start a new generation", () => {
    const bump = sliceBetween(src, "const beginNewGeneration = useCallback(", "}, [turn]);");
    anchorIndex(bump, "turn.generation += 1;");
    anchorIndex(bump, "turn.conversationId = null;");
    anchorIndex(sliceBetween(src, "function handleNewConversation()", "const handleDeleteConversation"), "beginNewGeneration();");
    anchorIndex(sliceBetween(src, "const loadConversation = useCallback(", "[setMessages"), "beginNewGeneration();");
    anchorIndex(sliceBetween(src, "if (conv.id === conversationId) {", "await fetchConversations();"), "beginNewGeneration();");
  });

  it("the request body reads state only, never the turn box", () => {
    // Since f5538ee5 the body is built per call and reads the open id from
    // conversationIdRef (written only by openConversation, in step with the
    // state), not from React state directly. What this protects is unchanged:
    // the body never reads the turn box, whose id belongs to the in-flight
    // request.
    const body = sliceBetween(src, "const currentRequestBody = useCallback(", "[scope, pathname]");
    anchorIndex(body, "conversationId: conversationIdRef.current");
    expect(body).not.toContain("turn.");
  });
});
