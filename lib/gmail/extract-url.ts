/**
 * Extract a per-article source URL from newsletter raw HTML and/or raw text.
 *
 * Strategy (in priority order):
 * 1. Find anchor tags with "view in browser" / "read online" / "read in browser" text
 * 2. Find direct article URLs for known newsletter domains (VK, Ghost, Substack)
 * 3. Find "View this post on the web at {URL}" in raw plaintext (Substack fallback)
 * 4. Find open.substack.com article links in HTML
 *
 * Returns null if no usable URL is found.
 */
export function extractSourceUrl(rawHtml: string | null, rawText?: string | null): string | null {
  if (!rawHtml && !rawText) return null;

  if (rawHtml) {
    // 1. Look for "View in browser" / "Read online" / "Read in browser" style links
    const viewInBrowserMatch = rawHtml.match(
      /<a[^>]*href="([^"]+)"[^>]*>[^<]*?(?:view[^<]*?browser|read\s+online|read\s+in\s+browser|view\s+(?:this\s+)?(?:email|message)\s+(?:in|on)\s+(?:your\s+)?(?:browser|web)|open\s+in\s+browser)[^<]*?<\/a>/i
    );
    if (viewInBrowserMatch) {
      return cleanUrl(viewInBrowserMatch[1]);
    }

    // Also check href after the link text (some newsletters put the text before href)
    const altMatch = rawHtml.match(
      /<a[^>]*?>[^<]*?(?:view[^<]*?browser|read\s+online|read\s+in\s+browser)[^<]*?<\/a>/i
    );
    if (altMatch) {
      const hrefMatch = altMatch[0].match(/href="([^"]+)"/);
      if (hrefMatch) return cleanUrl(hrefMatch[1]);
    }

    // 2. Known domain-specific article URL patterns

    // Vital Knowledge: direct article links
    const vkMatch = rawHtml.match(
      /href="(https?:\/\/(?:www\.)?vitalknowledge\.net\/article\/[^"]+)"/i
    );
    if (vkMatch) return cleanUrl(vkMatch[1]);

    // Ghost newsletters (MBI Deep Dives, The Diff): /r/{hash} redirect links
    // Skip the first two (logo + site name), take the article title link
    const ghostMatches = rawHtml.match(
      /href="(https?:\/\/(?:www\.)?(?:mbi-deepdives\.com|thediff\.co)\/r\/[^"]+)"/gi
    );
    if (ghostMatches && ghostMatches.length >= 3) {
      const hrefMatch = ghostMatches[2].match(/href="([^"]+)"/i);
      if (hrefMatch) return cleanUrl(hrefMatch[1]);
    }

    // Substack: open.substack.com/pub/{slug}/p/{slug} ("READ IN APP" links)
    const openSubstackMatch = rawHtml.match(
      /href="(https?:\/\/open\.substack\.com\/pub\/[^"?]+)"/i
    );
    if (openSubstackMatch) return cleanUrl(openSubstackMatch[1]);

    // Substack: direct post URLs with custom domains
    const substackPostMatch = rawHtml.match(
      /href="(https?:\/\/[^"]*\.substack\.com\/p\/[^"?]+)"/i
    );
    if (substackPostMatch) return cleanUrl(substackPostMatch[1]);
  }

  // 3. Plaintext fallback: Substack "View this post on the web at {URL}"
  if (rawText) {
    const textUrlMatch = rawText.match(
      /View this post on the web at\s+(https?:\/\/\S+)/i
    );
    if (textUrlMatch) return cleanUrl(textUrlMatch[1]);
  }

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
