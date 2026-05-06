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

  // Strip trailing whitespace, standalone hr/br, and orphan OPENING block
  // tags (<div>, <table>, etc. with no matching close because they wrapped
  // the now-removed footer). Closing tags are preserved — they're the
  // natural end of the body content above the footer, and stripping them
  // breaks balanced HTML that the normalizer needs to unwrap properly.
  result = result.replace(
    /(?:\s|<(?:br|hr)\s*\/?>|<(?:p|div|span|table|tbody|thead|tfoot|tr|td|th|caption)\b[^>]*>)+$/gi,
    ""
  );

  return result.trim();
}

function escapeAttr(value: string): string {
  return value
    // Only escape `&` that isn't already part of a valid entity. Without
    // this guard, re-running the sanitizer on already-sanitized HTML
    // (e.g. via the backfill script) doubles `&amp;` to `&amp;amp;` on
    // every pass — a chronic 8-byte-per-run growth bug.
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Normalize sanitized newsletter HTML for readability. Sanitizer handles
 * security cleanup (script/style/tracker removal). This pass handles the
 * layout-only noise that surface as wasted vertical space and "random
 * lines" — empty wrapper tags, hr/br runs, single-link CTA paragraphs,
 * pure-layout tables, and the leading "View this email in your browser"
 * publication chrome.
 *
 * Idempotent. Safe to call multiple times. Operates on already-sanitized
 * input — do NOT call on raw email HTML.
 */
export function normalizeNewsletterHtml(html: string): string {
  if (!html) return html;
  let result = html;
  result = stripPreheader(result);
  result = stripPublicationChrome(result);
  result = collapseEmptyBlocks(result);
  result = collapseHrBrRuns(result);
  result = stripLinkOnlyCtaParagraphs(result);
  result = unwrapLayoutTables(result);
  result = trimTrailingStructural(result);
  result = result.trim();
  return result;
}

/**
 * Strip leading "preheader" / inbox-preview text — a run of invisible
 * characters (zero-width spaces, soft hyphens, combining grapheme joiners,
 * &nbsp;) that newsletters insert at the very top of the message body to
 * pad out the email-client inbox preview. The sanitizer drops the
 * `style="display:none"` that originally hid them, so they become
 * visible chaff at the top of the rendered article.
 *
 * Heuristic: scan the first leading block element. If its text content is
 * >70% invisible chars (or contains a run of 6+ such chars), drop the
 * whole element. Otherwise leave it alone.
 */
function stripPreheader(html: string): string {
  // Match the first leading element + its content + close tag, allowing
  // for whitespace before/after.
  const leadingBlock = /^\s*<(p|div|span|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/i;
  const match = html.match(leadingBlock);
  if (!match) return html;
  const inner = match[2];
  // Decode &nbsp; to U+00A0 so the invisible-char check below counts them.
  const text = inner.replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ");
  if (!text.trim()) return html;

  let invisibleCount = 0;
  let runLength = 0;
  let hasLongRun = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isInv = isInvisibleChar(code);
    const isSpace = code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
    if (isInv) {
      invisibleCount++;
      runLength++;
      if (runLength >= 6) hasLongRun = true;
    } else if (isSpace && runLength > 0) {
      // Spaces inside a started invisible-run act as joining glue —
      // preheaders alternate ZWSP + nbsp + space repeatedly.
      runLength++;
      if (runLength >= 6) hasLongRun = true;
    } else {
      runLength = 0;
    }
  }

  if (
    (invisibleCount > 0 && invisibleCount / text.length > 0.4) ||
    hasLongRun
  ) {
    return html.slice(match.index! + match[0].length);
  }
  return html;
}

/**
 * Code points that don't render as visible glyphs and are commonly used to
 * pad email-preheader text: nbsp, soft hyphen, combining grapheme joiner,
 * the Unicode space block (U+2000–U+200A), zero-width space/joiners
 * (U+200B–U+200D), word joiner (U+2060), ideographic space (U+3000), BOM
 * (U+FEFF). Regular ASCII space is NOT counted — preheaders are detected
 * via the long-run check, which combines invisible chars with whitespace.
 */
function isInvisibleChar(code: number): boolean {
  if (code === 0x00a0 || code === 0x00ad || code === 0x034f) return true;
  if (code >= 0x2000 && code <= 0x200d) return true;
  if (code === 0x2060 || code === 0x3000 || code === 0xfeff) return true;
  return false;
}

/**
 * Newsletter chrome appears at the top of forwarded emails: a "View in
 * browser" link, masthead, date row, etc. Find the smallest block element
 * containing the marker and remove it cleanly so we don't leave orphan
 * close tags. Restricted to the head region (max 25% / 1000 chars) so we
 * don't accidentally eat real article content that happens to mention
 * "view in browser".
 */
function stripPublicationChrome(html: string): string {
  const headLen = Math.max(1000, Math.floor(html.length * 0.25));
  const headRegion = html.slice(0, headLen);
  const markerRegex =
    /(?:view\s+(?:this\s+)?(?:email|message)?\s*in\s+(?:your\s+)?(?:browser|web\s+browser)|web\s+version|open\s+in\s+browser|trouble\s+(?:viewing|reading))/i;
  if (!markerRegex.test(headRegion)) return html;

  // Walk all block elements in the head region; pick the earliest-starting
  // one whose content contains the marker. This drops the entire block
  // (open + content + close) so no orphan tags remain.
  const blockRegex = /<(p|div|h[1-6]|td|tr|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let earliestStart = -1;
  let earliestEnd = -1;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(headRegion)) !== null) {
    if (markerRegex.test(match[2])) {
      if (earliestStart < 0 || match.index < earliestStart) {
        earliestStart = match.index;
        earliestEnd = match.index + match[0].length;
      }
    }
  }
  if (earliestEnd < 0) return html;
  return html.slice(0, earliestStart) + html.slice(earliestEnd);
}

/**
 * Iteratively remove block elements (p, div, span) whose content is purely
 * whitespace — including &nbsp;, <br>, and other empties. Email templating
 * engines nest these 2–3 deep for layout padding; one pass isn't enough.
 */
function collapseEmptyBlocks(html: string): string {
  const emptyPattern =
    /<(p|div|span)\b[^>]*>(?:\s|&nbsp;|<br\s*\/?>)*<\/\1>/gi;
  let prev: string;
  let cur = html;
  let passes = 0;
  do {
    prev = cur;
    cur = cur.replace(emptyPattern, "");
    passes++;
  } while (cur !== prev && passes < 5);
  return cur;
}

/**
 * Newsletters often place 3-5 consecutive `<hr>` between sections, or
 * stack `<br><br><br>` for fake paragraph spacing. Collapse runs of either.
 */
function collapseHrBrRuns(html: string): string {
  // Multiple consecutive <hr> (with optional whitespace between) → 1
  let result = html.replace(/(?:\s*<hr\s*\/?>\s*){2,}/gi, "<hr />");
  // 3+ consecutive <br> → 2 (keep one paragraph break)
  result = result.replace(/(?:\s*<br\s*\/?>\s*){3,}/gi, "<br /><br />");
  return result;
}

/**
 * A `<p>` containing only a single short link with a generic CTA label
 * ("Read more", "View online", "Click here") is layout chrome, not
 * content. Drop it.
 *
 * Conservative: requires the entire visible text to match the CTA pattern.
 * Won't drop "Read more about <a>NVDA's earnings</a> in our coverage."
 */
function stripLinkOnlyCtaParagraphs(html: string): string {
  return html.replace(
    /<p\b[^>]*>\s*(?:<(?:strong|em|b|i|u)\b[^>]*>\s*)*<a\b[^>]*>([^<]{1,40})<\/a>(?:\s*<\/(?:strong|em|b|i|u)>)*\s*<\/p>/gi,
    (match, linkText: string) => {
      const text = linkText.trim();
      if (
        /^(read more|view (more|all|online|details?)|visit (our )?(site|website)|continue reading|click here|learn more|see (more|details?)|read on|full (article|story)|get started|subscribe|sign up|share)\.?$/i.test(
          text,
        )
      ) {
        return "";
      }
      return match;
    },
  );
}

/**
 * Tables with a single row and single cell are pure visual padding,
 * inherited from the email's layout-table HTML. Unwrap them down to the
 * inner content. Iterative — emails nest these. The negative lookahead on
 * the inner content prevents accidentally matching across multi-row /
 * multi-column tables (which are real data and must be preserved).
 */
function unwrapLayoutTables(html: string): string {
  const pattern =
    /<table\b[^>]*>\s*(?:<tbody[^>]*>)?\s*<tr\b[^>]*>\s*<td\b[^>]*>((?:(?!<(?:tr|td|table)\b)[\s\S])*?)<\/td>\s*<\/tr>\s*(?:<\/tbody>)?\s*<\/table>/gi;
  let prev: string;
  let cur = html;
  let passes = 0;
  do {
    prev = cur;
    cur = cur.replace(pattern, "$1");
    passes++;
  } while (cur !== prev && passes < 5);
  return cur;
}

/**
 * After cleanup, the document often ends with trailing whitespace,
 * standalone `<hr>`/`<br>`, or orphan opening structural tags (e.g. a
 * `<div>` whose closing got eaten by collapseEmptyBlocks). Strip those
 * narrowly — never touch closing tags, which are the natural end of
 * content (`<p>Body.</p>` should stay intact).
 */
function trimTrailingStructural(html: string): string {
  return html.replace(
    /(?:\s|<(?:br|hr)\s*\/?>|<(?:p|div|span|table|tbody|thead|tfoot|tr|td|th|caption|figure|figcaption)\b[^>]*>)+$/gi,
    "",
  );
}
