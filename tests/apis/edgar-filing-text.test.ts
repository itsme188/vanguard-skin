// tests/apis/edgar-filing-text.test.ts
//
// Pins the EDGAR filing-text cleanup pipeline (deep-QA finding
// security-detail-transcripts--edgar-8k-raw-entities-*): numeric HTML
// character references must decode (EDGAR leans on &#160;/&#8217;/&#9744;),
// and the inline-XBRL <ix:header>/<ix:hidden> metadata block must be removed
// BEFORE tag-stripping — otherwise the transcript opens with a mashed prefix
// like "hood-202604280001783879FALSE00017838792026-04-28...".
import { describe, it, expect } from "vitest";
import {
  decodeFilingEntities,
  stripXbrlHeader,
  stripFilingHtml,
} from "@/lib/apis/edgar";

describe("decodeFilingEntities", () => {
  it("decodes decimal numeric references", () => {
    expect(decodeFilingEntities("A&#160;B")).toBe("A B"); // NBSP normalized to plain space
    expect(decodeFilingEntities("it&#8217;s")).toBe("it’s");
    expect(decodeFilingEntities("&#9744; Check")).toBe("☐ Check");
  });

  it("decodes hex numeric references", () => {
    expect(decodeFilingEntities("&#xA0;")).toBe(" "); // NBSP normalized to plain space
    expect(decodeFilingEntities("&#x2019;")).toBe("’");
  });

  it("decodes the named entity set", () => {
    expect(decodeFilingEntities("Barnes &amp; Noble &lt;tag&gt; &quot;q&quot; &apos;a&apos;&nbsp;end")).toBe(
      'Barnes & Noble <tag> "q" \'a\' end'
    );
  });

  it("leaves invalid code points untouched instead of throwing", () => {
    expect(decodeFilingEntities("&#1114112;")).toBe("&#1114112;");
  });
});

describe("stripXbrlHeader", () => {
  it("removes ix:header blocks including hidden machine metadata", () => {
    const html =
      '<html><ix:header><ix:hidden><ix:nonNumeric name="dei:EntityCentralIndexKey">0001783879</ix:nonNumeric>hood-20260428FALSE</ix:hidden></ix:header><body><p>UNITED STATES</p></body></html>';
    const out = stripXbrlHeader(html);
    expect(out).not.toContain("0001783879");
    expect(out).not.toContain("hood-20260428");
    expect(out).toContain("UNITED STATES");
  });
});

describe("stripFilingHtml (end-to-end cleanup)", () => {
  it("produces readable text from an inline-XBRL 8-K shaped document", () => {
    const html = [
      "<html>",
      "<ix:header><ix:hidden>hood-202604280001783879FALSE00017838792026-04-28</ix:hidden></ix:header>",
      "<body>",
      "<div>UNITED STATES</div>",
      "<div>SECURITIES AND EXCHANGE COMMISSION</div>",
      "<p>Washington, D.C.&#160;20549</p>",
      "<p>The Company&#8217;s results&nbsp;follow.</p>",
      "</body></html>",
    ].join("");
    const out = stripFilingHtml(html);
    expect(out).not.toContain("&#160;");
    expect(out).not.toContain("&#8217;");
    expect(out).not.toContain("hood-20260428");
    expect(out).not.toContain("UNITED STATESSECURITIES");
    expect(out).toContain("Washington, D.C. 20549");
    expect(out).toContain("The Company’s results follow.");
  });
});
