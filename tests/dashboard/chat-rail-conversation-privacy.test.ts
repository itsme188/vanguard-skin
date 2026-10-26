/**
 * QA ledger: chat-rail--privacy-mode-leaves-conversation-previews-unmasked
 * (medium). With the header "Hide amounts" privacy toggle on, the dashboard
 * masks portfolio-derived text everywhere via <PrivateText>/<Money>/<Pct>/
 * etc (see CLAUDE.md Privacy section), but the persistent chat rail
 * (app/dashboard/components/ChatInterface.tsx) kept rendering
 * model-generated conversation titles verbatim in three spots: the
 * conversation-history dropdown list, the "Recent Conversations" empty
 * state, and the current-conversation header label. A conversation title
 * can name an account or assert whether a holding is owned, so it is
 * portfolio-derived prose and must be masked like any other.
 *
 * This repo has no React rendering harness (no jsdom/RTL — see the
 * precedent note in tests/dashboard/data-confidence-indicator-privacy.test.ts
 * and tests/dashboard/import-flow-warnings-map-privacy.test.ts), so this
 * scans the component source for the masking idiom instead of rendering it.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const COMPONENT_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/ChatInterface.tsx",
);

// Every line that renders `conv.title ??` as a JSX text child (as opposed to
// inside a `title=`/`aria-label=` string attribute) must show that text
// through <PrivateText>. The two known render sites (dropdown list item,
// "Recent Conversations" empty-state button) render on a single line as
// `<PrivateText>{conv.title ?? `Conversation ${conv.id}`}</PrivateText>`.
const TITLE_TEXT_NODE = /<PrivateText>\s*\{conv\.title \?\? `Conversation \$\{conv\.id\}`\}\s*<\/PrivateText>/;

function isAttributeLine(line: string): boolean {
  // A `title={...}` / `aria-label={...}` assignment that happens to
  // reference `conv.title ??` inside its expression (to pick a neutral
  // fallback in privacy mode) is fine — attributes can't hold a
  // <PrivateText> component. Only bare JSX text children need it.
  return /\b(title|aria-label)=\{[^\n]*conv\.title \?\?/.test(line);
}

describe("ChatInterface conversation titles mask figures only under privacy mode (ruling 2026-10-26)", () => {
  const source = fs.readFileSync(COMPONENT_PATH, "utf8");
  const lines = source.split("\n");

  it("imports displayConversationTitle", () => {
    expect(source).toMatch(/import\s*\{\s*displayConversationTitle\s*\}\s*from\s*["']@\/lib\/chat\/conversation-title["']/);
  });

  it("no line renders a raw conv.title ?? text node or fully masks it", () => {
    expect(lines.filter((l) => l.includes("conv.title ??"))).toEqual([]);
  });

  it("list item title=, row text, delete aria-label, header title and text use the helper", () => {
    expect(source).toMatch(/title=\{displayConversationTitle\(conv\.title, isPrivate\) \?\? `Conversation/);
    expect(source).toMatch(/aria-label=\{`Delete conversation \$\{displayConversationTitle\(conv\.title, isPrivate\)/);
    expect(source).toMatch(/title=\{displayTitle\}/);
    expect(source).toMatch(/<span className="truncate">\{displayTitle\}<\/span>/);
  });
});
