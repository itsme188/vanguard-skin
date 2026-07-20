/**
 * Extract a per-article source URL from newsletter raw HTML and/or raw text.
 *
 * Strategy (in priority order):
 * 1. Find anchor tags with "view in browser" / "read online" / "read in browser" text
 * 2. Find direct article URLs for known newsletter domains (VK, Ghost, Substack)
 * 3. Find "View this post on the web at {URL}" in raw plaintext (Substack fallback)
 * 4. Find open.substack.com article links in HTML
 *
 * `sender` (the From header) is used to reject a bare in-body `*.substack.com/p/`
 * link that belongs to a DIFFERENT publication than the one that sent the email
 * — newsletters routinely link to other authors' posts in their body, and
 * grabbing the first such link mis-attributed a Sharp Text issue to a Soapbox
 * Trade Substack post (2026-06). When the sender is provided and isn't on the
 * same registrable domain as the link, the link is skipped (and we fall back to
 * the plaintext "View in browser" URL instead).
 *
 * Returns null if no usable URL is found.
 */
export function extractSourceUrl(
  rawHtml: string | null,
  rawText?: string | null,
  sender?: string | null,
): string | null {
  if (!rawHtml && !rawText) return null;
  const senderDomain = extractSenderDomain(sender);

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

    // Substack: direct post URLs with custom domains. A bare in-body
    // substack-post link is only the article's OWN url when the sender is also
    // on substack.com; otherwise it's an editorial link to another author's
    // post (the Sharp Text → soapboxtrade.substack bug). With no sender known
    // we keep the legacy behavior.
    const substackPostMatch = rawHtml.match(
      /href="(https?:\/\/[^"]*\.substack\.com\/p\/[^"?]+)"/i
    );
    if (substackPostMatch) {
      const u = cleanUrl(substackPostMatch[1]);
      if (!senderDomain || sameRegistrableDomain(u, senderDomain)) return u;
    }
  }

  // 3. Plaintext fallbacks.
  if (rawText) {
    // 3a. "View in browser ( {URL} )" — recovers the canonical article URL when
    // the HTML anchor didn't match (Ghost / Sharp Text put it in the text head).
    const vibMatch = rawText.match(
      /view\s+(?:this\s+)?(?:email\s+|post\s+)?in\s+(?:your\s+)?browser[^\n]*?(https?:\/\/[^\s)<>"]+)/i
    );
    if (vibMatch) return cleanUrl(vibMatch[1]);

    // 3b. Substack "View this post on the web at {URL}"
    const textUrlMatch = rawText.match(
      /View this post on the web at\s+(https?:\/\/\S+)/i
    );
    if (textUrlMatch) return cleanUrl(textUrlMatch[1]);
  }

  return null;
}

/** Domain portion of a "Name <user@domain>" sender, lowercased. */
function extractSenderDomain(sender?: string | null): string {
  if (!sender) return "";
  const m = sender.match(/@([a-z0-9.-]+)/i);
  return m ? m[1].toLowerCase().replace(/[.>\s]+$/, "") : "";
}

/** Last two labels of a host — a good-enough registrable domain (no PSL). */
function registrableDomain(host: string): string {
  return host.toLowerCase().split(".").filter(Boolean).slice(-2).join(".");
}

/** True when the URL's host shares a registrable domain with the sender. */
function sameRegistrableDomain(url: string, senderDomain: string): boolean {
  try {
    return registrableDomain(new URL(url).host) === registrableDomain(senderDomain);
  } catch {
    return false;
  }
}

/** Strip common tracking parameters and decode entities. */
function cleanUrl(url: string): string {
  // Decode HTML entities
  url = url.replace(/&amp;/g, "&");
  // Strip fromEmail tracking param (VK adds ?fromEmail=1)
  url = url.replace(/[?&]fromEmail=\d+/, "");
  // Strip subscriber credentials: Stratechery-style ?access_token=<JWT>
  // grants feed/article read access to the user's subscription — it must
  // never be stored in source_url (digest emails cc other recipients; the
  // 7/20 digest mailed one out). Deliberately NOT stripping generic `token`
  // params: view-in-browser tokens are functional (the page 404s/paywalls
  // without them) and are scoped to rendering that single email.
  url = url.replace(/([?&])access_token=[^&\s]*&?/g, "$1").replace(/[?&]$/, "");
  // Remove trailing ? if params were stripped
  url = url.replace(/\?$/, "");
  return url;
}
