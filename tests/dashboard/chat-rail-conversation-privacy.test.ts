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

describe("ChatInterface conversation titles mask under privacy mode", () => {
  const source = fs.readFileSync(COMPONENT_PATH, "utf8");
  const lines = source.split("\n");

  it("imports PrivateText from the privacy components module", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*PrivateText[^}]*\}\s*from\s*["']@\/lib\/privacy\/components["']/,
    );
  });

  it("finds at least two `conv.title ??` JSX text-node render sites (dropdown + empty state)", () => {
    const textNodeLines = lines.filter(
      (line) => line.includes("conv.title ??") && !isAttributeLine(line),
    );
    expect(textNodeLines.length).toBeGreaterThanOrEqual(2);
  });

  it("wraps every `conv.title ??` JSX text-node render site in <PrivateText>", () => {
    const textNodeLines = lines.filter(
      (line) => line.includes("conv.title ??") && !isAttributeLine(line),
    );
    for (const line of textNodeLines) {
      expect(line).toMatch(TITLE_TEXT_NODE);
    }
  });

  it("does not render a bare unwrapped `{conv.title ?? ...}` text node anywhere", () => {
    const bareTextNode = lines.some((line) => {
      if (isAttributeLine(line)) return false;
      if (!line.includes("conv.title ??")) return false;
      return !TITLE_TEXT_NODE.test(line);
    });
    expect(bareTextNode).toBe(false);
  });

  it("gates the conversation-list item's title= attribute on the privacy flag", () => {
    const line = lines.find(
      (l) => l.includes("title=") && l.includes("conv.title ??") && isAttributeLine(l),
    );
    expect(line, "expected a title= attribute referencing conv.title ??").toBeDefined();
    expect(line).toMatch(/title=\{isPrivate \? `Conversation \$\{conv\.id\}` : /);
  });

  it("gates the delete button's aria-label= attribute on the privacy flag", () => {
    const line = lines.find((l) => l.includes("aria-label=") && l.includes("Delete conversation"));
    expect(line, "expected an aria-label= for the delete button").toBeDefined();
    expect(line).toMatch(/aria-label=\{isPrivate \? `Delete conversation \$\{conv\.id\}` : /);
  });

  it("gates the current-conversation header title= attribute on the privacy flag", () => {
    const line = lines.find((l) => l.includes("title=") && l.includes("displayTitle"));
    expect(line, "expected a title= attribute referencing displayTitle").toBeDefined();
    expect(line).toMatch(/title=\{isPrivate \? "Current conversation" : displayTitle\}/);
  });

  it("wraps the current-conversation header text node in <PrivateText>", () => {
    expect(source).toMatch(/<PrivateText>\{displayTitle\}<\/PrivateText>/);
  });
});
