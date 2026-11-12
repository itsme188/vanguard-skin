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

describe("the class travels in the per-call body, only before a conversation exists", () => {
  const body = sliceBetween(src, "const currentRequestBody = useCallback(", "[scope, pathname, modelFamily]");

  it("is spread in only while conversationIdRef is empty", () => {
    anchorIndex(body, "...(conversationIdRef.current === null ? { modelFamily } : {}),");
    expect(body).not.toContain("turn.");
  });

  it("is never baked into the transport", () => {
    const transport = sliceBetween(src, "new DefaultChatTransport(", "turn,");
    expect(transport).not.toContain("modelFamily");
  });
});

describe("the label once the conversation has started", () => {
  it("both header copies receive the same label", () => {
    const uses = src.match(/modelLabel=\{openConversationModelLabel\(conversations, conversationId, modelFamily\)\}/g);
    expect(uses).toHaveLength(2);
    const controls = sliceBetween(src, "function ConversationControls(", "// ─── Main component");
    anchorIndex(controls, "{modelLabel && (");
    expect(controls).toContain("text-ink-faint");
  });

  it("reads the server's label for a listed conversation, nothing for one with no class", () => {
    const list = [
      { id: 1, model_label: "Opus 5.5" },
      { id: 2, model_label: null },
      { id: 3, model_label: "Sonnet 5.5 (Opus not available)" },
    ];
    expect(openConversationModelLabel(list, 1, "sonnet")).toBe("Opus 5.5");
    expect(openConversationModelLabel(list, 2, "opus")).toBeNull();
    expect(openConversationModelLabel(list, 3, "opus")).toBe("Sonnet 5.5 (Opus not available)");
  });

  it("names the chosen class while the first turn's row is not listed yet", () => {
    expect(openConversationModelLabel([], null, "haiku")).toBe("Haiku");
    expect(openConversationModelLabel([{ id: 1, model_label: "Opus 5.5" }], 9, "opus")).toBe("Opus");
  });
});
