/**
 * Content images in a newsletter's HTML (2026-10-21).
 *
 * Some authors send every figure as a picture: TMT Breakout's "Buyside Bogeys"
 * posts one screenshot per day and almost no text. The newsletter bogey scan
 * reads those pictures (lib/earnings/newsletter-images.ts); this module only
 * finds them. Pure: no network, no database.
 *
 * What counts as content:
 *   - an image inside a <figure> (Substack's post images), or
 *   - an image the HTML says is at least CONTENT_MIN_WIDTH wide, or
 *   - an image whose Substack `data-attrs` names the original upload.
 * What never does: tracking pixels, avatars, icons, buttons, logos, and any
 * image the HTML says is under SMALL_IMAGE_MAX px on a side.
 *
 * URL choice, best first:
 *   1. the `src` inside Substack's `data-attrs` JSON (the original upload on
 *      substack-post-media) — present in Gmail's raw HTML, dropped by the
 *      sanitizer, so stored `raw_html` never carries it;
 *   2. a substackcdn.com `/image/fetch/` URL unwrapped to the original upload it
 *      names in its last path segment (so stored HTML reaches the same file);
 *   3. the `src` as written.
 * Only https URLs are returned. Host allowlisting is the FETCHER's job.
 */

/** An image this wide or wider is content even outside a <figure>. */
export const CONTENT_MIN_WIDTH = 300;
/** An image whose stated width or height is under this is chrome (pixels, icons, avatars, buttons). */
const SMALL_IMAGE_MAX = 100;

/** URL fragments that mark chrome, matched on the lower-cased URL (raw and decoded). */
const CHROME_URL_PATTERNS: RegExp[] = [
  /substack\.com\/icon\//,
  /substack\.com\/img\//, // email buttons ("Start your Substack")
  /\/icon(?:s)?\//,
  /avatar/,
  /logo/,
  /pixel/,
  /\/p\.gif(?:\?|$)/,
  /(?:^|\/\/)eotrx\./, // Substack open tracking
  /(?:^|\/\/)email\.mg\d*\./, // Mailgun open tracking
  /track/,
];

const CHROME_CLASS = /\b(?:avatar|icon|logo|button|emoji)\b/i;

function decodeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function parseAttrs(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([a-zA-Z][a-zA-Z0-9_:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    const name = m[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, decodeAttr(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return attrs;
}

function dimension(v: string | undefined): number | null {
  if (v == null) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** The original upload a Substack `data-attrs` JSON names, when it is https. */
function dataAttrsSrc(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const src = (parsed as Record<string, unknown>).src;
      if (typeof src === "string" && isHttps(src)) return src;
    }
  } catch {
    // not JSON: fall through to the src attribute
  }
  return null;
}

/**
 * A substackcdn `/image/fetch/<transforms>/<url-encoded original>` URL names
 * its original upload in the last path segment. Returns that original when it
 * is an https URL, else null.
 */
export function unwrapSubstackCdnUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== "substackcdn.com" || !u.pathname.startsWith("/image/fetch/")) return null;
  const last = u.pathname.slice(u.pathname.lastIndexOf("/") + 1);
  if (!/^https%3A/i.test(last)) return null;
  try {
    const inner = decodeURIComponent(last);
    return isHttps(inner) ? inner : null;
  } catch {
    return null;
  }
}

function looksLikeChrome(url: string): boolean {
  const lower = url.toLowerCase();
  let decoded = lower;
  try {
    decoded = decodeURIComponent(lower);
  } catch {
    // keep the raw form
  }
  return CHROME_URL_PATTERNS.some((re) => re.test(lower) || re.test(decoded));
}

/**
 * The content images in `html`, in document order, de-duplicated. Returns []
 * for null/empty HTML. Never throws on malformed markup.
 */
export function extractContentImageUrls(html: string | null | undefined): string[] {
  if (!html) return [];
  const lower = html.toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  const tagRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const attrs = parseAttrs(m[0].slice(4));
    const src = attrs.get("src")?.trim() ?? "";
    const fromData = dataAttrsSrc(attrs.get("data-attrs"));
    if (!src && !fromData) continue;

    const width = dimension(attrs.get("width"));
    const height = dimension(attrs.get("height"));
    if ((width != null && width < SMALL_IMAGE_MAX) || (height != null && height < SMALL_IMAGE_MAX)) continue;
    if (CHROME_CLASS.test(attrs.get("class") ?? "")) continue;
    if ((src && looksLikeChrome(src)) || (fromData && looksLikeChrome(fromData))) continue;

    const at = m.index;
    const inFigure = lower.lastIndexOf("<figure", at) > lower.lastIndexOf("</figure", at);
    const wide = width != null && width >= CONTENT_MIN_WIDTH;
    if (!inFigure && !wide && !fromData) continue;

    const chosen = fromData ?? (src ? unwrapSubstackCdnUrl(src) ?? src : null);
    if (!chosen || !isHttps(chosen) || seen.has(chosen)) continue;
    seen.add(chosen);
    out.push(chosen);
  }
  return out;
}
