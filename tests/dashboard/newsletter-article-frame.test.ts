import { describe, it, expect } from "vitest";
import {
  buildNewsletterSrcDoc,
  type ReaderTokens,
} from "@/app/dashboard/components/NewsletterArticleFrame";

const TOKENS: ReaderTokens = {
  fontSans: "'IBM Plex Sans', sans-serif",
  fontMono: "'IBM Plex Mono', monospace",
  ink: "#1a1611",
  inkDim: "#3d362c",
  inkFaint: "#7a6f5d",
  edge: "#e2d9c8",
  blue: "#1f5b99",
  gold: "#b07d10",
  raised: "#f3ecdd",
};

describe("buildNewsletterSrcDoc", () => {
  it("wraps the email body in a complete standalone document", () => {
    const doc = buildNewsletterSrcDoc("<p>Hello market</p>", TOKENS);
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain('<meta charset="utf-8">');
    expect(doc).toContain("<p>Hello market</p>");
  });

  it("links open in a new tab via <base target>", () => {
    const doc = buildNewsletterSrcDoc("<a href='https://x.test'>x</a>", TOKENS);
    expect(doc).toContain('<base target="_blank">');
  });

  it("resolves theme tokens to concrete values — no var() references survive (iframe docs inherit no custom properties)", () => {
    const doc = buildNewsletterSrcDoc("<p>x</p>", TOKENS);
    expect(doc).toContain("#3d362c"); // body color = inkDim
    expect(doc).toContain("'IBM Plex Sans'");
    expect(doc).not.toMatch(/var\(--/);
  });

  it("keeps a hostile email <style> block inside the framed document verbatim (isolation is the iframe boundary, not stripping)", () => {
    const hostile =
      "<style>a { color: blue !important } html { background: #fff }</style><p>body</p>";
    const doc = buildNewsletterSrcDoc(hostile, TOKENS);
    // The style block lands INSIDE the srcDoc body — a separate document —
    // so it can never reach the app's DOM.
    expect(doc).toContain(hostile);
  });
});
