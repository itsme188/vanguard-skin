import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { secFilingHref, isFilingRow } from "@/lib/transcripts/presentation";

const read = (p: string) => readFileSync(p, "utf8");

describe("secFilingHref guard", () => {
  it("accepts sec.gov https URLs", () => {
    expect(secFilingHref("https://www.sec.gov/Archives/edgar/data/1/x.htm")).toContain("sec.gov");
    expect(secFilingHref("https://sec.gov/a")).not.toBeNull();
  });
  it("rejects other hosts, look-alikes, http, empty and malformed", () => {
    expect(secFilingHref("https://evil.com/sec.gov")).toBeNull();
    expect(secFilingHref("https://sec.gov.evil.com/a")).toBeNull();
    expect(secFilingHref("https://notsec.gov/a")).toBeNull();
    expect(secFilingHref("http://www.sec.gov/a")).toBeNull();
    expect(secFilingHref("javascript:alert(1)")).toBeNull();
    expect(secFilingHref("not a url")).toBeNull();
    expect(secFilingHref("")).toBeNull();
    expect(secFilingHref(null)).toBeNull();
  });
  it("isFilingRow still keys on edgar_8k", () => {
    expect(isFilingRow({ source: "edgar_8k" })).toBe(true);
  });
});

describe("source pins", () => {
  it("TranscriptCard links the filing on the card and in the viewer", () => {
    const src = read("app/dashboard/components/TranscriptCard.tsx");
    expect(src).toContain("secFilingHref(t.filing_url)");
    expect(src).toContain("Open the filing on SEC.gov");
    expect(src).toContain('rel="noopener noreferrer"');
    expect(src.match(/\{filingLink\}|filingLink &&/g)?.length).toBeGreaterThanOrEqual(2);
  });
  it("transcript summary query selects filing_url", () => {
    expect(read("lib/queries/transcripts.ts")).toMatch(/et\.filing_url/);
  });
  it("option hub +Note passes the underlying and flags the option origin", () => {
    const src = read("app/dashboard/security/[id]/page.tsx");
    expect(src).toContain("resolveOptionUnderlying");
    expect(src).toContain("&via=option");
    expect(src).toContain("href={noteComposerHref}");
    expect(src).toContain("Open in Tax Lots →");
  });
  it("composer shows the option-note lines", () => {
    const src = read("app/dashboard/components/NotesView.tsx");
    expect(src).toContain("Notes on an option are filed under");
    expect(src).toContain("Pick the underlying security for this option note.");
  });
});
