/**
 * Owner ruling 2026-11-12: inside the chat the owner is the only reader, so
 * the chat no longer takes part in the app-wide privacy toggle. This file
 * pins the owner's OWN text: the typed message and the drafted note on the
 * Save / Don't save card render as written with the toggle on. The approval
 * gate itself is unchanged (pinned in chat-create-note-approval-card.test.ts).
 *
 * No DOM harness in this repo, so these are source pins.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/components/ChatInterface.tsx", "utf8");

describe("the owner's own chat text is never masked (ruling 2026-11-12)", () => {
  it("a typed message renders as written", () => {
    const user = sliceBetween(src, "function renderUserParts(", "// ─── Helper: convert DB messages");
    anchorIndex(user, '<div className="whitespace-pre-wrap">{text}</div>');
    expect(user).not.toMatch(/PrivateText|isPrivate|usePrivacy/);
  });

  it("the drafted note on the approval card renders as written", () => {
    const card = sliceBetween(src, "function NoteApprovalCard(", "// ─── Message rendering");
    anchorIndex(card, '<div className="whitespace-pre-wrap text-sm text-ink mb-3">{view.content}</div>');
    expect(card).not.toMatch(/PrivateText|isPrivate|usePrivacy/);
  });
});
