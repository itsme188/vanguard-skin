/**
 * A synthetic email shaped like a Substack post whose figures are all images
 * (the TMT Breakout "Buyside Bogeys" shape, 2026-10-21): a hidden preheader
 * padded with thousands of invisible characters, a "View in browser" header
 * link, an avatar, icon buttons, one <figure> screenshot per day with
 * Substack's data-attrs JSON, a footer with a "Start your Substack" button,
 * and open-tracking pixels. Synthetic hosts' image ids, tickers and text only.
 */

export const POST_MEDIA = "https://substack-post-media.s3.amazonaws.com/public/images";

export const IMG_DAY1 = `${POST_MEDIA}/00000000-aaaa-4000-8000-000000000001_1456x1411.png`;
export const IMG_DAY2 = `${POST_MEDIA}/00000000-aaaa-4000-8000-000000000002_1456x2631.png`;

function cdn(original: string, transforms = "$s_!abcd!,w_1100,c_limit,f_auto,q_auto:good,fl_progressive:steep"): string {
  return `https://substackcdn.com/image/fetch/${transforms}/${encodeURIComponent(original)}`;
}

function figure(original: string): string {
  const dataAttrs = JSON.stringify({ src: original, height: 1411, width: 1456, type: "image/png", alt: null })
    .replace(/"/g, "&quot;");
  return `<div class="captioned-image-container-static"><figure style="width: 100%;margin: 0 auto;"><table class="image-wrapper" width="100%"><tbody><tr><td></td><td class="content" align="left" width="1456"><a class="image-link" href="https://substack.com/redirect/x"><img class="wide-image" data-attrs="${dataAttrs}" alt="" width="550" height="533.0013736263736" src="${cdn(original)}" style="display: block;width: auto !important;"></a></td><td></td></tr></tbody></table></figure></div>`;
}

const ICON = (name: string) =>
  `<img class="icon" src="${cdn(`https://substack.com/icon/${name}?v=4&height=36`, "$s_!icon!,w_36,c_scale,f_png")}" width="18" height="18" alt="">`;

const PIXEL = `<img src="https://eotrx.substackcdn.com/o/abc/p.gif?token=t" alt="" width="1" height="1" border="0" style="height:1px !important;width:1px !important;"/>`;

/** The full raw email HTML, as Gmail hands it over. */
export function substackImageOnlyEmail(): string {
  const padding = "&#847; &nbsp; &#8199; &#173;".repeat(220);
  return `<html><head><title>Desk Bogeys: ACME, ZETA</title><style>.x{color:red}</style></head><body>${PIXEL}
<div class="preview" style="display:none;">Week of 10/19</div><div class="preview" style="display:none;">${padding}</div>
<table class="email-body-container" width="100%"><tbody><tr><td></td><td class="content" width="550"><div>
<table width="100%"><tbody><tr><td align="right"><span><a href="https://substack.com/redirect/2/abc">View in browser</a></span></td></tr></tbody></table>
<div class="post typography"><h1><a href="https://substack.com/app-link/post?x=1">Desk Bogeys: ACME, ZETA</a></h1><h3>Week of 10/19</h3>
<a href="https://substack.com/@desk"><img class="custom-css-email-avatar" src="${cdn(`${POST_MEDIA}/avatar-0000_617x617.png`, "$s_!av!,f_auto")}" width="40" height="40"></a>
<a class="email-icon-button" href="https://substack.com/like">${ICON("LucideHeart")}</a>
<a class="email-icon-button" href="https://substack.com/share">${ICON("LucideShare2")}</a>
</div>
<div class="post typography"><div class="body markup">
<h3><strong>Tuesday 10/20: ACME, ZETA</strong></h3>${figure(IMG_DAY1)}<hr>
<h3><strong>Wednesday 10/21: OTHR</strong></h3>${figure(IMG_DAY2)}
<p>Feedback welcome&#8230;</p></div></div>
<div class="postscript"><p><em>Copyright &#169; 2026 Desk Letter. All rights reserved.</em></p></div>
<div class="footer"><p>&#169; 2026 Desk Letter<br>548 Example Street, Somewhere, CA 94104 <br><a href="https://substack.com/redirect/unsub">Unsubscribe</a></p>
<p><a href="https://substack.com/signup"><img src="${cdn("https://substack.com/img/email/start-your-substack-button@2x.png", "$s_!btn!,w_366,c_limit,f_auto")}" width="183" alt="Start your Substack" height="40"></a></p></div>
</div></td><td></td></tr></tbody></table>${PIXEL}<img width="1" height="1" alt="" src="https://email.mg1.substack.com/o/eJx"></body></html>`;
}

/** The email's plain-text part: headings only, no figures. */
export const SUBSTACK_IMAGE_ONLY_TEXT =
  "View this post on the web at https://example.test/p/desk-bogeys\n\nTuesday 10/20: ACME, ZETA\nWednesday 10/21: OTHR\nFeedback welcome...\n" +
  " Desk prose that exists only to clear the two-hundred-character floor the scan query enforces on a newsletter body.".repeat(2);

/** Smallest valid-looking PNG / JPEG / WebP headers for the byte sniffer. */
export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
export const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
export const WEBP_BYTES = Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ", "latin1");
