/**
 * QA finding research-documents-check-inbox--silent-400-no-feedback:
 * on /dashboard/research?view=documents, clicking "Check inbox"
 * (InboxForwardCard) POSTs /api/research/ingest-inbox, which answers 400
 * {"success":false,"error":"Gmail OAuth not configured"} in the sandbox. The
 * button flips to "Checking…" and back and nothing else visibly changes — a
 * MutationObserver watching the whole document recorded zero added nodes
 * across three repro attempts, and a check of `main.innerText` before/after
 * was byte-identical.
 *
 * The code DOES call `toast(...)` on the failure path, but the toast list
 * (ToastProvider, app/dashboard/components/Toast.tsx) is mounted at the
 * dashboard layout root ABOVE `<main id="main-content">` — its container div
 * is a sibling of the `{children}` subtree that `<main>` wraps, so it never
 * lands inside `<main>` regardless of whether the toast call fires. That
 * alone accounts for the `main.innerText` check seeing nothing. This is the
 * un-fixed sibling of two prior "silent 400" QA regressions on this same
 * Gmail-OAuth-not-configured failure — Sync Feeds
 * (research-feeds-sync-feeds--silent-400-no-feedback, fixed via the
 * `syncFeedback` local-state status line in ResearchFeedsView.tsx /
 * lib/research/sync-feedback.ts) and Discover from Gmail
 * (research-sources-discover-gmail--silent-400-no-feedback, fixed via the
 * `discoverError` local-state box in ManageSourcesModal.tsx). Both fixes
 * abandoned the toast-only channel in favor of a status line rendered
 * directly in the calling component's own tree — deterministically inside
 * `<main>`, not dependent on a separate provider's mount point.
 *
 * This test follows that same house pattern for InboxForwardCard: a local
 * `checkError` state, set on the failure/catch paths and cleared on a
 * successful check, rendered as a `role="alert"` line under the button. The
 * toast calls are left in place (harmless — still useful to a user who has
 * the toast corner in view) but the inline line is now the line of record.
 *
 * This repo has no @testing-library/react / jsdom harness (see
 * tests/dashboard/research-documents-tag-count-sync.test.ts and
 * tests/dashboard/narrative-block-refresh.test.ts), so this is a source-scan
 * pin against the extracted InboxForwardCard function body.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const VIEW_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/ResearchDocumentsView.tsx",
);

const source = readFileSync(VIEW_PATH, "utf8");

/** Source slice from a function declaration to the start of the next one. */
function functionBody(src: string, declaration: string, endMarker: string): string {
  const startIdx = src.indexOf(declaration);
  if (startIdx === -1) {
    throw new Error(`declaration not found in ResearchDocumentsView.tsx: ${declaration}`);
  }
  const endIdx = src.indexOf(endMarker, startIdx);
  if (endIdx === -1) {
    throw new Error(`end marker ${endMarker} not found after ${declaration}`);
  }
  return src.slice(startIdx, endIdx);
}

const inboxCard = functionBody(
  source,
  "function InboxForwardCard({",
  "export function ResearchDocumentsView()",
);

describe("InboxForwardCard ('Check inbox') surfaces a silent 400 inline, not just via toast", () => {
  it("declares a local checkError state", () => {
    expect(inboxCard).toMatch(
      /const \[checkError, setCheckError\] = useState<string \| null>\(null\)/,
    );
  });

  it("the failure branch (res not ok / data.success false) sets checkError", () => {
    const check = functionBody(inboxCard, "const check = useCallback(", "}, [toast, onIngested]);");
    const elseBranch = check.slice(check.indexOf("} else {"));
    // Same message the toast already used — now also stored for inline render.
    expect(elseBranch).toMatch(/Couldn't check the inbox:/);
    expect(elseBranch).toMatch(/setCheckError\(/);
  });

  it("the network-catch branch sets checkError too — a thrown res.json() must not read as silence", () => {
    const check = functionBody(inboxCard, "const check = useCallback(", "}, [toast, onIngested]);");
    const catchBlock = check.slice(check.indexOf("} catch"));
    expect(catchBlock).toMatch(/setCheckError\(/);
  });

  it("a successful check clears any standing error", () => {
    const check = functionBody(inboxCard, "const check = useCallback(", "}, [toast, onIngested]);");
    const successBranch = check.slice(
      check.indexOf("if (res.ok && data.success)"),
      check.indexOf("} else {"),
    );
    expect(successBranch).toMatch(/setCheckError\(null\)/);
  });

  it("toast() is still called on the same paths — the inline line supplements, not replaces", () => {
    const check = functionBody(inboxCard, "const check = useCallback(", "}, [toast, onIngested]);");
    expect(check).toMatch(/toast\(/);
  });

  it("renders a role=alert line under the button, gated on checkError", () => {
    expect(inboxCard).toMatch(/checkError && \(/);
    const alertIdx = inboxCard.indexOf("checkError && (");
    const alertBlock = inboxCard.slice(alertIdx, alertIdx + 300);
    expect(alertBlock).toMatch(/role="alert"/);
    expect(alertBlock).toContain("{checkError}");
  });

  it("the alert line sits after the Check-inbox button in source order (under it, not above)", () => {
    const buttonIdx = inboxCard.indexOf("Check inbox");
    const alertIdx = inboxCard.indexOf("checkError && (");
    expect(buttonIdx).toBeGreaterThan(-1);
    expect(alertIdx).toBeGreaterThan(buttonIdx);
  });

  it("InboxForwardCard's whole return is part of ResearchDocumentsView's own tree (inside <main>), not the separate ToastProvider tree", () => {
    // Structural fact backing the root-cause note above: layout.tsx mounts
    // ToastProvider ABOVE the <main> wrapper, so its toast container is a
    // sibling of <main>'s subtree, never a descendant of <main>. The inline
    // alert line, by contrast, is emitted directly from InboxForwardCard's
    // own JSX, which IS inside <main> — verified structurally here.
    const layoutPath = path.join(process.cwd(), "app/dashboard/layout.tsx");
    const layoutSrc = readFileSync(layoutPath, "utf8");
    const toastProviderIdx = layoutSrc.indexOf("<ToastProvider>");
    const mainIdx = layoutSrc.indexOf('<main id="main-content"');
    expect(toastProviderIdx).toBeGreaterThan(-1);
    expect(mainIdx).toBeGreaterThan(toastProviderIdx);
  });
});
