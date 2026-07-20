import { describe, it, expect } from "vitest";
import { extractSourceUrl } from "@/lib/gmail/extract-url";

describe("extractSourceUrl", () => {
  // ── Existing patterns (regression) ────────────────────────────────

  it("extracts Vital Knowledge article URL", () => {
    const html = `<a href="https://vitalknowledge.net/article/growth-stocks?fromEmail=1">Read more</a>`;
    expect(extractSourceUrl(html)).toBe(
      "https://vitalknowledge.net/article/growth-stocks"
    );
  });

  it('extracts "View in browser" link', () => {
    const html = `<a href="https://example.com/post/123">View in browser</a>`;
    expect(extractSourceUrl(html)).toBe("https://example.com/post/123");
  });

  it('extracts "Read online" link', () => {
    const html = `<a href="https://example.com/issue/456">Read online</a>`;
    expect(extractSourceUrl(html)).toBe("https://example.com/issue/456");
  });

  it("returns null for empty input", () => {
    expect(extractSourceUrl(null)).toBeNull();
    expect(extractSourceUrl("")).toBeNull();
  });

  it("returns null for HTML with no matching patterns", () => {
    const html = `<div><p>Just some content</p></div>`;
    expect(extractSourceUrl(html)).toBeNull();
  });

  // ── Bloomberg: "Read in browser" ─────────────────────────────────

  it('extracts Bloomberg "Read in browser" link', () => {
    const html = `<a href="https://links.message.bloomberg.com/a/sc/xyz123" style="color:#000">Read in browser</a>`;
    expect(extractSourceUrl(html)).toBe(
      "https://links.message.bloomberg.com/a/sc/xyz123"
    );
  });

  it('extracts "Read in browser" with mixed case', () => {
    const html = `<a href="https://example.com/article">Read In Browser</a>`;
    expect(extractSourceUrl(html)).toBe("https://example.com/article");
  });

  // ── Substack: raw_text "View this post on the web" ────────────────

  it("extracts URL from Substack plaintext body", () => {
    const rawText = `View this post on the web at https://www.tmtbreakout.com/p/eod-wrap-april-15

Some article content here...`;
    expect(extractSourceUrl(null, rawText)).toBe(
      "https://www.tmtbreakout.com/p/eod-wrap-april-15"
    );
  });

  it("extracts URL from raw_text when HTML has no match", () => {
    const html = `<div><p>Substack email without view in browser link</p></div>`;
    const rawText = `View this post on the web at https://www.jamesbulltard.com/p/market-recap-april-14

Content follows...`;
    expect(extractSourceUrl(html, rawText)).toBe(
      "https://www.jamesbulltard.com/p/market-recap-april-14"
    );
  });

  it("prefers HTML match over raw_text", () => {
    const html = `<a href="https://example.com/html-url">View in browser</a>`;
    const rawText = `View this post on the web at https://example.com/text-url`;
    expect(extractSourceUrl(html, rawText)).toBe(
      "https://example.com/html-url"
    );
  });

  // ── Substack: open.substack.com links ─────────────────────────────

  it("extracts open.substack.com article link", () => {
    const html = `<a href="https://open.substack.com/pub/topdownchartspro/p/weekly-report">READ IN APP</a>`;
    expect(extractSourceUrl(html)).toBe(
      "https://open.substack.com/pub/topdownchartspro/p/weekly-report"
    );
  });

  it("extracts direct substack.com/p/ post link", () => {
    const html = `<a href="https://newsletter.doomberg.com/p/energy-crisis-ahead">Read more</a>
      <a href="https://doomberg.substack.com/p/energy-crisis-ahead">Post link</a>`;
    // The substack.com/p/ pattern matches
    expect(extractSourceUrl(html)).toBe(
      "https://doomberg.substack.com/p/energy-crisis-ahead"
    );
  });

  // ── Cross-publication guard (2026-06 Sharp Text → soapboxtrade bug) ─
  // Sharp Text (sender @sharptext.net, a Ghost site) had no matching HTML
  // "view in browser" anchor, so extraction grabbed an in-body editorial link
  // to ANOTHER author's Substack post. With the sender known, that bare
  // substack link must be rejected and the canonical URL recovered from the
  // plaintext "View in browser" line instead.
  it("does NOT grab an in-body substack link from a different publication", () => {
    const html = `<div>Great piece by Soapbox: <a href="https://soapboxtrade.substack.com/p/chinas-export-surge">read it</a></div>`;
    const text = `A closer look at Europe.\n\nView in browser ( https://sharptext.net/2026/europes-final-warning/?access_token=abc )\n\nbody`;
    const sender = "Andrew Sharp <email@sharptext.net>";
    // (access_token in the fixture URL is stripped by cleanUrl — see the
    // credential-stripping tests below; what matters here is the DOMAIN.)
    expect(extractSourceUrl(html, text, sender)).toBe(
      "https://sharptext.net/2026/europes-final-warning/"
    );
  });

  it("still extracts a substack post link when the SENDER is on substack.com", () => {
    const html = `<a href="https://thebignewsletter.substack.com/p/the-big-one">Read</a>`;
    const sender = "Big Newsletter <newsletter@substack.com>";
    expect(extractSourceUrl(html, null, sender)).toBe(
      "https://thebignewsletter.substack.com/p/the-big-one"
    );
  });

  it("recovers the canonical URL from a plaintext 'View in browser' line", () => {
    const text = `Headline\n\nView in browser ( https://sharptext.net/2026/foo/ )\n\nbody`;
    expect(extractSourceUrl(null, text, "x@sharptext.net")).toBe(
      "https://sharptext.net/2026/foo/"
    );
  });

  // ── Ghost: /r/{hash} redirect links ───────────────────────────────

  it("extracts MBI Deep Dives article link (3rd /r/ link)", () => {
    const html = `
      <a href="https://www.mbi-deepdives.com/r/abc123?m=uuid1">Logo</a>
      <a href="https://www.mbi-deepdives.com/r/def456?m=uuid2">MBI Deep Dives</a>
      <a href="https://www.mbi-deepdives.com/r/ghi789?m=uuid3">AI Economics in the East</a>
    `;
    expect(extractSourceUrl(html)).toBe(
      "https://www.mbi-deepdives.com/r/ghi789?m=uuid3"
    );
  });

  it("extracts The Diff article link (3rd /r/ link)", () => {
    const html = `
      <a href="https://www.thediff.co/r/aaa111?m=sub1">Logo</a>
      <a href="https://www.thediff.co/r/bbb222?m=sub2">The Diff</a>
      <a href="https://www.thediff.co/r/ccc333?m=sub3">Trade Wars and Capital Flows</a>
    `;
    expect(extractSourceUrl(html)).toBe(
      "https://www.thediff.co/r/ccc333?m=sub3"
    );
  });

  it("does not extract Ghost link if fewer than 3 matches", () => {
    const html = `
      <a href="https://www.mbi-deepdives.com/r/abc123?m=uuid1">Logo</a>
      <a href="https://www.mbi-deepdives.com/r/def456?m=uuid2">MBI Deep Dives</a>
    `;
    // Only 2 matches, not enough — should fall through to null
    expect(extractSourceUrl(html)).toBeNull();
  });

  // ── URL cleaning ──────────────────────────────────────────────────

  it("decodes HTML entities in URLs", () => {
    const html = `<a href="https://example.com/article?a=1&amp;b=2">View in browser</a>`;
    expect(extractSourceUrl(html)).toBe("https://example.com/article?a=1&b=2");
  });

  it("strips fromEmail tracking param", () => {
    const html = `<a href="https://vitalknowledge.net/article/test?fromEmail=1">View</a>`;
    // VK pattern matches first
    expect(extractSourceUrl(html)).toBe(
      "https://vitalknowledge.net/article/test"
    );
  });

  it("strips a personal access_token credential from the URL", () => {
    // Stratechery "view in browser" links embed the subscriber's JWT as
    // ?access_token=… — a credential that must never be stored or mailed
    // onward (the 7/20 digest cc'd it to a second recipient).
    const html = `<a href="https://stratechery.com/2026/whos-afraid/?access_token=eyJhb_Gci.abc_def">View in browser</a>`;
    expect(extractSourceUrl(html)).toBe("https://stratechery.com/2026/whos-afraid/");
  });

  it("strips access_token while preserving other query params", () => {
    const html = `<a href="https://example.com/post?a=1&amp;access_token=secret123&amp;b=2">Read online</a>`;
    expect(extractSourceUrl(html)).toBe("https://example.com/post?a=1&b=2");
  });
});
