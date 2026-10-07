/**
 * EarningsEmailViewer — privacy cover, dialog focus, Escape after a click in
 * the email, and the "refreshed after send" stamp.
 *
 * No DOM harness in this repo: the body and header are pure components
 * rendered with react-dom/server, the Tab ring and the stamp are pure
 * functions, and the effects that need a browser are source-pinned.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EmailViewerBody,
  EmailViewerHeader,
  nextTabStopIndex,
  scoreboardRefreshedAfterSend,
  type EmailContentResponse,
} from "@/app/dashboard/components/EarningsEmailViewer";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

// Synthetic prose shaped like an old send: a share count and an account return.
const LEAKY_BODY =
  "<html><head></head><body><p>The position, 123.45 sh AAA, already up ~12.3% unrealized, at $67.89 avg cost.</p></body></html>";

const response = (o: Partial<EmailContentResponse> = {}): EmailContentResponse => ({
  title: "AAA Earnings Recap — Thursday, September 10",
  sentAt: "2026-09-10 20:27:00",
  sentTo: "reader@example.com",
  eventDate: "2026-09-10",
  symbol: "AAA",
  phase: "recap",
  sentBy: "local",
  deliveryState: "sent",
  fullHtml: LEAKY_BODY,
  ...o,
});

const body = (masked: boolean) =>
  renderToStaticMarkup(
    createElement(EmailViewerBody, { data: response(), masked, onReveal: () => {} }),
  );

const src = readFileSync("app/dashboard/components/EarningsEmailViewer.tsx", "utf8");

describe("EmailViewerBody — privacy cover", () => {
  it("masked: no iframe, no srcdoc, and no figure from the email anywhere in the markup", () => {
    const html = body(true);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("srcdoc");
    expect(html).not.toContain("srcDoc");
    for (const figure of ["123.45", "12.3%", "67.89", "avg cost", "unrealized"]) {
      expect(html).not.toContain(figure);
    }
    // No attribute a tooltip or a screen reader could read the body from.
    expect(html).not.toMatch(/\b(?:title|aria-label|aria-description|alt|data-[\w-]+)=/);
  });

  it("masked: says why and offers an explicit reveal control", () => {
    const html = body(true);
    expect(html).toContain("Amounts hidden — privacy mode");
    expect(html).toMatch(/<button type="button"[^>]*>Reveal this email<\/button>/);
  });

  it("not masked: the email renders in the sandboxed frame only", () => {
    const html = body(false);
    expect(html).toContain("<iframe");
    expect(html).toContain('sandbox="allow-popups allow-popups-to-escape-sandbox"');
    expect(html).toContain("srcDoc=");
    expect(html).not.toContain("Reveal this email");
    // The body text exists only as the escaped srcdoc attribute value.
    expect(html).not.toContain("<p>The position");
  });

  it("the file never injects email HTML into the app document", () => {
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("EarningsEmailViewer — privacy wiring (source pins)", () => {
  it("masks from the privacy context and reveals only the loaded email the control was pressed for", () => {
    expect(src).toContain("const { isPrivate } = usePrivacy();");
    expect(src).toContain("const masked = isPrivate && (data === null || revealedFor !== data);");
    const at = anchorIndex(src, "onReveal={() => {");
    expect(src.slice(at, at + 60)).toContain("setRevealedFor(data);");
    // The reveal setter is called from that one control and nowhere else.
    expect(src.split("setRevealedFor(data)").length - 1).toBe(1);
  });

  it("drops the reveal whenever the viewer opens or closes or privacy is switched", () => {
    const at = anchorIndex(src, "const coverScope = open && isPrivate;");
    const block = src.slice(at, at + 260);
    expect(block).toContain("if (coverScope !== prevCoverScope) {");
    expect(block).toContain("setRevealedFor(null);");
  });

  it("the reveal is component state only — nothing is written to browser storage", () => {
    expect(src).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });

  it("the only iframe in the file is the one inside EmailViewerBody's unmasked branch", () => {
    expect(src.split("<iframe").length - 1).toBe(1);
    const bodyFn = sliceBetween(src, "export function EmailViewerBody", "export interface InlineEmailData");
    expect(anchorIndex(bodyFn, "if (masked) {")).toBeLessThan(anchorIndex(bodyFn, "<iframe"));
    expect(bodyFn).toContain("sandbox={EMAIL_FRAME_SANDBOX}");
  });
});

describe("nextTabStopIndex — Tab stays inside the dialog", () => {
  it("wraps forward off the last control and backward off the first", () => {
    expect(nextTabStopIndex(2, 0, false)).toBe(1);
    expect(nextTabStopIndex(2, 1, false)).toBe(0);
    expect(nextTabStopIndex(2, 0, true)).toBe(1);
    expect(nextTabStopIndex(2, 1, true)).toBe(0);
  });

  it("from the panel itself (or outside the ring) enters at the first / last control", () => {
    expect(nextTabStopIndex(2, -1, false)).toBe(0);
    expect(nextTabStopIndex(2, -1, true)).toBe(1);
  });

  it("a single control keeps focus; no control reports -1", () => {
    expect(nextTabStopIndex(1, 0, false)).toBe(0);
    expect(nextTabStopIndex(1, 0, true)).toBe(0);
    expect(nextTabStopIndex(0, -1, false)).toBe(-1);
  });
});

describe("EarningsEmailViewer — dialog focus (source pins)", () => {
  it("the panel is a modal dialog that can take focus", () => {
    const at = anchorIndex(src, "ref={panelRef}");
    const tag = src.slice(at, at + 260);
    expect(tag).toContain('role="dialog"');
    expect(tag).toContain('aria-modal="true"');
    expect(tag).toContain("tabIndex={-1}");
  });

  it("focus moves in on open and back to the opener on close", () => {
    const at = anchorIndex(src, "const opener = document.activeElement");
    const effect = src.slice(at, at + 260);
    expect(effect).toContain("panelRef.current?.focus();");
    expect(effect).toContain("if (opener && opener.isConnected) opener.focus();");
  });

  it("Tab is always handled by the dialog, never left to walk the page behind it", () => {
    const at = anchorIndex(src, 'if (e.key !== "Tab") return;');
    const handler = src.slice(at, at + 520);
    expect(handler).toContain("e.preventDefault();");
    expect(handler).toContain("nextTabStopIndex(");
  });
});

describe("EarningsEmailViewer — Escape after a click in the email (source pins)", () => {
  it("hands focus back to the dialog when it lands on the email frame", () => {
    const at = anchorIndex(src, "const onWindowBlur = () => {");
    const handler = src.slice(at, at + 420);
    expect(handler).toContain("document.activeElement === frameRef.current");
    expect(handler).toContain("panelRef.current?.focus();");
    expect(handler).toContain('window.addEventListener("blur", onWindowBlur);');
  });

  it("the sandbox is the shared script-free one", () => {
    expect(src).not.toContain("allow-scripts");
    expect(src).not.toContain("allow-same-origin");
  });
});

describe("scoreboardRefreshedAfterSend", () => {
  it("returns the leg instant when it is later than the send", () => {
    const at = scoreboardRefreshedAfterSend("2026-09-10 20:27:00", "2026-09-10T22:15:00.000Z");
    expect(at?.toISOString()).toBe("2026-09-10T22:15:00.000Z");
  });

  it("returns null when the leg predates or equals the send", () => {
    expect(scoreboardRefreshedAfterSend("2026-09-10 23:00:00", "2026-09-10T22:15:00.000Z")).toBeNull();
    expect(scoreboardRefreshedAfterSend("2026-09-10 22:15:00", "2026-09-10T22:15:00.000Z")).toBeNull();
  });

  it("returns null with no send (live preview), no leg, or an unreadable stamp", () => {
    expect(scoreboardRefreshedAfterSend("", "2026-09-10T22:15:00.000Z")).toBeNull();
    expect(scoreboardRefreshedAfterSend("2026-09-10 20:27:00", null)).toBeNull();
    expect(scoreboardRefreshedAfterSend("2026-09-10 20:27:00", undefined)).toBeNull();
    expect(scoreboardRefreshedAfterSend("2026-09-10 20:27:00", "not a time")).toBeNull();
  });
});

describe("EmailViewerHeader — refreshed-after-send stamp", () => {
  const header = (o: Partial<EmailContentResponse>) =>
    renderToStaticMarkup(createElement(EmailViewerHeader, { data: response(o) }));

  it("a recap whose reaction leg post-dates the send is stamped with the ET capture time", () => {
    const html = header({ reactionLegAt: "2026-09-10T22:15:00.000Z" });
    expect(html).toContain("Scoreboard refreshed after send — reaction captured Sep 10, 6:15 PM ET");
  });

  it("no stamp when the leg predates the send, is absent, or the email is a preview", () => {
    expect(header({ reactionLegAt: "2026-09-10T20:00:00.000Z" })).not.toContain("refreshed after send");
    expect(header({})).not.toContain("refreshed after send");
    expect(
      header({ phase: "preview", reactionLegAt: "2026-09-10T22:15:00.000Z" }),
    ).not.toContain("refreshed after send");
  });
});
