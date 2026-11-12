/**
 * Chat rail conversation titles and the privacy toggle.
 *
 * History: a QA finding (chat-rail--privacy-mode-leaves-conversation-
 * previews-unmasked) masked titles in privacy mode; rulings 2026-10-26 and
 * 2026-11-07 narrowed that to figures only. Owner ruling 2026-11-12
 * supersedes both: inside the chat the owner is the only reader, so the chat
 * no longer takes part in the app-wide toggle and titles show as stored.
 * The toggle still masks portfolio figures everywhere else in the app.
 *
 * No React rendering harness in this repo, so this scans the source.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const COMPONENT_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/ChatInterface.tsx",
);

describe("ChatInterface conversation titles are not masked (ruling 2026-11-12)", () => {
  const source = fs.readFileSync(COMPONENT_PATH, "utf8");

  it("does not import a title-masking helper", () => {
    expect(source).not.toMatch(/displayConversationTitle|maskTitleFigures/);
  });

  it("list item title=, row text, delete aria-label, header title and text show the stored title", () => {
    expect(source).toMatch(/title=\{conv\.title \?\? `Conversation/);
    expect(source).toMatch(/aria-label=\{`Delete conversation \$\{conv\.title \?\? conv\.id\}`\}/);
    expect(source).toMatch(/title=\{displayTitle\}/);
    expect(source).toMatch(/<span className="truncate">\{displayTitle\}<\/span>/);
  });
});
