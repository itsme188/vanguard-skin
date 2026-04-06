/**
 * Sanitize newsletter HTML for safe rendering.
 * Allowlist-based: only known-safe tags and attributes pass through.
 * Strips scripts, styles, tracking pixels, event handlers, and newsletter chrome.
 */

const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "div", "span",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "u", "s", "sub", "sup",
  "a", "img",
  "ul", "ol", "li",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption",
  "blockquote", "pre", "code",
  "figure", "figcaption",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title"]),
  img: new Set(["src", "alt", "width", "height", "title"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
};

/** Tags whose entire content (including children) should be removed. */
const STRIP_WITH_CONTENT = new Set(["script", "style", "noscript", "svg", "iframe", "form", "input", "button", "select", "textarea"]);

export function sanitizeNewsletterHtml(html: string): string {
  let result = html;

  // 1. Remove entire blocks for dangerous tags (content included)
  for (const tag of STRIP_WITH_CONTENT) {
    result = result.replace(
      new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"),
      ""
    );
    // Self-closing variants
    result = result.replace(new RegExp(`<${tag}[^>]*/?>`, "gi"), "");
  }

  // 2. Remove HTML comments (may contain conditional IE hacks, tracking, etc.)
  result = result.replace(/<!--[\s\S]*?-->/g, "");

  // 3. Remove tracking pixels (1x1 images, hidden images)
  result = result.replace(
    /<img[^>]*(?:width\s*=\s*["']?1["']?|height\s*=\s*["']?1["']?)[^>]*\/?>/gi,
    ""
  );
  result = result.replace(
    /<img[^>]*display\s*:\s*none[^>]*\/?>/gi,
    ""
  );

  // 4. Process remaining tags — allow or strip
  result = result.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)?\/?>/g, (match, tagName, attrsStr) => {
    const tag = tagName.toLowerCase();
    const isClosing = match.startsWith("</");

    if (!ALLOWED_TAGS.has(tag)) {
      return ""; // Strip unknown tags (keep their text content)
    }

    if (isClosing) {
      return `</${tag}>`;
    }

    // Sanitize attributes
    const allowedAttrSet = ALLOWED_ATTRS[tag];
    const isSelfClosing = match.endsWith("/>");

    if (!attrsStr?.trim() || !allowedAttrSet) {
      return isSelfClosing ? `<${tag} />` : `<${tag}>`;
    }

    const safeAttrs: string[] = [];
    const attrRegex = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let attrMatch;

    while ((attrMatch = attrRegex.exec(attrsStr)) !== null) {
      const attrName = attrMatch[1].toLowerCase();
      const attrValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "";

      if (!allowedAttrSet.has(attrName)) continue;

      // Block dangerous URL schemes
      if (attrName === "href" || attrName === "src") {
        const trimmed = attrValue.trim().toLowerCase();
        if (trimmed.startsWith("javascript:") || trimmed.startsWith("data:") || trimmed.startsWith("vbscript:")) {
          continue;
        }
        // For img src, only allow https
        if (attrName === "src" && !trimmed.startsWith("https://") && !trimmed.startsWith("http://")) {
          continue;
        }
      }

      safeAttrs.push(`${attrName}="${escapeAttr(attrValue)}"`);
    }

    const attrStr = safeAttrs.length > 0 ? " " + safeAttrs.join(" ") : "";
    return isSelfClosing ? `<${tag}${attrStr} />` : `<${tag}${attrStr}>`;
  });

  // 5. Remove common newsletter footer patterns
  result = result.replace(
    /(?:<[^>]*>)*\s*(?:unsubscribe|manage\s+(?:your\s+)?(?:preferences|subscription)|view\s+(?:this\s+)?(?:email\s+)?in\s+(?:your\s+)?browser|sent\s+(?:to|by)\s+\S+@\S+)[\s\S]{0,500}$/i,
    ""
  );

  // 6. Clean up whitespace
  result = result.replace(/\n{3,}/g, "\n\n").trim();

  return result;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
