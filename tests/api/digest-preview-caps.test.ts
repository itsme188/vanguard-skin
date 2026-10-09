import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTIVE_ARTICLE_CAP, DIGEST_ARTICLE_CAP } from "@/lib/digest/daily-digest";
import { BY_COMPANY_ARTICLE_CAP } from "@/lib/digest/group-by-company";
import { capCaption } from "@/app/dashboard/components/DigestEmailViewer";

describe("digest preview caps", () => {
  const route = readFileSync(join(process.cwd(), "app/api/digest/preview/route.ts"), "utf8");

  it("every preview response carries the caps", () => {
    const responses = route.split("NextResponse.json({").length - 1;
    const withCaps = route.split("caps: CAPS,").length - 1;
    expect(responses).toBeGreaterThanOrEqual(4);
    expect(withCaps).toBe(responses);
  });

  it("the caps come from the composers' own constants", () => {
    expect(route).toContain("structured: ADAPTIVE_ARTICLE_CAP");
    expect(route).toContain("bySource: DIGEST_ARTICLE_CAP");
    expect(route).toContain("byCompany: BY_COMPANY_ARTICLE_CAP");
  });

  it("the caption names the cap of the tab on screen", () => {
    const caps = { structured: ADAPTIVE_ARTICLE_CAP, bySource: DIGEST_ARTICLE_CAP, byCompany: BY_COMPANY_ARTICLE_CAP };
    expect(capCaption("structured", caps)).toContain(String(ADAPTIVE_ARTICLE_CAP));
    expect(capCaption("by_source", caps)).toContain(String(DIGEST_ARTICLE_CAP));
    expect(capCaption("by_company", caps)).toContain(String(BY_COMPANY_ARTICLE_CAP));
    expect(capCaption("structured", null)).toBe("");
  });
});
