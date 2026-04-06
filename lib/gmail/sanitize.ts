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

  // 5. Trim email footer boilerplate
  result = trimEmailFooter(result);

  // 6. Clean up whitespace
  result = result.replace(/\n{3,}/g, "\n\n").trim();

  return result;
}

/**
 * Trim email footer boilerplate from newsletter HTML (or plain text).
 * Finds the earliest footer marker in the second half of the content
 * and removes everything from that point onward.
 * Safe to call multiple times (idempotent).
 */
export function trimEmailFooter(html: string): string {
  if (!html) return html;

  const markers = [
    /(?:©|&copy;)\s*\d{4}/,                                        // © 2024 or &copy; 2024
    /all\s+rights\s+reserved/i,                                     // All Rights Reserved
    /you are receiving this\s/i,                                     // You are receiving this email/message
    /this (?:email|message) was sent/i,                              // This email was sent to
    /to\s+unsubscribe/i,                                             // To unsubscribe
    /update your (?:notification|email|subscription)/i,              // Update your notification settings
    /manage your (?:preferences|subscription)/i,                     // Manage your preferences
    /if you no longer wish/i,                                        // If you no longer wish to receive
    /got questions,?\s*feedback/i,                                   // Got questions, feedback
    /forward this (?:email|message)/i,                               // Forward this email
    /email\s+preferences/i,                                          // Email preferences
    /powered\s+by\s+\w/i,                                           // Powered by Mailchimp/etc.
    /\d{2,5}\s+\w[\w\s]*(?:street|st|ave|avenue|blvd|road|rd),/i,   // Physical addresses
    /view\s+(?:this\s+)?(?:email\s+)?in\s+(?:your\s+)?browser/i,    // View in browser
    /sent\s+(?:to|by)\s+\S+@\S+/i,                                  // Sent to/by email
  ];

  // Skip the first 20% to avoid false positives in article body.
  // Newsletter HTML is mostly layout markup (tables, divs) — actual content
  // is typically just 20-30% of the total HTML, so the footer markers
  // often appear as early as 25-40%.
  const searchFrom = Math.floor(html.length * 0.2);
  const tail = html.slice(searchFrom);
  let cutAt = html.length;

  for (const re of markers) {
    const idx = tail.search(re);
    if (idx >= 0) {
      const absIdx = searchFrom + idx;
      if (absIdx < cutAt) cutAt = absIdx;
    }
  }

  if (cutAt >= html.length) return html;

  let result = html.slice(0, cutAt);

  // If we cut inside a partial HTML tag (< with no closing >), remove it
  const lastGt = result.lastIndexOf(">");
  const lastLt = result.lastIndexOf("<");
  if (lastLt > lastGt) {
    result = result.slice(0, lastLt);
  }

  // Strip trailing layout/structural tags and whitespace — these are
  // the table/div wrappers that surrounded the now-removed footer.
  // The regex matches any opening or closing block-level tag, HRs, BRs,
  // and whitespace at the end of the string. Inline content tags like
  // <a>, <strong>, <em> are NOT in this list, so they act as a natural
  // stop — preserving the last piece of real content (e.g. "READ ONLINE</a>").
  result = result.replace(
    /(?:\s|<\/?(?:br|hr|p|div|span|table|tbody|thead|tfoot|tr|td|th|caption)(?:\s[^>]*)?\s*\/?>)+$/gi,
    ""
  );

  return result.trim();
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
