/**
 * Live print v2 slice B, Task 12 — the stored IR-page adapter.
 *
 * Pure string/URL work plus ONE seam (`fetchBytes`). Nothing here touches the
 * network: every page is scripted through the seam, exactly as the DJ/EDGAR
 * adapters are driven in their own suites.
 */

import { describe, it, expect, vi } from "vitest";
import {
  extractIrPageLinks,
  isAllowedIrLinkHost,
  pollIrPage,
  IR_PAGE_HEADLINE_RE,
  IR_PAGE_WIRE_HOSTS,
  IR_PAGE_MAX_TITLE_CHARS,
  type IrPageConfig,
} from "@/lib/print-watch/ir-page-adapter";
import type { FetchedBytes, HardenedFetchBytesOptions } from "@/lib/print-watch/url-fetch";

const CFG: IrPageConfig = {
  symbol: "ACME",
  irPageUrl: "https://ir.acme.example/news",
  linkMustContain: null,
};

const PAGE = `
<html><body>
<a href="/news/acme-reports-second-quarter-fiscal-2026-results">Acme Reports Second Quarter Fiscal 2026 Results</a>
<a href="https://www.businesswire.com/news/home/2026/acme-q2">Acme Announces Q2 2026 Earnings</a>
<a href="/news/acme-to-host-conference-call">Acme to Host Second Quarter Conference Call</a>
<a href="https://evil.example/acme-q2-results">Acme Q2 2026 Results (mirror)</a>
<a href="/news/acme-names-new-cfo">Acme Names New CFO</a>
</body></html>`;

/** A page server for the `fetchBytes` seam: same shape hardenedFetchBytes returns. */
function pageServer(
  body: string,
  finalUrl = CFG.irPageUrl,
): (url: string, opts: HardenedFetchBytesOptions) => Promise<FetchedBytes> {
  return async () => ({
    bytes: Buffer.from(body, "utf8"),
    finalUrl,
    status: 200,
    contentType: "text/html",
  });
}

describe("extractIrPageLinks", () => {
  it("keeps anchors matching the default earnings-headline pattern, resolves relative hrefs, dedupes", () => {
    const links = extractIrPageLinks(PAGE + PAGE, "https://ir.acme.example/news", CFG);
    expect(links).toEqual([
      {
        link: "https://ir.acme.example/news/acme-reports-second-quarter-fiscal-2026-results",
        title: "Acme Reports Second Quarter Fiscal 2026 Results",
      },
      {
        link: "https://www.businesswire.com/news/home/2026/acme-q2",
        title: "Acme Announces Q2 2026 Earnings",
      },
      { link: "https://evil.example/acme-q2-results", title: "Acme Q2 2026 Results (mirror)" },
    ]);
  });

  it("applies link_must_contain as a literal substring on text OR href", () => {
    expect(
      extractIrPageLinks(PAGE, "https://ir.acme.example/news", { ...CFG, linkMustContain: "Fiscal 2026" }),
    ).toHaveLength(1);
    expect(
      extractIrPageLinks(PAGE, "https://ir.acme.example/news", { ...CFG, linkMustContain: "businesswire" }),
    ).toHaveLength(1);
    // A literal, never a regex: ".*" matches nothing on this page.
    expect(
      extractIrPageLinks(PAGE, "https://ir.acme.example/news", { ...CFG, linkMustContain: ".*" }),
    ).toHaveLength(0);
  });

  it("the default pattern needs a period word AND results/earnings", () => {
    expect(IR_PAGE_HEADLINE_RE.test("Acme Reports Fourth Quarter and Full Year 2025 Results")).toBe(true);
    expect(IR_PAGE_HEADLINE_RE.test("Acme Announces FY2026 Earnings")).toBe(true);
    expect(IR_PAGE_HEADLINE_RE.test("Acme Names New CFO")).toBe(false);
    expect(IR_PAGE_HEADLINE_RE.test("Acme to Host Second Quarter Conference Call")).toBe(false);
  });

  it("the headline pattern is stateless — the same title tests the same way twice", () => {
    // A `g`/`y` flag would carry lastIndex between calls on this shared constant
    // and make every other poll miss the release.
    expect(IR_PAGE_HEADLINE_RE.flags.includes("g")).toBe(false);
    expect(IR_PAGE_HEADLINE_RE.flags.includes("y")).toBe(false);
    expect(IR_PAGE_HEADLINE_RE.test("Acme Reports Q2 2026 Results")).toBe(true);
    expect(IR_PAGE_HEADLINE_RE.test("Acme Reports Q2 2026 Results")).toBe(true);
  });

  it("resolves relative hrefs against the page URL it was actually served from", () => {
    const links = extractIrPageLinks(
      `<a href="acme-q2-2026-results">Acme Reports Q2 2026 Results</a>`,
      "https://ir.acme.example/press/index.html",
      CFG,
    );
    expect(links.map((l) => l.link)).toEqual(["https://ir.acme.example/press/acme-q2-2026-results"]);
  });

  it("decodes entities and flattens inline markup in the anchor text", () => {
    const links = extractIrPageLinks(
      `<a href="/x"><span>Acme &amp; Co.</span>  Reports  Q2 2026\n  Results</a>`,
      "https://ir.acme.example/news",
      CFG,
    );
    expect(links).toEqual([
      { link: "https://ir.acme.example/x", title: "Acme & Co. Reports Q2 2026 Results" },
    ]);
  });

  it("skips an oversized anchor blob without pathological backtracking", () => {
    // A hostile/broken page can wrap a whole article in one <a>. The pattern is
    // ^-anchored (single scan) AND the blob is skipped outright.
    const blob = "no period word here ".repeat(300); // > IR_PAGE_MAX_TITLE_CHARS
    expect(blob.length).toBeGreaterThan(IR_PAGE_MAX_TITLE_CHARS);
    const started = Date.now();
    expect(
      extractIrPageLinks(`<a href="/x">${blob}</a>`, "https://ir.acme.example/news", CFG),
    ).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("drops non-https hrefs (javascript:, mailto:, plain http) — the fetch would refuse them anyway", () => {
    expect(
      extractIrPageLinks(
        `<a href="javascript:void(0)">Acme Reports Q2 2026 Results</a>
         <a href="mailto:ir@acme.example">Acme Reports Q2 2026 Results</a>
         <a href="http://ir.acme.example/insecure">Acme Reports Q2 2026 Results</a>
         <a href="/secure">Acme Reports Q2 2026 Results</a>`,
        "https://ir.acme.example/news",
        CFG,
      ).map((l) => l.link),
    ).toEqual(["https://ir.acme.example/secure"]);
  });

  it("skips an unparseable href rather than throwing", () => {
    expect(
      extractIrPageLinks(
        `<a href="http://[bad">Acme Reports Q2 2026 Results</a><a href="/ok">Acme Reports Q2 2026 Results</a>`,
        "https://ir.acme.example/news",
        CFG,
      ).map((l) => l.link),
    ).toEqual(["https://ir.acme.example/ok"]);
  });
});

describe("isAllowedIrLinkHost", () => {
  it("allows the IR host and the fixed wire hosts (any subdomain), nothing else", () => {
    expect(isAllowedIrLinkHost("https://ir.acme.example/x", "ir.acme.example")).toBe(true);
    expect(isAllowedIrLinkHost("https://www.businesswire.com/x", "ir.acme.example")).toBe(true);
    expect(isAllowedIrLinkHost("https://www.globenewswire.com/x", "ir.acme.example")).toBe(true);
    expect(isAllowedIrLinkHost("https://www.prnewswire.com/x", "ir.acme.example")).toBe(true);
    expect(isAllowedIrLinkHost("https://www.sec.gov/x", "ir.acme.example")).toBe(true);
    expect(isAllowedIrLinkHost("https://evil.example/x", "ir.acme.example")).toBe(false);
    expect(isAllowedIrLinkHost("https://businesswire.com.evil.example/x", "ir.acme.example")).toBe(false);
  });

  it("compares hosts case-insensitively and refuses junk", () => {
    expect(isAllowedIrLinkHost("https://IR.ACME.example/x", "ir.acme.example")).toBe(true);
    expect(isAllowedIrLinkHost("https://ir.acme.example/x", "IR.Acme.Example")).toBe(true);
    expect(isAllowedIrLinkHost("not a url", "ir.acme.example")).toBe(false);
    // A same-suffix impostor of the IR host itself is not the IR host.
    expect(isAllowedIrLinkHost("https://evil-ir.acme.example.attacker.test/x", "ir.acme.example")).toBe(false);
  });

  it("pins the wire-host list to the four the spec names", () => {
    expect([...IR_PAGE_WIRE_HOSTS]).toEqual([
      "businesswire.com",
      "globenewswire.com",
      "prnewswire.com",
      "sec.gov",
    ]);
  });
});

describe("pollIrPage", () => {
  it("baseline: marks every allowed matching link seen and returns nothing", async () => {
    const fetchBytes = vi.fn(pageServer(PAGE));
    const seen = new Set<string>();
    const out = await pollIrPage(CFG, seen, fetchBytes, { baseline: true });
    expect(out).toEqual([]);
    expect([...seen].sort()).toEqual([
      "https://ir.acme.example/news/acme-reports-second-quarter-fiscal-2026-results",
      "https://www.businesswire.com/news/home/2026/acme-q2",
    ]);
  });

  it("after the baseline: returns only new allowed links, UNMARKED (caller-owns-seen)", async () => {
    const fetchBytes = vi.fn(pageServer(PAGE));
    const seen = new Set(["https://www.businesswire.com/news/home/2026/acme-q2"]);
    const out = await pollIrPage(CFG, seen, fetchBytes, { baseline: false });
    expect(out.map((l) => l.link)).toEqual([
      "https://ir.acme.example/news/acme-reports-second-quarter-fiscal-2026-results",
    ]);
    expect(seen.has(out[0].link)).toBe(false);
  });

  it("never returns an off-allowlist link, baseline or not (M17)", async () => {
    const fetchBytes = vi.fn(pageServer(PAGE));
    const seen = new Set<string>();
    const out = await pollIrPage(CFG, seen, fetchBytes, { baseline: false });
    expect(out.map((l) => l.link)).not.toContain("https://evil.example/acme-q2-results");
    expect([...seen]).not.toContain("https://evil.example/acme-q2-results");
  });

  it("resolves relative links against the page's FINAL url (a redirect moved the page)", async () => {
    const fetchBytes = vi.fn(
      pageServer(
        `<a href="acme-q2-2026-results">Acme Reports Q2 2026 Results</a>`,
        "https://ir.acme.example/newsroom/",
      ),
    );
    const out = await pollIrPage(CFG, new Set<string>(), fetchBytes, { baseline: false });
    expect(out.map((l) => l.link)).toEqual([
      "https://ir.acme.example/newsroom/acme-q2-2026-results",
    ]);
  });

  it("labels its own fetch and passes the caller's options through untouched", async () => {
    const fetchBytes = vi.fn(pageServer(PAGE));
    await pollIrPage(CFG, new Set<string>(), fetchBytes, { baseline: true });
    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(fetchBytes.mock.calls[0][0]).toBe(CFG.irPageUrl);
    expect(fetchBytes.mock.calls[0][1]).toMatchObject({ label: expect.stringContaining("IR page") });
  });
});
