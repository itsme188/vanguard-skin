/**
 * Fetch a newsletter's content images for the bogey scan (2026-10-21).
 *
 * Why: TMT Breakout's "Buyside Bogeys" sends every figure as a screenshot.
 * Text-only extraction read the headings, found no numbers, and booked
 * `no_numbers`. The manual upload path already reads the same screenshot
 * fine (lib/earnings/extract-bogeys.ts), so the scan now sends the pictures
 * to the model as image blocks beside the text.
 *
 * Guarantees, all enforced here (the URLs come from email HTML, so they are
 * untrusted):
 *   - https only, on an allowlist of known newsletter image hosts, checked on
 *     the first URL and on every redirect hop;
 *   - the repo's hardened fetch (`hardenedFetchBytes`): DNS pinned to a
 *     globally routable address, a timeout, at most three redirects;
 *   - at most MAX_NEWSLETTER_IMAGES images, each at most MAX_IMAGE_BYTES;
 *   - the media type is read off the bytes (PNG, JPEG, GIF, WebP), never off a
 *     header or an extension.
 * A failure never throws: the caller gets the images that worked plus a
 * count of the ones that did not, and degrades to text for the rest.
 */
import { hardenedFetchBytes } from "@/lib/print-watch/url-fetch";
import { extractContentImageUrls } from "@/lib/gmail/content-images";

/** Hosts a newsletter image may be fetched from. Exact match, no subdomains
 *  (`eotrx.substackcdn.com` is Substack's open tracker). */
export const NEWSLETTER_IMAGE_HOSTS: ReadonlySet<string> = new Set([
  "substackcdn.com",
  "substack-post-media.s3.amazonaws.com",
]);

/** Images per article (and per deep read). A day-by-day bogey post runs 3-5. */
export const MAX_NEWSLETTER_IMAGES = 4;
/**
 * Per image. The model API caps an image at 5 MB once base64-encoded, and
 * base64 grows bytes by a third: 3.75 MB of raw bytes is the most that fits.
 * The screenshots seen so far are 0.4-0.9 MB.
 */
export const MAX_IMAGE_BYTES = 3_750_000;
/** Per image; the images are fetched in parallel, so this is also the batch bound. */
export const IMAGE_FETCH_TIMEOUT_MS = 15_000;

export type NewsletterImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface NewsletterImage {
  url: string;
  mediaType: NewsletterImageMediaType;
  data: Uint8Array;
}

export interface NewsletterImageFetchResult {
  images: NewsletterImage[];
  /** URLs asked for (after the allowlist and the cap). */
  expected: number;
  /** One short reason per URL that did not produce an image. */
  failures: string[];
}

export type FetchNewsletterImagesFn = (
  urls: string[],
  opts?: { signal?: AbortSignal },
) => Promise<NewsletterImageFetchResult>;

export function isAllowedNewsletterImageHost(hostname: string): boolean {
  return NEWSLETTER_IMAGE_HOSTS.has(hostname.toLowerCase().replace(/\.+$/, ""));
}

/** https, default port, no credentials, allowlisted host. */
export function isAllowedNewsletterImageUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  return isAllowedNewsletterImageHost(u.hostname);
}

/** The images the scan would fetch for this article: content images on an
 *  allowlisted host, capped. [] means the article is read as text only. */
export function newsletterImageUrls(rawHtml: string | null | undefined): string[] {
  return extractContentImageUrls(rawHtml).filter(isAllowedNewsletterImageUrl).slice(0, MAX_NEWSLETTER_IMAGES);
}

/** Media type from the magic bytes; null when the bytes are not one the model takes. */
export function sniffImageMediaType(bytes: Uint8Array): NewsletterImageMediaType | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** Test seam: the byte fetch. Same shape as `hardenedFetchBytes`. */
export type ImageBytesFetcher = typeof hardenedFetchBytes;

export async function fetchNewsletterImages(
  urls: string[],
  opts: { signal?: AbortSignal; fetchBytes?: ImageBytesFetcher } = {},
): Promise<NewsletterImageFetchResult> {
  const fetchBytes = opts.fetchBytes ?? hardenedFetchBytes;
  const failures: string[] = [];
  const wanted: string[] = [];
  for (const url of urls) {
    if (wanted.length >= MAX_NEWSLETTER_IMAGES) break;
    if (!isAllowedNewsletterImageUrl(url)) {
      failures.push("host not on the newsletter image allowlist");
      continue;
    }
    wanted.push(url);
  }

  const settled = await Promise.all(
    wanted.map(async (url): Promise<NewsletterImage | string> => {
      try {
        const res = await fetchBytes(url, {
          label: "newsletter image",
          maxBytes: MAX_IMAGE_BYTES,
          timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
          allowHost: isAllowedNewsletterImageHost,
          headers: { Accept: "image/png,image/jpeg,image/webp,image/gif;q=0.9" },
          signal: opts.signal,
        });
        const mediaType = sniffImageMediaType(res.bytes);
        if (!mediaType) return "not a PNG, JPEG, GIF or WebP image";
        return { url, mediaType, data: new Uint8Array(res.bytes) };
      } catch (err) {
        return (err instanceof Error ? err.message : String(err)).slice(0, 200);
      }
    }),
  );

  const images: NewsletterImage[] = [];
  for (const s of settled) {
    if (typeof s === "string") failures.push(s);
    else images.push(s);
  }
  return { images, expected: urls.length === 0 ? 0 : Math.min(urls.length, MAX_NEWSLETTER_IMAGES), failures };
}
