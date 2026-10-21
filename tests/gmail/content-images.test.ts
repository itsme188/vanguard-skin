/**
 * Content images in newsletter HTML (2026-10-21). An image-only Substack post
 * (every figure a screenshot) was stored cut off at its "View in browser"
 * header link, so the bogey scan never saw a single image. These tests pin:
 *   - the sanitizer keeps the post body and its images behind a long preheader;
 *   - the sanitizer's pixel filter no longer eats width="1456"-style images;
 *   - only content images are picked (no pixels, avatars, icons, buttons);
 *   - the original upload is preferred (data-attrs, else the unwrapped CDN URL).
 */
import { describe, it, expect } from "vitest";
import { extractContentImageUrls, unwrapSubstackCdnUrl } from "@/lib/gmail/content-images";
import { normalizeNewsletterHtml, sanitizeNewsletterHtml } from "@/lib/gmail/sanitize";
import { IMG_DAY1, IMG_DAY2, substackImageOnlyEmail } from "../helpers/substack-email-fixture";

const stored = () => normalizeNewsletterHtml(sanitizeNewsletterHtml(substackImageOnlyEmail()));

describe("stored newsletter HTML keeps the post body", () => {
  it("a long preheader no longer lets the header's 'View in browser' link cut the post off", () => {
    const html = stored();
    expect(html).toContain("Tuesday 10/20: ACME, ZETA");
    expect(html).toContain("Wednesday 10/21: OTHR");
    expect(html).toContain("<figure");
    // The footer is still trimmed.
    expect(html).not.toContain("Unsubscribe");
  });

  it("the tracking-pixel filter removes 1px images but not images whose size merely starts with 1", () => {
    const out = sanitizeNewsletterHtml(
      `<p>a<img src="https://x.test/p.gif" width="1" height="1"></p>` +
        `<p>b<img src="https://x.test/zero.gif" width="0" height="0"></p>` +
        `<p>c<img src="https://x.test/chart.png" width="1456" height="1411"></p>` +
        `<p>d<img src="https://x.test/wide.png" width="100" height="120"></p>`,
    );
    expect(out).not.toContain("p.gif");
    expect(out).not.toContain("zero.gif");
    expect(out).toContain("chart.png");
    expect(out).toContain("wide.png");
  });
});

describe("extractContentImageUrls", () => {
  it("raw Gmail HTML: picks the figure images by their data-attrs original, nothing else", () => {
    expect(extractContentImageUrls(substackImageOnlyEmail())).toEqual([IMG_DAY1, IMG_DAY2]);
  });

  it("stored (sanitized) HTML has no data-attrs: the CDN URL is unwrapped to the same original", () => {
    expect(stored()).not.toContain("data-attrs");
    expect(extractContentImageUrls(stored())).toEqual([IMG_DAY1, IMG_DAY2]);
  });

  it("excludes pixels, avatars, icons and buttons even when they sit in a figure or are wide", () => {
    const html =
      `<figure><img src="https://eotrx.substackcdn.com/o/x/p.gif" width="1" height="1"></figure>` +
      `<figure><img class="avatar" src="https://cdn.example.test/a.png"></figure>` +
      `<figure><img src="https://substackcdn.com/image/fetch/w_36/https%3A%2F%2Fsubstack.com%2Ficon%2FLucideHeart" width="18"></figure>` +
      `<img src="https://substackcdn.com/image/fetch/w_366/https%3A%2F%2Fsubstack.com%2Fimg%2Femail%2Fbutton%402x.png" width="400">` +
      `<img src="https://cdn.example.test/logo-wide.png" width="600">`;
    expect(extractContentImageUrls(html)).toEqual([]);
  });

  it("a wide image outside a figure counts; a small or size-less one outside a figure does not", () => {
    const html =
      `<p><img src="https://cdn.example.test/table.png" width="600" height="400"></p>` +
      `<p><img src="https://cdn.example.test/inline.png"></p>` +
      `<p><img src="https://cdn.example.test/thumb.png" width="120" height="120"></p>`;
    expect(extractContentImageUrls(html)).toEqual(["https://cdn.example.test/table.png"]);
  });

  it("returns https URLs only, de-duplicated, and never throws on junk", () => {
    const html =
      `<figure><img src="http://cdn.example.test/a.png"></figure>` +
      `<figure><img src="https://cdn.example.test/b.png"></figure>` +
      `<figure><img src="https://cdn.example.test/b.png"></figure>` +
      `<figure><img data-attrs="{not json" src="https://cdn.example.test/c.png"></figure><img src=`;
    expect(extractContentImageUrls(html)).toEqual(["https://cdn.example.test/b.png", "https://cdn.example.test/c.png"]);
    expect(extractContentImageUrls(null)).toEqual([]);
  });
});

describe("unwrapSubstackCdnUrl", () => {
  it("returns the original upload a fetch URL names, else null", () => {
    expect(
      unwrapSubstackCdnUrl(`https://substackcdn.com/image/fetch/$s_!x!,w_1100/${encodeURIComponent(IMG_DAY1)}`),
    ).toBe(IMG_DAY1);
    expect(unwrapSubstackCdnUrl("https://substackcdn.com/image/fetch/w_1100/http%3A%2F%2Fx.test%2Fa.png")).toBeNull();
    expect(unwrapSubstackCdnUrl("https://cdn.example.test/image/fetch/x/https%3A%2F%2Fx.test%2Fa.png")).toBeNull();
  });
});
