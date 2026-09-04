import { describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { printHtmlOneSheet } from "@/lib/earnings/print-ladder";

/** A fake renderer whose page count is driven by the compose flags. */
function renderer(pagesFor: (html: string) => number) {
  return vi.fn(async (html: string) =>
    Buffer.from(`%PDF-${"/Type /Page ".repeat(pagesFor(html))}%%EOF`),
  );
}
const compose = (o: { dropFlexible: boolean; compact: boolean }) =>
  `<html>flex:${!o.dropFlexible} compact:${o.compact}</html>`;

/** Typed like `printPdfViaLp` so `mock.calls[n][1]` is the real opts arg. */
function lp(impl: (path: string, opts?: { printer?: string | null; title?: string }) => void = () => {}) {
  return vi.fn(async (path: string, opts?: { printer?: string | null; title?: string }) => {
    impl(path, opts);
  });
}

describe("printHtmlOneSheet", () => {
  it("prints the first render when it already fits", async () => {
    const renderPdf = renderer(() => 1);
    const printPdf = lp();
    const res = await printHtmlOneSheet({
      compose,
      symbol: "XMPL",
      title: "t",
      printer: null,
      seams: { renderPdf, printPdf },
    });
    expect(res).toEqual({ pages: 1 });
    expect(renderPdf).toHaveBeenCalledTimes(1);
    expect(renderPdf.mock.calls[0][0]).toContain("flex:true");
    expect(printPdf).toHaveBeenCalledTimes(1);
  });

  it("rung 2 drops the flexible block; rung 3 compacts; it never renders a fourth time", async () => {
    const renderPdf = renderer((html) => (html.includes("compact:true") ? 3 : 5));
    const printPdf = lp();
    const res = await printHtmlOneSheet({
      compose,
      symbol: "XMPL",
      title: "t",
      printer: null,
      seams: { renderPdf, printPdf },
    });
    expect(renderPdf).toHaveBeenCalledTimes(3);
    expect(renderPdf.mock.calls[1][0]).toContain("flex:false");
    expect(renderPdf.mock.calls[2][0]).toContain("compact:true");
    // Still >2 pages: it prints anyway rather than truncating anything.
    expect(res).toEqual({ pages: 3 });
    expect(printPdf).toHaveBeenCalledTimes(1);
  });

  it("treats a 0-page render as a failure and throws", async () => {
    const renderPdf = vi.fn(async () => Buffer.from("garbage"));
    await expect(
      printHtmlOneSheet({
        compose,
        symbol: "XMPL",
        title: "t",
        printer: null,
        seams: { renderPdf, printPdf: lp() },
      }),
    ).rejects.toThrow(/unparseable PDF/);
  });

  it("propagates an lp failure (the CALLER decides whether to downgrade)", async () => {
    await expect(
      printHtmlOneSheet({
        compose,
        symbol: "XMPL",
        title: "t",
        printer: null,
        seams: {
          renderPdf: renderer(() => 1),
          printPdf: async () => {
            throw new Error("cupsd wedged");
          },
        },
      }),
    ).rejects.toThrow("cupsd wedged");
  });

  it("passes the printer and a title through to lp and cleans its temp dir up", async () => {
    let seenPath = "";
    const printPdf = lp((p) => {
      seenPath = p;
      expect(p).toMatch(/XMPL.*\.pdf$/);
      expect(existsSync(p)).toBe(true);
    });
    await printHtmlOneSheet({
      compose,
      symbol: "XMPL",
      title: "XMPL post-print sheet",
      printer: "Desk_LaserJet",
      seams: { renderPdf: renderer(() => 1), printPdf },
    });
    expect(printPdf.mock.calls[0][1]).toEqual({ printer: "Desk_LaserJet", title: "XMPL post-print sheet" });
    // The temp dir is gone once the ladder returns.
    expect(existsSync(seenPath)).toBe(false);
    expect(existsSync(dirname(seenPath))).toBe(false);
  });
});
