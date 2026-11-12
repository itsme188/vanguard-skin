/**
 * The chat's model picker on the client (owner-approved 2026-11-13). No DOM
 * harness in this repo, so these are source pins plus the pure label helper;
 * the browser pass covers the look (scratchpad browser-pass/model-picker/).
 *
 *   - Three pills (Haiku, Sonnet, Opus) on the new-chat screen, the scope
 *     bar's own pill (checked gold token, aria-pressed, focus ring), one line.
 *   - Shown only while no conversation exists; Sonnet preselected each time a
 *     new chat starts.
 *   - The class rides in the per-call body (the way scope and page path do),
 *     never in the transport, and only while no conversation exists.
 *   - Once the conversation has a message, a quiet label names the model.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";
import { openConversationModelLabel } from "@/lib/chat/model-choice";

const src = readFileSync("app/dashboard/components/ChatInterface.tsx", "utf8");

describe("the model pills on the new-chat screen", () => {
  const row = sliceBetween(src, "{/* Model class for this conversation", "{/* Conversation history in empty state */}");

  it("render only while no conversation exists, inside the empty state", () => {
    const empty = sliceBetween(src, "{/* Empty state */}", "{/* Message list */}");
    expect(empty).toContain('aria-label="Model for this conversation"');
    const guard = sliceBetween(src, "{/* Model class for this conversation", 'role="group"');
    expect(guard).toContain("{conversationId === null && (");
  });

  it("are one button per class from the shared list, labelled by name", () => {
    anchorIndex(row, "CHAT_MODEL_FAMILIES.map((family) => (");
    anchorIndex(row, "{chatFamilyName(family)}");
    expect(row).not.toMatch(/fable/i);
    expect(row).not.toMatch(/claude-/);
  });

  it("use the scope bar's checked pill: aria-pressed, gold token, focus ring, one line", () => {
    anchorIndex(row, 'type="button"');
    anchorIndex(row, "aria-pressed={modelFamily === family}");
    anchorIndex(row, "border-gold ${CHIP_TONE_TEXT.gold}");
    expect(row).toContain("focus-ring");
    expect(row).toContain("whitespace-nowrap");
    expect(row).toContain("flex-nowrap");
    // No caret and no dropdown (feedback_no_carets).
    expect(row).not.toContain("<svg");
    expect(row).not.toContain("<select");
  });

  it("Sonnet is preselected at mount and again on New Conversation", () => {
    anchorIndex(src, "useState<ChatModelFamily>(DEFAULT_CHAT_MODEL_FAMILY)");
    const fresh = sliceBetween(src, "function handleNewConversation()", "const handleDeleteConversation");
    anchorIndex(fresh, "setModelFamily(DEFAULT_CHAT_MODEL_FAMILY);");
  });
});

describe("the class travels in the per-call body", () => {
  const body = sliceBetween(src, "const currentRequestBody = useCallback(", "[scope, pathname, modelFamily, conversations]");

  it("is the open conversation's known class, or the picker's for a new chat (review item 2)", () => {
    anchorIndex(body, "const family = requestModelFamily(conversations, conversationIdRef.current, modelFamily);");
    anchorIndex(body, "...(family ? { modelFamily: family } : {}),");
    expect(body).not.toContain("turn.");
  });

  it("deleting the open conversation puts the picker back on the default (review item 3)", () => {
    const reset = sliceBetween(src, "if (conv.id === conversationId) {", "await fetchConversations();");
    anchorIndex(reset, "setModelFamily(DEFAULT_CHAT_MODEL_FAMILY);");
  });

  it("is never baked into the transport", () => {
    const transport = sliceBetween(src, "new DefaultChatTransport(", "turn,");
    expect(transport).not.toContain("modelFamily");
  });
});

describe("the label once the conversation has started", () => {
  it("both header copies receive the same label, the stream's until the list row arrives", () => {
    const uses = src.match(
      /modelLabel=\{openConversationModelLabel\(conversations, conversationId, modelFamily, liveModelLabel\(messages\)\)\}/g,
    );
    expect(uses).toHaveLength(2);
  });

  it("sits on its own line under the controls, so the title and New Conversation keep their room (review item 1)", () => {
    const controls = sliceBetween(src, "function ConversationControls(", "// ─── Main component");
    const label = controls.slice(anchorIndex(controls, "{modelLabel && ("));
    const cls = label.match(/className="([^"]*)"/)![1].split(/\s+/);
    for (const c of ["basis-full", "order-last", "truncate", "min-w-0", "text-ink-faint"]) expect(cls).toContain(c);
    expect(cls).not.toContain("shrink-0");
    anchorIndex(label, "title={`Model: ${modelLabel}`}");
    anchorIndex(label, '<span className="sr-only">Model: </span>');
    // The label is outside the left group: it comes after New Conversation.
    expect(anchorIndex(controls, "{modelLabel && (")).toBeGreaterThan(anchorIndex(controls, "New Conversation"));
    // Both header rows wrap, so the label's full-width line goes underneath.
    const phoneRow = sliceBetween(src, "{isLocked && (\n        <div", "<ConversationControls");
    const mdRow = sliceBetween(src, "{isLocked && (\n          <div", "<ConversationControls");
    expect(phoneRow).toMatch(/className="[^"]*\bflex-wrap\b/);
    expect(mdRow).toMatch(/className="[^"]*\bflex-wrap\b/);
  });

  it("reads the server's label for a listed conversation, nothing for one with no class", () => {
    const list = [
      { id: 1, model_label: "Opus 5.5" },
      { id: 2, model_label: null },
      { id: 3, model_label: "Sonnet 5.5 (Opus not available)" },
    ];
    expect(openConversationModelLabel(list, 1, "sonnet", null)).toBe("Opus 5.5");
    expect(openConversationModelLabel(list, 2, "opus", null)).toBeNull();
    expect(openConversationModelLabel(list, 3, "opus", null)).toBe("Sonnet 5.5 (Opus not available)");
  });

  it("names the chosen class while the first turn's row is not listed yet", () => {
    expect(openConversationModelLabel([], null, "haiku", null)).toBe("Haiku");
    expect(openConversationModelLabel([{ id: 1, model_label: "Opus 5.5" }], 9, "opus", null)).toBe("Opus");
  });

  it("prefers the server's resolved label from the stream until the list row arrives (review item 4)", () => {
    expect(openConversationModelLabel([], null, "opus", "Sonnet 5.5 (Opus not available)")).toBe(
      "Sonnet 5.5 (Opus not available)",
    );
    // The list is the later source: once the row is there it wins.
    expect(openConversationModelLabel([{ id: 4, model_label: "Opus 5.5" }], 4, "opus", "Sonnet 5.5")).toBe("Opus 5.5");
    expect(openConversationModelLabel([{ id: 4, model_label: null }], 4, "opus", "Sonnet 5.5")).toBeNull();
  });
});
