import { describe, it, expect } from "vitest";
import {
  EMAIL_FRAME_SANDBOX,
  withExternalLinkTarget,
} from "@/lib/email/archive-srcdoc";
import { briefingToHtml } from "@/lib/calendar/briefing-html";

/**
 * Deep-QA finding qa:earnings-email-viewer--source-link-navigates-sandboxed-iframe-to-third-party
 *
 * An archived earnings email is rendered srcDoc'd into a sandboxed iframe.
 * Its source links (`<a href="https://www.investing.com/...">`) carry no
 * target, so a click navigated the IFRAME ITSELF: the modal body became a
 * live third-party page under the "Sent Jul 27" header, with an outbound
 * request from inside the dashboard and no way back except ✕.
 *
 * The fix is the same one NewsletterArticleFrame already uses: a
 * `<base target="_blank">` in the framed document's head, so every link
 * resolves to a NEW browsing context instead of the frame, plus a sandbox
 * that permits that popup (and nothing more).
 */

// Shape emitted by lib/calendar/briefing-html.ts::briefingToHtml.
const EMAIL_DOC =
  `<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>NVDA Earnings Recap</title>\n</head>\n` +
  `<body><p><a href="https://www.investing.com/news/x">Investing.com</a></p></body>\n</html>`;

describe("withExternalLinkTarget", () => {
  it("injects <base target=\"_blank\"> immediately inside <head> so links never navigate the frame", () => {
    const out = withExternalLinkTarget(EMAIL_DOC);
    expect(out).toContain('<base target="_blank">');
    expect(out).toContain('<head><base target="_blank">');
  });

  it("changes nothing else about the archived document", () => {
    const out = withExternalLinkTarget(EMAIL_DOC);
    expect(out.replace('<base target="_blank">', "")).toBe(EMAIL_DOC);
  });

  it("is idempotent", () => {
    const once = withExternalLinkTarget(EMAIL_DOC);
    expect(withExternalLinkTarget(once)).toBe(once);
  });

  it("leaves a document that already declares a <base target> in its head untouched", () => {
    const authored =
      '<!DOCTYPE html><html><head><base href="https://example.test/" target="_top"><title>x</title></head><body>hi</body></html>';
    expect(withExternalLinkTarget(authored)).toBe(authored);
  });

  it("does not treat an href-only <base> as a target declaration", () => {
    const hrefOnly =
      '<!DOCTYPE html><html><head><base href="https://example.test/"></head><body>hi</body></html>';
    const out = withExternalLinkTarget(hrefOnly);
    expect(out).toContain('<base target="_blank">');
    // Our tag carries no href, so it never becomes the URL-resolution base.
    expect(out).toContain('<base href="https://example.test/">');
  });

  it("supplies a head when the document has <html> but no <head>", () => {
    const out = withExternalLinkTarget("<html><body><a href='https://x.test'>x</a></body></html>");
    expect(out).toBe('<html><head><base target="_blank"></head><body><a href=\'https://x.test\'>x</a></body></html>');
  });

  it("prepends the base tag to a bare fragment", () => {
    const out = withExternalLinkTarget("<p><a href='https://x.test'>x</a></p>");
    expect(out).toBe('<base target="_blank"><p><a href=\'https://x.test\'>x</a></p>');
  });

  it("wins over a hostile <base target=\"_self\"> planted in the email body (head is first in tree order)", () => {
    const hostile =
      '<!DOCTYPE html><html><head><title>x</title></head><body><base target="_self"><a href="https://evil.test">go</a></body></html>';
    const out = withExternalLinkTarget(hostile);
    expect(out).toContain('<head><base target="_blank">');
    expect(out.indexOf('<base target="_blank">')).toBeLessThan(out.indexOf('<base target="_self">'));
  });

  it("rewrites no anchors at all — mailto: and href-less anchors survive verbatim", () => {
    const body =
      '<a href="mailto:unsubscribe@x.test">unsub</a><a name="top"></a><a>plain</a>';
    const out = withExternalLinkTarget(`<html><head></head><body>${body}</body></html>`);
    expect(out).toContain(body);
    expect(out).not.toContain("noopener");
  });

  it("returns empty input unchanged", () => {
    expect(withExternalLinkTarget("")).toBe("");
  });
});

describe("EMAIL_FRAME_SANDBOX", () => {
  it("permits the escaping popup but never scripts or top-level navigation", () => {
    const tokens = EMAIL_FRAME_SANDBOX.split(" ");
    expect(tokens).toContain("allow-same-origin");
    expect(tokens).toContain("allow-popups");
    expect(tokens).toContain("allow-popups-to-escape-sandbox");
    expect(tokens).not.toContain("allow-scripts");
    expect(tokens).not.toContain("allow-top-navigation");
    expect(tokens).not.toContain("allow-top-navigation-by-user-activation");
    expect(tokens).not.toContain("allow-forms");
  });
});

/**
 * Integration guard: the injection point must match what the REAL email
 * renderer emits, not just a hand-written fixture. briefingToHtml is the
 * single source of the archived HTML for every earnings email and the
 * morning digest, so a future change to its <head> that broke injection
 * would silently restore the navigate-the-frame defect.
 */
describe("withExternalLinkTarget on real briefingToHtml output", () => {
  const markdown = "# NVDA Recap\n\nSee [Investing.com](https://www.investing.com/news/x).";
  const rendered = briefingToHtml(markdown, "NVDA Earnings Recap — August 27, 2026");

  it("the renderer still emits a document with a <head> and no base tag of its own", () => {
    expect(rendered).toMatch(/<head>/i);
    expect(rendered).not.toMatch(/<base\b/i);
  });

  it("carries a real source link that would otherwise navigate the frame", () => {
    expect(rendered).toContain('href="https://www.investing.com/news/x"');
    // The anchor has no target of its own — that is the whole defect.
    expect(rendered).not.toMatch(/<a[^>]*target=/i);
  });

  it("gains exactly one <base target=\"_blank\"> inside the head", () => {
    const out = withExternalLinkTarget(rendered);
    expect(out.match(/<base target="_blank">/g)).toHaveLength(1);
    const baseAt = out.indexOf('<base target="_blank">');
    expect(baseAt).toBeGreaterThan(out.search(/<head>/i));
    expect(baseAt).toBeLessThan(out.search(/<\/head>/i));
    // Body content is untouched.
    expect(out).toContain('href="https://www.investing.com/news/x"');
  });
});
