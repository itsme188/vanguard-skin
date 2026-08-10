import { describe, it, expect } from "vitest";
import {
  sanitizeNewsletterHtml,
  normalizeNewsletterHtml,
  visibleHtmlTextLength,
  htmlHidesStoredText,
} from "@/lib/gmail/sanitize";

/**
 * normalizeNewsletterHtml is the second-pass cleanup that runs after
 * sanitizeNewsletterHtml. It removes layout-only noise (empty wrappers,
 * hr/br runs, single-link CTAs, layout tables, publication chrome) so
 * the rendered article reads like an article, not a forwarded email.
 */
describe("normalizeNewsletterHtml", () => {
  it("returns empty string for empty input", () => {
    expect(normalizeNewsletterHtml("")).toBe("");
  });

  it("is idempotent on already-clean content", () => {
    const clean = "<p>This is a clean paragraph.</p><p>And another.</p>";
    expect(normalizeNewsletterHtml(clean)).toBe(clean);
    expect(normalizeNewsletterHtml(normalizeNewsletterHtml(clean))).toBe(clean);
  });

  describe("preheader stripping", () => {
    it("strips leading zero-width-space + nbsp run", () => {
      const html =
        "<div>​&nbsp;​&nbsp;​&nbsp;​&nbsp; preview text</div><p>Real content here.</p>";
      const out = normalizeNewsletterHtml(html);
      expect(out).not.toContain("preview text");
      expect(out).toContain("Real content here.");
    });

    it("strips soft-hyphen-padded preheader", () => {
      const html =
        "<p>­­­­­­ inbox preview teaser</p><p>Article body.</p>";
      const out = normalizeNewsletterHtml(html);
      expect(out).not.toContain("inbox preview teaser");
      expect(out).toContain("Article body.");
    });

    it("does NOT strip a normal first paragraph", () => {
      const html = "<p>This is a real opening sentence.</p>";
      const out = normalizeNewsletterHtml(html);
      expect(out).toContain("This is a real opening sentence.");
    });
  });

  describe("publication chrome stripping", () => {
    it("removes 'View this email in your browser' header", () => {
      const html =
        '<p><a href="https://x.com">View this email in your browser</a></p><p>Real content here.</p>';
      const out = normalizeNewsletterHtml(html);
      expect(out).not.toContain("View this email");
      expect(out).toContain("Real content here.");
    });

    it("removes 'Web version' link", () => {
      const html =
        '<div><a href="https://x.com">Web version</a></div><p>Article body.</p>';
      const out = normalizeNewsletterHtml(html);
      expect(out).not.toContain("Web version");
      expect(out).toContain("Article body.");
    });

    it("does NOT touch chrome markers in the article body", () => {
      // Marker appears in the latter 75% — should be preserved.
      const body = "<p>" + "Long body text. ".repeat(100) + "</p>";
      const html = body + "<p>Trouble viewing this? Here's why.</p>";
      const out = normalizeNewsletterHtml(html);
      expect(out).toContain("Trouble viewing this");
    });
  });

  describe("empty block collapsing", () => {
    it("removes whitespace-only paragraphs", () => {
      const html = "<p>Real text.</p><p>   </p><p>More text.</p>";
      const out = normalizeNewsletterHtml(html);
      expect(out).toBe("<p>Real text.</p><p>More text.</p>");
    });

    it("removes &nbsp;-only paragraphs", () => {
      const html = "<p>Real text.</p><p>&nbsp;</p><p>More text.</p>";
      const out = normalizeNewsletterHtml(html);
      expect(out).toBe("<p>Real text.</p><p>More text.</p>");
    });

    it("removes <br>-only paragraphs", () => {
      const html = "<p>Real text.</p><p><br /></p><p>More text.</p>";
      const out = normalizeNewsletterHtml(html);
      expect(out).toBe("<p>Real text.</p><p>More text.</p>");
    });

    it("removes nested empty wrappers iteratively", () => {
      const html =
        "<p>A.</p><div><div><p>&nbsp;</p></div></div><p>B.</p>";
      const out = normalizeNewsletterHtml(html);
      expect(out).toContain("<p>A.</p>");
      expect(out).toContain("<p>B.</p>");
      expect(out).not.toContain("<div>");
    });

    it("preserves non-empty divs", () => {
      const html = "<div><p>Real content.</p></div>";
      const out = normalizeNewsletterHtml(html);
      expect(out).toContain("<p>Real content.</p>");
    });
  });

  describe("hr/br run collapsing", () => {
    it("collapses 4 consecutive <hr> to 1", () => {
      const html = "<p>A.</p><hr /><hr /><hr /><hr /><p>B.</p>";
      const out = normalizeNewsletterHtml(html);
      const hrCount = (out.match(/<hr/g) || []).length;
      expect(hrCount).toBe(1);
    });

    it("collapses 5 consecutive <br> to 2", () => {
      const html = "<p>A<br /><br /><br /><br /><br />B</p>";
      const out = normalizeNewsletterHtml(html);
      const brCount = (out.match(/<br/g) || []).length;
      expect(brCount).toBe(2);
    });

    it("preserves a single <hr>", () => {
      const html = "<p>A.</p><hr /><p>B.</p>";
      const out = normalizeNewsletterHtml(html);
      expect((out.match(/<hr/g) || []).length).toBe(1);
    });
  });

  describe("link-only CTA paragraph stripping", () => {
    it("removes 'Read more' single-link CTA", () => {
      const html =
        '<p>Article text.</p><p><a href="https://x.com">Read more</a></p>';
      const out = normalizeNewsletterHtml(html);
      expect(out).not.toContain("Read more");
      expect(out).toContain("Article text.");
    });

    it("removes 'View online' CTA", () => {
      const html =
        '<p>Body.</p><p><a href="https://x.com">View online</a></p>';
      const out = normalizeNewsletterHtml(html);
      expect(out).not.toContain("View online");
    });

    it("removes 'Click here' CTA", () => {
      const html =
        '<p>Body.</p><p><a href="https://x.com">Click here</a></p>';
      const out = normalizeNewsletterHtml(html);
      expect(out).not.toContain("Click here");
    });

    it("does NOT remove links inside paragraphs with surrounding text", () => {
      const html =
        '<p>Read more about <a href="https://x.com">NVDA</a> in our coverage.</p>';
      const out = normalizeNewsletterHtml(html);
      expect(out).toContain("Read more about");
      expect(out).toContain("NVDA");
      expect(out).toContain("in our coverage");
    });

    it("does NOT remove paragraphs with substantial link text", () => {
      const html =
        '<p><a href="https://x.com">An article about Nvidia\'s latest earnings beat</a></p>';
      const out = normalizeNewsletterHtml(html);
      expect(out).toContain("An article about");
    });
  });

  describe("layout table unwrapping", () => {
    it("unwraps single-cell wrapper tables", () => {
      const html =
        "<table><tr><td><p>Real content.</p></td></tr></table>";
      const out = normalizeNewsletterHtml(html);
      expect(out).not.toContain("<table");
      expect(out).toContain("<p>Real content.</p>");
    });

    it("unwraps nested layout tables iteratively", () => {
      const html =
        "<table><tbody><tr><td><table><tr><td><p>Inner.</p></td></tr></table></td></tr></tbody></table>";
      const out = normalizeNewsletterHtml(html);
      expect(out).not.toContain("<table");
      expect(out).toContain("<p>Inner.</p>");
    });

    it("preserves real data tables (multiple rows)", () => {
      const html =
        "<table><tr><td>A</td></tr><tr><td>B</td></tr></table>";
      const out = normalizeNewsletterHtml(html);
      expect(out).toContain("<table");
      expect(out).toContain("A");
      expect(out).toContain("B");
    });

    it("preserves real data tables (multiple columns)", () => {
      const html = "<table><tr><td>A</td><td>B</td></tr></table>";
      const out = normalizeNewsletterHtml(html);
      expect(out).toContain("<table");
      expect(out).toContain("A");
      expect(out).toContain("B");
    });
  });

  describe("trailing structural cleanup", () => {
    it("strips trailing empty divs and hrs", () => {
      const html = "<p>Body.</p><div></div><hr /><br />";
      const out = normalizeNewsletterHtml(html);
      expect(out.endsWith("</p>")).toBe(true);
    });
  });

  describe("end-to-end sanitize + normalize", () => {
    it("processes a realistic newsletter sample", () => {
      // Real newsletter shape: chrome on top, layout-tables wrapping content,
      // footer AFTER the body wrappers (not inside).
      const html = `
        <html>
        <head><style>body{color:red}</style></head>
        <body>
          <p><a href="https://example.com">View this email in your browser</a></p>
          <table><tr><td>
            <table><tr><td>
              <p><strong>The Daily Brief</strong></p>
              <hr />
              <hr />
              <p>NVDA reported earnings yesterday. The numbers were strong.</p>
              <p>&nbsp;</p>
              <p>Revenue grew 30% YoY.</p>
              <p><a href="https://example.com">Read more</a></p>
            </td></tr></table>
          </td></tr></table>
          <p>© 2026 Some Newsletter LLC. All rights reserved.</p>
        </body>
        </html>
      `;
      const sanitized = sanitizeNewsletterHtml(html);
      const out = normalizeNewsletterHtml(sanitized);

      // Cleaned away
      expect(out).not.toContain("View this email");
      expect(out).not.toContain("color:red");
      expect(out).not.toContain("<table");
      expect(out).not.toContain("Read more");
      expect(out).not.toContain("&nbsp;");
      expect(out).not.toContain("<hr /><hr />");
      // sanitizer trims footer; normalizer leaves the result clean
      expect(out).not.toContain("All rights reserved");

      // Preserved
      expect(out).toContain("The Daily Brief");
      expect(out).toContain("NVDA reported earnings");
      expect(out).toContain("Revenue grew 30%");
    });
  });

  describe("idempotency on real-world cases", () => {
    it("running normalize twice yields the same result", () => {
      const html = `
        <p><a href="https://x.com">View this email in browser</a></p>
        <table><tr><td>
          <p>Hello.</p>
          <p>&nbsp;</p>
          <p>World.</p>
          <hr /><hr /><hr />
          <p><a href="https://x.com">Read more</a></p>
        </td></tr></table>
      `;
      const once = normalizeNewsletterHtml(sanitizeNewsletterHtml(html));
      const twice = normalizeNewsletterHtml(once);
      expect(twice).toBe(once);
    });
  });
});

describe("visibleHtmlTextLength / htmlHidesStoredText (blank expand-panel fallback)", () => {
  it("counts only rendered text — style/script/head blocks and tags are invisible", () => {
    const html =
      "<html><head><title>t</title><style>.a{color:red}</style></head>" +
      "<body><style>p{margin:0}</style><p>Hello&nbsp;world</p><script>x()</script></body></html>";
    const len = visibleHtmlTextLength(html);
    expect(len).toBeGreaterThan(5);
    expect(len).toBeLessThan(30);
  });

  it("style-only HTML with substantial stored raw_text triggers the fallback", () => {
    // The James Bulltard shape: ~30KB of <style>, 4 chars of rendered text,
    // 7,351 chars of stored raw_text.
    const styleOnly = `<html><head><style>${".x{}".repeat(5000)}</style></head><body><p>8/3</p></body></html>`;
    const rawText = "Recap paragraph. ".repeat(400);
    expect(htmlHidesStoredText(styleOnly, rawText)).toBe(true);
  });

  it("HTML rendering a small fraction of a long raw_text triggers the fallback", () => {
    const partial = `<html><body><p>${"a".repeat(400)}</p></body></html>`;
    const rawText = "b".repeat(10_000);
    expect(htmlHidesStoredText(partial, rawText)).toBe(true);
  });

  it("healthy HTML (full article text) does NOT trigger the fallback", () => {
    const body = "A full paragraph of readable newsletter prose. ".repeat(80);
    const html = `<html><body><p>${body}</p></body></html>`;
    expect(htmlHidesStoredText(html, body)).toBe(false);
  });

  it("no raw_text to fall back to → never triggers", () => {
    const styleOnly = "<html><head><style>.a{}</style></head><body></body></html>";
    expect(htmlHidesStoredText(styleOnly, null)).toBe(false);
    expect(htmlHidesStoredText(styleOnly, "")).toBe(false);
  });
});
