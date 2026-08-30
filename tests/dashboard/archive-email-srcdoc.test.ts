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

  it("rewrites an already-present <base target> to _blank instead of leaving it alone", () => {
    // A <base target="_top"> in the head would otherwise navigate the whole
    // top-level document out from under the app — the early-return-unchanged
    // behavior this used to have reproduced the same in-frame-navigation bug
    // for any email carrying its own <base target>.
    const authored =
      '<!DOCTYPE html><html><head><base href="https://example.test/" target="_top"><title>x</title></head><body>hi</body></html>';
    const expected =
      '<!DOCTYPE html><html><head><base href="https://example.test/" target="_blank"><title>x</title></head><body>hi</body></html>';
    expect(withExternalLinkTarget(authored)).toBe(expected);
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

  it("wins over a hostile <base target=\"_self\"> planted in the email body (head is first in tree order, and the body base is rewritten too)", () => {
    const hostile =
      '<!DOCTYPE html><html><head><title>x</title></head><body><base target="_self"><a href="https://evil.test">go</a></body></html>';
    const out = withExternalLinkTarget(hostile);
    expect(out).toContain('<head><base target="_blank">');
    // The body's own <base target> no longer says _self either — every
    // <base target> in the document is neutralised, not just the one we
    // inject into the head.
    expect(out).not.toContain("_self");
    expect(out).toContain('<base target="_blank"><a href="https://evil.test">go</a>');
  });

  it("rewrites href-less anchors and mailto: links only if they carry a hostile target — otherwise verbatim", () => {
    const body =
      '<a href="mailto:unsubscribe@x.test">unsub</a><a name="top"></a><a>plain</a>';
    const out = withExternalLinkTarget(`<html><head></head><body>${body}</body></html>`);
    expect(out).toContain(body);
    expect(out).not.toContain("noopener");
  });

  it("rewrites an anchor's own target=\"_self\" to _blank (a per-element target overrides <base target>)", () => {
    const out = withExternalLinkTarget(
      '<html><head></head><body><a href="https://evil.test" target="_self">go</a></body></html>',
    );
    expect(out).toContain('<a href="https://evil.test" target="_blank">go</a>');
    expect(out).not.toContain('target="_self"');
  });

  it("rewrites target=_top (unquoted) and TARGET='_parent' (uppercase attr, single-quoted) to _blank", () => {
    const outTop = withExternalLinkTarget(
      "<html><head></head><body><a href='https://evil.test' target=_top>go</a></body></html>",
    );
    expect(outTop).toContain('target="_blank"');
    expect(outTop).not.toContain("_top");

    const outParent = withExternalLinkTarget(
      "<html><head></head><body><form action='https://evil.test' TARGET='_parent'></form></body></html>",
    );
    expect(outParent).toContain('target="_blank"');
    expect(outParent).not.toContain("_parent");
  });

  it("never touches target=\"_blank\" or a named target like target=\"print\"", () => {
    const out = withExternalLinkTarget(
      '<html><head></head><body>' +
        '<a href="https://a.test" target="_blank">a</a>' +
        '<a href="https://b.test" target="print">b</a>' +
        "</body></html>",
    );
    expect(out).toContain('target="_blank">a<');
    expect(out).toContain('target="print">b<');
  });

  it("returns empty input unchanged", () => {
    expect(withExternalLinkTarget("")).toBe("");
  });

  // Codex finding: the tag regex ran over raw HTML and rewrote tag-like
  // strings INSIDE <script>…</script> and <style>…</style> — a probe turned
  // `const x="<a target=\"_self\">"` (JS string literal text, not markup)
  // into broken text, and rewrote a CSS `content:"<a target=_top>"` literal
  // too. Scripts never execute in this frame (no allow-scripts in
  // EMAIL_FRAME_SANDBOX), but the rewrite must still leave non-markup text
  // inside those regions byte-for-byte untouched.
  it("does not rewrite target-attribute-looking text inside a <script> block, but still rewrites a real <a> tag after it", () => {
    const html =
      '<html><head></head><body>' +
      '<script>const x = "<a target=\\"_self\\">";</script>' +
      '<a href="https://evil.test" target="_self">go</a>' +
      "</body></html>";
    const out = withExternalLinkTarget(html);
    // The script's text content is untouched, hostile target and all.
    expect(out).toContain('<script>const x = "<a target=\\"_self\\">";</script>');
    // The real anchor after the script IS rewritten.
    expect(out).toContain('<a href="https://evil.test" target="_blank">go</a>');
  });

  it("does not rewrite a <style> block's CSS content literal that looks like a hostile tag", () => {
    const html =
      "<html><head><style>a::after { content: \"<a target=_top>\"; }</style></head>" +
      '<body><a href="https://evil.test" target="_self">go</a></body></html>';
    const out = withExternalLinkTarget(html);
    // The CSS content literal is untouched.
    expect(out).toContain('a::after { content: "<a target=_top>"; }');
    // The real anchor in the body IS still rewritten.
    expect(out).toContain('<a href="https://evil.test" target="_blank">go</a>');
  });

  it("still injects <base target=\"_blank\"> in the head even when the body carries a <script>/<style> block", () => {
    const html =
      "<html><head><style>.x { content: \"<a target=_top>\"; }</style></head>" +
      "<body><script>var y = '<base target=\"_top\">';</script><p>hi</p></body></html>";
    const out = withExternalLinkTarget(html);
    expect(out).toContain('<head><base target="_blank">');
    // The script text's fake <base target> is untouched, not neutralised.
    expect(out).toContain("var y = '<base target=\"_top\">';");
  });
});

describe("EMAIL_FRAME_SANDBOX", () => {
  it("permits the escaping popup but never scripts, own-origin, or top-level navigation", () => {
    const tokens = EMAIL_FRAME_SANDBOX.split(" ");
    // Neither EarningsEmailViewer nor DigestEmailViewer reads
    // `contentDocument` (both use a fixed 75dvh/75vh frame height), so
    // there is no reason to grant the frame its parent's origin.
    expect(tokens).not.toContain("allow-same-origin");
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
