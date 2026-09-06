import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import { NotesAmbient } from "@/app/dashboard/components/NotesAmbient";

// QA ruling (2026-09-04, closes an 8-entry finding family: "the floating
// notes button covers a control" across Today/Accounts/Import/Alerts/
// Research Notes, desktop + mobile): the ambient-notes floating action
// button is REMOVED entirely. The overlay itself stays and is reachable via
// Cmd+; (desktop, global) and the bottom-nav "Notes" entry (mobile, routes
// to /dashboard/research?view=notes — see MobileBottomNav.tsx, unedited by
// this change). This test pins the closed state to render nothing.
//
// next/navigation's useRouter is mocked because NotesAmbient calls it
// unconditionally, and it throws outside a real App Router tree. Same
// renderToStaticMarkup approach as tests/dashboard/nearby-levels-privacy.test.tsx
// and tests/dashboard/account-detail-snapshot-date.test.tsx (this repo has no
// @testing-library/react and no jsdom environment in vitest.config.ts —
// confirmed by grep before writing this file; not adding either since new
// dependencies need sign-off).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

describe("NotesAmbient closed state has no floating action button", () => {
  it("renders nothing when closed — no button, no dialog", () => {
    const html = renderToStaticMarkup(<NotesAmbient />);
    expect(html).toBe("");
  });

  it("never renders the old FAB's aria-label, even as dead markup", () => {
    const html = renderToStaticMarkup(<NotesAmbient />);
    expect(html).not.toContain("Open ambient notes");
    expect(html).not.toMatch(/role="dialog"/);
  });
});

// renderToStaticMarkup performs a one-shot server render with no DOM, no
// event listeners, and no effects — there is no way to dispatch a real
// `keydown` and observe a re-render without jsdom, which this repo does not
// have configured (see mock comment above). Firing `window.dispatchEvent`
// against a plain Node `window` global (no jsdom) would not reach a React
// tree that was never mounted into a document in the first place, so a
// "press Cmd+; and see the panel" assertion is not achievable here. Instead
// this is a static-scan backstop pinning the exact toggle condition the
// keydown handler checks (lines documented in NotesAmbient.tsx's own
// "Cmd+; / Ctrl+; toggles" comment) — if that condition is ever weakened or
// removed, this test fails and calls it out as the only remaining way to
// reach the overlay now that the FAB is gone.
describe("NotesAmbient keydown toggle is preserved as the (now sole, with mobile nav) way to open the overlay", () => {
  it("still listens for Cmd+; / Ctrl+; on window and flips `open`", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "app/dashboard/components/NotesAmbient.tsx"),
      "utf8"
    );
    expect(source).toContain('window.addEventListener("keydown"');
    expect(source).toContain('(e.metaKey || e.ctrlKey) && e.key === ";"');
    expect(source).toMatch(/setOpen\(\(o\) => !o\)/);
  });

  it("still renders the open-state panel with role=dialog and aria-label Ambient notes", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "app/dashboard/components/NotesAmbient.tsx"),
      "utf8"
    );
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-label="Ambient notes"');
  });
});
