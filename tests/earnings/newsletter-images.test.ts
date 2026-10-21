/**
 * Fetching a newsletter's content images for the bogey scan (2026-10-21).
 * The URLs come from email HTML, so the fetcher refuses anything off the
 * allowlist, caps count and size, types by magic bytes, and never throws.
 */
import { describe, it, expect, vi } from "vitest";
import {
  fetchNewsletterImages,
  isAllowedNewsletterImageUrl,
  MAX_IMAGE_BYTES,
  MAX_NEWSLETTER_IMAGES,
  newsletterImageUrls,
  sniffImageMediaType,
  type ImageBytesFetcher,
} from "@/lib/earnings/newsletter-images";
import { CDN_DAY1, CDN_DAY2, IMG_DAY1, IMG_DAY2, JPEG_BYTES, PNG_BYTES, WEBP_BYTES, substackImageOnlyEmail } from "../helpers/substack-email-fixture";

const okFetch = (bytes: Buffer) =>
  vi.fn(async (url: string) => ({ bytes, finalUrl: url, status: 200, contentType: "image/png" })) as unknown as ImageBytesFetcher &
    ReturnType<typeof vi.fn>;

describe("isAllowedNewsletterImageUrl", () => {
  it("allows the Substack image hosts over https only", () => {
    expect(isAllowedNewsletterImageUrl(IMG_DAY1)).toBe(true);
    expect(isAllowedNewsletterImageUrl("https://substackcdn.com/image/fetch/w_1100/x.png")).toBe(true);
    expect(isAllowedNewsletterImageUrl(IMG_DAY1.replace("https:", "http:"))).toBe(false);
  });

  it("refuses other hosts, subdomains, ports and credentials", () => {
    expect(isAllowedNewsletterImageUrl("https://cdn.example.test/a.png")).toBe(false);
    expect(isAllowedNewsletterImageUrl("https://eotrx.substackcdn.com/o/x/p.gif")).toBe(false);
    expect(isAllowedNewsletterImageUrl("https://substackcdn.com.evil.test/a.png")).toBe(false);
    expect(isAllowedNewsletterImageUrl("https://substackcdn.com:8443/a.png")).toBe(false);
    expect(isAllowedNewsletterImageUrl("https://u:p@substackcdn.com/a.png")).toBe(false);
    expect(isAllowedNewsletterImageUrl("not a url")).toBe(false);
  });
});

describe("newsletterImageUrls", () => {
  it("keeps allowlisted content images, capped", () => {
    expect(newsletterImageUrls(substackImageOnlyEmail())).toEqual([CDN_DAY1, CDN_DAY2]);
    const many = Array.from({ length: 7 }, (_, i) => `<figure><img src="${IMG_DAY1}?n=${i}"></figure>`).join("");
    expect(newsletterImageUrls(many)).toHaveLength(MAX_NEWSLETTER_IMAGES);
    expect(newsletterImageUrls(`<figure><img src="https://cdn.example.test/a.png"></figure>`)).toEqual([]);
    expect(newsletterImageUrls(null)).toEqual([]);
  });
});

describe("sniffImageMediaType", () => {
  it("types by magic bytes", () => {
    expect(sniffImageMediaType(PNG_BYTES)).toBe("image/png");
    expect(sniffImageMediaType(JPEG_BYTES)).toBe("image/jpeg");
    expect(sniffImageMediaType(WEBP_BYTES)).toBe("image/webp");
    expect(sniffImageMediaType(Buffer.from("GIF89a....", "latin1"))).toBe("image/gif");
    expect(sniffImageMediaType(Buffer.from("<html>nope</html>"))).toBeNull();
  });
});

describe("fetchNewsletterImages", () => {
  it("fetches through the hardened fetcher with the allowlist, size cap and timeout", async () => {
    const fetchBytes = okFetch(PNG_BYTES);
    const r = await fetchNewsletterImages([IMG_DAY1], { fetchBytes });
    expect(r.images).toEqual([{ url: IMG_DAY1, mediaType: "image/png", data: new Uint8Array(PNG_BYTES) }]);
    expect(r.failures).toEqual([]);
    const opts = fetchBytes.mock.calls[0][1];
    expect(opts.maxBytes).toBe(MAX_IMAGE_BYTES);
    expect(opts.timeoutMs).toBeGreaterThan(0);
    // The host check is applied per redirect hop by the fetcher itself.
    expect(opts.allowHost("substack-post-media.s3.amazonaws.com")).toBe(true);
    expect(opts.allowHost("169.254.169.254")).toBe(false);
    expect(opts.allowHost("evil.example.test")).toBe(false);
  });

  it("refuses an off-allowlist URL without fetching it", async () => {
    const fetchBytes = okFetch(PNG_BYTES);
    const r = await fetchNewsletterImages(["https://cdn.example.test/a.png", IMG_DAY1], { fetchBytes });
    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(fetchBytes.mock.calls[0][0]).toBe(IMG_DAY1);
    expect(r.images).toHaveLength(1);
    expect(r.failures).toEqual(["host not on the newsletter image allowlist"]);
  });

  it("a fetch error or non-image bytes is a counted failure, never a throw", async () => {
    const fetchBytes = vi.fn(async (url: string) => {
      if (url === IMG_DAY1) throw new Error("newsletter image: HTTP 404 for https://…");
      return { bytes: Buffer.from("<html>"), finalUrl: url, status: 200, contentType: "text/html" };
    }) as unknown as ImageBytesFetcher;
    const r = await fetchNewsletterImages([IMG_DAY1, IMG_DAY2], { fetchBytes });
    expect(r.images).toEqual([]);
    expect(r.expected).toBe(2);
    expect(r.failures).toHaveLength(2);
    expect(r.failures[0]).toMatch(/404/);
    expect(r.failures[1]).toMatch(/not a PNG/);
  });

  it("a bounded CDN PNG that is too big or unreadable is retried once as JPEG", async () => {
    const seen: string[] = [];
    const fetchBytes = vi.fn(async (url: string) => {
      seen.push(url);
      if (url.includes(",f_png,")) throw new Error("newsletter image: content-length 9000000 exceeds 3750000-byte cap");
      return { bytes: JPEG_BYTES, finalUrl: url, status: 200, contentType: "image/jpeg" };
    }) as unknown as ImageBytesFetcher;
    const r = await fetchNewsletterImages([CDN_DAY1], { fetchBytes });
    expect(seen).toEqual([CDN_DAY1, CDN_DAY1.replace(",f_png,", ",f_jpg,")]);
    expect(r.images).toEqual([{ url: CDN_DAY1, mediaType: "image/jpeg", data: new Uint8Array(JPEG_BYTES) }]);
    expect(r.failures).toEqual([]);
  });

  it("a non-CDN URL is never retried", async () => {
    const fetchBytes = vi.fn(async () => {
      throw new Error("HTTP 404");
    }) as unknown as ImageBytesFetcher & ReturnType<typeof vi.fn>;
    const r = await fetchNewsletterImages([IMG_DAY1], { fetchBytes });
    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(r.failures).toHaveLength(1);
  });

  it("fetches at most MAX_NEWSLETTER_IMAGES", async () => {
    const fetchBytes = okFetch(JPEG_BYTES);
    const urls = Array.from({ length: 6 }, (_, i) => `${IMG_DAY1}?n=${i}`);
    const r = await fetchNewsletterImages(urls, { fetchBytes });
    expect(fetchBytes).toHaveBeenCalledTimes(MAX_NEWSLETTER_IMAGES);
    expect(r.images).toHaveLength(MAX_NEWSLETTER_IMAGES);
  });
});
