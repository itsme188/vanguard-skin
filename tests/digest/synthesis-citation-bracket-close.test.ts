import { describe, it, expect } from "vitest";
import { retainSuppliedSourceLinks } from "@/lib/digest/synthesis-editorial";
import { retainSuppliedSourceLinks as workerLinks } from "../../workers/cron/src/synthesis-editorial";
import { briefingToHtml } from "@/lib/calendar/briefing-html";
import { briefingToHtml as workerHtml } from "../../workers/cron/src/html";

// The synthesis prompt lists each source URL in square brackets
// ("- Source (bullish) [https://...]: summary"), and the model sometimes
// closes a citation with that bracket: "[Label](url]". The link regex then
// never matched, and the italics pass ran over the URL's underscore pairs,
// printing raw markdown with <em> inside the token (digest QA, 2026-11-22).
// Invented redirect URL of the real shape: ~640 chars, underscores, dashes.
const segment = "eyJlIjoiaHR0cHM6Ly9leGFtcGxlLnRlc3Qvc3Rvcnk_dXRtX3NvdXJjZT1x-ZmFrZS10b2tlbg";
const LONG_URL = `https://substack.example/redirect/2/${Array.from({ length: 8 }, (_, i) => `${segment}${i}_`).join("")}tail-0abc_9xyz`;

describe.each([
  ["Mac", retainSuppliedSourceLinks, briefingToHtml],
  ["Worker", workerLinks, workerHtml],
] as const)("%s: citation closed with a square bracket", (_side, retain, toHtml) => {
  const articles = [{ source_url: LONG_URL, website_url: null }];

  it("is repaired to a well-formed supplied link", () => {
    expect(LONG_URL.length).toBeGreaterThan(600);
    const md = `An analyst argued demand is underestimated. [Newsletter](${LONG_URL}]`;
    expect(retain(md, articles)).toBe(`An analyst argued demand is underestimated. [Newsletter](${LONG_URL})`);
  });

  it("renders as a short linked label with no emphasis inside the URL", () => {
    const md = `# Headline\n\nSubhead.\n\n## Section\n\nA claim. [Newsletter](${LONG_URL}] Another claim. [Other](https://example.test/a)`;
    const html = toHtml(retain(md, [...articles, { source_url: "https://example.test/a", website_url: null }]), "Digest");
    expect(html).toContain(`href="${LONG_URL}"`);
    expect(html).toContain(">Newsletter</a>");
    expect(html).not.toContain("<em>");
    expect(html).not.toContain("](");
  });

  it("still neutralizes an unsupplied URL closed with a square bracket", () => {
    const md = `A claim. [Newsletter](https://example.test/invented_one_two]`;
    expect(retain(md, articles)).toBe("A claim. Newsletter (source link unavailable)");
  });

  it("leaves well-formed citations unchanged", () => {
    const md = `A claim. [Newsletter](${LONG_URL}).`;
    expect(retain(md, articles)).toBe(md);
  });
});
