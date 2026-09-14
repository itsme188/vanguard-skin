/**
 * Source-pin regression guard for finding
 * `research-notes--privacy-leaves-note-prose-unmasked` (nightly deep-QA,
 * MEDIUM). With the header "Hide amounts" privacy toggle ON, every table on
 * Accounts/Today/Charts and the chat rail mask portfolio-derived numbers,
 * but `NotesView.tsx`'s read-mode note body rendered `{note.content}` raw —
 * so a note like "sold 35 of my 50 shares at 352" stayed in the clear next
 * to masked figures everywhere else. The project convention (CLAUDE.md,
 * Privacy) is "Wrap AI prose in <PrivateText>"; the already-fixed sibling is
 * `app/dashboard/alerts/page.tsx` (`Note: <PrivateText>{alert.user_response_note}</PrivateText>`).
 *
 * This repo has no DOM test harness (no jsdom, no React Testing Library —
 * see reference_no_dom_test_harness_source_pin.md), so pinning "the read-mode
 * note body is masked when privacy is on" cannot be done by rendering the
 * component and toggling a context provider. Instead this is a SOURCE PIN,
 * in the style of tests/repo/hub-live-client-boundary.test.ts and
 * tests/repo/no-handrolled-latest-holdings.test.ts: it reads NotesView.tsx's
 * text and asserts (a) it imports `PrivateText` from
 * `@/lib/privacy/components`, and (b) the read-mode content paragraph's
 * child is `<PrivateText>{note.content}</PrivateText>` rather than the bare
 * expression. The regex is whitespace/newline-tolerant so reformatting the
 * JSX doesn't make this test a false negative.
 *
 * Editing mode is deliberately NOT covered here: opening a note for editing
 * is an explicit reveal (the textarea's `value={editContent}` is meant to
 * show the real text so the user can edit it), matching how the alerts page
 * and every other privacy-gated editor in this repo works.
 *
 * A landing review of the same fix (commit 99c1aeb7) found one more bare
 * render of the same shape: `app/dashboard/security/[id]/page.tsx`'s notes
 * block rendered `{note.content}` raw in a `line-clamp-2` paragraph. That
 * page is a server component, but `PrivateText` is a client component and
 * is fine to render from one, so the fix is the identical
 * `<PrivateText>{note.content}</PrivateText>` wrap. The second describe
 * block below pins that file the same way.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SOURCE_PATH = path.join(
  process.cwd(),
  "app",
  "dashboard",
  "components",
  "NotesView.tsx",
);

const SECURITY_PAGE_SOURCE_PATH = path.join(
  process.cwd(),
  "app",
  "dashboard",
  "security",
  "[id]",
  "page.tsx",
);

function readSource(): string {
  return fs.readFileSync(SOURCE_PATH, "utf8");
}

function readSecurityPageSource(): string {
  return fs.readFileSync(SECURITY_PAGE_SOURCE_PATH, "utf8");
}

describe("NotesView masks note prose under the privacy toggle", () => {
  it("imports PrivateText from @/lib/privacy/components", () => {
    const source = readSource();
    const importRe =
      /import\s*\{[^}]*\bPrivateText\b[^}]*\}\s*from\s*["']@\/lib\/privacy\/components["']/;
    expect(
      importRe.test(source),
      "NotesView.tsx must import PrivateText from @/lib/privacy/components",
    ).toBe(true);
  });

  it("wraps the read-mode note body in <PrivateText>, not a bare {note.content}", () => {
    const source = readSource();

    // The read-mode paragraph: `<p ... whitespace-pre-wrap ...> ... </p>`,
    // tolerant of attribute order/whitespace and of newlines between the
    // opening tag, the child expression, and the closing tag.
    const paragraphRe =
      /<p\s+className="[^"]*whitespace-pre-wrap[^"]*">\s*([\s\S]*?)\s*<\/p>/;
    const match = source.match(paragraphRe);
    expect(
      match,
      "expected to find the read-mode note-body <p className=\"...whitespace-pre-wrap...\"> in NotesView.tsx",
    ).not.toBeNull();

    // Strip any JSX comments ({/* ... */}) before comparing — the fix adds
    // an explanatory one directly above the PrivateText wrapper.
    const child = match![1].replace(/\{\/\*[\s\S]*?\*\/\}/g, "").trim();
    expect(
      child,
      "the read-mode note-body paragraph must render <PrivateText>{note.content}</PrivateText>, not the bare {note.content} expression, so it masks under the privacy toggle like every other portfolio-derived surface",
    ).toBe("<PrivateText>{note.content}</PrivateText>");
  });

  it("never renders a bare {note.content} expression outside the edit textarea", () => {
    const source = readSource();
    // Every occurrence of the literal token sequence `{note.content}` in the
    // file must be either inside a PrivateText wrapper, or the
    // onStartEdit(note.id, note.content) call that seeds the edit textarea
    // (a plain function-argument reference, not a JSX child expression).
    const allMatches = [...source.matchAll(/\{note\.content\}/g)];
    const offenders = allMatches.filter((m) => {
      const start = m.index ?? 0;
      const before = source.slice(Math.max(0, start - 20), start);
      const after = source.slice(start + m[0].length, start + m[0].length + 15);
      const isWrapped = /<PrivateText>\s*$/.test(before) && /^\s*<\/PrivateText>/.test(after);
      const isEditSeed = /onStartEdit\(\s*note\.id,\s*$/.test(before);
      return !isWrapped && !isEditSeed;
    });
    expect(
      offenders.map((m) => m[0]),
      "found a {note.content} reference that is neither wrapped in <PrivateText> nor the edit-textarea seed call",
    ).toEqual([]);
  });
});

describe("security detail hub masks note prose under the privacy toggle", () => {
  it("imports PrivateText from @/lib/privacy/components", () => {
    const source = readSecurityPageSource();
    const importRe =
      /import\s*\{[^}]*\bPrivateText\b[^}]*\}\s*from\s*["']@\/lib\/privacy\/components["']/;
    expect(
      importRe.test(source),
      "app/dashboard/security/[id]/page.tsx must import PrivateText from @/lib/privacy/components",
    ).toBe(true);
  });

  it("never renders a bare {note.content} JSX child outside a <PrivateText> wrapper", () => {
    const source = readSecurityPageSource();
    // Every occurrence of the literal token sequence `{note.content}` in the
    // file must be immediately wrapped by <PrivateText>...</PrivateText> —
    // this page has no edit-textarea seed call to exempt (notes here are
    // read-only), so a bare occurrence anywhere is a regression.
    const allMatches = [...source.matchAll(/\{note\.content\}/g)];
    expect(
      allMatches.length,
      "expected exactly one {note.content} reference in app/dashboard/security/[id]/page.tsx",
    ).toBe(1);

    const offenders = allMatches.filter((m) => {
      const start = m.index ?? 0;
      const before = source.slice(Math.max(0, start - 20), start);
      const after = source.slice(start + m[0].length, start + m[0].length + 15);
      const isWrapped = /<PrivateText>\s*$/.test(before) && /^\s*<\/PrivateText>/.test(after);
      return !isWrapped;
    });
    expect(
      offenders.map((m) => m[0]),
      "found a {note.content} reference in the security detail hub that is not wrapped in <PrivateText> — if the wrap is ever removed, this assertion must fail",
    ).toEqual([]);
  });
});
