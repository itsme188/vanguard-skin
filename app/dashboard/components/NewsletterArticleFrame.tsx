"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Sandboxed reader frame for newsletter article bodies.
 *
 * Email HTML is foreign markup: a document-global <style> block inside it
 * (blue underlined anchors, white html background) restyles the WHOLE app
 * when rendered via dangerouslySetInnerHTML (deep-QA finding — bottom nav
 * and header links flipped blue until reload). An iframe srcDoc is a hard
 * isolation boundary: the email's styles apply only to its own document.
 * Same trade as DigestEmailViewer/EarningsEmailViewer.
 *
 * sandbox: allow-same-origin (parent must read contentDocument height) but
 * NO allow-scripts — same-origin access on a script-less document is inert.
 * Links escape via <base target="_blank"> + allow-popups.
 */

/** Theme tokens the reader CSS needs, resolved to concrete values. */
export interface ReaderTokens {
  fontSans: string;
  fontMono: string;
  ink: string;
  inkDim: string;
  inkFaint: string;
  edge: string;
  blue: string;
  gold: string;
  raised: string;
}

const FALLBACK_TOKENS: ReaderTokens = {
  fontSans: "'IBM Plex Sans', system-ui, sans-serif",
  fontMono: "'IBM Plex Mono', ui-monospace, monospace",
  ink: "#1a1611",
  inkDim: "#3d362c",
  inkFaint: "#7a6f5d",
  edge: "#e2d9c8",
  blue: "#1f5b99",
  gold: "#b07d10",
  raised: "#f3ecdd",
};

function readToken(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = styles.getPropertyValue(name).trim();
  return v || fallback;
}

/** Snapshot the app's resolved theme tokens off <html>. Client-only. */
export function snapshotReaderTokens(): ReaderTokens {
  if (typeof document === "undefined") return FALLBACK_TOKENS;
  const styles = getComputedStyle(document.documentElement);
  return {
    fontSans: readToken(styles, "--font-sans", FALLBACK_TOKENS.fontSans),
    fontMono: readToken(styles, "--font-mono", FALLBACK_TOKENS.fontMono),
    ink: readToken(styles, "--color-ink", FALLBACK_TOKENS.ink),
    inkDim: readToken(styles, "--color-ink-dim", FALLBACK_TOKENS.inkDim),
    inkFaint: readToken(styles, "--color-ink-faint", FALLBACK_TOKENS.inkFaint),
    edge: readToken(styles, "--color-edge", FALLBACK_TOKENS.edge),
    blue: readToken(styles, "--color-blue", FALLBACK_TOKENS.blue),
    gold: readToken(styles, "--color-gold", FALLBACK_TOKENS.gold),
    raised: readToken(styles, "--color-raised", FALLBACK_TOKENS.raised),
  };
}

/**
 * Compose the full srcDoc: reader typography (the .prose-newsletter rules
 * with tokens resolved — an iframe document inherits no CSS custom
 * properties from its parent) + <base target="_blank"> + the email body.
 * Pure — unit-tested directly.
 */
export function buildNewsletterSrcDoc(html: string, tokens: ReaderTokens): string {
  const css = `
    html, body { margin: 0; padding: 0; background: transparent; }
    body {
      font-family: ${tokens.fontSans};
      font-size: 18px;
      line-height: 1.7;
      color: ${tokens.inkDim};
      max-width: 72ch;
      overflow-wrap: break-word;
      word-break: break-word;
    }
    p { margin: 0 0 1em; }
    p:last-child { margin-bottom: 0; }
    p:empty { display: none; }
    h1, h2, h3, h4, h5, h6 {
      color: ${tokens.ink};
      font-weight: 600;
      margin: 1.5em 0 0.5em;
      line-height: 1.3;
    }
    h1 { font-size: 1.4em; }
    h2 { font-size: 1.25em; }
    h3 { font-size: 1.1em; }
    img { max-width: min(100%, 600px); height: auto; border-radius: 6px; margin: 1.2em 0; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; margin: 1em 0; }
    td, th { padding: 6px 10px; border-bottom: 1px solid ${tokens.edge}; text-align: left; }
    th { color: ${tokens.ink}; font-weight: 600; }
    a { color: ${tokens.blue}; text-decoration: underline; text-underline-offset: 2px; }
    a:hover { color: ${tokens.gold}; }
    blockquote { border-left: 2px solid ${tokens.gold}; padding-left: 1em; margin: 1em 0; color: ${tokens.inkFaint}; }
    ul, ol { padding-left: 1.5em; margin: 0.75em 0; }
    li { margin-bottom: 0.3em; }
    pre, code { font-family: ${tokens.fontMono}; font-size: 0.9em; background: ${tokens.raised}; border-radius: 4px; }
    pre { padding: 1em; overflow-x: auto; margin: 1em 0; }
    code { padding: 0.15em 0.3em; }
    hr { border: none; border-top: 1px solid ${tokens.edge}; margin: 0.75em 0; }
  `;
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${css}</style></head><body>${html}</body></html>`;
}

export function NewsletterArticleFrame({ html }: { html: string }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(320);
  // Tokens snapshot once per mount — the frame appears on expand, so it
  // always picks up the theme active when the user opened the article.
  const [tokens] = useState<ReaderTokens>(() => snapshotReaderTokens());

  const srcDoc = useMemo(() => buildNewsletterSrcDoc(html, tokens), [html, tokens]);

  const measure = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc?.documentElement) return;
    const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
    if (h > 0) setHeight(h + 16);
  }, []);

  // Images inside the email load after the document's load event and change
  // content height; a couple of delayed re-measures cover the common case
  // without a polling loop.
  const handleLoad = useCallback(() => {
    measure();
    const t1 = window.setTimeout(measure, 600);
    const t2 = window.setTimeout(measure, 2000);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [measure]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  return (
    <iframe
      ref={iframeRef}
      title="Newsletter article"
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      onLoad={handleLoad}
      className="w-full block border-0"
      style={{ height, backgroundColor: "transparent", colorScheme: "auto" }}
    />
  );
}
