/**
 * Extract a per-article source URL from newsletter raw HTML.
 *
 * Strategy (in priority order):
 * 1. Find anchor tags with "view in browser" / "read online" text
 * 2. Find direct article URLs for known newsletter domains
 *
 * Returns null if no usable URL is found.
 */
export function extractSourceUrl(rawHtml: string | null): string | null {
  if (!rawHtml) return null;

  // 1. Look for "View in browser" / "Read online" style links
  const viewInBrowserMatch = rawHtml.match(
    /<a[^>]*href="([^"]+)"[^>]*>[^<]*?(?:view[^<]*?browser|read\s+online|view\s+(?:this\s+)?(?:email|message)\s+(?:in|on)\s+(?:your\s+)?(?:browser|web)|open\s+in\s+browser)[^<]*?<\/a>/i
  );
  if (viewInBrowserMatch) {
    return cleanUrl(viewInBrowserMatch[1]);
  }

  // Also check href after the link text (some newsletters put the text before href)
  const altMatch = rawHtml.match(
    /<a[^>]*?>[^<]*?(?:view[^<]*?browser|read\s+online)[^<]*?<\/a>/i
  );
  if (altMatch) {
    const hrefMatch = altMatch[0].match(/href="([^"]+)"/);
    if (hrefMatch) return cleanUrl(hrefMatch[1]);
  }

  // 2. Known domain-specific article URL patterns
  // Vital Knowledge: direct article links (no "view in browser" text)
  const vkMatch = rawHtml.match(
    /href="(https?:\/\/(?:www\.)?vitalknowledge\.net\/article\/[^"]+)"/i
  );
  if (vkMatch) return cleanUrl(vkMatch[1]);

  return null;
}

/** Strip common tracking parameters and decode entities. */
function cleanUrl(url: string): string {
  // Decode HTML entities
  url = url.replace(/&amp;/g, "&");
  // Strip fromEmail tracking param (VK adds ?fromEmail=1)
  url = url.replace(/[?&]fromEmail=\d+/, "");
  // Remove trailing ? if params were stripped
  url = url.replace(/\?$/, "");
  return url;
}
